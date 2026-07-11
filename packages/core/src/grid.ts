/**
 * Tabular — a canvas-first data grid engine.
 *
 * Architecture (per the cggrid plan): the scrollable cell viewport is
 * canvas; chrome and cell editors are DOM. A native-overflow scroller with
 * a spacer element drives scrolling; scroll events update offsets and
 * schedule an rAF repaint. No DOM node per row — 100k×N stays flat.
 */
import { CalcResolver } from './calcResolver';
import { attachFormat, FormatResolver } from './formatBridge';
import { attachRules } from './rulesBridge';
import type { RulesEngine } from '@tabular/rules';
import { buildHtmlClipboardTable, writeClipboardTsvAndHtml } from '@tabular/format';
import { ColumnModel, type InternalColumn, type Region } from './columnModel';
import {
  aggFuncFromDelta,
  ComponentRegistry,
  globalRegistry,
  normalizeCellRenderer,
  type CellEditorFactory,
  type CellEditorParams,
  type CellRendererComp,
  type CellRendererDef,
  type CellRendererFn,
  type DeltaAggregate,
  type ToolPanelFactory,
} from './registry';
import {
  colSpanAnchorIndex,
  colSpanCount,
  rowSpanRange,
  spanRowsActive,
  type SpanEnv,
} from './spanning';
import { RowModel, type CellChange } from './rowModel';
import { FlashManager } from './flash';
import {
  cellChangeFlashEnabled,
  type CellStyleResolver,
  type ResolverCellParams,
  type ValueFormatResolver,
} from './styling';
import { resolveTheme, type ResolvedTheme, withAlpha } from './theme';
import { paintBody, paintHeader, paintOverlay, paintPinnedRows, cellRect, fillHandleRect, findStickyGroup, floatingFilterRect, floatingFilterClearAt, floatingFilterInputGeom, wrapLines, wrapLineHeight, trailingPaddingLevels, headerButtonAt, headerCellX, FLOATING_FILTER_CLEAR_SIZE, type PaintEnv } from './renderer';
import {
  formatFilterDisplay,
  isDateFilter,
  parseFloatingFilterInput,
  resolveFilterKind,
  setFilterKey,
  tokenizeQuickFilter,
} from './filters';
import { iconSvg, type IconName } from './icons';
import { buildPivotResultColumns } from './pivot';
import {
  buildExportMatrix,
  downloadText,
  downloadBytes,
  matrixToCsv,
  matrixToSpreadsheetXml,
  resolveCsvFileName,
  resolveExcelFileName,
  type ExportContext,
  type ExportRowNode,
} from './export';
import { resolveCellTooltip, resolveHeaderTooltip, textOverflows } from './tooltips';
import { resolveSideBarDef, SideBarController } from './sideBar';
import { renderColumnsToolPanel } from './toolPanels/columnsToolPanel';
import type { AggFunc } from './aggregation';
import { DataWorkerClient } from './worker/dataClient';
import { WorkerCoordinator } from './worker/coordinator';
import { decodeText } from './worker/chunkFormat';
import {
  WORKER_AGG_FUNCS,
  workerCalcField,
  type ViewportChunk,
  type WorkerAutosizeColumn,
  type WorkerClipboardRange,
  type WorkerCsvColumn,
  type WorkerModelOutput,
  type WorkerPipelineConfig,
  type AggTransactionPayload,
} from './worker/protocol';
import type {
  AnyColDef,
  CellParams,
  CellPosition,
  ColumnFilter,
  ColumnGroupStateItem,
  ColumnState,
  ContextMenuItem,
  CsvExportParams,
  DateColumnFilter,
  Density,
  DetailCellRendererParams,
  DetailGridInfo,
  ExcelExportParams,
  FillHandleOptions,
  FilterModel,
  FlashCellsParams,
  GridEventName,
  GridEvents,
  GridlineMode,
  GridOptions,
  GridState,
  GridStateModule,
  GridStateModuleSlice,
  RowDelta,
  PaginationPanel,
  Pinned,
  RowDataTransaction,
  SideBarDef,
  SortDir,
  SortModelItem,
  StatusPanelAggFunc,
  StatusPanelName,
  ThemeName,
} from './types';

interface EditorState {
  rowIndex: number;
  colId: string;
  /** Mounted editor root — the default input or a component editor's gui. */
  el: HTMLElement;
  /** Default text-input editor; null when a component editor is active. */
  input: HTMLInputElement | null;
  /** Component editor (colDef.cellEditor), when active. */
  comp: import('./registry').CellEditorComp | null;
  oldValue: unknown;
  canceled: boolean;
}

/** One reversible cell mutation; an undo operation is a batch of these. */
interface CellEditOp {
  rowId: string;
  colId: string;
  oldValue: unknown;
  newValue: unknown;
}

interface FloatingFilterState {
  colId: string;
  input: HTMLInputElement;
  debounce: ReturnType<typeof setTimeout> | null;
}

/** Tracks an in-progress cell range pointer gesture (AG Grid click vs drag). */
interface RangePointerState {
  anchor: CellPosition;
  clientX: number;
  clientY: number;
  dragging: boolean;
  shiftKey: boolean;
}

type Handler = (payload: unknown) => void;

/** One mounted (or kept-alive) detail row: DOM container + optional nested grid. */
interface DetailInstance {
  masterId: string;
  el: HTMLDivElement;
  /** Default detail renderer: the nested Tabular instance. Null for custom renderers. */
  grid: Tabular<unknown> | null;
  /** Height already applied via `detailRowAutoHeight` (epsilon-guarded). */
  measuredHeight: number | null;
}

export class Tabular<TData = unknown> {
  private readonly options: GridOptions<TData>;
  private readonly cols: ColumnModel<TData>;
  private readonly rows: RowModel<TData>;
  private readonly flashMgr = new FlashManager();
  private rulesAttach: { engine: RulesEngine<TData>; detach: () => void } | null = null;
  private formatAttach: { detach: () => void } | null = null;

  private theme: ResolvedTheme;

  // DOM
  private readonly root: HTMLElement;
  private readonly headerCanvas: HTMLCanvasElement;
  private readonly scroller: HTMLDivElement;
  private readonly spacer: HTMLDivElement;
  private readonly bodyCanvas: HTMLCanvasElement;
  private readonly overlayCanvas: HTMLCanvasElement;
  private readonly pinnedTopCanvas: HTMLCanvasElement;
  private readonly pinnedBottomCanvas: HTMLCanvasElement;
  private readonly ctxH: CanvasRenderingContext2D;
  private readonly ctxB: CanvasRenderingContext2D;
  private readonly ctxO: CanvasRenderingContext2D;
  private readonly ctxPT: CanvasRenderingContext2D;
  private readonly ctxPB: CanvasRenderingContext2D;

  // worker lifecycle (data plane)
  private readonly workerCoord: WorkerCoordinator;
  /** Snapshot from a compare-mode main-thread run, awaiting worker output. */
  private workerCompareSnapshot: {
    filteredCount: number;
    displayedIds: string[];
  } | null = null;
  private workerAggregationWarned = false;
  /** Cached viewport chunk from the data worker (W5). */
  private viewportChunk: ViewportChunk | null = null;
  private viewportPrefetchGen = 0;
  /** PREV([field]) snapshots on the main thread (main-path calc). */
  private readonly prevByRow = new Map<string, Map<string, unknown>>();

  // Phase 0 seams: per-grid registry (shadows the global), renderer caches,
  // resolver chains, unified state modules, persisted-state autosave.
  private readonly registry = new ComponentRegistry(globalRegistry);
  private readonly calcResolver = new CalcResolver();
  private readonly formatResolver = new FormatResolver();
  /** Column-level renderer resolution cache (colId → comp); cleared per refresh. */
  private readonly columnRendererCache = new Map<string, CellRendererComp<TData> | null>();
  /** Registered-name → normalized comp cache (selector string results). */
  private readonly namedRendererCache = new Map<string, CellRendererComp<TData> | null>();
  /** Registry aggregates merged over `options.aggFuncs`; undefined ⇒ recompute. */
  private mergedAggFuncs: Record<string, AggFunc> | null | undefined = undefined;
  private styleResolvers: Array<{ fn: CellStyleResolver<TData>; priority: number }> = [];
  /** Sorted style chain handed to the painter; null when empty (zero-cost check). */
  private styleChain: CellStyleResolver<TData>[] | null = null;
  private formatResolvers: Array<{ fn: ValueFormatResolver<TData>; priority: number }> = [];
  private formatChain: ValueFormatResolver<TData>[] | null = null;
  private readonly stateModules = new Map<string, GridStateModule>();
  /** Restored module slices awaiting their module's registration. */
  private pendingModuleSlices: Record<string, GridStateModuleSlice> | null = null;
  /** Named layouts (Phase 7) — stored separately so getState can embed them. */
  private namedLayouts: import('./types').NamedLayout[] = [];
  private activeLayoutId: string | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  // view state
  private scrollLeft = 0;
  private scrollTop = 0;
  private viewWidth = 0;
  private viewHeight = 0;
  private dpr = 1;

  // variable row heights (getRowHeight / autoHeight); null ⇒ uniform fast path
  private rowOffsets: Float64Array | null = null;
  private rowOffsetsDirty = true;

  private focused: { rowIndex: number; colId: string } | null = null;
  private selectedIds = new Set<string>();
  private selectionAnchor = -1;
  private editor: EditorState | null = null;
  private floatingFilter: FloatingFilterState | null = null;
  private ffClearLayer: HTMLDivElement | null = null;
  private readonly ffClearButtons = new Map<string, HTMLButtonElement>();
  private range: { start: CellPosition; end: CellPosition } | null = null;
  /** Fixed start cell for shift-extend (AG Grid range anchor). */
  private rangeAnchor: CellPosition | null = null;
  private rangePointer: RangePointerState | null = null;
  /** Active fill-handle drag: source bounds + live preview target. */
  private fillDrag: {
    bounds: { row0: number; row1: number; col0: number; col1: number };
    preview: { row0: number; row1: number; col0: number; col1: number } | null;
    direction: 'up' | 'down' | 'left' | 'right';
  } | null = null;
  private moveDrag: { colId: string; fromIndex: number } | null = null;

  // row group panel
  private groupPanel: HTMLDivElement | null = null;
  /** Pivot column panel (below row group panel). */
  private pivotPanel: HTMLDivElement | null = null;
  private sideBarCtrl: SideBarController<TData> | null = null;
  private pivotChipDrag: { colId: string; startX: number; startY: number; moved: boolean } | null = null;
  private dragGhost: HTMLDivElement | null = null;
  private panelIndicator: HTMLDivElement | null = null;
  /** Chip being dragged inside the row group panel (reorder / drag-out removes). */
  private chipDrag: { colId: string; startX: number; startY: number; moved: boolean } | null = null;

  // popups (set filter dropdown, context menu)
  private setFilterPopup: HTMLDivElement | null = null;
  private setFilterCleanup: (() => void) | null = null;
  private contextMenuEl: HTMLDivElement | null = null;
  /** Root menu plus any open submenu layers (outside-click detection). */
  private contextMenuLayers: HTMLDivElement[] = [];
  private contextMenuCleanup: (() => void) | null = null;
  /** Header funnel-button filter popup (below the header cell). */
  private headerFilterPopup: HTMLDivElement | null = null;
  private headerFilterPopupCleanup: (() => void) | null = null;
  /** Floating Choose Columns dialog (column menu → Choose Columns). */
  private columnChooserEl: HTMLDivElement | null = null;
  private columnChooserCleanup: (() => void) | null = null;

  // status bar + overlays
  private statusBar: HTMLDivElement | null = null;
  private statusLeft: HTMLSpanElement | null = null;
  private statusRight: HTMLSpanElement | null = null;
  private paginationPanel: HTMLDivElement | null = null;
  private currentPage = 0;
  private autoPageSizeValue = 100;
  private overlayEl: HTMLDivElement | null = null;
  private overlayState: 'none' | 'loading' | 'noRows' = 'none';

  // master / detail (§4.15)
  private detailLayer: HTMLDivElement | null = null;
  private detailInstances = new Map<string, DetailInstance>();
  /** Measured heights per master id (`detailRowAutoHeight`). */
  private detailHeights = new Map<string, number>();
  /** Registered detail grids (`detail_{rowId}` → info), incl. manual adds. */
  private detailGridInfoStore = new Map<string, DetailGridInfo>();
  /** LRU of collapsed-but-kept instances (`keepDetailRows`), oldest first. */
  private detailKeepOrder: string[] = [];

  // tooltips (§4.11)
  private tooltipEl: HTMLDivElement | null = null;
  private tooltipShowTimer: ReturnType<typeof setTimeout> | null = null;
  private tooltipHideTimer: ReturnType<typeof setTimeout> | null = null;
  private tooltipTarget: { kind: 'cell' | 'header'; rowIndex?: number; colId: string; text: string } | null =
    null;

  // keyboard nav coalescing (§4.11)
  private navRafId = 0;
  private navPending: { dr: number; dc: number; extend: boolean } | null = null;

  // undo / redo of cell edits (edits + pastes; §4.6)
  private undoStack: CellEditOp[][] = [];
  private redoStack: CellEditOp[][] = [];

  // painting
  private rafId = 0;
  private paintPending = false;
  private firstPaintDone = false;

  // async transactions
  private txQueue: RowDataTransaction<TData>[] = [];
  private txTimer: ReturnType<typeof setTimeout> | null = null;

  // interaction
  private resizeDrag: { colId: string; startX: number; startWidth: number } | null = null;
  private headerDownAt: { x: number; y: number } | null = null;

  /** Trackpad axis lock — one scroll axis per gesture. */
  private wheelAxis: 'x' | 'y' | null = null;
  private wheelAxisAccX = 0;
  private wheelAxisAccY = 0;
  private wheelAxisIdle: ReturnType<typeof setTimeout> | null = null;
  private static readonly WHEEL_AXIS_THRESHOLD = 6;
  private static readonly RANGE_DRAG_THRESHOLD = 4;
  private static readonly WHEEL_AXIS_IDLE_MS = 120;

  private listeners = new Map<string, Set<Handler>>();
  private cleanups: Array<() => void> = [];
  private destroyed = false;
  private ro: ResizeObserver;

  constructor(container: HTMLElement, options: GridOptions<TData>) {
    this.options = options;
    this.theme = resolveTheme(options.theme ?? 'dark', options.density ?? 'compact', {
      gridlines: options.gridlines,
    });
    if (options.cellFlashDuration) this.flashMgr.duration = options.cellFlashDuration;

    this.cols = new ColumnModel(
      options.columnDefs,
      options.defaultColDef,
      this.theme.headerHeight,
      this.theme.floatingFilterHeight,
      options.floatingFilter === true,
      options.treeData === true,
      options.autoGroupColumnDef,
      this.selectionColumnMode(),
      options.selectionColumnDef,
    );
    this.rows = new RowModel(options.getRowId ? (d) => options.getRowId!({ data: d }) : undefined);
    this.rows.quickFilter = options.quickFilterText ?? '';
    const grid = this;
    this.workerCoord = new WorkerCoordinator({
      get destroyed() {
        return grid.destroyed;
      },
      requestPaint: () => grid.requestPaint(),
      updateStatusBar: () => grid.updateStatusBar(),
      flashCellChange: (c) => grid.flashCellChange(c),
      get enableCellFlash() {
        return grid.options.enableCellFlash !== false;
      },
      applyWorkerModel: (output) => grid.applyWorkerModelFromWorker(output),
      patchGroupAggregates: (updates) => grid.rows.patchGroupAggregates(updates),
      fallbackToMain: () => {
        grid.options.rowDataMode = 'main';
        grid.refreshModel();
      },
      onRulesResult: (rules) => grid.applyWorkerRulesResult(rules),
      get dataMirrorActive() {
        return grid.rows.dataMirrorActive;
      },
      restoreDataMirror: (rows) => grid.rows.restoreDataMirror(rows as TData[]),
      syncWorkerRulesConfig: (client) => grid.syncWorkerRulesConfig(client),
      warnWorkerAggregationIgnored: () => {
        if (grid.options.workerAggregation !== false || grid.workerAggregationWarned) return;
        grid.workerAggregationWarned = true;
        console.warn(
          '[tabular] workerAggregation is deprecated and ignored when the data-plane worker is active; use rowDataMode: "main" to force main-thread aggregation',
        );
      },
    });
    if (options.pivotMode) this.cols.setPivotMode(true);

    // ── DOM assembly ────────────────────────────────────────────────
    this.root = container;
    this.root.classList.add('tabular-root');
    ensureScrollbarStyles();
    this.root.style.position = 'relative';
    this.root.style.overflow = 'hidden';
    this.root.style.outline = 'none';
    this.root.tabIndex = 0;

    this.headerCanvas = document.createElement('canvas');
    Object.assign(this.headerCanvas.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      display: 'block',
      cursor: 'default',
    } satisfies Partial<CSSStyleDeclaration>);

    this.scroller = document.createElement('div');
    Object.assign(this.scroller.style, {
      position: 'absolute',
      left: '0',
      right: '0',
      bottom: '0',
      overflow: 'auto',
    } satisfies Partial<CSSStyleDeclaration>);

    this.spacer = document.createElement('div');
    this.spacer.style.pointerEvents = 'none';
    this.scroller.appendChild(this.spacer);

    this.bodyCanvas = document.createElement('canvas');
    Object.assign(this.bodyCanvas.style, {
      position: 'absolute',
      left: '0',
      display: 'block',
      pointerEvents: 'none',
    } satisfies Partial<CSSStyleDeclaration>);

    this.overlayCanvas = document.createElement('canvas');
    Object.assign(this.overlayCanvas.style, {
      position: 'absolute',
      left: '0',
      display: 'block',
      pointerEvents: 'none',
    } satisfies Partial<CSSStyleDeclaration>);

    this.pinnedTopCanvas = document.createElement('canvas');
    this.pinnedBottomCanvas = document.createElement('canvas');
    for (const cv of [this.pinnedTopCanvas, this.pinnedBottomCanvas]) {
      Object.assign(cv.style, {
        position: 'absolute',
        left: '0',
        display: 'none',
      } satisfies Partial<CSSStyleDeclaration>);
    }

    this.root.appendChild(this.scroller);
    this.root.appendChild(this.bodyCanvas);
    this.root.appendChild(this.overlayCanvas);
    this.root.appendChild(this.pinnedTopCanvas);
    this.root.appendChild(this.pinnedBottomCanvas);
    this.root.appendChild(this.headerCanvas);

    const panelShow = options.rowGroupPanelShow ?? 'never';
    if (panelShow === 'always' || panelShow === 'onlyWhenGrouping') {
      this.groupPanel = document.createElement('div');
      Object.assign(this.groupPanel.style, {
        position: 'absolute',
        top: '0',
        left: '0',
        right: '0',
        display: 'none',
        alignItems: 'center',
        gap: '6px',
        boxSizing: 'border-box',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        zIndex: '12',
      } satisfies Partial<CSSStyleDeclaration>);
      this.root.appendChild(this.groupPanel);
    }

    const pivotShow = options.pivotPanelShow ?? 'never';
    if (pivotShow === 'always' || pivotShow === 'onlyWhenPivoting') {
      this.pivotPanel = document.createElement('div');
      Object.assign(this.pivotPanel.style, {
        position: 'absolute',
        left: '0',
        right: '0',
        display: 'none',
        alignItems: 'center',
        gap: '6px',
        boxSizing: 'border-box',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        zIndex: '12',
      } satisfies Partial<CSSStyleDeclaration>);
      this.root.appendChild(this.pivotPanel);
    }

    if (options.statusBar) {
      this.statusBar = document.createElement('div');
      Object.assign(this.statusBar.style, {
        position: 'absolute',
        left: '0',
        right: '0',
        bottom: '0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        boxSizing: 'border-box',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        zIndex: '12',
        userSelect: 'none',
      } satisfies Partial<CSSStyleDeclaration>);
      this.statusLeft = document.createElement('span');
      this.statusRight = document.createElement('span');
      this.statusBar.appendChild(this.statusLeft);
      this.statusBar.appendChild(this.statusRight);
      this.root.appendChild(this.statusBar);
    }

    if (options.pagination) {
      this.ensurePaginationPanel();
    }

    if (options.masterDetail === true) {
      // Detail rows are DOM (a nested grid can't live on canvas): punched-out
      // rects on the body canvas covered by absolutely-positioned children of
      // this layer, translated in lockstep with vertical scroll each frame.
      this.detailLayer = document.createElement('div');
      Object.assign(this.detailLayer.style, {
        position: 'absolute',
        left: '0',
        right: '0',
        overflow: 'hidden',
        pointerEvents: 'none',
        zIndex: '5',
      } satisfies Partial<CSSStyleDeclaration>);
      this.root.appendChild(this.detailLayer);
    }

    this.overlayEl = document.createElement('div');
    Object.assign(this.overlayEl.style, {
      position: 'absolute',
      left: '0',
      right: '0',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '15',
      pointerEvents: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.overlayEl);

    this.ffClearLayer = document.createElement('div');
    Object.assign(this.ffClearLayer.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '100%',
      height: '0',
      pointerEvents: 'none',
      zIndex: '11',
      overflow: 'visible',
    } satisfies Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.ffClearLayer);

    this.ctxH = this.headerCanvas.getContext('2d')!;
    this.ctxB = this.bodyCanvas.getContext('2d')!;
    this.ctxO = this.overlayCanvas.getContext('2d')!;
    this.ctxPT = this.pinnedTopCanvas.getContext('2d')!;
    this.ctxPB = this.pinnedBottomCanvas.getContext('2d')!;

    // ── listeners ───────────────────────────────────────────────────
    this.listen(this.scroller, 'scroll', () => this.onScroll(), { passive: true });
    this.listen(this.scroller, 'mousedown', (e) => this.onBodyMouseDown(e as MouseEvent));
    this.listen(this.scroller, 'mousemove', (e) => this.onBodyMouseMove(e as MouseEvent));
    this.listen(this.scroller, 'click', (e) => this.onBodyClick(e as MouseEvent));
    this.listen(this.scroller, 'dblclick', (e) => this.onBodyDblClick(e as MouseEvent));
    this.listen(this.headerCanvas, 'mousedown', (e) => this.onHeaderMouseDown(e as MouseEvent));
    this.listen(this.headerCanvas, 'mousemove', (e) => this.onHeaderHover(e as MouseEvent));
    this.listen(this.headerCanvas, 'dblclick', (e) => this.onHeaderDblClick(e as MouseEvent));
    this.listen(this.scroller, 'contextmenu', (e) => this.onBodyContextMenu(e as MouseEvent));
    this.listen(this.headerCanvas, 'contextmenu', (e) => this.onHeaderContextMenu(e as MouseEvent));
    this.listen(window, 'mousemove', (e) => this.onWindowMouseMove(e as MouseEvent));
    this.listen(window, 'mouseup', (e) => this.onWindowMouseUp(e as MouseEvent));
    this.listen(this.root, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent));
    // Capture wheel on the whole grid (incl. header) so trackpad gestures lock
    // to a single axis for the duration of the swipe.
    this.listen(this.root, 'wheel', (e) => this.onWheel(e as WheelEvent), {
      passive: false,
      capture: true,
    });

    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.root);

    if (options.onGridReady) this.on('gridReady', options.onGridReady as Handler);
    if (options.onCellValueChanged) this.on('cellValueChanged', options.onCellValueChanged as Handler);
    if (options.onSelectionChanged) this.on('selectionChanged', options.onSelectionChanged as Handler);
    if (options.onSortChanged) this.on('sortChanged', options.onSortChanged as Handler);
    if (options.onToolPanelVisibleChanged) {
      this.on('toolPanelVisibleChanged', options.onToolPanelVisibleChanged as Handler);
    }
    if (options.onToolPanelSizeChanged) {
      this.on('toolPanelSizeChanged', options.onToolPanelSizeChanged as Handler);
    }
    if (options.onRowGroupOpened) this.on('rowGroupOpened', options.onRowGroupOpened as Handler);

    const sideBarDef = resolveSideBarDef(options.sideBar);
    if (sideBarDef) {
      this.sideBarCtrl = new SideBarController<TData>(
        {
          root: this.root,
          theme: this.theme,
          api: this,
          cols: this.cols,
          options: this.options,
          headerLabel: this.headerLabel,
          getDistinctValues: (colId) => this.getDistinctValues(colId),
          emit: (name, payload) => this.emit(name, payload),
          emitSizeChanged: (width, started, ended) =>
            this.emit('toolPanelSizeChanged', { width, started, ended }),
          requestLayout: () => this.layout(),
          refreshPanels: () => {
            this.renderGroupPanel();
            this.renderPivotPanel();
            this.sideBarCtrl?.refresh();
          },
        },
        sideBarDef,
      );
    }

    if (options.rowData) this.rows.setRowData(options.rowData);
    if (options.loading === true) this.overlayState = 'loading';

    // Unified state: explicit initialState wins over persisted state; both
    // apply before the first model refresh / paint (AG `initialState`).
    const initialState = options.initialState ?? this.loadPersistedState();
    if (initialState) this.applyStateSnapshot(initialState, true);
    if (options.persistState === true && options.gridId) this.wireStatePersistence();

    this.rebuildCalcResolver();
    this.rebuildFormatResolver();
    this.formatAttach = attachFormat(
      {
        addValueFormatResolver: (fn, priority) => this.addValueFormatResolver(fn as ValueFormatResolver<TData>, priority),
        addCellStyleResolver: (fn, priority) => this.addCellStyleResolver(fn as CellStyleResolver<TData>, priority),
        getThemeTokens: () => this.theme,
      },
      this.formatResolver,
      { formatting: options.formatting },
    );
    if (options.rules) {
      this.rulesAttach = attachRules(this.rulesHost(), {
        rules: options.rules,
        onAlert: (e) => {
          options.onAlert?.(e);
          this.emit('alert', e);
        },
      });
    }
    this.refreshModel(false);
    this.renderGroupPanel();
    this.renderPivotPanel();
    this.layout();
    this.renderOverlay();
    this.emit('gridReady', { api: this });
  }

  // ── events ────────────────────────────────────────────────────────

  on<K extends GridEventName>(event: K, handler: (e: GridEvents<TData>[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as Handler);
    return () => set!.delete(handler as Handler);
  }

  private emit<K extends GridEventName>(event: K, payload: GridEvents<TData>[K]): void {
    const set = this.listeners.get(event);
    if (set) for (const h of [...set]) h(payload);
  }

  private listen(
    target: EventTarget,
    type: string,
    fn: (e: Event) => void,
    opts?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, fn, opts);
    this.cleanups.push(() => target.removeEventListener(type, fn, opts));
  }

  // ── Phase 0 seams: registries, resolver chains, state, tx feed ─────

  /** Register a canvas cell renderer for this grid (shadows the global registry). */
  registerCellRenderer(name: string, def: CellRendererDef<TData>): void {
    this.registry.setCellRenderer(name, def);
    this.columnRendererCache.clear();
    this.namedRendererCache.clear();
    this.requestPaint();
  }

  /** Register a DOM cell editor for this grid (used via `colDef.cellEditor`). */
  registerCellEditor(name: string, factory: CellEditorFactory<TData>): void {
    this.registry.setCellEditor(name, factory);
  }

  /** Register a delta aggregate; usable as a string `aggFunc` name. */
  registerAggregate(name: string, agg: DeltaAggregate): void {
    this.registry.setAggregate(name, agg);
    this.mergedAggFuncs = undefined;
    this.refreshModel();
  }

  /** Register a custom tool panel; reference it from `SideBarDef.toolPanel`. */
  registerToolPanel(name: string, factory: ToolPanelFactory<TData>): void {
    this.registry.setToolPanel(name, factory);
    this.sideBarCtrl?.refreshToolPanel();
  }

  /** @internal Side bar hook — resolves registered custom tool panels. */
  resolveToolPanelFactory(name: string): ToolPanelFactory<TData> | undefined {
    return this.registry.getToolPanel(name) as ToolPanelFactory<TData> | undefined;
  }

  /** @internal Editor resolution for `colDef.cellEditor` string names. */
  resolveCellEditorFactory(name: string): CellEditorFactory<TData> | undefined {
    return this.registry.getCellEditor(name) as CellEditorFactory<TData> | undefined;
  }

  /**
   * Append a cell-style resolver (rules, format tiers). Entries run after the
   * built-in class/inline resolution in ascending `priority` order, mutating
   * a pooled style object. Returns an unsubscribe function.
   */
  addCellStyleResolver(fn: CellStyleResolver<TData>, priority = 0): () => void {
    this.styleResolvers.push({ fn, priority });
    this.rebuildStyleChain();
    this.requestPaint();
    return () => {
      this.styleResolvers = this.styleResolvers.filter((e) => e.fn !== fn);
      this.rebuildStyleChain();
      this.requestPaint();
    };
  }

  /**
   * Append a value-format resolver (format DSL, composite text). Runs before
   * `valueFormatter`; the first entry returning a string wins. Returns an
   * unsubscribe function.
   */
  addValueFormatResolver(fn: ValueFormatResolver<TData>, priority = 0): () => void {
    this.formatResolvers.push({ fn, priority });
    this.rebuildFormatChain();
    this.requestPaint();
    return () => {
      this.formatResolvers = this.formatResolvers.filter((e) => e.fn !== fn);
      this.rebuildFormatChain();
      this.requestPaint();
    };
  }

  /** Subscribe to the applied-transaction delta feed. Returns unsubscribe. */
  onTransactionApplied(
    handler: (e: GridEvents<TData>['transactionApplied']) => void,
  ): () => void {
    return this.on('transactionApplied', handler);
  }

  private rebuildStyleChain(): void {
    this.styleChain = this.styleResolvers.length
      ? [...this.styleResolvers].sort((a, b) => a.priority - b.priority).map((e) => e.fn)
      : null;
  }

  private rebuildFormatChain(): void {
    this.formatChain = this.formatResolvers.length
      ? [...this.formatResolvers].sort((a, b) => a.priority - b.priority).map((e) => e.fn)
      : null;
  }

  /**
   * Effective canvas renderer for a cell: `cellRendererSelector` (per cell,
   * only when defined) falling back to the column's `cellRenderer` (string
   * names resolved through the registries, cached per column).
   */
  private rendererFor = (
    col: InternalColumn<TData>,
    params: CellParams<TData>,
  ): CellRendererComp<TData> | null => {
    const selector = col.def.cellRendererSelector;
    if (selector) {
      const chosen = selector(params);
      if (chosen?.component !== undefined) {
        return typeof chosen.component === 'string'
          ? this.rendererByName(chosen.component)
          : normalizeCellRenderer(chosen.component as CellRendererFn<TData>);
      }
    }
    let comp = this.columnRendererCache.get(col.colId);
    if (comp === undefined) {
      const def = col.def.cellRenderer;
      comp =
        def === undefined || def === 'agGroupCellRenderer'
          ? null
          : typeof def === 'string'
            ? this.rendererByName(def)
            : { paint: def };
      this.columnRendererCache.set(col.colId, comp);
    }
    return comp;
  };

  private rendererByName(name: string): CellRendererComp<TData> | null {
    let comp = this.namedRendererCache.get(name);
    if (comp === undefined) {
      const def = this.registry.getCellRenderer(name) as CellRendererDef<TData> | undefined;
      comp = def ? normalizeCellRenderer(def) : null;
      this.namedRendererCache.set(name, comp);
    }
    return comp;
  }

  /** Registry delta aggregates merged under `options.aggFuncs` (options win). */
  private effectiveAggFuncs(): Record<string, AggFunc> | undefined {
    if (this.mergedAggFuncs === undefined) {
      const names = this.registry.aggregateNames();
      if (!names.length) {
        this.mergedAggFuncs = this.options.aggFuncs ?? null;
      } else {
        const merged: Record<string, AggFunc> = {};
        for (const n of names) merged[n] = aggFuncFromDelta(this.registry.getAggregate(n)!);
        Object.assign(merged, this.options.aggFuncs);
        this.mergedAggFuncs = merged;
      }
    }
    return this.mergedAggFuncs ?? undefined;
  }

  /** First format-chain entry returning a string wins; undefined falls through. */
  private runFormatChain(
    value: unknown,
    data: TData | undefined,
    rowIndex: number,
    col: InternalColumn<TData>,
  ): string | undefined {
    const params = {
      value,
      data,
      rowIndex,
      colDef: col.def,
      api: this,
      colId: col.colId,
    } as ResolverCellParams<TData>;
    for (const fn of this.formatChain!) {
      const out = fn(params);
      if (out !== undefined) return out;
    }
    return undefined;
  }

  /** Build + emit the transaction delta feed — only when someone listens. */
  private emitTransactionApplied(
    txs: readonly RowDataTransaction<TData>[],
    changes: readonly CellChange[],
  ): void {
    const set = this.listeners.get('transactionApplied');
    if (!set?.size) return;
    const byRow = new Map<string, RowDelta<TData>>();
    for (const c of changes) {
      let delta = byRow.get(c.rowId);
      if (!delta) {
        const data = this.rows.getRowById(c.rowId);
        if (data === undefined) continue;
        delta = { rowId: c.rowId, data, changes: [] };
        byRow.set(c.rowId, delta);
      }
      delta.changes.push({ key: c.colKey, oldValue: c.oldValue, newValue: c.newValue });
    }
    const addedIds: string[] = [];
    const removedIds: string[] = [];
    for (const tx of txs) {
      for (const r of tx.add ?? []) addedIds.push(this.rows.getId(r));
      for (const r of tx.remove ?? []) removedIds.push(this.rows.getId(r));
    }
    if (!byRow.size && !addedIds.length && !removedIds.length) return;
    this.emit('transactionApplied', { updates: [...byRow.values()], addedIds, removedIds });
  }

  // ── unified state (getState / setState / initialState / persistState) ─

  /** Snapshot the full grid state (AG `getState`-shaped + module slices). */
  getState(): GridState {
    const modules: Record<string, GridStateModuleSlice> = {};
    let hasModules = false;
    for (const [id, mod] of this.stateModules) {
      const data = mod.get();
      if (data !== undefined) {
        modules[id] = { version: mod.version, data };
        hasModules = true;
      }
    }
    // Keep unclaimed restored slices so a save doesn't drop late-loading modules.
    if (this.pendingModuleSlices) {
      for (const [id, slice] of Object.entries(this.pendingModuleSlices)) {
        if (!(id in modules)) {
          modules[id] = slice;
          hasModules = true;
        }
      }
    }
    const state: GridState = {
      version: 1,
      columns: this.cols.getColumnState(),
      columnGroups: this.cols.getColumnGroupState(),
      filter: {
        filterModel: { ...this.rows.filterModel },
        quickFilter: this.rows.quickFilter || undefined,
      },
      rowGroup: this.getRowGroupColumns(),
      pivot: {
        pivotMode: this.cols.pivotMode,
        pivotColumns: this.getPivotColumns(),
        valueColumns: this.getValueColumns(),
      },
    };
    if (this.sideBarCtrl) {
      state.sideBar = {
        visible: this.isSideBarVisible(),
        openToolPanel: this.getOpenedToolPanel(),
      };
    }
    if (this.options.pagination) state.pagination = { page: this.currentPage };
    if (hasModules) state.modules = modules;
    if (this.namedLayouts.length) state.layouts = this.namedLayouts.map((l) => ({ ...l }));
    if (this.activeLayoutId != null) state.activeLayoutId = this.activeLayoutId;
    return state;
  }

  /** List named layouts. */
  getLayouts(): import('./types').NamedLayout[] {
    return this.namedLayouts.map((l) => ({ ...l, state: { ...l.state } }));
  }

  getActiveLayoutId(): string | null {
    return this.activeLayoutId;
  }

  /** Save current grid state as a named layout (create or overwrite by id). */
  saveLayout(name: string, id?: string): import('./types').NamedLayout {
    const layoutId = id ?? `layout-${Date.now().toString(36)}`;
    const full = this.getState();
    const { layouts: _l, activeLayoutId: _a, ...rest } = full;
    const entry: import('./types').NamedLayout = {
      id: layoutId,
      name,
      updatedAt: new Date().toISOString(),
      state: rest,
    };
    const idx = this.namedLayouts.findIndex((l) => l.id === layoutId);
    if (idx >= 0) this.namedLayouts[idx] = entry;
    else this.namedLayouts.push(entry);
    this.activeLayoutId = layoutId;
    this.emitLayoutChanged();
    this.scheduleStatePersist();
    return { ...entry, state: { ...entry.state } };
  }

  /** Apply a named layout by id. */
  applyLayout(id: string): boolean {
    const layout = this.namedLayouts.find((l) => l.id === id);
    if (!layout) return false;
    this.setState(layout.state);
    this.activeLayoutId = id;
    this.emitLayoutChanged();
    return true;
  }

  renameLayout(id: string, name: string): boolean {
    const layout = this.namedLayouts.find((l) => l.id === id);
    if (!layout) return false;
    layout.name = name;
    layout.updatedAt = new Date().toISOString();
    this.emitLayoutChanged();
    this.scheduleStatePersist();
    return true;
  }

  duplicateLayout(id: string, newName?: string): import('./types').NamedLayout | null {
    const layout = this.namedLayouts.find((l) => l.id === id);
    if (!layout) return null;
    return this.saveLayout(newName ?? `${layout.name} copy`);
  }

  deleteLayout(id: string): boolean {
    const before = this.namedLayouts.length;
    this.namedLayouts = this.namedLayouts.filter((l) => l.id !== id);
    if (this.activeLayoutId === id) this.activeLayoutId = null;
    if (this.namedLayouts.length === before) return false;
    this.emitLayoutChanged();
    this.scheduleStatePersist();
    return true;
  }

  /** Replace the layout catalog (e.g. import). */
  setLayouts(layouts: import('./types').NamedLayout[], activeId?: string | null): void {
    this.namedLayouts = layouts.map((l) => ({ ...l, state: { ...l.state } }));
    this.activeLayoutId = activeId ?? null;
    this.emitLayoutChanged();
    this.scheduleStatePersist();
  }

  private emitLayoutChanged(): void {
    this.emit('layoutChanged', {
      layouts: this.getLayouts(),
      activeLayoutId: this.activeLayoutId,
    });
  }

  /** Restore a state snapshot produced by `getState`. */
  setState(state: GridState): void {
    this.applyStateSnapshot(state, false);
  }

  /**
   * Register a versioned module state slice (satellite packages). If a
   * restored snapshot already carried this module's slice, it is delivered
   * immediately. Returns an unregister function.
   */
  registerStateModule(module: GridStateModule): () => void {
    this.stateModules.set(module.id, module);
    const pending = this.pendingModuleSlices?.[module.id];
    if (pending) {
      delete this.pendingModuleSlices![module.id];
      module.set(pending.data, pending.version);
    }
    return () => {
      if (this.stateModules.get(module.id) === module) this.stateModules.delete(module.id);
    };
  }

  /** Nudge the persisted-state autosave (module-only state changes). */
  markStateDirty(): void {
    this.scheduleStatePersist();
  }

  private applyStateSnapshot(state: GridState, initialPhase: boolean): void {
    // Grouping / pivot before column state: they may inject the auto group
    // column whose width/pin/sort the column state then restores.
    if (state.rowGroup) this.cols.setRowGroupColumns(state.rowGroup);
    if (state.pivot) {
      if (state.pivot.pivotMode !== undefined) this.cols.setPivotMode(state.pivot.pivotMode);
      if (state.pivot.pivotColumns) this.cols.setPivotColumns(state.pivot.pivotColumns);
      if (state.pivot.valueColumns) this.cols.setValueColumns(state.pivot.valueColumns);
    }
    if (state.columns) this.cols.applyColumnState(state.columns);
    if (state.columnGroups) this.cols.setColumnGroupState(state.columnGroups);
    if (state.filter) {
      this.rows.filterModel = { ...state.filter.filterModel };
      this.rows.quickFilter = state.filter.quickFilter ?? '';
      this.options.quickFilterText = state.filter.quickFilter ?? '';
    }
    if (state.pagination) this.currentPage = Math.max(0, state.pagination.page);
    if (state.sideBar && this.sideBarCtrl) {
      this.sideBarCtrl.setVisible(state.sideBar.visible);
      if (state.sideBar.openToolPanel) {
        this.sideBarCtrl.openToolPanel(state.sideBar.openToolPanel, 'api');
      } else {
        this.sideBarCtrl.closeToolPanel('api');
      }
    }
    if (state.modules) {
      for (const [id, slice] of Object.entries(state.modules)) {
        const mod = this.stateModules.get(id);
        if (mod) {
          mod.set(slice.data, slice.version);
        } else {
          this.pendingModuleSlices ??= {};
          this.pendingModuleSlices[id] = slice;
        }
      }
    }
    if (state.layouts) {
      this.namedLayouts = state.layouts.map((l) => ({ ...l, state: { ...l.state } }));
    }
    if (state.activeLayoutId !== undefined) {
      this.activeLayoutId = state.activeLayoutId;
    }
    if (!initialPhase) {
      this.renderGroupPanel();
      this.renderPivotPanel();
      this.layout();
      this.refreshModel();
      this.sideBarCtrl?.refresh();
    }
    this.emit('stateUpdated', {});
  }

  private persistStateKey(): string | null {
    return this.options.persistState === true && this.options.gridId
      ? `tabular:state:${this.options.gridId}`
      : null;
  }

  private loadPersistedState(): GridState | null {
    const key = this.persistStateKey();
    if (!key) return null;
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as GridState) : null;
    } catch {
      return null;
    }
  }

  private wireStatePersistence(): void {
    const dirty = (): void => this.scheduleStatePersist();
    const events: GridEventName[] = [
      'sortChanged',
      'filterChanged',
      'columnResized',
      'columnMoved',
      'columnPinned',
      'columnVisible',
      'columnGroupOpened',
      'columnRowGroupChanged',
      'columnPivotModeChanged',
      'columnPivotChanged',
      'paginationChanged',
      'toolPanelVisibleChanged',
    ];
    for (const ev of events) this.on(ev, dirty);
  }

  private scheduleStatePersist(): void {
    if (this.destroyed || !this.persistStateKey()) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistStateNow();
    }, 500);
  }

  private persistStateNow(): void {
    const key = this.persistStateKey();
    if (!key) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(this.getState()));
    } catch {
      // Quota / privacy mode — persistence is best-effort.
    }
  }

  // ── value access ──────────────────────────────────────────────────

  private valueOf = (row: TData, col: InternalColumn<TData>, rowIndex: number): unknown => {
    if (col.def.calc && !col.def.valueGetter && this.calcResolver.has(col.colId)) {
      const node = this.rows.getDisplayedNode(rowIndex);
      const rowId = node?.id;
      const v = this.calcResolver.evaluate(col.colId, row as Record<string, unknown>, {
        rowId,
        prev: rowId ? (field) => this.prevByRow.get(rowId)?.get(field) ?? null : undefined,
      });
      if (v !== undefined) return v;
    }
    if (col.def.valueGetter) {
      return col.def.valueGetter({ value: undefined, data: row, rowIndex, colDef: col.def, api: this });
    }
    const field = col.def.field;
    if (!field) return undefined;
    if (field.includes('.')) {
      return field.split('.').reduce<unknown>((acc, k) => {
        if (acc == null || typeof acc !== 'object') return undefined;
        return (acc as Record<string, unknown>)[k];
      }, row);
    }
    return (row as Record<string, unknown>)[field];
  };

  private valueAtDisplayed = (rowIndex: number, col: InternalColumn<TData>): unknown => {
    const fromChunk = this.valueFromViewportChunk(rowIndex, col);
    if (fromChunk !== undefined) return fromChunk;

    const node = this.rows.getDisplayedNode(rowIndex);
    if (!node) return undefined;
    if (col.colId === 'ag-Grid-AutoColumn') {
      if (node.group) return node.key;
      return '';
    }
    if (node.group) {
      const childIds = col.def.pivotChildColIds;
      if (childIds?.length) {
        const agg = col.def.aggFunc;
        const nums: number[] = [];
        for (const id of childIds) {
          const v = node.aggData[id];
          if (typeof v === 'number' && Number.isFinite(v)) nums.push(v);
        }
        if (nums.length) {
          if (agg === 'min') return Math.min(...nums);
          if (agg === 'max') return Math.max(...nums);
          if (agg === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
          if (agg === 'count') return nums.length;
          return nums.reduce((a, b) => a + b, 0);
        }
      }
      if (node.aggData[col.colId] !== undefined) return node.aggData[col.colId];
      if (col.def.field && node.aggData[col.def.field] !== undefined) {
        return node.aggData[col.def.field];
      }
      // Tree parents are real rows — fall through to their own values.
      if (node.data) return this.valueOf(node.data, col, rowIndex);
      return undefined;
    }
    if (!node.data) return undefined;
    return this.valueOf(node.data, col, rowIndex);
  };

  private formatValue = (row: TData, col: InternalColumn<TData>, rowIndex: number): string => {
    const value = this.valueOf(row, col, rowIndex);
    if (this.formatChain) {
      const out = this.runFormatChain(value, row, rowIndex, col);
      if (out !== undefined) return out;
    }
    if (col.def.valueFormatter) {
      return col.def.valueFormatter({ value, data: row, rowIndex, colDef: col.def, api: this });
    }
    if (value == null) return '';
    if (typeof value === 'number') {
      return Number.isInteger(value)
        ? value.toLocaleString()
        : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    return String(value);
  };

  private formatDisplayed = (rowIndex: number, col: InternalColumn<TData>): string => {
    const node = this.rows.getDisplayedNode(rowIndex);
    if (!node) return '';
    if (col.colId === 'ag-Grid-AutoColumn') {
      if (node.footer) return node.key;
      if (!node.group) return node.key; // tree leaves render their key; grouped leaves have none
      return `${node.key} (${node.childCount})`;
    }
    const value = this.valueAtDisplayed(rowIndex, col);
    if (node.group && value == null) return '';
    if (this.formatChain) {
      const out = this.runFormatChain(value, (node.data ?? undefined) as TData, rowIndex, col);
      if (out !== undefined) return out;
    }
    // AG Grid runs valueFormatter for aggregated group cells too; `data` is
    // undefined on synthesized (filler / grouped) rows.
    if (col.def.valueFormatter) {
      return col.def.valueFormatter({
        value,
        data: (node.data ?? undefined) as TData,
        rowIndex,
        colDef: col.def,
        api: this,
      });
    }
    if (value == null) return '';
    if (typeof value === 'number') {
      return Number.isInteger(value)
        ? value.toLocaleString()
        : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    return String(value);
  };

  // ── layout / paint ────────────────────────────────────────────────

  private headerHeight(): number {
    return this.cols.totalHeaderHeight;
  }

  private groupPanelVisible(): boolean {
    if (!this.groupPanel) return false;
    if (this.options.rowGroupPanelShow === 'always') return true;
    return this.cols.getRowGroupCols().length > 0;
  }

  private groupPanelHeight(): number {
    return this.groupPanelVisible() ? this.theme.headerHeight + 4 : 0;
  }

  private pivotPanelVisible(): boolean {
    if (!this.pivotPanel || !this.cols.pivotMode) return false;
    if (this.options.pivotPanelShow === 'always') return true;
    return this.cols.pivotColumns().length > 0;
  }

  private pivotPanelHeight(): number {
    return this.pivotPanelVisible() ? this.theme.headerHeight + 4 : 0;
  }

  /**
   * Y offset of the header canvas — the drop panels sit above it. When both
   * the row-group and pivot panels are visible AG places them side by side
   * on a single row (half width each), not stacked.
   */
  private headerTop(): number {
    const g = this.groupPanelHeight();
    const p = this.pivotPanelHeight();
    return g > 0 && p > 0 ? Math.max(g, p) : g + p;
  }

  /** Effective header row heights: options override theme; autoHeaderHeight grows the column row. */
  private applyHeaderHeights(): void {
    const base = this.options.headerHeight ?? this.theme.headerHeight;
    const column = Math.max(base, this.measureAutoHeaderHeight(base));
    const group = this.options.groupHeaderHeight ?? base;
    this.cols.setHeaderHeights(column, group);
  }

  /** Tallest wrapped header label among `autoHeaderHeight` columns (AG parity). */
  private measureAutoHeaderHeight(base: number): number {
    const t = this.theme;
    let max = base;
    let font: string | null = null;
    for (const col of this.cols.displayed()) {
      if (col.def.autoHeaderHeight !== true || !col.def.wrapHeaderText) continue;
      if (!font) font = `500 ${t.headerFontSize}px ${t.fontSans}`;
      const label = this.headerLabel(col);
      if (!label) continue;
      const lineH = Math.round(t.headerFontSize * 1.45);
      const avail = Math.max(8, col.width - t.paddingX * 2);
      const lines = wrapLines(this.ctxB, font, label, avail).length;
      if (lines > 1) max = Math.max(max, base + (lines - 1) * lineH);
    }
    return max;
  }

  /**
   * Re-check header heights after column geometry changes (resize, autosize,
   * visibility); runs a full layout only when the header actually grows/shrinks.
   */
  private syncHeaderGeometry(): void {
    const before = this.cols.totalHeaderHeight;
    this.applyHeaderHeights();
    if (this.cols.totalHeaderHeight !== before) this.layout();
  }

  private statusBarHeight(): number {
    return this.statusBar ? Math.max(24, this.theme.rowHeight) : 0;
  }

  /** Height of the pinned-top band (rows + 1px separator). */
  private pinnedTopHeight(): number {
    const n = this.options.pinnedTopRowData?.length ?? 0;
    return n > 0 ? n * this.uniformRowHeight() + 1 : 0;
  }

  /** Height of the pinned-bottom band (rows + 1px separator). */
  private pinnedBottomHeight(): number {
    const n = this.options.pinnedBottomRowData?.length ?? 0;
    return n > 0 ? n * this.uniformRowHeight() + 1 : 0;
  }

  private paginationPanelHeight(): number {
    if (this.paginationPanels().length === 0) return 0;
    return this.paginationPanel && !this.options.suppressPaginationPanel
      ? Math.max(28, this.theme.rowHeight)
      : 0;
  }

  private paginationPanels(): PaginationPanel[] {
    if (this.options.paginationPanels) return this.options.paginationPanels;
    return ['pageSize', 'rowSummary', 'pageSummary'];
  }

  private paginationActive(): boolean {
    return this.options.pagination === true;
  }

  private paginateChildRowsActive(): boolean {
    return this.options.paginateChildRows === true;
  }

  private updateAutoPageSize(): void {
    if (!this.options.paginationAutoPageSize) return;
    const rh = this.uniformRowHeight();
    const h = Math.max(1, this.scroller.clientHeight);
    const next = Math.max(1, Math.floor(h / rh));
    if (next !== this.autoPageSizeValue) {
      this.autoPageSizeValue = next;
      this.clampCurrentPage();
    }
  }

  private effectivePageSize(): number {
    if (this.options.paginationAutoPageSize) return this.autoPageSizeValue;
    return this.options.paginationPageSize ?? 100;
  }

  /** Top-level pagination segments when `paginateChildRows` is false. */
  private pageableSegmentBounds(): { start: number; end: number }[] {
    const nodes = this.rows.displayedNodes;
    if (this.paginateChildRowsActive() || nodes.length === 0) {
      return nodes.map((_, i) => ({ start: i, end: i + 1 }));
    }
    const segments: { start: number; end: number }[] = [];
    let i = 0;
    while (i < nodes.length) {
      const start = i;
      const baseLevel = nodes[i].level;
      i++;
      while (i < nodes.length && nodes[i].level > baseLevel) i++;
      segments.push({ start, end: i });
    }
    return segments;
  }

  private pageableRowCount(): number {
    return this.paginateChildRowsActive()
      ? this.rows.displayed.length
      : this.pageableSegmentBounds().length;
  }

  private pageRowStart(): number {
    if (!this.paginationActive()) return 0;
    const segments = this.pageableSegmentBounds();
    const pageSize = this.effectivePageSize();
    const seg = this.currentPage * pageSize;
    return seg < segments.length ? segments[seg].start : this.rows.displayed.length;
  }

  private pageRowEnd(): number {
    if (!this.paginationActive()) return this.rows.displayed.length;
    const segments = this.pageableSegmentBounds();
    const pageSize = this.effectivePageSize();
    const segEnd = Math.min(segments.length, (this.currentPage + 1) * pageSize);
    return segEnd > 0 ? segments[segEnd - 1].end : 0;
  }

  private totalPages(): number {
    if (!this.paginationActive()) return 1;
    return Math.max(1, Math.ceil(this.pageableRowCount() / this.effectivePageSize()));
  }

  private formatPaginationNumber(value: number): string {
    const fmt = this.options.paginationNumberFormatter;
    return fmt ? fmt({ value, api: this }) : value.toLocaleString();
  }

  private clampCurrentPage(): void {
    const max = this.totalPages() - 1;
    if (this.currentPage > max) this.currentPage = Math.max(0, max);
  }

  private selectionColumnMode(): 'none' | 'single' | 'multiple' {
    return this.checkboxesEnabled() ? (this.rowSelectionMode() ?? 'none') : 'none';
  }

  private checkboxesEnabled(): boolean {
    const mode = this.rowSelectionMode();
    if (mode !== 'multiple') return false;
    const rs = this.options.rowSelection;
    if (typeof rs === 'object' && rs !== null && rs.checkboxes === false) return false;
    return true;
  }

  private headerCheckboxEnabled(): boolean {
    if (!this.checkboxesEnabled()) return false;
    const rs = this.options.rowSelection;
    if (typeof rs === 'object' && rs !== null && rs.headerCheckbox === false) return false;
    return true;
  }

  private selectableLeafIds(): string[] {
    const leaves = this.rows.displayedNodes
      .filter((n) => !n.group && !n.footer && !n.detail && n.data != null)
      .map((n) => n.id);
    if (leaves.length) return leaves;
    // Pivot mode suppresses leaf rows — group rows are the selectable rows.
    return this.rows.displayedNodes.filter((n) => n.group && !n.footer).map((n) => n.id);
  }

  private selectionCheckboxState(): { all: boolean; some: boolean } {
    const ids = this.selectableLeafIds();
    if (!ids.length) return { all: false, some: false };
    let hit = 0;
    for (const id of ids) if (this.selectedIds.has(id)) hit++;
    return { all: hit === ids.length, some: hit > 0 };
  }

  private layout(): void {
    if (this.destroyed) return;
    const rect = this.root.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const inset = this.sideBarCtrl?.inset() ?? { left: 0, right: 0 };
    const contentWidth = Math.max(0, rect.width - inset.left - inset.right);
    const applyInset = (el: HTMLElement | null): void => {
      if (!el) return;
      el.style.left = `${inset.left}px`;
      el.style.right = `${inset.right}px`;
    };
    applyInset(this.headerCanvas);
    applyInset(this.scroller);
    applyInset(this.bodyCanvas);
    applyInset(this.overlayCanvas);
    applyInset(this.groupPanel);
    applyInset(this.pivotPanel);
    applyInset(this.statusBar);
    applyInset(this.paginationPanel);
    applyInset(this.overlayEl);
    this.sideBarCtrl?.layout(rect.height);
    this.applyHeaderHeights();
    this.cols.setFloatingFilterOptions(
      this.options.floatingFilter === true,
      this.options.floatingFiltersHeight ?? this.theme.floatingFilterHeight,
    );
    const headerH = this.headerHeight();

    this.root.style.background = this.theme.base;
    this.scroller.style.colorScheme = this.theme.name;
    this.root.style.setProperty('--tabular-scrollbar-thumb', withAlpha(this.theme.textSecondary, 0.35));
    this.root.style.setProperty('--tabular-scrollbar-thumb-hover', withAlpha(this.theme.textSecondary, 0.6));

    const groupPanelH = this.groupPanelHeight();
    const pivotPanelH = this.pivotPanelHeight();
    // AG shows both drop panels side by side (half width each) on one row.
    const sideBySide = groupPanelH > 0 && pivotPanelH > 0;
    const panelsH = sideBySide ? Math.max(groupPanelH, pivotPanelH) : groupPanelH + pivotPanelH;
    if (this.groupPanel) {
      const t = this.theme;
      Object.assign(this.groupPanel.style, {
        display: groupPanelH > 0 ? 'flex' : 'none',
        top: '0',
        left: `${inset.left}px`,
        right: sideBySide ? 'auto' : `${inset.right}px`,
        width: sideBySide ? `${contentWidth / 2}px` : 'auto',
        height: `${panelsH}px`,
        padding: `0 ${t.paddingX + 2}px`,
        background: t.headerBg,
        borderBottom: `1px solid ${t.hairline}`,
        borderRight: sideBySide ? `1px solid ${t.hairline}` : 'none',
        font: `${t.fontSize}px ${t.fontSans}`,
        color: t.textSecondary,
      } satisfies Partial<CSSStyleDeclaration>);
    }
    if (this.pivotPanel) {
      const t = this.theme;
      Object.assign(this.pivotPanel.style, {
        display: pivotPanelH > 0 ? 'flex' : 'none',
        top: sideBySide ? '0' : `${groupPanelH}px`,
        left: sideBySide ? `${inset.left + contentWidth / 2}px` : `${inset.left}px`,
        right: `${inset.right}px`,
        height: `${panelsH}px`,
        padding: `0 ${t.paddingX + 2}px`,
        background: t.headerBg,
        borderBottom: `1px solid ${t.hairline}`,
        font: `${t.fontSize}px ${t.fontSans}`,
        color: t.textSecondary,
      } satisfies Partial<CSSStyleDeclaration>);
    }
    this.headerCanvas.style.top = `${panelsH}px`;
    if (this.ffClearLayer) this.ffClearLayer.style.top = `${panelsH}px`;
    const pinnedTopH = this.pinnedTopHeight();
    const pinnedBottomH = this.pinnedBottomHeight();
    this.pinnedTopCanvas.style.display = pinnedTopH > 0 ? 'block' : 'none';
    this.pinnedBottomCanvas.style.display = pinnedBottomH > 0 ? 'block' : 'none';
    this.pinnedTopCanvas.style.top = `${panelsH + headerH}px`;
    applyInset(this.pinnedTopCanvas);
    applyInset(this.pinnedBottomCanvas);
    this.scroller.style.top = `${panelsH + headerH + pinnedTopH}px`;
    this.bodyCanvas.style.top = `${panelsH + headerH + pinnedTopH}px`;
    this.overlayCanvas.style.top = `${panelsH + headerH + pinnedTopH}px`;

    const statusH = this.statusBarHeight();
    const paginationH = this.paginationPanelHeight();
    this.pinnedBottomCanvas.style.bottom = `${statusH + paginationH}px`;
    this.scroller.style.bottom = `${statusH + paginationH + pinnedBottomH}px`;
    if (this.paginationPanel) {
      const t = this.theme;
      Object.assign(this.paginationPanel.style, {
        display: paginationH > 0 ? 'flex' : 'none',
        height: `${paginationH}px`,
        bottom: `${statusH}px`,
        padding: `0 ${t.paddingX + 2}px`,
        background: t.headerBg,
        borderTop: `1px solid ${t.structural}`,
        font: `${t.fontSize - 1}px ${t.fontSans}`,
        color: t.textSecondary,
      } satisfies Partial<CSSStyleDeclaration>);
      this.renderPaginationPanel();
    }
    if (this.statusBar) {
      const t = this.theme;
      Object.assign(this.statusBar.style, {
        height: `${statusH}px`,
        padding: `0 ${t.paddingX + 2}px`,
        background: t.headerBg,
        borderTop: `1px solid ${t.structural}`,
        font: `${t.fontSize - 1}px ${t.fontSans}`,
        color: t.textSecondary,
      } satisfies Partial<CSSStyleDeclaration>);
      this.updateStatusBar();
    }
    if (this.overlayEl) {
      this.overlayEl.style.top = `${panelsH + headerH}px`;
      this.overlayEl.style.bottom = `${statusH + paginationH}px`;
      this.overlayEl.style.font = `${this.theme.fontSize}px ${this.theme.fontSans}`;
    }
    if (this.detailLayer) {
      this.detailLayer.style.top = `${panelsH + headerH}px`;
      this.detailLayer.style.bottom = `${statusH + paginationH}px`;
    }

    this.cols.setViewportWidth(contentWidth);
    this.updateSpacer();
    // Classic scrollbars consume layout space; re-run flex sizing against the
    // true client area so flex columns don't overflow into the gutter.
    if (this.scroller.clientWidth !== contentWidth) {
      this.cols.setViewportWidth(this.scroller.clientWidth);
      this.updateSpacer();
    }

    this.viewWidth = this.scroller.clientWidth;
    this.viewHeight = this.scroller.clientHeight;
    if (this.paginationActive()) this.updateAutoPageSize();
    this.dpr = window.devicePixelRatio || 1;

    sizeCanvas(this.headerCanvas, contentWidth, headerH, this.dpr);
    sizeCanvas(this.bodyCanvas, this.viewWidth, this.viewHeight, this.dpr);
    sizeCanvas(this.overlayCanvas, this.viewWidth, this.viewHeight, this.dpr);
    if (pinnedTopH > 0) sizeCanvas(this.pinnedTopCanvas, this.viewWidth, pinnedTopH, this.dpr);
    if (pinnedBottomH > 0) sizeCanvas(this.pinnedBottomCanvas, this.viewWidth, pinnedBottomH, this.dpr);

    this.requestPaint();
  }

  /**
   * Browsers cap element heights (~16.7M px in Chrome), so a tall enough row
   * set cannot drive native scroll 1:1. Above the cap the spacer is clamped
   * and DOM scrollTop is scaled by `scrollRatio` (logical px per DOM px),
   * AG's row-container stretching. 1 for every grid under the cap.
   */
  private static readonly MAX_SPACER_HEIGHT = 15_000_000;
  private scrollRatio = 1;

  private updateSpacer(): void {
    this.invalidateRowHeights();
    this.spacer.style.width = `${Math.max(this.cols.totalWidth, 1)}px`;
    const contentH = Math.max(this.pageContentHeight(), 1);
    const domH = Math.min(contentH, Tabular.MAX_SPACER_HEIGHT);
    this.spacer.style.height = `${domH}px`;
    const viewH = this.scroller.clientHeight;
    this.scrollRatio =
      contentH > domH && domH > viewH ? (contentH - viewH) / (domH - viewH) : 1;
  }

  /** DOM scroller position → logical content offset. */
  private logicalScrollTop(): number {
    return this.scroller.scrollTop * this.scrollRatio;
  }

  /** Scroll so the logical content offset `top` is at the viewport top. */
  private setLogicalScrollTop(top: number): void {
    this.scroller.scrollTop = top / this.scrollRatio;
  }

  /** Scroll the content by `dy` logical pixels. */
  private scrollContentBy(dy: number): void {
    this.scroller.scrollTop += dy / this.scrollRatio;
  }

  // ── row heights (uniform fast path / getRowHeight / autoHeight) ────

  /** Data-row height when no per-row height applies. */
  private uniformRowHeight(): number {
    const h = this.options.rowHeight;
    return typeof h === 'number' && h > 0 ? h : this.theme.rowHeight;
  }

  private variableRowHeightsActive(): boolean {
    if (this.options.getRowHeight) return true;
    if (this.options.masterDetail === true) return true;
    return this.cols.displayed().some((c) => c.def.autoHeight === true);
  }

  private invalidateRowHeights(): void {
    this.rowOffsetsDirty = true;
  }

  /** Lazily (re)build the prefix-sum offsets over all displayed rows. */
  private ensureRowOffsets(): void {
    if (!this.rowOffsetsDirty) return;
    this.rowOffsetsDirty = false;
    if (!this.variableRowHeightsActive()) {
      this.rowOffsets = null;
      return;
    }
    const n = this.rows.displayed.length;
    const offs = new Float64Array(n + 1);
    const autoCols = this.cols.displayed().filter((c) => c.def.autoHeight === true);
    const lineH = wrapLineHeight(this.theme);
    let acc = 0;
    for (let r = 0; r < n; r++) {
      offs[r] = acc;
      acc += this.computeRowHeight(r, autoCols, lineH);
    }
    offs[n] = acc;
    this.rowOffsets = offs;
  }

  private computeRowHeight(r: number, autoCols: InternalColumn<TData>[], lineH: number): number {
    const uniform = this.uniformRowHeight();
    const node = this.rows.getDisplayedNode(r);
    if (!node) return uniform;
    if (node.detail) return this.detailRowHeightFor(node.id);
    if (this.options.getRowHeight) {
      const h = this.options.getRowHeight({
        data: (node.data ?? undefined) as TData,
        node: { data: node.data, group: node.group, footer: node.footer, level: node.level, key: node.key },
        api: this,
        context: this.options.context,
      });
      if (typeof h === 'number' && h > 0) return Math.ceil(h);
    }
    if (autoCols.length === 0 || node.group || node.footer) return uniform;
    const t = this.theme;
    let maxLines = 1;
    for (const col of autoCols) {
      const text = this.formatDisplayed(r, col);
      if (!text) continue;
      if (!col.def.wrapText) continue; // single line ⇒ uniform already fits
      const value = this.valueAtDisplayed(r, col);
      const isNumber = col.def.type === 'number' || typeof value === 'number';
      const font = `500 ${t.fontSize}px ${isNumber ? t.fontMono : t.fontSans}`;
      const lines = wrapLines(this.ctxB, font, text, Math.max(4, col.width - t.paddingX * 2)).length;
      if (lines > maxLines) maxLines = lines;
    }
    // One line measures exactly `uniform`; each extra wrapped line adds lineH.
    return uniform + (maxLines - 1) * lineH;
  }

  /** Content offset of a displayed row from displayed row 0 (absolute). */
  private rowTopAbs(rowIndex: number): number {
    this.ensureRowOffsets();
    const n = this.rows.displayed.length;
    const r = Math.max(0, Math.min(rowIndex, n));
    return this.rowOffsets ? this.rowOffsets[r] : r * this.uniformRowHeight();
  }

  /** Content offset of a displayed row from the top of the current page. */
  private pageRowTop = (rowIndex: number): number => {
    return this.rowTopAbs(rowIndex) - this.rowTopAbs(this.pageRowStart());
  };

  private rowHeightAt = (rowIndex: number): number => {
    this.ensureRowOffsets();
    if (!this.rowOffsets) return this.uniformRowHeight();
    const n = this.rows.displayed.length;
    if (rowIndex < 0 || rowIndex >= n) return this.uniformRowHeight();
    return this.rowOffsets[rowIndex + 1] - this.rowOffsets[rowIndex];
  };

  /** Displayed row index at a page-local content Y (clamped to the page). */
  private rowAtLocalY = (localY: number): number => {
    const pageStart = this.pageRowStart();
    const pageEnd = this.pageRowEnd();
    this.ensureRowOffsets();
    if (!this.rowOffsets) {
      const r = pageStart + Math.floor(localY / this.uniformRowHeight());
      return Math.max(pageStart, Math.min(r, pageEnd - 1));
    }
    const y = this.rowOffsets[pageStart] + localY;
    let lo = pageStart;
    let hi = Math.max(pageStart, pageEnd - 1);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.rowOffsets[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  /** Total content height of the current page. */
  private pageContentHeight(): number {
    return this.rowTopAbs(this.pageRowEnd()) - this.rowTopAbs(this.pageRowStart());
  }

  private isFullWidthRowAt = (rowIndex: number): boolean => {
    const fn = this.options.isFullWidthRow;
    if (!fn) return false;
    const node = this.rows.getDisplayedNode(rowIndex);
    if (!node) return false;
    return fn({
      rowNode: { data: node.data, group: node.group, footer: node.footer, level: node.level, key: node.key },
      api: this,
    });
  };

  // ── master / detail (§4.15) ────────────────────────────────────────

  /** AG quartz `.ag-details-row` padding (~22.5px at spacing 6). */
  private static readonly DETAIL_PADDING = 22;
  private static readonly DETAIL_DEFAULT_HEIGHT = 300;
  /** AG parity: auto-height detail grids keep a minimum rows-viewport height. */
  private static readonly DETAIL_MIN_BODY = 150;
  /** Pre-mount margin: detail rows this close to the viewport get mounted. */
  private static readonly DETAIL_MOUNT_MARGIN = 200;

  private detailRowHeightFor(detailId: string): number {
    const masterId = detailId.startsWith('detail_') ? detailId.slice(7) : detailId;
    return (
      this.detailHeights.get(masterId) ??
      this.options.detailRowHeight ??
      Tabular.DETAIL_DEFAULT_HEIGHT
    );
  }

  private toggleMasterExpanded(rowId: string): void {
    const expanded = this.rows.masterExpanded.get(rowId) !== true;
    this.rows.setMasterExpanded(rowId, expanded);
    if (!expanded) this.releaseDetailInstance(rowId);
    this.refreshModel();
    this.emit('rowGroupOpened', { rowId, expanded, data: this.rows.getRowById(rowId) });
  }

  /** Collapse: destroy the instance, or park it in the keep-alive LRU. */
  private releaseDetailInstance(masterId: string): void {
    const inst = this.detailInstances.get(masterId);
    if (!inst) return;
    if (this.options.keepDetailRows === true) {
      inst.el.style.display = 'none';
      const i = this.detailKeepOrder.indexOf(masterId);
      if (i >= 0) this.detailKeepOrder.splice(i, 1);
      this.detailKeepOrder.push(masterId);
      const max = this.options.keepDetailRowsCount ?? 10;
      while (this.detailKeepOrder.length > max) {
        this.destroyDetailInstance(this.detailKeepOrder.shift()!);
      }
      return;
    }
    this.destroyDetailInstance(masterId);
  }

  private destroyDetailInstance(masterId: string): void {
    const inst = this.detailInstances.get(masterId);
    if (!inst) return;
    this.detailInstances.delete(masterId);
    this.detailGridInfoStore.delete(`detail_${masterId}`);
    const i = this.detailKeepOrder.indexOf(masterId);
    if (i >= 0) this.detailKeepOrder.splice(i, 1);
    inst.grid?.destroy();
    inst.el.remove();
  }

  /**
   * Per-frame lockstep: position mounted detail rows over their punched-out
   * canvas rects; lazily mount those scrolled near the viewport.
   */
  private syncDetailLayer(): void {
    if (!this.detailLayer) return;
    for (const [id, expanded] of this.rows.masterExpanded) {
      const inst = this.detailInstances.get(id);
      if (!expanded) continue; // collapse handled in toggle; kept rows stay hidden
      const idx = this.rows.displayedIndexOf(`detail_${id}`);
      if (idx < 0) {
        // Master filtered out or on another page.
        if (inst) inst.el.style.display = 'none';
        continue;
      }
      const top = this.pageRowTop(idx) - this.scrollTop;
      const h = this.rowHeightAt(idx);
      const margin = Tabular.DETAIL_MOUNT_MARGIN;
      if (top + h < -margin || top > this.viewHeight + margin) {
        if (inst) inst.el.style.display = 'none';
        continue;
      }
      const live = inst ?? this.mountDetailInstance(id);
      if (!live) continue;
      const k = this.detailKeepOrder.indexOf(id);
      if (k >= 0) this.detailKeepOrder.splice(k, 1); // visible again — un-park
      live.el.style.display = '';
      live.el.style.top = `${top}px`;
      live.el.style.width = `${this.viewWidth}px`;
      live.el.style.height = `${h}px`;
    }
  }

  private mountDetailInstance(masterId: string): DetailInstance | null {
    if (!this.detailLayer) return null;
    const data = this.rows.getRowById(masterId);
    if (data === undefined) return null;
    const t = this.theme;
    const el = document.createElement('div');
    el.className = 'tabular-detail-row';
    Object.assign(el.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      boxSizing: 'border-box',
      padding: `${Tabular.DETAIL_PADDING}px`,
      background: t.raised,
      borderBottom: `1px solid ${t.structural}`,
      overflow: 'hidden',
      pointerEvents: 'auto',
    } satisfies Partial<CSSStyleDeclaration>);
    this.detailLayer.appendChild(el);
    const node = { id: masterId, data: data as TData | null, expanded: true };
    const inst: DetailInstance = { masterId, el, grid: null, measuredHeight: null };
    this.detailInstances.set(masterId, inst);

    // Custom detail renderer: arbitrary DOM in the punched-out rect.
    if (this.options.detailCellRenderer) {
      const content = this.options.detailCellRenderer({ data, node, api: this, pinned: null });
      if (content) el.appendChild(content);
      this.scheduleDetailAutoHeight(masterId);
      return inst;
    }

    // Default: a nested Tabular grid configured by detailCellRendererParams.
    const paramsOpt = this.options.detailCellRendererParams;
    const params: DetailCellRendererParams<TData> | undefined =
      typeof paramsOpt === 'function'
        ? paramsOpt({ data, node, api: this, pinned: null })
        : paramsOpt;

    const inner = document.createElement('div');
    // AG draws a wrapper border around the nested detail grid.
    Object.assign(inner.style, {
      width: '100%',
      height: '100%',
      boxSizing: 'border-box',
      border: `1px solid ${t.structural}`,
      borderRadius: '2px',
      overflow: 'hidden',
    } satisfies Partial<CSSStyleDeclaration>);
    el.appendChild(inner);

    const detailOpts = {
      theme: this.options.theme,
      density: this.options.density,
      ...(params?.detailGridOptions ?? { columnDefs: [] }),
    } as GridOptions<unknown>;
    const grid = new Tabular<unknown>(inner, detailOpts);
    inst.grid = grid;
    this.detailGridInfoStore.set(`detail_${masterId}`, { id: `detail_${masterId}`, api: grid });

    if (params?.getDetailRowData) {
      let resolved = false;
      params.getDetailRowData({
        node,
        data,
        successCallback: (rows) => {
          resolved = true;
          grid.setRowData(rows as unknown[]);
          grid.hideOverlay();
          this.scheduleDetailAutoHeight(masterId);
        },
      });
      // Async load: skeleton until successCallback resolves (AG parity).
      if (!resolved && !detailOpts.rowData) grid.showLoadingOverlay();
    }
    this.scheduleDetailAutoHeight(masterId);
    return inst;
  }

  /** Two-phase `detailRowAutoHeight`: mount → measure → write height → repaint. */
  private scheduleDetailAutoHeight(masterId: string): void {
    if (this.options.detailRowAutoHeight !== true) return;
    requestAnimationFrame(() => {
      if (this.destroyed) return;
      const inst = this.detailInstances.get(masterId);
      if (!inst) return;
      const pad = Tabular.DETAIL_PADDING * 2;
      let h: number | null = null;
      if (inst.grid) {
        const g = inst.grid;
        // AG parity: the auto-height detail grid keeps a min rows viewport.
        const body = Math.max(g.pageContentHeight(), Tabular.DETAIL_MIN_BODY);
        h =
          pad +
          g.headerTop() +
          g.headerHeight() +
          body +
          g.statusBarHeight() +
          g.paginationPanelHeight() +
          1;
      } else {
        const content = inst.el.firstElementChild as HTMLElement | null;
        if (content) h = pad + content.offsetHeight;
      }
      if (h == null) return;
      h = Math.ceil(h);
      // Epsilon guard against measure/layout feedback loops.
      if (inst.measuredHeight != null && Math.abs(inst.measuredHeight - h) <= 1) return;
      inst.measuredHeight = h;
      this.detailHeights.set(masterId, h);
      this.invalidateRowHeights();
      this.updateSpacer();
      this.requestPaint();
    });
  }

  private env(): PaintEnv<TData> {
    const selectionState = this.selectionCheckboxState();
    return {
      theme: this.theme,
      cols: this.cols,
      rows: this.rows,
      flash: this.flashMgr,
      scrollLeft: this.scrollLeft,
      scrollTop: this.scrollTop,
      viewWidth: this.viewWidth,
      viewHeight: this.viewHeight,
      focused: this.focused,
      selectedIds: this.selectedIds,
      filteredColIds: new Set(Object.keys(this.rows.filterModel)),
      api: this,
      valueOf: this.valueOf,
      formatValue: this.formatValue,
      valueAtDisplayed: this.valueAtDisplayed,
      formatDisplayed: this.formatDisplayed,
      enableFlash: this.options.enableCellFlash !== false,
      enableCellSpan: this.options.enableCellSpan === true,
      uniformRowHeight: this.uniformRowHeight(),
      rowTop: this.pageRowTop,
      rowHeightAt: this.rowHeightAt,
      rowAtY: this.rowAtLocalY,
      contentHeight: this.pageContentHeight(),
      isFullWidthRow: this.options.isFullWidthRow ? this.isFullWidthRowAt : undefined,
      fullWidthCellRenderer: this.options.fullWidthCellRenderer,
      range: this.range,
      fillHandle: this.fillHandleOpts() !== null,
      fillPreview: this.fillDrag?.preview ?? null,
      editingFloatingFilterColId: this.floatingFilter?.colId ?? null,
      groupIndent: this.options.groupIndent ?? 16,
      headerLabel: this.headerLabel,
      classStyles: this.options.classStyles,
      rowStyle: this.options.rowStyle,
      getRowStyle: this.options.getRowStyle,
      rowClass: this.options.rowClass,
      getRowClass: this.options.getRowClass,
      rowClassRules: this.options.rowClassRules,
      context: this.options.context,
      pagination: this.paginationActive()
        ? { pageStart: this.pageRowStart(), pageEnd: this.pageRowEnd() }
        : undefined,
      groupSticky: this.options.groupSticky !== false,
      headerCheckbox: this.headerCheckboxEnabled(),
      selectionAllSelected: selectionState.all,
      selectionSomeSelected: selectionState.some,
      rendererFor: this.rendererFor,
      cellStyleChain: this.styleChain,
      ruleIndicator: this.rulesAttach
        ? (rowId, colId) => this.rulesAttach!.engine.getIndicator(rowId, colId)
        : undefined,
    };
  }

  /**
   * Header caption. While grouping / tree data is active, value columns show
   * their agg func — `sum(Notional)` — unless `suppressAggFuncInHeader` (AG
   * parity).
   */
  private displayHeaderBase(raw: string): string {
    // AG Grid humanizes simple field ids when no headerName is set:
    // gold → Gold, callId → Call Id (camelCaseToHumanText).
    if (/^[a-z][a-zA-Z0-9]*$/.test(raw)) {
      return raw
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(' ')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    }
    return raw;
  }

  private headerLabel = (col: InternalColumn<TData>): string => {
    const base = this.displayHeaderBase(col.def.headerName ?? col.def.field ?? col.colId);
    if (this.options.suppressAggFuncInHeader === true) return base;
    const agg = col.def.aggFunc;
    if (typeof agg !== 'string' || col.colId === 'ag-Grid-AutoColumn') return base;
    const grouped = this.options.treeData === true || this.cols.rowGroupColumns().length > 0;
    return grouped ? `${agg}(${base})` : base;
  };

  requestPaint(): void {
    if (this.paintPending || this.destroyed) return;
    this.scheduleViewportPrefetch();
    this.paintPending = true;
    this.rafId = requestAnimationFrame(() => {
      this.paintPending = false;
      this.paint();
    });
  }

  private paint(): void {
    if (this.destroyed || this.viewWidth === 0) return;
    const env = this.env();
    this.ctxH.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctxB.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    paintHeader(this.ctxH, env);
    paintBody(this.ctxB, env);
    this.syncFloatingFilterClearButtons(env);
    this.ctxO.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    paintOverlay(this.ctxO, env);
    const pinnedTop = this.options.pinnedTopRowData;
    if (pinnedTop?.length) {
      this.ctxPT.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      paintPinnedRows(this.ctxPT, env, pinnedTop, 'top');
    }
    const pinnedBottom = this.options.pinnedBottomRowData;
    if (pinnedBottom?.length) {
      this.ctxPB.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      paintPinnedRows(this.ctxPB, env, pinnedBottom, 'bottom');
    }
    this.syncDetailLayer();
    if (!this.firstPaintDone && this.rows.displayed.length) {
      this.firstPaintDone = true;
      this.emit('firstDataRendered', { api: this });
    }
    // Flash decay is a pure function of time — keep repainting while active.
    const now = performance.now();
    if (this.flashMgr.hasActive(now) || this.rulesAttach?.engine.hasTimedRules(now)) {
      this.requestPaint();
    }
  }

  private rulesHost(): import('./rulesBridge').RulesHost<TData> {
    return {
      addCellStyleResolver: (fn, priority) =>
        this.addCellStyleResolver(
          (params, style) =>
            fn({ colId: params.colId, data: params.data, rowId: params.rowId }, style),
          priority,
        ),
      onTransactionApplied: (handler) => this.onTransactionApplied(handler),
      onModelUpdated: (handler) => this.on('modelUpdated', handler),
      registerStateModule: (module) => this.registerStateModule(module),
      getColIdForField: (field) => {
        const col = this.cols.all.find((c) => c.def.field === field);
        return col?.colId;
      },
      getFieldForColId: (colId) => this.cols.getColumn(colId)?.def.field,
      forEachDisplayedRow: (fn) => {
        for (const node of this.rows.displayedNodes) {
          if (node.group || node.footer || !node.data) continue;
          fn(this.rows.getId(node.data), node.data);
        }
      },
      getRowById: (id) => this.rows.getRowById(id),
      getRowId: (data) => this.rows.getId(data),
      ruleFlash: (key, opts) => this.flashMgr.ruleFlash(key, opts),
      requestPaint: () => this.requestPaint(),
      isWorkerRulesActive: () => this.workerCoord.dataPlaneActive && !!this.options.rules,
    };
  }

  private onScroll(): void {
    this.scrollLeft = this.scroller.scrollLeft;
    this.scrollTop = this.logicalScrollTop();
    if (this.editor) this.commitEdit();
    this.closeFloatingFilter();
    this.closeSetFilter();
    this.closeContextMenu();
    this.hideTooltip();
    this.requestPaint();
  }

  /**
   * Trackpad / wheel: lock to one axis per gesture. The first axis to exceed a
   * small movement threshold wins; the other axis is suppressed until idle.
   */
  private onWheel(e: WheelEvent): void {
    if (this.destroyed) return;
    // Gestures inside a mounted detail row belong to the nested content while
    // it can still scroll in that direction; once it hits its edge the outer
    // grid takes over (scroll chaining, AG parity — the detail layer is not
    // inside our scroller, so the browser can't chain natively).
    if (this.detailLayer && e.target instanceof Node && this.detailLayer.contains(e.target)) {
      if (detailCanConsumeWheel(e, this.detailLayer)) return;
    }

    const scrollX = this.canScrollX();
    const scrollY = this.canScrollY();
    if (!scrollX && !scrollY) return;

    let dx = e.deltaX;
    let dy = e.deltaY;
    // Shift+wheel (mouse) is horizontal scroll.
    if (e.shiftKey && dx === 0 && dy !== 0) {
      dx = dy;
      dy = 0;
    }

    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (absX === 0 && absY === 0) return;

    if (!scrollX) {
      e.preventDefault();
      this.scrollContentBy(this.wheelDelta(dy, e.deltaMode, this.viewHeight));
      this.scheduleWheelAxisRelease();
      return;
    }
    if (!scrollY) {
      e.preventDefault();
      this.scroller.scrollLeft += this.wheelDelta(dx, e.deltaMode, this.viewWidth);
      this.scheduleWheelAxisRelease();
      return;
    }

    if (!this.wheelAxis) {
      this.wheelAxisAccX += absX;
      this.wheelAxisAccY += absY;
      if (this.wheelAxisAccX >= Tabular.WHEEL_AXIS_THRESHOLD && this.wheelAxisAccX > this.wheelAxisAccY) {
        this.wheelAxis = 'x';
      } else if (this.wheelAxisAccY >= Tabular.WHEEL_AXIS_THRESHOLD && this.wheelAxisAccY > this.wheelAxisAccX) {
        this.wheelAxis = 'y';
      } else {
        // Not locked yet — scroll only the axis that is winning cumulatively.
        e.preventDefault();
        if (this.wheelAxisAccX > this.wheelAxisAccY && dx !== 0) {
          this.scroller.scrollLeft += this.wheelDelta(dx, e.deltaMode, this.viewWidth);
        } else if (dy !== 0) {
          this.scrollContentBy(this.wheelDelta(dy, e.deltaMode, this.viewHeight));
        }
        this.scheduleWheelAxisRelease();
        return;
      }
    }

    e.preventDefault();
    if (this.wheelAxis === 'x') {
      this.scroller.scrollLeft += this.wheelDelta(dx, e.deltaMode, this.viewWidth);
    } else {
      this.scrollContentBy(this.wheelDelta(dy, e.deltaMode, this.viewHeight));
    }
    this.scheduleWheelAxisRelease();
  }

  private canScrollX(): boolean {
    return this.cols.totalWidth > this.viewWidth + 1;
  }

  private canScrollY(): boolean {
    return this.pageContentHeight() > this.viewHeight + 1;
  }

  private wheelDelta(delta: number, mode: number, pageSize: number): number {
    if (mode === WheelEvent.DOM_DELTA_LINE) return delta * this.uniformRowHeight();
    if (mode === WheelEvent.DOM_DELTA_PAGE) return delta * pageSize;
    return delta;
  }

  private scheduleWheelAxisRelease(): void {
    if (this.wheelAxisIdle) clearTimeout(this.wheelAxisIdle);
    this.wheelAxisIdle = setTimeout(() => {
      this.wheelAxisIdle = null;
      this.wheelAxis = null;
      this.wheelAxisAccX = 0;
      this.wheelAxisAccY = 0;
    }, Tabular.WHEEL_AXIS_IDLE_MS);
  }

  // ── model refresh ─────────────────────────────────────────────────

  private refreshModel(repaint = true): void {
    // Column defs may have changed (setColumnDefs, pivot result columns);
    // renderer resolution re-caches lazily on next paint.
    this.columnRendererCache.clear();
    const headerHBefore = this.headerHeight();
    this.rebuildCalcResolver();
    this.rebuildFormatResolver();
    const externalPresent = this.options.isExternalFilterPresent?.() ?? false;
    const groupCols = this.cols.getRowGroupCols();
    const pivotMode = this.cols.pivotMode;
    const treeActive =
      this.options.treeData === true &&
      (this.options.getDataPath != null || this.options.treeDataChildrenField != null);
    const treeOpts = treeActive
      ? {
          getDataPath: this.options.getDataPath,
          childrenField: this.options.treeDataChildrenField,
          keyField: this.options.autoGroupColumnDef?.field,
          aggCols: this.cols.getAggCols(),
          groupDefaultExpanded: this.options.groupDefaultExpanded ?? 0,
          excludeChildrenWhenTreeDataFiltering:
            this.options.excludeChildrenWhenTreeDataFiltering === true,
          customAggFuncs: this.effectiveAggFuncs(),
        }
      : null;
    const groupOpts =
      !treeActive && groupCols.length > 0
        ? {
            groupCols,
            aggCols: this.cols.getAggCols(),
            groupDefaultExpanded: this.options.groupDefaultExpanded ?? 0,
            customAggFuncs: this.effectiveAggFuncs(),
            groupTotalRow: this.options.groupTotalRow,
            groupSuppressBlankHeader: this.options.groupSuppressBlankHeader,
            grandTotalRow: this.options.grandTotalRow,
            suppressLeafRows: pivotMode,
            pivotMode,
            pivotCols: pivotMode ? this.cols.getPivotCols() : undefined,
            valueCols: pivotMode ? this.cols.getValueCols() : undefined,
            processPivotResultColDef: this.options.processPivotResultColDef,
            removePivotHeaderRowWhenSingleValueColumn:
              this.options.removePivotHeaderRowWhenSingleValueColumn,
            columnHeaderHeight: this.theme.headerHeight,
            onPivotColumnsBuilt: (paths: string[][]) => {
              if (!paths.length) {
                this.cols.clearPivotResultColumns();
                return;
              }
              const build = buildPivotResultColumns(
                paths,
                this.cols.getValueCols(),
                this.cols.valueColumns(),
                this.cols.getPivotCols(),
                {
                  processPivotResultColDef: this.options.processPivotResultColDef,
                  removePivotHeaderRowWhenSingleValueColumn:
                    this.options.removePivotHeaderRowWhenSingleValueColumn,
                  pivotDefaultExpanded: this.options.pivotDefaultExpanded,
                  suppressExpandablePivotGroups: this.options.suppressExpandablePivotGroups,
                },
              );
              this.cols.applyPivotResult(build);
              this.emit('columnPivotChanged', { columns: this.getPivotColumns() });
            },
          }
        : null;
    this.rows.masterDetail =
      this.options.masterDetail === true
        ? { isRowMaster: this.options.isRowMaster }
        : null;

    const workerConfig = this.workerDataPlaneConfig();
    const useWorker = this.options.rowDataMode !== 'main' && workerConfig != null;
    const compare = useWorker && this.options.workerCompareMode === true;

    // Only warn when the caller explicitly asked for the worker and we cannot
    // honour it (pivot/tree/callbacks). Default worker-first falls back quietly.
    if (
      this.options.rowDataMode === 'worker' &&
      workerConfig == null &&
      !this.workerCoord.fallbackLogged
    ) {
      this.workerCoord.logIneligibleWarning();
    }

    if (!useWorker || compare) {
      this.rows.refresh(
        this.cols,
        this.valueOf,
        {
          present: externalPresent,
          pass: externalPresent ? this.options.doesExternalFilterPass : undefined,
        },
        groupOpts,
        treeOpts,
      );
    }

    if (compare) {
      this.workerCompareSnapshot = {
        filteredCount: this.rows.filteredCount,
        displayedIds: this.rows.displayedIds.slice(),
      };
    } else {
      this.workerCompareSnapshot = null;
    }

    if (useWorker) {
      const ids: string[] = [];
      const rows: unknown[] = [];
      for (const row of this.rows.sourceRows) {
        ids.push(this.rows.getId(row));
        rows.push(row);
      }
      this.workerCoord.syncDataPlane(workerConfig, ids, rows);
    } else {
      this.afterModelRefresh(repaint, headerHBefore);
    }
  }

  /** Post-model housekeeping shared by main-thread and worker paths. */
  private afterModelRefresh(repaint: boolean, headerHBefore?: number): void {
    const headerBefore = headerHBefore ?? this.headerHeight();
    this.updateSpacer();
    this.clampCurrentPage();
    if (this.paginationActive()) this.scroller.scrollTop = 0;
    const maxTop = Math.max(0, this.pageContentHeight() - this.viewHeight);
    if (this.scrollTop > maxTop) this.setLogicalScrollTop(maxTop);
    const lastRow = this.rows.displayed.length - 1;
    if (this.range && Math.max(this.range.start.rowIndex, this.range.end.rowIndex) > lastRow) {
      this.setRange(null, null);
    }
    if (this.focused && this.focused.rowIndex > lastRow) this.focused = null;
    this.emit('modelUpdated', {
      rowCount: this.rows.rowCount,
      displayedRowCount: this.rows.displayed.length,
    });
    this.syncNoRowsOverlay();
    this.updateStatusBar();
    this.renderPivotPanel();
    this.applyHeaderHeights();
    if (this.headerHeight() !== headerBefore) this.layout();
    else if (repaint) this.requestPaint();
  }

  // ── live aggregation (main-thread fallback) ────────────────────────

  /**
   * Live group / pivot / grand-total aggregates after update-only ticks when
   * the data-plane worker is not handling them. Returns true when a full
   * model refresh ran.
   */
  private reaggregateLiveAfterUpdates(): boolean {
    if (this.workerCoord.dataPlaneActive) return false;
    const groupCols = this.cols.getRowGroupCols();
    if (!groupCols.length) return false;
    const pivotMode = this.cols.pivotMode;
    const hasAgg =
      pivotMode
        ? this.cols.getValueCols().length > 0
        : this.cols.getAggCols().length > 0;
    if (!hasAgg && this.options.grandTotalRow == null) return false;

    const groupOpts: import('./rowModel').GroupRefreshOptions<TData> = {
      groupCols,
      aggCols: this.cols.getAggCols(),
      groupDefaultExpanded: this.options.groupDefaultExpanded ?? 0,
      customAggFuncs: this.effectiveAggFuncs(),
      groupTotalRow: this.options.groupTotalRow,
      groupSuppressBlankHeader: this.options.groupSuppressBlankHeader,
      grandTotalRow: this.options.grandTotalRow,
      suppressLeafRows: pivotMode,
      pivotMode,
      pivotCols: pivotMode ? this.cols.getPivotCols() : undefined,
      valueCols: pivotMode ? this.cols.getValueCols() : undefined,
    };
    const { changes, needsFullRefresh } = this.rows.reaggregateLive(
      groupOpts,
      this.valueOf,
      this.cols,
    );
    if (needsFullRefresh) {
      this.refreshModel();
      return true;
    }
    if (changes.length && this.options.enableCellFlash !== false) {
      for (const c of changes) this.flashCellChange(c);
    }
    if (changes.length) this.updateStatusBar();
    return false;
  }

  // ── worker data plane (Tabular extension) ──────────────────────────

  private workerColumnField(col: InternalColumn<TData>): string | null {
    if (col.def.valueGetter) return null;
    if (col.def.calc && this.calcResolver.has(col.colId)) return workerCalcField(col.colId);
    return col.def.field ?? null;
  }

  /**
   * Worker-eligible pipeline config, or null when the worker path does not
   * apply: forced main, pivot/tree/external-filter active, or an *active*
   * sort/filter/group/agg/calc needs main-thread code (valueGetter,
   * comparator, function aggFunc, PREV/aggregate calc scopes).
   * Displayed columns with JS getters are skipped for the field maps rather
   * than disqualifying the whole plane.
   */
  private workerDataPlaneConfig(): WorkerPipelineConfig | null {
    if (this.options.rowDataMode === 'main') return null;
    if (typeof Worker === 'undefined') return null;
    if (this.options.treeData || this.options.getDataPath || this.options.treeDataChildrenField) {
      return null;
    }
    if (this.options.isExternalFilterPresent?.()) return null;

    const pivotMode = this.cols.pivotMode;

    const dataFields = new Set<string>();
    for (const col of this.cols.all) {
      if (col.def.field && !col.def.valueGetter && !col.def.calc) {
        dataFields.add(col.def.field);
      }
    }
    if (this.calcResolver.calcColIds().length && !this.calcResolver.isWorkerEligible(dataFields)) {
      return null;
    }

    const filterCols: WorkerPipelineConfig['filterCols'] = [];
    const sortCols: WorkerPipelineConfig['sortCols'] = [];
    const fieldByColId = new Map<string, string>();
    for (const col of this.cols.displayed()) {
      const field = this.workerColumnField(col);
      if (!field) continue; // valueGetter / no field — paint may still use main valueOf
      fieldByColId.set(col.colId, field);
      filterCols.push({ colId: col.colId, field });
      if (col.def.comparator) continue; // sortable only via main if this col is sorted
      const t = col.def.type;
      const type =
        t === 'number' || col.def.calc
          ? 'number'
          : t === 'date'
            ? 'date'
            : 'text';
      sortCols.push({ colId: col.colId, field, type });
    }

    // Active filters on non-worker columns require the main-thread path.
    for (const colId of Object.keys(this.rows.filterModel)) {
      if (!fieldByColId.has(colId)) return null;
    }

    // Active sorts on non-worker / custom-comparator columns require main.
    for (const s of this.cols.sortModel()) {
      const col = this.cols.getColumn(s.colId);
      if (!col || !fieldByColId.has(s.colId) || col.def.comparator) return null;
    }

    const groupCols: WorkerPipelineConfig['groupCols'] = [];
    for (const c of this.cols.rowGroupColumns()) {
      const field = this.workerColumnField(c);
      if (!field) return null;
      groupCols.push({ colId: c.colId, field });
    }

    const pivotCols: NonNullable<WorkerPipelineConfig['pivotCols']> = [];
    if (pivotMode) {
      for (const spec of this.cols.getPivotCols()) {
        const col = this.cols.getColumn(spec.colId);
        const field = col ? this.workerColumnField(col) : spec.field;
        if (!field) return null;
        pivotCols.push({ colId: spec.colId, field });
      }
    }

    const buildWorkerAggCol = (
      spec: { colId: string; field?: string; aggFunc: unknown; weightField?: string },
    ): WorkerPipelineConfig['aggCols'][number] | null => {
      const col = this.cols.getColumn(spec.colId);
      if (!spec.field || typeof spec.aggFunc !== 'string' || col?.def.valueGetter) return null;
      if (!WORKER_AGG_FUNCS.has(spec.aggFunc)) return null;
      const field =
        col && col.def.calc && this.calcResolver.has(col.colId)
          ? workerCalcField(col.colId)
          : spec.field;
      return {
        colId: spec.colId,
        field,
        aggFunc: spec.aggFunc as WorkerPipelineConfig['aggCols'][number]['aggFunc'],
        weightField: spec.weightField,
      };
    };

    const valueCols: NonNullable<WorkerPipelineConfig['valueCols']> = [];
    if (pivotMode) {
      for (const spec of this.cols.getValueCols()) {
        const built = buildWorkerAggCol(spec);
        if (!built) return null;
        valueCols.push(built);
      }
    }

    const pivotActive = pivotMode && pivotCols.length > 0 && valueCols.length > 0;

    const aggCols: WorkerPipelineConfig['aggCols'] = [];
    if (!pivotActive) {
      for (const spec of this.cols.getAggCols()) {
        const built = buildWorkerAggCol(spec);
        if (!built) return null;
        aggCols.push(built);
      }
    }

    const groupTotalRow = this.options.groupTotalRow;
    const resolvedGroupTotal =
      typeof groupTotalRow === 'function' ? undefined : groupTotalRow;

    return {
      filterCols,
      sortCols,
      calcCols: this.calcResolver.workerCalcCols(),
      filterModel: this.rows.filterModel,
      quickFilterTerms: tokenizeQuickFilter(this.rows.quickFilter),
      sortModel: this.cols.sortModel(),
      groupCols,
      aggCols,
      groupDefaultExpanded: this.options.groupDefaultExpanded ?? 0,
      expandedState: [...this.rows.groupExpanded.entries()],
      groupTotalRow: resolvedGroupTotal,
      groupSuppressBlankHeader: this.options.groupSuppressBlankHeader,
      grandTotalRow:
        this.options.grandTotalRow === 'top' || this.options.grandTotalRow === 'bottom'
          ? this.options.grandTotalRow
          : undefined,
      suppressLeafRows: pivotMode,
      pivotMode,
      pivotCols: pivotMode ? pivotCols : undefined,
      valueCols: pivotMode ? valueCols : undefined,
    };
  }

  private workerOwnsRowDataActive(): boolean {
    if (!this.workerCoord.dataPlaneActive) return false;
    if (this.options.workerCompareMode === true) return false;
    if (this.options.workerOwnsRowData === false) return false;
    return true;
  }

  private applyWorkerModelFromWorker(output: WorkerModelOutput): void {
    if (this.workerCompareSnapshot) {
      this.compareWorkerOutput(output, this.workerCompareSnapshot);
      this.workerCompareSnapshot = null;
    }
    this.viewportChunk = null;
    if (output.pivotKeyPaths !== undefined) {
      this.applyPivotResultColumnsFromPaths(output.pivotKeyPaths);
    }
    this.rows.applyWorkerModel(output);
    if (this.workerOwnsRowDataActive()) {
      this.rows.dropDataMirror();
    }
    this.afterModelRefresh(true);
  }

  /** Build pivot result columns from worker-discovered key paths. */
  private applyPivotResultColumnsFromPaths(paths: string[][]): void {
    if (!paths.length) {
      this.cols.clearPivotResultColumns();
      return;
    }
    const build = buildPivotResultColumns(
      paths,
      this.cols.getValueCols(),
      this.cols.valueColumns(),
      this.cols.getPivotCols(),
      {
        processPivotResultColDef: this.options.processPivotResultColDef,
        removePivotHeaderRowWhenSingleValueColumn:
          this.options.removePivotHeaderRowWhenSingleValueColumn,
        pivotDefaultExpanded: this.options.pivotDefaultExpanded,
        suppressExpandablePivotGroups: this.options.suppressExpandablePivotGroups,
      },
    );
    this.cols.applyPivotResult(build);
    this.emit('columnPivotChanged', { columns: this.getPivotColumns() });
  }

  private applyWorkerRulesResult(rules: import('@tabular/rules').RulesEvalResult): void {
    if (this.rulesAttach) {
      this.rulesAttach.engine.workerEval = true;
      this.rulesAttach.engine.applyWorkerResults(rules);
    }
  }

  private syncWorkerRulesConfig(client: DataWorkerClient): Promise<void> {
    const rules = this.options.rules;
    if (!rules) {
      if (this.rulesAttach) this.rulesAttach.engine.workerEval = false;
      return client.setRulesConfig(null);
    }
    const fieldToColId: Record<string, string> = {};
    for (const col of this.cols.all) {
      if (col.def.field) fieldToColId[col.def.field] = col.colId;
    }
    if (this.rulesAttach) this.rulesAttach.engine.workerEval = true;
    return client.setRulesConfig({
      style: rules.style,
      alerts: rules.alerts,
      fieldToColId,
    });
  }

  /** Read a leaf cell value from the cached viewport chunk when available. */
  private valueFromViewportChunk(rowIndex: number, col: InternalColumn<TData>): unknown | undefined {
    const chunk = this.viewportChunk;
    if (!chunk || col.def.valueGetter) return undefined;
    const local = rowIndex - chunk.rowStart;
    if (local < 0 || local >= chunk.rowCount) return undefined;
    if (chunk.rowKinds[local] !== 0) return undefined;
    const field =
      col.def.calc && this.calcResolver.has(col.colId)
        ? workerCalcField(col.colId)
        : col.def.field;
    if (!field) return undefined;
    const num = chunk.numericCols[col.colId];
    if (num) {
      const v = num[local];
      return Number.isNaN(v) ? undefined : v;
    }
    const tc = chunk.textCols[col.colId];
    if (tc) {
      const strings = decodeText(tc.offsets, tc.bytes);
      return strings[local];
    }
    return undefined;
  }

  private scheduleViewportPrefetch(): void {
    if (!this.workerCoord.dataPlaneActive || !this.workerCoord.dataClient) return;
    const gen = ++this.viewportPrefetchGen;
    const pageStart = this.pageRowStart();
    const pageEnd = this.pageRowEnd();
    const rowH = this.theme.rowHeight;
    const overscan = Math.max(20, Math.ceil((this.viewHeight / rowH) * 2));
    const rowStart = Math.max(0, pageStart - overscan);
    const rowEnd = Math.min(this.rows.displayed.length, pageEnd + overscan);
    const columns = this.cols
      .displayed()
      .filter((c) => this.workerColumnField(c))
      .map((c) => c.colId);
    if (!columns.length) return;
    void this.workerCoord
      .requestViewport({ rowStart, rowEnd, columns })
      .then((chunk) => {
        if (this.destroyed || gen !== this.viewportPrefetchGen || !chunk) return;
        this.viewportChunk = chunk;
        if (!this.paintPending) this.paint();
      });
  }

  private compareWorkerOutput(
    output: WorkerModelOutput,
    main: { filteredCount: number; displayedIds: string[] },
  ): void {
    const workerIds = output.displayed.map((d) => d.id);
    if (output.filteredCount !== main.filteredCount) {
      console.warn('[tabular worker] filteredCount mismatch', {
        main: main.filteredCount,
        worker: output.filteredCount,
      });
    }
    if (
      workerIds.length !== main.displayedIds.length ||
      workerIds.some((id, i) => id !== main.displayedIds[i])
    ) {
      console.warn('[tabular worker] displayedIds mismatch', {
        mainLen: main.displayedIds.length,
        workerLen: workerIds.length,
      });
    }
  }

  private workerTransactionPayload(tx: RowDataTransaction<TData>): AggTransactionPayload {
    const payload: AggTransactionPayload = {};
    if (tx.add?.length) {
      payload.addIds = tx.add.map((r) => this.rows.getId(r));
      payload.add = tx.add as unknown[];
    }
    if (tx.update?.length) {
      payload.updateIds = tx.update.map((r) => this.rows.getId(r));
      payload.update = tx.update as unknown[];
    }
    if (tx.remove?.length) {
      payload.removeIds = tx.remove.map((r) => this.rows.getId(r));
    }
    return payload;
  }

  private capturePrevFromChanges(changes: readonly CellChange[]): void {
    for (const c of changes) {
      if (c.oldValue === undefined) continue;
      let bag = this.prevByRow.get(c.rowId);
      if (!bag) {
        bag = new Map();
        this.prevByRow.set(c.rowId, bag);
      }
      bag.set(c.colKey, c.oldValue);
    }
  }

  private rebuildCalcResolver(): void {
    try {
      this.calcResolver.rebuild(
        this.cols.all.map((c) => ({ colId: c.colId, def: c.def as import('./types').ColDef })),
      );
    } catch (e) {
      console.warn('[tabular] calc resolver rebuild failed', e);
    }
  }

  private rebuildFormatResolver(): void {
    try {
      this.formatResolver.setConfig(this.options.formatting);
      this.formatResolver.rebuild(
        this.cols.all.map((c) => ({ colId: c.colId, def: c.def as import('./types').ColDef })),
      );
    } catch (e) {
      console.warn('[tabular] format resolver rebuild failed', e);
    }
  }

  private workerExportColumns(): WorkerCsvColumn[] {
    const out: WorkerCsvColumn[] = [];
    for (const c of this.cols.displayed()) {
      const field = this.workerColumnField(c);
      if (!field) continue;
      out.push({
        colId: c.colId,
        field,
        headerName: c.def.headerName ?? c.def.field ?? c.colId,
      });
    }
    return out;
  }

  // ── hit testing ───────────────────────────────────────────────────

  private hitTest(vx: number, vy: number): { rowIndex: number; col: InternalColumn<TData> } | null {
    const pageStart = this.pageRowStart();
    const pageEnd = this.pageRowEnd();
    const localY = vy + this.scrollTop;
    if (localY < 0 || localY >= this.pageContentHeight()) return null;

    // Sticky group row is painted at y=0 but its model index may be above the
    // viewport — route clicks in the sticky band to that group row.
    if (this.options.groupSticky !== false) {
      const firstRow = this.rowAtLocalY(this.scrollTop);
      const sticky = findStickyGroup(this.env(), firstRow);
      if (sticky) {
        const stickyIdx = this.rows.displayedNodes.indexOf(sticky);
        if (stickyIdx >= 0) {
          const stickyH = this.rowHeightAt(stickyIdx);
          if (vy >= 0 && vy < stickyH) {
            const col = this.colAtViewX(vx);
            if (!col) return null;
            return this.snapHitToSpanAnchor(stickyIdx, col);
          }
        }
      }
    }

    const rowIndex = this.rowAtLocalY(localY);
    if (rowIndex < pageStart || rowIndex >= pageEnd || rowIndex >= this.rows.displayed.length) return null;
    const col = this.colAtViewX(vx);
    if (!col) return null;
    return this.snapHitToSpanAnchor(rowIndex, col);
  }

  // ── cell spanning ─────────────────────────────────────────────────

  private spanEnv(): SpanEnv<TData> {
    return {
      rows: this.rows,
      api: this,
      valueAtDisplayed: this.valueAtDisplayed,
      pagination: this.paginationActive()
        ? { pageStart: this.pageRowStart(), pageEnd: this.pageRowEnd() }
        : undefined,
      enableCellSpan: this.options.enableCellSpan === true,
    };
  }

  private spanningPossible(): boolean {
    return (
      this.options.enableCellSpan === true ||
      this.cols.all.some((c) => !!c.def.colSpan)
    );
  }

  private findColRegionIndex(colId: string): { region: Region<TData>; index: number } | null {
    for (const region of [this.cols.left, this.cols.center, this.cols.right]) {
      const index = region.cols.findIndex((c) => c.colId === colId);
      if (index >= 0) return { region, index };
    }
    return null;
  }

  private snapHitToSpanAnchor(
    rowIndex: number,
    col: InternalColumn<TData>,
  ): { rowIndex: number; col: InternalColumn<TData> } {
    if (!this.spanningPossible()) return { rowIndex, col };
    const env = this.spanEnv();
    let outCol = col;
    let outRow = rowIndex;
    const loc = this.findColRegionIndex(col.colId);
    if (loc) {
      const anchor = colSpanAnchorIndex(env, rowIndex, loc.region, loc.index);
      if (anchor !== loc.index) outCol = loc.region.cols[anchor];
    }
    if (spanRowsActive(env, outCol)) {
      outRow = rowSpanRange(env, rowIndex, outCol).start;
    }
    return { rowIndex: outRow, col: outCol };
  }

  /** Anchor form of an arbitrary cell position. */
  private snapPosToSpanAnchor(pos: CellPosition): CellPosition {
    const col = this.cols.getColumn(pos.colId);
    if (!col) return pos;
    const hit = this.snapHitToSpanAnchor(pos.rowIndex, col);
    return { rowIndex: hit.rowIndex, colId: hit.col.colId };
  }

  /**
   * Keyboard target adjusted for spans: a single-step move that lands inside
   * the span we started from jumps past the span's far edge instead.
   */
  private adjustMoveForSpans(
    from: CellPosition,
    next: CellPosition,
    dr: number,
    dc: number,
  ): CellPosition {
    if (!this.spanningPossible()) return next;
    const snapped = this.snapPosToSpanAnchor(next);
    if (snapped.rowIndex !== from.rowIndex || snapped.colId !== from.colId || (dr === 0 && dc === 0)) {
      return snapped;
    }
    const env = this.spanEnv();
    const col = this.cols.getColumn(from.colId);
    if (!col) return snapped;
    if (dr !== 0 && spanRowsActive(env, col)) {
      const range = rowSpanRange(env, from.rowIndex, col);
      const target = dr > 0 ? range.end + 1 : range.start - 1;
      if (target >= 0 && target < this.rows.displayed.length) {
        return this.snapPosToSpanAnchor({ rowIndex: target, colId: from.colId });
      }
      return from;
    }
    if (dc !== 0 && col.def.colSpan) {
      const loc = this.findColRegionIndex(from.colId);
      if (loc) {
        const span = colSpanCount(env, from.rowIndex, loc.region, loc.index);
        const lastCovered = loc.region.cols[Math.min(loc.index + span - 1, loc.region.cols.length - 1)];
        const displayed = this.cols.displayed();
        const di = displayed.findIndex((c) => c.colId === lastCovered.colId);
        const target = displayed[di + (dc > 0 ? 1 : 0)];
        if (dc > 0 && target) {
          return this.snapPosToSpanAnchor({ rowIndex: from.rowIndex, colId: target.colId });
        }
      }
      return from;
    }
    return snapped;
  }

  private colAtViewX(vx: number): InternalColumn<TData> | null {
    const leftW = this.cols.left.width;
    const rightStart = this.viewWidth - this.cols.right.width;
    if (vx < leftW) {
      const i = this.cols.colIndexAtX(this.cols.left, vx);
      return i >= 0 ? this.cols.left.cols[i] : null;
    }
    if (vx >= rightStart) {
      const i = this.cols.colIndexAtX(this.cols.right, vx - rightStart);
      return i >= 0 ? this.cols.right.cols[i] : null;
    }
    const i = this.cols.colIndexAtX(this.cols.center, vx - leftW + this.scrollLeft);
    return i >= 0 ? this.cols.center.cols[i] : null;
  }

  /** Header-space x of a column's right edge, or null when out of view. */
  private headerEdgeAtX(vx: number): InternalColumn<TData> | null {
    const TOL = 5;
    const leftW = this.cols.left.width;
    const rightStart = this.viewWidth - this.cols.right.width;
    const check = (edgeX: number): boolean => Math.abs(vx - edgeX) <= TOL;
    for (let i = 0; i < this.cols.left.cols.length; i++) {
      if (check(this.cols.left.offsets[i + 1])) return this.cols.left.cols[i];
    }
    for (let i = 0; i < this.cols.center.cols.length; i++) {
      const edge = leftW + this.cols.center.offsets[i + 1] - this.scrollLeft;
      if (edge > leftW && edge < rightStart && check(edge)) {
        return this.cols.center.cols[i];
      }
    }
    for (let i = 0; i < this.cols.right.cols.length; i++) {
      if (check(rightStart + this.cols.right.offsets[i + 1])) {
        return this.cols.right.cols[i];
      }
    }
    return null;
  }

  private columnHeaderRowTop(): number {
    const layout = this.cols.header;
    if (!layout) return 0;
    return layout.maxGroupDepth * layout.groupHeaderHeight;
  }

  /** Pinned / auto-group headers span group + column rows (AG pivot parity). */
  private headerColumnSpansRows(col: InternalColumn<TData> | null | undefined): boolean {
    const layout = this.cols.header;
    return !!col && !!layout && layout.maxGroupDepth > 0 && col.ancestorGroups.length === 0;
  }

  /**
   * True when (vx-independent) vy falls inside the column's leaf header cell.
   * Leaf cells stretch up through balanced-tree padding rows, and pinned
   * chrome spans the whole header (AG parity).
   */
  private inLeafHeaderCell(col: InternalColumn<TData> | null | undefined, vy: number): boolean {
    if (!col) return false;
    if (vy >= this.floatingFilterRowTop()) return false;
    if (this.headerColumnSpansRows(col)) return true;
    const layout = this.cols.header;
    const top =
      this.columnHeaderRowTop() -
      (layout ? trailingPaddingLevels(col) * layout.groupHeaderHeight : 0);
    return vy >= top;
  }

  private floatingFilterRowTop(): number {
    const layout = this.cols.header;
    if (!layout) return this.theme.headerHeight;
    return layout.maxGroupDepth * layout.groupHeaderHeight + layout.columnHeaderHeight;
  }

  private isFloatingFilterRow(vy: number): boolean {
    const layout = this.cols.header;
    if (!layout?.floatingFilters) return false;
    const top = this.floatingFilterRowTop();
    return vy >= top && vy < top + layout.floatingFilterHeight;
  }

  private headerGroupAt(vx: number, vy: number): string | null {
    const layout = this.cols.header;
    if (!layout || layout.maxGroupDepth === 0) return null;
    const groupRowH = layout.groupHeaderHeight;
    const level = Math.floor(vy / groupRowH);
    if (level < 0 || level >= layout.maxGroupDepth) return null;

    const leftW = this.cols.left.width;
    const rightStart = this.viewWidth - this.cols.right.width;
    const spans = (originX: number, list: typeof layout.left[number]) => {
      for (const span of list) {
        if (span.padding || !span.expandable) continue;
        const x0 = originX + span.left;
        if (vx >= x0 && vx < x0 + span.width) return span.groupId;
      }
      return null;
    };

    if (vx < leftW) return spans(0, layout.left[level] ?? []);
    if (vx >= rightStart) return spans(rightStart, layout.right[level] ?? []);
    return spans(leftW - this.scrollLeft, layout.center[level] ?? []);
  }

  private cellPositionAt(vx: number, vy: number): CellPosition | null {
    const hit = this.hitTest(vx, vy);
    return hit ? { rowIndex: hit.rowIndex, colId: hit.col.colId } : null;
  }

  /** Map viewport coords to a cell, clamping to the nearest edge cell (AG Grid drag-to-edge). */
  private cellPositionAtClamped(clientX: number, clientY: number): CellPosition | null {
    const rect = this.scroller.getBoundingClientRect();
    const vx = clientX - rect.left;
    const vy = clientY - rect.top;
    const clampedVx = Math.max(0, Math.min(vx, this.viewWidth - 1));
    const clampedVy = Math.max(0, Math.min(vy, this.viewHeight - 1));
    return this.cellPositionAt(clampedVx, clampedVy);
  }

  private setRange(range: { start: CellPosition; end: CellPosition } | null, anchor?: CellPosition | null): void {
    this.range = range;
    if (anchor !== undefined) this.rangeAnchor = anchor;
    this.emit('rangeSelectionChanged', { range });
    this.emit('cellSelectionChanged', { range }); // AG v32.2+ name
    this.updateStatusBar();
    this.requestPaint();
  }

  private extendRangeTo(end: CellPosition, start?: CellPosition): void {
    const rangeStart = start ?? this.rangeAnchor ?? this.range?.start ?? end;
    this.setRange({ start: rangeStart, end });
    this.focused = end;
    this.requestPaint();
  }

  private autoScrollDuringRangeDrag(clientX: number, clientY: number): void {
    const rect = this.scroller.getBoundingClientRect();
    const vx = clientX - rect.left;
    const vy = clientY - rect.top;
    const margin = 24;
    const step = Math.max(4, Math.floor(this.uniformRowHeight() * 0.6));
    let scrolled = false;
    if (vy < margin) {
      this.scrollContentBy(-step);
      scrolled = true;
    } else if (vy > this.viewHeight - margin) {
      this.scrollContentBy(step);
      scrolled = true;
    }
    const centerW = this.viewWidth - this.cols.left.width - this.cols.right.width;
    const centerVx = vx - this.cols.left.width;
    if (centerVx < margin && this.canScrollX()) {
      this.scroller.scrollLeft -= step;
      scrolled = true;
    } else if (centerVx > centerW - margin && this.canScrollX()) {
      this.scroller.scrollLeft += step;
      scrolled = true;
    }
    if (scrolled) {
      this.scrollLeft = this.scroller.scrollLeft;
      this.scrollTop = this.logicalScrollTop();
    }
  }

  private finishRangePointer(e: MouseEvent): void {
    const ptr = this.rangePointer;
    if (!ptr || !this.options.cellSelection) return;
    this.rangePointer = null;
    this.scroller.style.userSelect = '';

    const pos = this.cellPositionAtClamped(e.clientX, e.clientY);
    if (!pos) return;

    if (ptr.dragging) {
      this.extendRangeTo(pos, ptr.anchor);
      this.rangeAnchor = ptr.anchor;
      return;
    }

    // Click (no drag): single cell or shift-extend from anchor.
    if (ptr.shiftKey) {
      this.extendRangeTo(pos);
    } else {
      this.setRange({ start: pos, end: pos }, pos);
      this.setFocusedCell(pos.rowIndex, pos.colId);
      if (this.clickSelectionEnabled()) {
        this.handleRowSelection(pos.rowIndex, e);
      }
      const row = this.rows.displayed[pos.rowIndex];
      if (row !== undefined && row !== null) {
        this.emit('cellClicked', { rowIndex: pos.rowIndex, colId: pos.colId, data: row });
      }
      if (this.options.singleClickEdit) this.startEdit(pos.rowIndex, pos.colId, null);
    }
  }

  // ── fill handle (AG cellSelection.handle, mode 'fill') ────────────

  /** Fill-handle options when enabled via the object form of `cellSelection`. */
  private fillHandleOpts(): FillHandleOptions<TData> | null {
    const cs = this.options.cellSelection;
    if (typeof cs !== 'object' || cs === null) return null;
    const h = cs.handle;
    if (!h || (h.mode !== undefined && h.mode !== 'fill')) return null;
    return h;
  }

  /** Current range as displayed row/col index bounds. */
  private rangeBoundsIdx(): { row0: number; row1: number; col0: number; col1: number } | null {
    if (!this.range) return null;
    const c0 = this.colIndexOf(this.range.start.colId);
    const c1 = this.colIndexOf(this.range.end.colId);
    if (c0 < 0 || c1 < 0) return null;
    return {
      row0: Math.min(this.range.start.rowIndex, this.range.end.rowIndex),
      row1: Math.max(this.range.start.rowIndex, this.range.end.rowIndex),
      col0: Math.min(c0, c1),
      col1: Math.max(c0, c1),
    };
  }

  /** Is the viewport point on the fill handle (with a small grab margin)? */
  private fillHandleHit(vx: number, vy: number): boolean {
    if (!this.fillHandleOpts()) return false;
    const bounds = this.rangeBoundsIdx();
    if (!bounds) return false;
    const rect = fillHandleRect(this.env(), bounds, this.cols.displayed());
    if (!rect) return false;
    const m = 3;
    return (
      vx >= rect.x - m && vx <= rect.x + rect.w + m && vy >= rect.y - m && vy <= rect.y + rect.h + m
    );
  }

  /** Recompute the fill preview from the pointer position (dominant-axis drag). */
  private updateFillPreview(clientX: number, clientY: number): void {
    const drag = this.fillDrag;
    if (!drag) return;
    const pos = this.cellPositionAtClamped(clientX, clientY);
    if (!pos) return;
    const ci = this.colIndexOf(pos.colId);
    if (ci < 0) return;
    const b = drag.bounds;
    const allowed = this.fillHandleOpts()?.direction ?? 'xy';

    // Distance beyond the range on each axis (0 when inside).
    const dRow = pos.rowIndex > b.row1 ? pos.rowIndex - b.row1 : pos.rowIndex < b.row0 ? pos.rowIndex - b.row0 : 0;
    const dCol = ci > b.col1 ? ci - b.col1 : ci < b.col0 ? ci - b.col0 : 0;
    const vertical =
      allowed === 'y' ? true : allowed === 'x' ? false : Math.abs(dRow) >= Math.abs(dCol);

    let preview: { row0: number; row1: number; col0: number; col1: number } | null = null;
    let direction: 'up' | 'down' | 'left' | 'right' = drag.direction;
    if (vertical) {
      if (dRow > 0) {
        preview = { row0: b.row0, row1: pos.rowIndex, col0: b.col0, col1: b.col1 };
        direction = 'down';
      } else if (dRow < 0) {
        preview = { row0: pos.rowIndex, row1: b.row1, col0: b.col0, col1: b.col1 };
        direction = 'up';
      } else if (pos.rowIndex < b.row1 && pos.rowIndex >= b.row0) {
        // Reduction: shrink from the bottom up to the hovered row.
        preview = { row0: b.row0, row1: pos.rowIndex, col0: b.col0, col1: b.col1 };
        direction = 'down';
      }
    } else {
      if (dCol > 0) {
        preview = { row0: b.row0, row1: b.row1, col0: b.col0, col1: ci };
        direction = 'right';
      } else if (dCol < 0) {
        preview = { row0: b.row0, row1: b.row1, col0: ci, col1: b.col1 };
        direction = 'left';
      } else if (ci < b.col1 && ci >= b.col0) {
        preview = { row0: b.row0, row1: b.row1, col0: b.col0, col1: ci };
        direction = 'right';
      }
    }
    drag.preview = preview;
    drag.direction = direction;
    this.requestPaint();
  }

  /** Fill-drag released: write the fill (or clear on reduction), one undo batch. */
  private applyFill(e: MouseEvent): void {
    const drag = this.fillDrag;
    this.fillDrag = null;
    this.scroller.style.userSelect = '';
    if (!drag) return;
    const preview = drag.preview;
    this.requestPaint();
    if (!preview) return;
    const b = drag.bounds;
    const opts = this.fillHandleOpts();
    if (!opts) return;
    const displayed = this.cols.displayed();
    const dir = drag.direction;
    const initialRange = this.range
      ? { start: { ...this.range.start }, end: { ...this.range.end } }
      : {
          start: { rowIndex: b.row0, colId: displayed[b.col0].colId },
          end: { rowIndex: b.row1, colId: displayed[b.col1].colId },
        };
    this.emit('fillStart', { initialRange, direction: dir });

    const ops: CellEditOp[] = [];
    const writeTyped = (rowIndex: number, colIndex: number, value: unknown): void => {
      const col = displayed[colIndex];
      if (!col || col.colId === 'ag-Grid-AutoColumn' || !this.isCellEditable(col, rowIndex)) return;
      const node = this.rows.getDisplayedNode(rowIndex);
      if (!node || node.group || !node.data) return;
      const oldValue = this.valueOf(node.data, col, rowIndex);
      if (value === oldValue) return;
      const rowId = this.rows.getId(node.data);
      if (this.writeCellValue(rowId, col, oldValue, value, rowIndex)) {
        ops.push({ rowId, colId: col.colId, oldValue, newValue: value });
      }
    };

    const isReduction =
      preview.row0 >= b.row0 && preview.row1 <= b.row1 && preview.col0 >= b.col0 && preview.col1 <= b.col1 &&
      (preview.row1 < b.row1 || preview.col0 > b.col0 || preview.col1 < b.col1 || preview.row0 > b.row0);

    if (isReduction) {
      if (opts.suppressClearOnFillReduction !== true) {
        for (let r = b.row0; r <= b.row1; r++) {
          for (let c = b.col0; c <= b.col1; c++) {
            const inside =
              r >= preview.row0 && r <= preview.row1 && c >= preview.col0 && c <= preview.col1;
            if (!inside) writeTyped(r, c, null);
          }
        }
      }
    } else {
      const vertical = dir === 'up' || dir === 'down';
      // One independent run per column (vertical) or per row (horizontal).
      const runCount = vertical ? b.col1 - b.col0 + 1 : b.row1 - b.row0 + 1;
      for (let k = 0; k < runCount; k++) {
        const colIndex = vertical ? b.col0 + k : -1;
        const rowIndex = vertical ? -1 : b.row0 + k;
        const col = displayed[vertical ? colIndex : b.col0];
        if (!col) continue;

        // Source values in fill direction.
        const initialValues: unknown[] = [];
        const srcLen = vertical ? b.row1 - b.row0 + 1 : b.col1 - b.col0 + 1;
        for (let i = 0; i < srcLen; i++) {
          const r = vertical ? (dir === 'down' ? b.row0 + i : b.row1 - i) : rowIndex;
          const c = vertical ? colIndex : dir === 'right' ? b.col0 + i : b.col1 - i;
          const node = this.rows.getDisplayedNode(r);
          initialValues.push(node?.data ? this.valueOf(node.data, displayed[c], r) : null);
        }

        const allNumeric =
          initialValues.length > 0 && initialValues.every((v) => typeof v === 'number');
        // Least-squares slope over the source run continues the series.
        let slope = 0;
        let last = 0;
        if (allNumeric) {
          const n = initialValues.length;
          const nums = initialValues as number[];
          last = nums[n - 1];
          if (n > 1) {
            const xbar = (n - 1) / 2;
            const ybar = nums.reduce((a, v) => a + v, 0) / n;
            let num = 0;
            let den = 0;
            for (let i = 0; i < n; i++) {
              num += (i - xbar) * (nums[i] - ybar);
              den += (i - xbar) * (i - xbar);
            }
            slope = den ? num / den : 0;
          }
        }

        const targetLen = vertical
          ? dir === 'down'
            ? preview.row1 - b.row1
            : b.row0 - preview.row0
          : dir === 'right'
            ? preview.col1 - b.col1
            : b.col0 - preview.col0;
        const written: unknown[] = [];
        for (let i = 0; i < targetLen; i++) {
          const r = vertical ? (dir === 'down' ? b.row1 + 1 + i : b.row0 - 1 - i) : rowIndex;
          const c = vertical ? colIndex : dir === 'right' ? b.col1 + 1 + i : b.col0 - 1 - i;
          const targetCol = displayed[c];
          if (!targetCol) continue;
          const node = this.rows.getDisplayedNode(r);
          let value: unknown;
          if (opts.setFillValue) {
            value = opts.setFillValue({
              event: e,
              values: written.slice(),
              initialValues: initialValues.slice(),
              currentCellValue: node?.data ? this.valueOf(node.data, targetCol, r) : null,
              currentIndex: i,
              direction: dir,
              colDef: targetCol.def,
              data: (node?.data ?? undefined) as TData | undefined,
              rowIndex: r,
              api: this,
            });
          } else if (allNumeric && e.altKey !== true) {
            value = last + slope * (i + 1);
          } else {
            value = initialValues[i % initialValues.length];
          }
          written.push(value);
          writeTyped(r, c, value);
        }
      }
    }

    if (ops.length) {
      this.pushUndo(ops);
      this.updateStatusBar();
    }

    // The range follows the fill result (AG behaviour).
    const finalRange = {
      start: { rowIndex: preview.row0, colId: displayed[preview.col0].colId },
      end: { rowIndex: preview.row1, colId: displayed[preview.col1].colId },
    };
    this.setRange(finalRange, finalRange.start);
    this.emit('fillEnd', { initialRange, finalRange, direction: dir });
    this.requestPaint();
  }

  private measureColumnContentWidth(col: InternalColumn<TData>, skipHeader = false): number {
    const t = this.theme;
    const headerFont = `500 ${t.headerFontSize}px ${t.fontSans}`;
    const bodyFont = `${t.fontSize}px ${t.fontSans}`;
    let max = 0;
    if (!skipHeader) {
      this.ctxB.font = headerFont;
      const label = this.headerLabel(col);
      max = this.ctxB.measureText(label).width;
    }
    const sample = Math.min(this.rows.displayed.length, 120);
    this.ctxB.font = bodyFont;
    for (let i = 0; i < sample; i++) {
      const row = this.rows.displayed[i];
      if (row == null) continue;
      const text = this.formatValue(row, col, i);
      max = Math.max(max, this.ctxB.measureText(text).width);
    }
    return Math.ceil(max + t.paddingX * 2 + 18);
  }

  // ── mouse ─────────────────────────────────────────────────────────

  private onHeaderHover(e: MouseEvent): void {
    if (this.resizeDrag || this.moveDrag) return;
    const rect = this.headerCanvas.getBoundingClientRect();
    const vx = e.clientX - rect.left;
    const vy = e.clientY - rect.top;
    const col = this.headerEdgeAtX(vx);
    if (col && col.def.resizable !== false) {
      this.headerCanvas.style.cursor = 'col-resize';
      return;
    }
    if (this.headerGroupAt(vx, vy)) {
      this.headerCanvas.style.cursor = 'pointer';
      return;
    }
    if (this.isFloatingFilterRow(vy)) {
      if (floatingFilterClearAt(this.env(), vx, vy)) {
        this.headerCanvas.style.cursor = 'pointer';
        return;
      }
      this.headerCanvas.style.cursor = 'text';
      return;
    }
    if (headerButtonAt(this.env(), vx, vy)) {
      this.headerCanvas.style.cursor = 'pointer';
      return;
    }
    this.headerCanvas.style.cursor = this.inLeafHeaderCell(this.colAtViewX(vx), vy)
      ? 'grab'
      : 'default';
    const headerCol = this.colAtViewX(vx);
    if (headerCol && vy < this.floatingFilterRowTop() && !this.isFloatingFilterRow(vy)) {
      const text = this.headerTooltipText(headerCol);
      if (text) this.scheduleTooltip({ kind: 'header', colId: headerCol.colId, text }, e.clientX, e.clientY);
      else if (!this.resizeDrag) this.hideTooltip();
    } else if (!this.resizeDrag) {
      this.hideTooltip();
    }
  }

  private onHeaderMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return; // right-click is handled by contextmenu
    const rect = this.headerCanvas.getBoundingClientRect();
    const vx = e.clientX - rect.left;
    const vy = e.clientY - rect.top;
    const edgeCol = this.headerEdgeAtX(vx);
    if (edgeCol && edgeCol.def.resizable !== false) {
      this.resizeDrag = { colId: edgeCol.colId, startX: e.clientX, startWidth: edgeCol.width };
      e.preventDefault();
      return;
    }
    if (!this.isFloatingFilterRow(vy)) {
      const col = this.colAtViewX(vx);
      if (
        this.inLeafHeaderCell(col, vy) &&
        !headerButtonAt(this.env(), vx, vy) &&
        col!.def.suppressMovable !== true &&
        col!.def.lockPosition !== true
      ) {
        const fromIndex = this.cols.displayed().findIndex((c) => c.colId === col!.colId);
        this.moveDrag = { colId: col!.colId, fromIndex };
        this.headerCanvas.style.cursor = 'grabbing';
        // Stop native selection/drag from fighting the custom drag.
        e.preventDefault();
      }
    }
    this.headerDownAt = { x: e.clientX, y: e.clientY };
  }

  private onHeaderDblClick(e: MouseEvent): void {
    const rect = this.headerCanvas.getBoundingClientRect();
    const vx = e.clientX - rect.left;
    const vy = e.clientY - rect.top;
    if (this.isFloatingFilterRow(vy)) return;
    if (!this.inLeafHeaderCell(this.colAtViewX(vx), vy)) return;
    const col = this.colAtViewX(vx);
    if (!col || col.def.resizable === false) return;
    const width = this.measureColumnContentWidth(col, this.options.skipHeaderOnAutoSize === true);
    this.cols.autoSizeColumn(col.colId, width);
    this.updateSpacer();
    this.syncHeaderGeometry();
    this.emit('columnResized', { colId: col.colId, width });
    this.requestPaint();
  }

  private onWindowMouseMove(e: MouseEvent): void {
    if (this.resizeDrag) {
      const col = this.cols.getColumn(this.resizeDrag.colId);
      if (!col) return;
      this.cols.resizeColumn(col.colId, this.resizeDrag.startWidth + (e.clientX - this.resizeDrag.startX));
      this.updateSpacer();
      this.syncHeaderGeometry();
      this.requestPaint();
      return;
    }
    if (this.fillDrag) {
      this.autoScrollDuringRangeDrag(e.clientX, e.clientY);
      this.updateFillPreview(e.clientX, e.clientY);
      return;
    }
    if (this.rangePointer && this.options.cellSelection) {
      const moved =
        Math.abs(e.clientX - this.rangePointer.clientX) > Tabular.RANGE_DRAG_THRESHOLD ||
        Math.abs(e.clientY - this.rangePointer.clientY) > Tabular.RANGE_DRAG_THRESHOLD;
      if (moved) {
        if (!this.rangePointer.dragging) {
          this.rangePointer.dragging = true;
          this.scroller.style.userSelect = 'none';
        }
        this.autoScrollDuringRangeDrag(e.clientX, e.clientY);
        const pos = this.cellPositionAtClamped(e.clientX, e.clientY);
        if (pos) {
          this.extendRangeTo(pos, this.rangePointer.anchor);
        }
      }
      return;
    }
    if (this.moveDrag && this.headerDownAt) {
      // Self-heal: mouseup was missed (released outside the window) — cancel.
      if ((e.buttons & 1) === 0) {
        this.cancelHeaderDrag();
        return;
      }
      const moved =
        Math.abs(e.clientX - this.headerDownAt.x) > 4 || Math.abs(e.clientY - this.headerDownAt.y) > 4;
      if (moved) {
        const col = this.cols.getColumn(this.moveDrag.colId);
        this.ensureDragGhost(col?.def.headerName ?? this.moveDrag.colId);
        this.moveDragGhost(e.clientX, e.clientY);
        const overGroup = this.isOverGroupPanel(e.clientX, e.clientY);
        const overPivot = this.isOverPivotPanel(e.clientX, e.clientY);
        const droppableGroup = overGroup && this.canRowGroup(col);
        const droppablePivot = overPivot && this.canPivot(col);
        const droppable = droppableGroup || droppablePivot;
        if (this.dragGhost) this.dragGhost.style.opacity = (overGroup || overPivot) && !droppable ? '0.4' : '0.9';
        if (this.groupPanel && this.groupPanelVisible()) {
          this.groupPanel.style.background = droppableGroup
            ? withAlpha(this.theme.accent, 0.12)
            : this.theme.headerBg;
          if (droppableGroup) this.updatePanelIndicator(e.clientX);
          else if (!overPivot) this.removePanelIndicator();
        }
        if (this.pivotPanel && this.pivotPanelVisible()) {
          this.pivotPanel.style.background = droppablePivot
            ? withAlpha(this.theme.accent, 0.12)
            : this.theme.headerBg;
        }
      }
      return;
    }
    if (this.chipDrag) {
      if ((e.buttons & 1) === 0) {
        this.chipDrag = null;
        this.removeDragGhost();
        this.removePanelIndicator();
        return;
      }
      const moved =
        Math.abs(e.clientX - this.chipDrag.startX) > 4 || Math.abs(e.clientY - this.chipDrag.startY) > 4;
      if (moved) {
        this.chipDrag.moved = true;
        const col = this.cols.getColumn(this.chipDrag.colId);
        this.ensureDragGhost(col?.def.headerName ?? this.chipDrag.colId);
        this.moveDragGhost(e.clientX, e.clientY);
        const over = this.isOverGroupPanel(e.clientX, e.clientY);
        // Outside the panel the drop removes the group — dim the ghost as a hint.
        if (this.dragGhost) this.dragGhost.style.opacity = over ? '0.9' : '0.5';
        if (over) this.updatePanelIndicator(e.clientX, this.chipDrag.colId);
        else this.removePanelIndicator();
      }
      return;
    }
    if (this.pivotChipDrag) {
      if ((e.buttons & 1) === 0) {
        this.pivotChipDrag = null;
        this.removeDragGhost();
        return;
      }
      const moved =
        Math.abs(e.clientX - this.pivotChipDrag.startX) > 4 ||
        Math.abs(e.clientY - this.pivotChipDrag.startY) > 4;
      if (moved) {
        this.pivotChipDrag.moved = true;
        const col = this.cols.getColumn(this.pivotChipDrag.colId);
        this.ensureDragGhost(col?.def.headerName ?? this.pivotChipDrag.colId);
        this.moveDragGhost(e.clientX, e.clientY);
        const over = this.isOverPivotPanel(e.clientX, e.clientY);
        if (this.dragGhost) this.dragGhost.style.opacity = over ? '0.9' : '0.5';
        if (this.pivotPanel) {
          this.pivotPanel.style.background = over
            ? withAlpha(this.theme.accent, 0.12)
            : this.theme.headerBg;
        }
      }
      return;
    }
  }

  private cancelHeaderDrag(): void {
    this.moveDrag = null;
    this.headerDownAt = null;
    this.headerCanvas.style.cursor = 'default';
    this.removeDragGhost();
    this.removePanelIndicator();
  }

  private onWindowMouseUp(e: MouseEvent): void {
    if (this.resizeDrag) {
      const col = this.cols.getColumn(this.resizeDrag.colId);
      if (col) this.emit('columnResized', { colId: col.colId, width: col.width });
      this.resizeDrag = null;
      return;
    }
    if (this.fillDrag) {
      this.applyFill(e);
      return;
    }
    if (this.rangePointer) {
      this.finishRangePointer(e);
      return;
    }
    if (this.chipDrag) {
      this.finishChipDrag(e);
      return;
    }
    if (this.pivotChipDrag) {
      this.finishPivotChipDrag(e);
      return;
    }
    if (this.moveDrag) {
      const moved = this.headerDownAt
        ? Math.abs(e.clientX - this.headerDownAt.x) > 4 || Math.abs(e.clientY - this.headerDownAt.y) > 4
        : false;
      if (moved) {
        this.removeDragGhost();
        if (this.isOverPivotPanel(e.clientX, e.clientY)) {
          const col = this.cols.getColumn(this.moveDrag.colId);
          this.moveDrag = null;
          this.headerDownAt = null;
          this.headerCanvas.style.cursor = 'default';
          this.removePanelIndicator();
          if (this.canPivot(col)) {
            this.cols.addPivotColumn(col!.colId);
            this.commitPivotChange();
          }
          return;
        }
        if (this.isOverGroupPanel(e.clientX, e.clientY)) {
          const col = this.cols.getColumn(this.moveDrag.colId);
          const insertAt = this.panelInsertIndexAt(e.clientX);
          this.moveDrag = null;
          this.headerDownAt = null;
          this.headerCanvas.style.cursor = 'default';
          this.removePanelIndicator();
          if (this.canRowGroup(col)) {
            const order = this.cols.getRowGroupCols().map((c) => c.colId);
            order.splice(insertAt, 0, col!.colId);
            this.cols.setRowGroupColumns(order);
            this.commitRowGroupChange();
          }
          return;
        }
        const rect = this.headerCanvas.getBoundingClientRect();
        if (
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom &&
          e.clientX >= rect.left &&
          e.clientX <= rect.right
        ) {
          const col = this.colAtViewX(e.clientX - rect.left);
          if (col) {
            const toIndex = this.cols.displayed().findIndex((c) => c.colId === col.colId);
            if (this.cols.moveColumn(this.moveDrag.colId, toIndex)) {
              this.emit('columnMoved', { colId: this.moveDrag.colId, toIndex });
              this.requestPaint();
            }
          }
        }
        this.headerDownAt = null;
      }
      this.moveDrag = null;
      this.headerCanvas.style.cursor = 'default';
      if (moved) return;
    }
    if (this.headerDownAt) {
      const moved =
        Math.abs(e.clientX - this.headerDownAt.x) > 4 || Math.abs(e.clientY - this.headerDownAt.y) > 4;
      this.headerDownAt = null;
      if (!moved) {
        const rect = this.headerCanvas.getBoundingClientRect();
        if (
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom &&
          e.clientX >= rect.left &&
          e.clientX <= rect.right
        ) {
          const vx = e.clientX - rect.left;
          const vy = e.clientY - rect.top;
          const groupId = this.headerGroupAt(vx, vy);
          if (groupId) {
            const state = this.cols.getColumnGroupState().find((s) => s.groupId === groupId);
            const open = !(state?.open ?? true);
            this.cols.setColumnGroupOpened(groupId, open);
            this.layout();
            this.emit('columnGroupOpened', { groupId, open });
            this.requestPaint();
            return;
          }
          if (this.isFloatingFilterRow(vy)) {
            const clearCol = floatingFilterClearAt(this.env(), vx, vy);
            if (clearCol) {
              this.setColumnFilter(clearCol, null);
              return;
            }
            const col = this.colAtViewX(vx);
            if (col && this.cols.showsFloatingFilter(col)) this.openFloatingFilter(col.colId);
            return;
          }
          const btn = headerButtonAt(this.env(), vx, vy);
          if (btn) {
            if (btn.kind === 'menu') {
              this.showColumnMenuAt(btn.colId, rect.left + btn.x, rect.top + btn.cellBottom);
            } else {
              this.openHeaderFilter(btn.colId, btn.x, btn.cellBottom);
            }
            return;
          }
          if (this.inLeafHeaderCell(this.colAtViewX(vx), vy)) {
            const col = this.colAtViewX(vx);
            if (col?.colId === 'ag-Grid-SelectionColumn' && this.headerCheckboxEnabled()) {
              const state = this.selectionCheckboxState();
              if (state.all) this.deselectAll();
              else this.selectAll();
              return;
            }
            if (col && col.def.sortable !== false) {
              this.cols.toggleSort(col.colId, e.shiftKey);
              this.refreshModel();
              this.emit('sortChanged', { sortModel: this.cols.sortModel() });
            }
          }
        }
      }
    }
  }

  private onBodyMouseDown(e: MouseEvent): void {
    this.root.focus();
    if (e.button !== 0) return;
    const rect = this.scroller.getBoundingClientRect();
    const vx = e.clientX - rect.left;
    const vy = e.clientY - rect.top;
    const hit = this.hitTest(vx, vy);
    if (hit) {
      const node = this.rows.getDisplayedNode(hit.rowIndex);
      if (node?.group && hit.col.colId === 'ag-Grid-AutoColumn') {
        // Toggling happens on click — don't start a range drag from the group cell.
        e.preventDefault();
        return;
      }
      if (node?.detail) return;
    }
    if (!this.options.cellSelection) return;
    if (this.fillHandleHit(vx, vy)) {
      const bounds = this.rangeBoundsIdx();
      if (bounds) {
        this.fillDrag = { bounds, preview: null, direction: 'down' };
        this.scroller.style.userSelect = 'none';
        e.preventDefault();
        return;
      }
    }
    const pos = this.cellPositionAt(vx, vy);
    if (!pos) return;
    e.preventDefault();
    this.rangePointer = {
      anchor: pos,
      clientX: e.clientX,
      clientY: e.clientY,
      dragging: false,
      shiftKey: e.shiftKey,
    };
  }

  private onBodyClick(e: MouseEvent): void {
    const rect = this.scroller.getBoundingClientRect();
    const vx = e.clientX - rect.left;
    const vy = e.clientY - rect.top;
    const hit = this.hitTest(vx, vy);
    if (!hit) return;

    const node = this.rows.getDisplayedNode(hit.rowIndex);
    if (node?.detail) return; // detail rows live in the DOM layer
    if (node?.group && hit.col.colId === 'ag-Grid-AutoColumn' && !node.footer && node.groupId) {
      this.toggleGroupExpanded(node.groupId);
      return;
    }
    if (node?.master && hit.col.def.cellRenderer === 'agGroupCellRenderer') {
      // Toggle only when the click lands on the chevron slot (AG parity).
      const rect = cellRect(this.env(), hit.rowIndex, hit.col.colId);
      if (rect && vx <= rect.x + this.theme.paddingX + 16) {
        this.toggleMasterExpanded(node.id);
        return;
      }
    }
    if (hit.col.colId === 'ag-Grid-SelectionColumn' && node && !node.footer) {
      this.toggleCheckboxSelection(hit.rowIndex);
      return;
    }
    if (this.options.cellSelection) return;

    this.setFocusedCell(hit.rowIndex, hit.col.colId);
    if (node && !node.group && this.clickSelectionEnabled()) {
      this.handleRowSelection(hit.rowIndex, e);
    }
    this.emit('cellClicked', {
      rowIndex: hit.rowIndex,
      colId: hit.col.colId,
      data: (node?.data ?? undefined) as TData,
    });
    if (this.options.singleClickEdit) this.startEdit(hit.rowIndex, hit.col.colId, null);
    this.requestPaint();
  }

  private toggleCheckboxSelection(rowIndex: number): void {
    const node = this.rows.getDisplayedNode(rowIndex);
    // Group rows are selectable via checkbox (AG groupSelects 'self').
    if (!node || node.footer || node.detail) return;
    const id = this.rows.displayedIds[rowIndex];
    if (this.rowSelectionMode() === 'single') {
      this.selectedIds.clear();
      this.selectedIds.add(id);
    } else if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
    } else {
      this.selectedIds.add(id);
    }
    this.selectionAnchor = rowIndex;
    this.emit('selectionChanged', { selectedIds: [...this.selectedIds] });
    this.updateStatusBar();
    this.requestPaint();
  }

  private onBodyDblClick(e: MouseEvent): void {
    const rect = this.scroller.getBoundingClientRect();
    const hit = this.hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    const node = this.rows.getDisplayedNode(hit.rowIndex);
    // Group rows toggle on single click; a dblclick already toggled twice via
    // the click handler — don't toggle a third time or start an edit.
    if (node?.group || node?.detail) return;
    this.emit('cellDoubleClicked', {
      rowIndex: hit.rowIndex,
      colId: hit.col.colId,
      data: (node?.data ?? undefined) as TData,
    });
    this.startEdit(hit.rowIndex, hit.col.colId, null);
  }

  private toggleGroupExpanded(groupId: string): void {
    const node = this.rows.displayedNodes.find((n) => n.groupId === groupId);
    const next = !(node?.expanded ?? true);
    this.rows.setGroupExpanded(groupId, next);
    this.refreshModel();
    this.emit('rowGroupOpened', { groupId, expanded: next });
  }

  /** Normalize `rowSelection` (legacy strings or the AG object form). */
  private rowSelectionMode(): 'single' | 'multiple' | null {
    const rs = this.options.rowSelection;
    if (!rs) return null;
    if (rs === 'single' || rs === 'multiple') return rs;
    return rs.mode === 'multiRow' ? 'multiple' : 'single';
  }

  /** Whether clicking a row (de)selects it. */
  private clickSelectionEnabled(): boolean {
    if (!this.rowSelectionMode()) return false;
    const rs = this.options.rowSelection;
    if (rs && typeof rs === 'object' && rs.enableClickSelection !== undefined) {
      return rs.enableClickSelection !== false;
    }
    return this.options.suppressRowClickSelection !== true;
  }

  /** multiRow + enableSelectionWithoutKeys: plain click toggles selection. */
  private selectionWithoutKeys(): boolean {
    const rs = this.options.rowSelection;
    return typeof rs === 'object' && rs !== null && rs.enableSelectionWithoutKeys === true;
  }

  private handleRowSelection(rowIndex: number, e: MouseEvent | KeyboardEvent): void {
    const mode = this.rowSelectionMode();
    if (!mode) return;
    const node = this.rows.getDisplayedNode(rowIndex);
    if (!node || node.group) return;
    const id = this.rows.displayedIds[rowIndex];
    const multi = mode === 'multiple';

    if (multi && e.shiftKey && this.selectionAnchor >= 0) {
      const [a, b] = [Math.min(this.selectionAnchor, rowIndex), Math.max(this.selectionAnchor, rowIndex)];
      if (!(e.ctrlKey || e.metaKey)) this.selectedIds.clear();
      for (let i = a; i <= b; i++) {
        const n = this.rows.getDisplayedNode(i);
        if (n && !n.group) this.selectedIds.add(this.rows.displayedIds[i]);
      }
    } else if (multi && (e.ctrlKey || e.metaKey || this.selectionWithoutKeys())) {
      if (this.selectedIds.has(id)) this.selectedIds.delete(id);
      else this.selectedIds.add(id);
      this.selectionAnchor = rowIndex;
    } else {
      this.selectedIds.clear();
      this.selectedIds.add(id);
      this.selectionAnchor = rowIndex;
    }
    this.emit('selectionChanged', { selectedIds: [...this.selectedIds] });
    this.updateStatusBar();
  }

  // ── tooltips (§4.11) ─────────────────────────────────────────────

  private tooltipShowDelayMs(): number {
    return this.options.tooltipShowDelay ?? 2000;
  }

  private tooltipHideDelayMs(): number {
    return this.options.tooltipHideDelay ?? 10000;
  }

  private ensureTooltipEl(): HTMLDivElement {
    if (this.tooltipEl) return this.tooltipEl;
    const el = document.createElement('div');
    Object.assign(el.style, {
      position: 'fixed',
      display: 'none',
      maxWidth: '320px',
      padding: '6px 8px',
      borderRadius: '2px',
      pointerEvents: 'none',
      zIndex: '100',
      whiteSpace: 'pre-wrap',
      boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(el);
    this.tooltipEl = el;
    return el;
  }

  private hideTooltip(): void {
    if (this.tooltipShowTimer) {
      clearTimeout(this.tooltipShowTimer);
      this.tooltipShowTimer = null;
    }
    if (this.tooltipHideTimer) {
      clearTimeout(this.tooltipHideTimer);
      this.tooltipHideTimer = null;
    }
    if (this.tooltipEl) this.tooltipEl.style.display = 'none';
    if (this.tooltipTarget) {
      this.emit('tooltipHide', {});
      this.tooltipTarget = null;
    }
  }

  private scheduleTooltip(
    target: { kind: 'cell' | 'header'; rowIndex?: number; colId: string; text: string },
    clientX: number,
    clientY: number,
  ): void {
    if (this.options.tooltipTrigger === 'focus') return;
    if (this.tooltipTarget?.colId === target.colId && this.tooltipTarget?.rowIndex === target.rowIndex) {
      return;
    }
    this.hideTooltip();
    this.tooltipTarget = target;
    this.tooltipShowTimer = setTimeout(() => {
      this.tooltipShowTimer = null;
      const el = this.ensureTooltipEl();
      const t = this.theme;
      el.textContent = target.text;
      Object.assign(el.style, {
        display: 'block',
        background: t.raised,
        color: t.textPrimary,
        border: `1px solid ${t.structural}`,
        font: `${t.fontSize - 1}px ${t.fontSans}`,
      } satisfies Partial<CSSStyleDeclaration>);
      el.style.left = `${clientX + 12}px`;
      el.style.top = `${clientY + 14}px`;
      this.emit('tooltipShow', {
        tooltipText: target.text,
        rowIndex: target.rowIndex,
        colId: target.colId,
      });
      this.tooltipHideTimer = setTimeout(() => this.hideTooltip(), this.tooltipHideDelayMs());
    }, this.tooltipShowDelayMs());
  }

  private cellTooltipText(rowIndex: number, col: InternalColumn<TData>): string | null {
    const node = this.rows.getDisplayedNode(rowIndex);
    const params = {
      value: this.valueAtDisplayed(rowIndex, col),
      data: node?.data ?? undefined,
      rowIndex,
      colDef: col.def,
      api: this,
    };
    const text = resolveCellTooltip(col.def, params);
    if (!text) return null;
    if (this.options.tooltipShowMode === 'whenTruncated') {
      const rect = cellRect(this.env(), rowIndex, col.colId);
      if (!rect) return null;
      const formatted = this.formatDisplayed(rowIndex, col);
      const t = this.theme;
      const font = `${t.fontSize}px ${col.def.type === 'number' ? t.fontMono : t.fontSans}`;
      if (!textOverflows(this.ctxB, formatted, rect.w - t.paddingX * 2, font)) return null;
    }
    return text;
  }

  private headerTooltipText(col: InternalColumn<TData>): string | null {
    const name = col.def.headerName ?? col.def.field ?? col.colId;
    return resolveHeaderTooltip(col.def, name, this);
  }

  private onBodyMouseMove(e: MouseEvent): void {
    if (this.resizeDrag || this.rangePointer?.dragging || this.moveDrag || this.fillDrag) return;
    const rect = this.bodyCanvas.getBoundingClientRect();
    if (this.fillHandleOpts()) {
      const overHandle = this.fillHandleHit(e.clientX - rect.left, e.clientY - rect.top);
      this.scroller.style.cursor = overHandle ? 'crosshair' : '';
    }
    const hit = this.hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) {
      this.hideTooltip();
      return;
    }
    const text = this.cellTooltipText(hit.rowIndex, hit.col);
    if (!text) {
      this.hideTooltip();
      return;
    }
    this.scheduleTooltip(
      { kind: 'cell', rowIndex: hit.rowIndex, colId: hit.col.colId, text },
      e.clientX,
      e.clientY,
    );
  }

  // ── keyboard (§4.11) ────────────────────────────────────────────

  private isNavigable(col: InternalColumn<TData>, rowIndex: number): boolean {
    const sn = col.def.suppressNavigable;
    if (typeof sn === 'function') {
      const node = this.rows.getDisplayedNode(rowIndex);
      return !sn({
        value: this.valueAtDisplayed(rowIndex, col),
        data: node?.data ?? undefined,
        rowIndex,
        colDef: col.def,
        api: this,
      });
    }
    return sn !== true;
  }

  private suppressKeyboardForFocused(e: KeyboardEvent): boolean {
    const f = this.focused;
    if (!f) return false;
    const col = this.cols.getColumn(f.colId);
    if (!col?.def.suppressKeyboardEvent) return false;
    const node = this.rows.getDisplayedNode(f.rowIndex);
    return col.def.suppressKeyboardEvent({
      value: this.valueAtDisplayed(f.rowIndex, col),
      data: node?.data ?? undefined,
      rowIndex: f.rowIndex,
      colDef: col.def,
      api: this,
      event: e,
    });
  }

  private nextNavigablePosition(
    rowIndex: number,
    colId: string,
    dr: number,
    dc: number,
  ): CellPosition | null {
    const displayed = this.cols.displayed();
    if (dr !== 0 && dc === 0) {
      let newRow = clampInt(rowIndex + dr, 0, this.rows.displayed.length - 1);
      // Detail rows are DOM, not cells — keyboard focus steps over them.
      const step = dr > 0 ? 1 : -1;
      while (this.rows.getDisplayedNode(newRow)?.detail) {
        const next = newRow + step;
        if (next < 0 || next >= this.rows.displayed.length) {
          newRow = rowIndex;
          break;
        }
        newRow = next;
      }
      return newRow === rowIndex ? null : { rowIndex: newRow, colId };
    }
    if (dc !== 0 && dr === 0) {
      let ci = displayed.findIndex((c) => c.colId === colId);
      if (ci < 0) ci = 0;
      const step = dc > 0 ? 1 : -1;
      for (let n = 0; n < displayed.length; n++) {
        ci = clampInt(ci + step, 0, displayed.length - 1);
        const col = displayed[ci];
        if (this.isNavigable(col, rowIndex)) return { rowIndex, colId: col.colId };
        if ((step > 0 && ci >= displayed.length - 1) || (step < 0 && ci <= 0)) break;
      }
      return null;
    }
    let r = rowIndex;
    let ci = displayed.findIndex((c) => c.colId === colId);
    if (ci < 0) ci = 0;
    const rStep = dr === 0 ? 0 : dr > 0 ? 1 : -1;
    const cStep = dc === 0 ? 0 : dc > 0 ? 1 : -1;
    const maxSteps = displayed.length + this.rows.displayed.length;
    for (let step = 0; step < maxSteps; step++) {
      if (rStep) r = clampInt(r + rStep, 0, this.rows.displayed.length - 1);
      if (cStep) ci = clampInt(ci + cStep, 0, displayed.length - 1);
      const col = displayed[ci];
      if (this.isNavigable(col, r)) return { rowIndex: r, colId: col.colId };
    }
    return null;
  }

  private jumpToRegionEdge(rowIndex: number, colId: string, key: string): CellPosition | null {
    const displayed = this.cols.displayed();
    if (key === 'ArrowUp') return { rowIndex: 0, colId };
    if (key === 'ArrowDown') return { rowIndex: this.rows.displayed.length - 1, colId };
    if (key === 'ArrowLeft') return { rowIndex, colId: displayed[0]?.colId ?? colId };
    if (key === 'ArrowRight') return { rowIndex, colId: displayed[displayed.length - 1]?.colId ?? colId };
    return null;
  }

  private applyKeyboardMove(
    dr: number,
    dc: number,
    extendRange: boolean,
    e: KeyboardEvent | null,
    jumpKey?: string,
  ): void {
    const displayed = this.cols.displayed();
    if (!displayed.length || !this.rows.displayed.length) return;

    let f = this.focused;
    if (!f) {
      const pos = { rowIndex: 0, colId: displayed[0].colId };
      this.setFocusedCell(pos.rowIndex, pos.colId);
      if (extendRange) this.setRange({ start: pos, end: pos }, pos);
      this.ensureCellVisible(pos.rowIndex, pos.colId);
      this.requestPaint();
      return;
    }

    let next: CellPosition | null;
    if (e && (e.ctrlKey || e.metaKey) && jumpKey) {
      next = this.jumpToRegionEdge(f.rowIndex, f.colId, jumpKey);
    } else {
      next = this.nextNavigablePosition(f.rowIndex, f.colId, dr, dc);
    }

    if (!next) return;

    const nav = this.options.navigateToNextCell;
    if (nav && e) {
      const overridden = nav({
        key: jumpKey ?? e.key,
        previousCellPosition: f,
        nextCellPosition: next,
        event: e,
        api: this,
      });
      if (overridden) next = overridden;
    }

    next = this.adjustMoveForSpans(f, next, dr, dc);

    if (extendRange) {
      this.extendRangeTo(next);
    } else {
      this.setFocusedCell(next.rowIndex, next.colId);
      if (this.options.cellSelection) {
        this.setRange({ start: next, end: next }, next);
      }
    }
    this.ensureCellVisible(next.rowIndex, next.colId);
    if (this.options.tooltipTrigger === 'focus') {
      const col = this.cols.getColumn(next.colId);
      if (col) {
        const text = this.cellTooltipText(next.rowIndex, col);
        if (text) {
          const rect = cellRect(this.env(), next.rowIndex, next.colId);
          const rootRect = this.root.getBoundingClientRect();
          if (rect) {
            this.scheduleTooltip(
              { kind: 'cell', rowIndex: next.rowIndex, colId: next.colId, text },
              rootRect.left + rect.x + rect.w / 2,
              rootRect.top + this.headerTop() + this.headerHeight() + rect.y,
            );
          }
        } else {
          this.hideTooltip();
        }
      }
    }
    this.requestPaint();
  }

  private queueKeyboardMove(dr: number, dc: number, extend: boolean, e: KeyboardEvent): void {
    if (this.navPending) {
      this.navPending.dr += dr;
      this.navPending.dc += dc;
    } else {
      this.navPending = { dr, dc, extend };
    }
    if (!this.navRafId) {
      this.navRafId = requestAnimationFrame(() => {
        this.navRafId = 0;
        const p = this.navPending;
        this.navPending = null;
        if (!p) return;
        this.applyKeyboardMove(p.dr, p.dc, p.extend, e);
      });
    }
  }

  private navigateTab(backward: boolean): void {
    if (!this.focused) {
      this.applyKeyboardMove(0, 0, false, null);
      return;
    }
    const dir = backward ? -1 : 1;
    let pos = this.focused;
    const displayed = this.cols.displayed();
    for (let i = 0; i < displayed.length * this.rows.displayed.length; i++) {
      let ci = displayed.findIndex((c) => c.colId === pos.colId);
      let r = pos.rowIndex;
      ci += dir;
      if (ci >= displayed.length) {
        ci = 0;
        r++;
      } else if (ci < 0) {
        ci = displayed.length - 1;
        r--;
      }
      if (r < 0 || r >= this.rows.displayed.length) break;
      pos = { rowIndex: r, colId: displayed[ci].colId };
      if (this.isNavigable(displayed[ci], r)) {
        const anchored = this.snapPosToSpanAnchor(pos);
        // Tab lands inside a span it started from — keep walking.
        if (anchored.rowIndex === this.focused?.rowIndex && anchored.colId === this.focused.colId) continue;
        this.setFocusedCell(anchored.rowIndex, anchored.colId);
        if (this.options.cellSelection) this.setRange({ start: anchored, end: anchored }, anchored);
        this.ensureCellVisible(anchored.rowIndex, anchored.colId);
        this.requestPaint();
        return;
      }
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.editor) return;
    // Keys targeting a nested detail grid must not drive the master grid.
    if (this.detailLayer && e.target instanceof Node && this.detailLayer.contains(e.target)) return;
    if (this.suppressKeyboardForFocused(e)) return;
    const f = this.focused;
    const pageRows = Math.max(1, Math.floor(this.viewHeight / this.uniformRowHeight()) - 1);
    const extend = !!(e.shiftKey && this.options.cellSelection);

    switch (e.key) {
      case 'ArrowDown':
        if (e.ctrlKey || e.metaKey) this.applyKeyboardMove(0, 0, extend, e, 'ArrowDown');
        else this.queueKeyboardMove(1, 0, extend, e);
        e.preventDefault();
        break;
      case 'ArrowUp':
        if (e.ctrlKey || e.metaKey) this.applyKeyboardMove(0, 0, extend, e, 'ArrowUp');
        else this.queueKeyboardMove(-1, 0, extend, e);
        e.preventDefault();
        break;
      case 'ArrowLeft':
        if (e.ctrlKey || e.metaKey) this.applyKeyboardMove(0, 0, extend, e, 'ArrowLeft');
        else this.queueKeyboardMove(0, -1, extend, e);
        e.preventDefault();
        break;
      case 'ArrowRight':
        if (e.ctrlKey || e.metaKey) this.applyKeyboardMove(0, 0, extend, e, 'ArrowRight');
        else this.queueKeyboardMove(0, 1, extend, e);
        e.preventDefault();
        break;
      case 'PageDown':
        this.queueKeyboardMove(pageRows, 0, extend, e);
        e.preventDefault();
        break;
      case 'PageUp':
        this.queueKeyboardMove(-pageRows, 0, extend, e);
        e.preventDefault();
        break;
      case 'Home':
        if (e.ctrlKey || e.metaKey) this.applyKeyboardMove(-this.rows.displayed.length, 0, extend, e, 'ArrowUp');
        else this.applyKeyboardMove(0, -this.cols.displayed().length, extend, e, 'ArrowLeft');
        e.preventDefault();
        break;
      case 'End':
        if (e.ctrlKey || e.metaKey) this.applyKeyboardMove(this.rows.displayed.length, 0, extend, e, 'ArrowDown');
        else this.applyKeyboardMove(0, this.cols.displayed().length, extend, e, 'ArrowRight');
        e.preventDefault();
        break;
      case 'Tab':
        e.preventDefault();
        this.navigateTab(e.shiftKey);
        break;
      case 'Enter':
        if (e.shiftKey) {
          this.queueKeyboardMove(-1, 0, extend, e);
          e.preventDefault();
          break;
        }
        if (f) this.startEdit(f.rowIndex, f.colId, null);
        e.preventDefault();
        break;
      case 'F2':
        if (f) this.startEdit(f.rowIndex, f.colId, null);
        e.preventDefault();
        break;
      case ' ':
        if (f) this.handleRowSelection(f.rowIndex, e);
        this.requestPaint();
        e.preventDefault();
        break;
      case 'a':
      case 'A':
        if ((e.ctrlKey || e.metaKey) && this.rowSelectionMode() === 'multiple') {
          this.selectAll();
          e.preventDefault();
        } else if (f && !e.ctrlKey && !e.metaKey) {
          this.startEdit(f.rowIndex, f.colId, e.key);
          e.preventDefault();
        }
        break;
      case 'c':
      case 'C':
        if (e.ctrlKey || e.metaKey) {
          this.copyToClipboard();
          e.preventDefault();
        } else if (f) {
          this.startEdit(f.rowIndex, f.colId, e.key);
          e.preventDefault();
        }
        break;
      case 'v':
      case 'V':
        if (e.ctrlKey || e.metaKey) {
          void this.pasteFromClipboard();
          e.preventDefault();
        } else if (f) {
          this.startEdit(f.rowIndex, f.colId, e.key);
          e.preventDefault();
        }
        break;
      case 'x':
      case 'X':
        if ((e.ctrlKey || e.metaKey) && !this.options.suppressCutToClipboard) {
          this.cutToClipboard();
          e.preventDefault();
        } else if (f) {
          this.startEdit(f.rowIndex, f.colId, e.key);
          e.preventDefault();
        }
        break;
      case 'z':
      case 'Z':
        if (e.ctrlKey || e.metaKey) {
          if (e.shiftKey) this.redoCellEditing();
          else this.undoCellEditing();
          e.preventDefault();
        } else if (f) {
          this.startEdit(f.rowIndex, f.colId, e.key);
          e.preventDefault();
        }
        break;
      case 'y':
      case 'Y':
        if (e.ctrlKey || e.metaKey) {
          this.redoCellEditing();
          e.preventDefault();
        } else if (f) {
          this.startEdit(f.rowIndex, f.colId, e.key);
          e.preventDefault();
        }
        break;
      case 'Delete':
      case 'Backspace':
        this.clearSelectedCells();
        e.preventDefault();
        break;
      case 'Escape':
        this.selectedIds.clear();
        this.emit('selectionChanged', { selectedIds: [] });
        this.updateStatusBar();
        this.requestPaint();
        break;
      default:
        // Type-to-replace: a printable char starts editing with that char.
        if (f && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          this.startEdit(f.rowIndex, f.colId, e.key);
          e.preventDefault();
        }
    }
  }

  /** Copy priority: cell range → selected rows → focused cell (TSV). */
  copyToClipboard(
    params?: { includeHeaders?: boolean; includeGroupHeaders?: boolean },
    forceMain = false,
  ): void {
    const withHeaders =
      params?.includeHeaders === true || this.options.copyHeadersToClipboard === true;
    const withGroupHeaders =
      params?.includeGroupHeaders === true || this.options.copyGroupHeadersToClipboard === true;
    const delim = this.options.clipboardDelimiter ?? '\t';
    const headerLine = (cols: InternalColumn<TData>[]): string =>
      cols.map((c) => c.def.headerName ?? c.def.field ?? c.colId).join(delim);
    const cellOut = (rowIndex: number, col: InternalColumn<TData>): string => {
      const proc = this.options.processCellForClipboard;
      if (proc) {
        const node = this.rows.getDisplayedNode(rowIndex);
        const out = proc({
          value: this.valueAtDisplayed(rowIndex, col),
          colDef: col.def,
          data: node?.data ?? undefined,
        });
        return out == null ? '' : String(out);
      }
      return this.formatDisplayed(rowIndex, col);
    };
    const copyCols = (cols: InternalColumn<TData>[], lines: string[]): void => {
      if (withHeaders) {
        if (withGroupHeaders) {
          const groupLine = cols.map((c) => c.def.headerName ?? c.colId).join(delim);
          lines.push(groupLine);
        }
        lines.push(headerLine(cols));
      }
    };
    let text = '';
    if (
      !forceMain &&
      this.range &&
      this.workerCoord.dataPlaneActive &&
      this.workerCoord.dataClient &&
      !this.options.processCellForClipboard
    ) {
      const displayed = this.cols.displayed();
      const c0 = displayed.findIndex((c) => c.colId === this.range!.start.colId);
      const c1 = displayed.findIndex((c) => c.colId === this.range!.end.colId);
      const cols = displayed.slice(Math.min(c0, c1), Math.max(c0, c1) + 1);
      const r0 = Math.min(this.range.start.rowIndex, this.range.end.rowIndex);
      const r1 = Math.max(this.range.start.rowIndex, this.range.end.rowIndex);
      const ranges: WorkerClipboardRange[] = [
        { rowStart: r0, rowEnd: r1, colIds: cols.map((c) => c.colId) },
      ];
      void this.workerCoord.dataClient!
        .clipboardSerialize(ranges, delim)
        .then((tsv) => {
          const lines: string[] = [];
          if (withHeaders) {
            if (withGroupHeaders) {
              lines.push(cols.map((c) => c.def.headerName ?? c.colId).join(delim));
            }
            lines.push(headerLine(cols));
          }
          if (tsv) lines.push(tsv);
          const out = lines.join('\n');
          if (out) void navigator.clipboard?.writeText(out);
        })
        .catch(() => this.copyToClipboard(params, true));
      return;
    }
    if (this.range) {
      const displayed = this.cols.displayed();
      const c0 = displayed.findIndex((c) => c.colId === this.range!.start.colId);
      const c1 = displayed.findIndex((c) => c.colId === this.range!.end.colId);
      const cols = displayed.slice(Math.min(c0, c1), Math.max(c0, c1) + 1);
      const r0 = Math.min(this.range.start.rowIndex, this.range.end.rowIndex);
      const r1 = Math.max(this.range.start.rowIndex, this.range.end.rowIndex);
      const lines: string[] = [];
      copyCols(cols, lines);
      const htmlRows: import('@tabular/format').HtmlClipboardCell[][] = [];
      for (let i = r0; i <= r1; i++) {
        lines.push(cols.map((c) => cellOut(i, c)).join(delim));
        htmlRows.push(
          cols.map((c) => {
            const text = cellOut(i, c);
            const compiled = this.formatResolver?.get(c.colId);
            const value = this.valueAtDisplayed(i, c);
            const style = compiled?.styleFor(value) ?? compiled?.style;
            return { text, style };
          }),
        );
      }
      text = lines.join('\n');
      if (text) {
        const headers = withHeaders
          ? cols.map((c) => c.def.headerName ?? c.def.field ?? c.colId)
          : undefined;
        const html = buildHtmlClipboardTable(htmlRows, headers);
        void writeClipboardTsvAndHtml(text, html);
      }
      return;
    } else if (this.selectedIds.size && !this.options.suppressCopyRowsToClipboard) {
      const cols = this.cols.displayed();
      const lines: string[] = [];
      copyCols(cols, lines);
      for (let i = 0; i < this.rows.displayed.length; i++) {
        if (!this.selectedIds.has(this.rows.displayedIds[i])) continue;
        const row = this.rows.displayed[i];
        if (row == null) continue;
        lines.push(cols.map((c) => cellOut(i, c)).join(delim));
      }
      text = lines.join('\n');
    } else if (this.focused) {
      const col = this.cols.getColumn(this.focused.colId);
      if (col) {
        const row = this.rows.displayed[this.focused.rowIndex];
        if (row != null) {
          const cell = cellOut(this.focused.rowIndex, col);
          const lines: string[] = [];
          if (withHeaders) {
            copyCols([col], lines);
          }
          lines.push(cell);
          text = lines.join('\n');
        }
      }
    }
    if (text) void navigator.clipboard?.writeText(text);
  }

  /** Copy selected rows to the clipboard (AG `copySelectedRowsToClipboard`). */
  copySelectedRowsToClipboard(params?: {
    includeHeaders?: boolean;
    includeGroupHeaders?: boolean;
    columnKeys?: string[];
  }): void {
    if (!this.selectedIds.size) return;
    const displayed = this.cols.displayed();
    const cols = params?.columnKeys?.length
      ? params.columnKeys
          .map((k) => this.cols.getColumn(k))
          .filter((c): c is InternalColumn<TData> => c != null)
      : displayed;
    const delim = this.options.clipboardDelimiter ?? '\t';
    const withHeaders = params?.includeHeaders === true || this.options.copyHeadersToClipboard === true;
    const lines: string[] = [];
    if (withHeaders) {
      lines.push(cols.map((c) => c.def.headerName ?? c.def.field ?? c.colId).join(delim));
    }
    for (let i = 0; i < this.rows.displayed.length; i++) {
      if (!this.selectedIds.has(this.rows.displayedIds[i])) continue;
      lines.push(cols.map((c) => this.formatDisplayed(i, c)).join(delim));
    }
    const text = lines.join('\n');
    if (text) void navigator.clipboard?.writeText(text);
  }

  /** Copy only the selected cell range (AG `copySelectedRangeToClipboard`). */
  copySelectedRangeToClipboard(params?: { includeHeaders?: boolean }): void {
    if (!this.range) return;
    this.copyToClipboard(params);
  }

  /** AG `cutToClipboard`: copy, then clear the source cells (editable only). */
  cutToClipboard(params?: { includeHeaders?: boolean }): void {
    if (this.options.suppressClipboardPaste || this.options.suppressCutToClipboard) return;
    this.copyToClipboard(params);
    this.clearSelectedCells();
  }

  /**
   * Clear the current cell range (or focused cell) to null — Delete /
   * Backspace behaviour with cell selection (AG parity). Editable data cells
   * only; one undoable batch; `cellValueChanged` fires per cleared cell.
   */
  clearSelectedCells(): void {
    const cells: { rowIndex: number; col: InternalColumn<TData> }[] = [];
    if (this.range) {
      const displayed = this.cols.displayed();
      const c0 = this.colIndexOf(this.range.start.colId);
      const c1 = this.colIndexOf(this.range.end.colId);
      const r0 = Math.min(this.range.start.rowIndex, this.range.end.rowIndex);
      const r1 = Math.max(this.range.start.rowIndex, this.range.end.rowIndex);
      for (let r = r0; r <= r1; r++) {
        for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) {
          cells.push({ rowIndex: r, col: displayed[c] });
        }
      }
    } else if (this.focused) {
      const col = this.cols.getColumn(this.focused.colId);
      if (col) cells.push({ rowIndex: this.focused.rowIndex, col });
    }
    const ops: CellEditOp[] = [];
    for (const { rowIndex, col } of cells) {
      if (col.colId === 'ag-Grid-AutoColumn' || !this.isCellEditable(col, rowIndex)) continue;
      const node = this.rows.getDisplayedNode(rowIndex);
      if (!node || node.group || !node.data) continue;
      const oldValue = this.valueOf(node.data, col, rowIndex);
      if (oldValue == null || oldValue === '') continue;
      const rowId = this.rows.getId(node.data);
      if (this.writeCellValue(rowId, col, oldValue, null, rowIndex)) {
        ops.push({ rowId, colId: col.colId, oldValue, newValue: null });
      }
    }
    if (ops.length) {
      this.pushUndo(ops);
      this.updateStatusBar();
      this.requestPaint();
    }
  }

  // ── clipboard paste (TSV → transactions, §4.10) ───────────────────

  /** Paste TSV from the system clipboard at the range start / focused cell. */
  async pasteFromClipboard(): Promise<void> {
    if (this.options.suppressClipboardPaste) return;
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return; // permission denied — nothing to do
    }
    if (text) this.pasteText(text);
  }

  /** Apply TSV text starting at the current range start / focused cell. */
  pasteText(text: string): void {
    const lines = text.replace(/\r/g, '').split('\n');
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) return;
    let matrix: string[][] | null = lines.map((l) => l.split('\t'));
    if (this.options.processDataFromClipboard) {
      matrix = this.options.processDataFromClipboard({ data: matrix });
      if (!matrix || !matrix.length) return; // null vetoes the paste (AG Grid)
    }

    const start = this.range
      ? {
          rowIndex: Math.min(this.range.start.rowIndex, this.range.end.rowIndex),
          colId:
            this.colIndexOf(this.range.start.colId) <= this.colIndexOf(this.range.end.colId)
              ? this.range.start.colId
              : this.range.end.colId,
        }
      : this.focused;
    if (!start) return;

    const displayed = this.cols.displayed();
    const startCol = this.colIndexOf(start.colId);
    if (startCol < 0) return;

    this.emit('pasteStart', {});
    const ops: CellEditOp[] = [];
    const writeCell = (rowIndex: number, colIndex: number, raw: string): void => {
      if (rowIndex >= this.rows.displayed.length || colIndex >= displayed.length) return;
      const col = displayed[colIndex];
      if (col.colId === 'ag-Grid-AutoColumn' || !this.isCellEditable(col, rowIndex)) return;
      const node = this.rows.getDisplayedNode(rowIndex);
      if (!node || node.group || !node.data) return;
      const op = this.applyCellValue(rowIndex, col, raw);
      if (op) ops.push(op);
    };

    // Single value into a multi-cell range fills the whole range (AG Grid).
    if (matrix.length === 1 && matrix[0].length === 1 && this.range) {
      const r0 = Math.min(this.range.start.rowIndex, this.range.end.rowIndex);
      const r1 = Math.max(this.range.start.rowIndex, this.range.end.rowIndex);
      const c0 = Math.min(this.colIndexOf(this.range.start.colId), this.colIndexOf(this.range.end.colId));
      const c1 = Math.max(this.colIndexOf(this.range.start.colId), this.colIndexOf(this.range.end.colId));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) writeCell(r, c, matrix[0][0]);
      }
    } else {
      for (let r = 0; r < matrix.length; r++) {
        for (let c = 0; c < matrix[r].length; c++) {
          writeCell(start.rowIndex + r, startCol + c, matrix[r][c]);
        }
      }
    }

    if (ops.length) {
      this.pushUndo(ops);
      this.updateStatusBar();
      this.requestPaint();
    }
    this.emit('pasteEnd', { cellCount: ops.length });
  }

  private colIndexOf(colId: string): number {
    return this.cols.displayed().findIndex((c) => c.colId === colId);
  }

  /**
   * Parse + write one cell (paste / undo / redo path). Returns the reversible
   * op, or null when the column rejects the value or nothing changed.
   */
  private applyCellValue(rowIndex: number, col: InternalColumn<TData>, raw: string): CellEditOp | null {
    const node = this.rows.getDisplayedNode(rowIndex);
    if (!node?.data) return null;
    const row = node.data;
    const oldValue = this.valueOf(row, col, rowIndex);

    let parsed: unknown = raw;
    if (this.options.processCellFromClipboard) {
      parsed = this.options.processCellFromClipboard({ value: raw, colDef: col.def, data: row });
    } else if (col.def.valueParser) {
      parsed = col.def.valueParser({ newValue: raw, oldValue, data: row });
    } else if (col.def.type === 'number' || typeof oldValue === 'number') {
      const n = Number(raw.replace(/,/g, ''));
      if (Number.isNaN(n)) return null;
      parsed = n;
    }
    if (parsed === oldValue) return null;

    const rowId = this.rows.getId(row);
    if (!this.writeCellValue(rowId, col, oldValue, parsed, rowIndex)) return null;
    return { rowId, colId: col.colId, oldValue, newValue: parsed };
  }

  /** Assign, flash, and announce a cell mutation (shared by edit/paste/undo). */
  private writeCellValue(
    rowId: string,
    col: InternalColumn<TData>,
    oldValue: unknown,
    newValue: unknown,
    rowIndexHint = -1,
  ): boolean {
    const row = this.rows.getRowById(rowId);
    if (row == null) return false;
    const field = col.def.field;
    if (!field || field.includes('.')) return false;
    (row as Record<string, unknown>)[field] = newValue;
    if (this.options.enableCellFlash !== false && cellChangeFlashEnabled(col.def)) {
      const dir =
        typeof newValue === 'number' && typeof oldValue === 'number'
          ? newValue > oldValue
            ? 1
            : -1
          : 0;
      this.flashMgr.flash(`${rowId}\u0000${col.colId}`, dir as 1 | -1 | 0);
    }
    const rowIndex = rowIndexHint >= 0 ? rowIndexHint : this.rows.displayedIndexOf(rowId);
    this.emit('cellValueChanged', {
      data: row,
      colId: col.colId,
      oldValue,
      newValue,
      rowIndex,
    });
    return true;
  }

  // ── undo / redo of cell edits ─────────────────────────────────────

  private undoRedoEnabled(): boolean {
    // AG parity: undo/redo is opt-in.
    return this.options.undoRedoCellEditing === true;
  }

  private pushUndo(ops: CellEditOp[]): void {
    if (!this.undoRedoEnabled() || !ops.length) return;
    this.undoStack.push(ops);
    const limit = this.options.undoRedoCellEditingLimit ?? 10;
    while (this.undoStack.length > limit) this.undoStack.shift();
    this.redoStack = [];
  }

  undoCellEditing(): void {
    if (!this.undoRedoEnabled()) return;
    const ops = this.undoStack.pop();
    if (!ops) return;
    this.emit('undoStarted', {});
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i];
      const col = this.cols.getColumn(op.colId);
      if (col) this.writeCellValue(op.rowId, col, op.newValue, op.oldValue);
    }
    this.redoStack.push(ops);
    this.updateStatusBar();
    this.requestPaint();
    this.emit('undoEnded', { operations: ops.length });
  }

  redoCellEditing(): void {
    if (!this.undoRedoEnabled()) return;
    const ops = this.redoStack.pop();
    if (!ops) return;
    this.emit('redoStarted', {});
    for (const op of ops) {
      const col = this.cols.getColumn(op.colId);
      if (col) this.writeCellValue(op.rowId, col, op.oldValue, op.newValue);
    }
    this.undoStack.push(ops);
    this.updateStatusBar();
    this.requestPaint();
    this.emit('redoEnded', { operations: ops.length });
  }

  getCurrentUndoSize(): number {
    return this.undoStack.length;
  }

  getCurrentRedoSize(): number {
    return this.redoStack.length;
  }

  // ── status bar ────────────────────────────────────────────────────

  /** Normalize `statusBar` (boolean or AG `{ statusPanels }`) to a panel list. */
  private resolveStatusPanels(): {
    name: StatusPanelName;
    align: 'left' | 'right';
    aggFuncs?: StatusPanelAggFunc[];
  }[] {
    const sb = this.options.statusBar;
    if (!sb) return [];
    if (sb === true) {
      return [
        { name: 'agTotalAndFilteredRowCountComponent', align: 'left' },
        { name: 'agSelectedRowCountComponent', align: 'left' },
        { name: 'agAggregationComponent', align: 'right' },
      ];
    }
    return sb.statusPanels.map((p) => ({
      name: p.statusPanel,
      align:
        p.align === 'right' || p.align === 'left'
          ? p.align
          : p.statusPanel === 'agAggregationComponent'
            ? 'right'
            : 'left',
      aggFuncs: p.statusPanelParams?.aggFuncs,
    }));
  }

  private updateStatusBar(): void {
    if (!this.statusBar || !this.statusLeft || !this.statusRight) return;
    const total = this.rows.rowCount;
    const shown = this.rows.filteredCount;
    const leftParts: string[] = [];
    const rightParts: string[] = [];
    const push = (align: 'left' | 'right', text: string): void => {
      if (text) (align === 'left' ? leftParts : rightParts).push(text);
    };
    for (const p of this.resolveStatusPanels()) {
      switch (p.name) {
        case 'agTotalRowCountComponent':
          push(p.align, `Total Rows: ${total.toLocaleString()}`);
          break;
        case 'agFilteredRowCountComponent':
          push(p.align, `Filtered Rows: ${shown.toLocaleString()}`);
          break;
        case 'agTotalAndFilteredRowCountComponent':
          push(
            p.align,
            shown >= total
              ? `Rows: ${shown.toLocaleString()}`
              : `Rows: ${shown.toLocaleString()} of ${total.toLocaleString()}`,
          );
          break;
        case 'agSelectedRowCountComponent':
          // AG hides the selected-count panel until something is selected.
          if (this.selectedIds.size > 0) {
            push(p.align, `Selected: ${this.selectedIds.size.toLocaleString()}`);
          }
          break;
        case 'agAggregationComponent':
          push(p.align, this.rangeAggregationText(p.aggFuncs));
          break;
      }
    }
    this.statusLeft.textContent = leftParts.join('    ');
    this.statusRight.textContent = rightParts.join('    ');
    this.statusRight.style.color = this.theme.textPrimary;
  }

  /** AG aggregation status panel: stats over the selected cell range. */
  private rangeAggregationText(aggFuncs?: StatusPanelAggFunc[]): string {
    if (!this.range) return '';
    const displayed = this.cols.displayed();
    const c0 = this.colIndexOf(this.range.start.colId);
    const c1 = this.colIndexOf(this.range.end.colId);
    const r0 = Math.min(this.range.start.rowIndex, this.range.end.rowIndex);
    const r1 = Math.max(this.range.start.rowIndex, this.range.end.rowIndex);
    // AG semantics: all stats — including Count — cover numeric cells only.
    let numCount = 0;
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let r = r0; r <= r1; r++) {
      for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) {
        const v = this.valueAtDisplayed(r, displayed[c]);
        if (typeof v === 'number' && Number.isFinite(v)) {
          numCount++;
          sum += v;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
    }
    if (numCount === 0) return '';
    const fmt = (n: number): string =>
      Number.isInteger(n)
        ? n.toLocaleString()
        : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const enabled = (f: StatusPanelAggFunc): boolean => !aggFuncs || aggFuncs.includes(f);
    const segs: string[] = [];
    if (enabled('avg')) segs.push(`Average: ${fmt(sum / numCount)}`);
    if (enabled('count')) segs.push(`Count: ${numCount.toLocaleString()}`);
    if (enabled('min')) segs.push(`Min: ${fmt(min)}`);
    if (enabled('max')) segs.push(`Max: ${fmt(max)}`);
    if (enabled('sum')) segs.push(`Sum: ${fmt(sum)}`);
    return segs.join('    ');
  }

  // ── overlays (loading / no rows) ──────────────────────────────────

  showLoadingOverlay(): void {
    this.overlayState = 'loading';
    this.renderOverlay();
  }

  showNoRowsOverlay(): void {
    this.overlayState = 'noRows';
    this.renderOverlay();
  }

  hideOverlay(): void {
    this.overlayState = 'none';
    this.renderOverlay();
  }

  /** Auto no-rows: empty grid shows the overlay unless loading / suppressed. */
  private syncNoRowsOverlay(): void {
    if (this.overlayState === 'loading') return;
    const empty = this.rows.displayed.length === 0;
    if (empty && !this.options.suppressNoRowsOverlay) {
      if (this.overlayState !== 'noRows') {
        this.overlayState = 'noRows';
        this.renderOverlay();
      }
    } else if (this.overlayState === 'noRows') {
      this.overlayState = 'none';
      this.renderOverlay();
    }
  }

  private renderOverlay(): void {
    const el = this.overlayEl;
    if (!el) return;
    const t = this.theme;
    if (this.overlayState === 'none') {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    el.style.display = 'flex';
    // Loading dims + blocks the stale grid beneath; no-rows is passive.
    el.style.pointerEvents = this.overlayState === 'loading' ? 'auto' : 'none';
    el.style.background = this.overlayState === 'loading' ? withAlpha(t.base, 0.6) : 'transparent';
    const template =
      this.overlayState === 'loading'
        ? this.options.overlayLoadingTemplate
        : this.options.overlayNoRowsTemplate;
    if (template) {
      el.innerHTML = template;
      return;
    }
    el.innerHTML = '';
    const badge = document.createElement('div');
    Object.assign(badge.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '6px 16px',
      borderRadius: '4px',
      border: `1px solid ${withAlpha(t.textSecondary, 0.25)}`,
      background: t.raised,
      color: t.textSecondary,
      boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
    } satisfies Partial<CSSStyleDeclaration>);
    if (this.overlayState === 'loading') {
      ensureOverlayKeyframes();
      const spinner = document.createElement('span');
      Object.assign(spinner.style, {
        width: '12px',
        height: '12px',
        borderRadius: '50%',
        border: `2px solid ${withAlpha(t.textSecondary, 0.3)}`,
        borderTopColor: t.textPrimary,
        animation: 'tabular-spin 0.8s linear infinite',
        flex: 'none',
      } satisfies Partial<CSSStyleDeclaration>);
      badge.appendChild(spinner);
      badge.appendChild(document.createTextNode('Loading…'));
    } else {
      // AG Grid v33+: filtered-empty and data-empty are distinct overlays.
      badge.textContent = this.rows.rowCount > 0 ? 'No Matching Rows' : 'No Rows To Show';
    }
    el.appendChild(badge);
  }

  // ── context menus (cell + header right-click) ─────────────────────

  private onBodyContextMenu(e: MouseEvent): void {
    if (this.options.suppressContextMenu) return;
    e.preventDefault();
    const rect = this.scroller.getBoundingClientRect();
    const hit = this.hitTest(e.clientX - rect.left, e.clientY - rect.top);
    let value: unknown;
    if (hit) {
      const node = this.rows.getDisplayedNode(hit.rowIndex);
      value = this.valueAtDisplayed(hit.rowIndex, hit.col);
      // AG Grid: right-click focuses the cell unless it's inside the range.
      if (!this.cellInRange(hit.rowIndex, hit.col.colId)) {
        this.setRange(null, null);
        this.setFocusedCell(hit.rowIndex, hit.col.colId);
        this.requestPaint();
      }
      this.emit('cellContextMenu', {
        rowIndex: hit.rowIndex,
        colId: hit.col.colId,
        data: (node?.data ?? undefined) as TData,
      });
    }
    const defaultItems: ContextMenuItem[] = [
      { name: 'Copy', shortcut: '⌘C', disabled: !hit, action: () => this.copyToClipboard() },
      {
        name: 'Copy with Headers',
        disabled: !hit,
        action: () => this.copyToClipboard({ includeHeaders: true }),
      },
      'separator',
      { name: 'CSV Export', action: () => this.exportDataAsCsv() },
      { name: 'Excel Export', action: () => this.exportDataAsExcel() },
    ];
    this.showContextMenu(
      this.options.getContextMenuItems?.({
        rowIndex: hit ? hit.rowIndex : null,
        colId: hit ? hit.col.colId : null,
        value,
        defaultItems,
      }) ?? defaultItems,
      e.clientX,
      e.clientY,
    );
  }

  private cellInRange(rowIndex: number, colId: string): boolean {
    if (!this.range) return false;
    const r0 = Math.min(this.range.start.rowIndex, this.range.end.rowIndex);
    const r1 = Math.max(this.range.start.rowIndex, this.range.end.rowIndex);
    if (rowIndex < r0 || rowIndex > r1) return false;
    const displayed = this.cols.displayed();
    const ci = displayed.findIndex((c) => c.colId === colId);
    const c0 = displayed.findIndex((c) => c.colId === this.range!.start.colId);
    const c1 = displayed.findIndex((c) => c.colId === this.range!.end.colId);
    return ci >= Math.min(c0, c1) && ci <= Math.max(c0, c1);
  }

  private onHeaderContextMenu(e: MouseEvent): void {
    if (this.options.suppressContextMenu) return;
    e.preventDefault();
    const rect = this.headerCanvas.getBoundingClientRect();
    const vx = e.clientX - rect.left;
    const vy = e.clientY - rect.top;
    if (this.isFloatingFilterRow(vy)) return;
    const col = this.colAtViewX(vx);
    if (!col) return;

    const label = col.def.headerName ?? col.def.field ?? col.colId;
    const isAuto = col.colId === 'ag-Grid-AutoColumn';
    const defaultItems: ContextMenuItem[] = [
      {
        name: 'Pin Left',
        checked: col.pinned === 'left',
        action: () => this.setColumnPinned(col.colId, col.pinned === 'left' ? null : 'left'),
      },
      {
        name: 'Pin Right',
        checked: col.pinned === 'right',
        action: () => this.setColumnPinned(col.colId, col.pinned === 'right' ? null : 'right'),
      },
      {
        name: 'No Pin',
        checked: col.pinned === null,
        action: () => this.setColumnPinned(col.colId, null),
      },
      'separator',
      { name: 'Autosize This Column', action: () => this.autoSizeColumn(col.colId) },
      { name: 'Autosize All Columns', action: () => this.autoSizeColumns() },
      'separator',
    ];
    if (!isAuto && col.def.enableRowGroup) {
      defaultItems.push(
        col.def.rowGroup
          ? { name: `Un-Group by ${label}`, action: () => this.removeRowGroupColumns([col.colId]) }
          : { name: `Group by ${label}`, action: () => this.addRowGroupColumns([col.colId]) },
        'separator',
      );
    }
    defaultItems.push(
      { name: 'Hide Column', disabled: isAuto, action: () => this.setColumnVisible(col.colId, false) },
      { name: 'Reset Columns', action: () => this.resetColumnState() },
    );
    this.showContextMenu(
      this.options.getContextMenuItems?.({
        rowIndex: null,
        colId: col.colId,
        value: undefined,
        defaultItems,
      }) ?? defaultItems,
      e.clientX,
      e.clientY,
    );
  }

  /** Map AG built-in item names to concrete menu entries. */
  private resolveMenuItem(item: ContextMenuItem): ContextMenuItem {
    switch (item) {
      case 'copy':
        return { name: 'Copy', shortcut: '⌘C', action: () => this.copyToClipboard() };
      case 'copyWithHeaders':
        return {
          name: 'Copy with Headers',
          action: () => this.copyToClipboard({ includeHeaders: true }),
        };
      case 'export':
      case 'csvExport':
        return { name: 'CSV Export', action: () => this.exportDataAsCsv() };
      default:
        return item;
    }
  }

  /** Build one menu layer (root or submenu); rows recurse into `subMenu`. */
  private buildMenuElement(items: ContextMenuItem[]): HTMLDivElement {
    const t = this.theme;
    const menu = document.createElement('div');
    Object.assign(menu.style, {
      position: 'fixed',
      minWidth: '190px',
      padding: '4px 0',
      boxSizing: 'border-box',
      background: t.raised,
      border: `1px solid ${withAlpha(t.textSecondary, 0.25)}`,
      borderRadius: '4px',
      boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
      zIndex: '1000',
      font: `${t.fontSize - 1}px ${t.fontSans}`,
      color: t.textPrimary,
      userSelect: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    menu.addEventListener('mousedown', (e) => e.stopPropagation());
    menu.addEventListener('contextmenu', (e) => e.preventDefault());

    // One open submenu per layer; replaced when hovering another row.
    let openSub: HTMLDivElement | null = null;
    const closeSub = (): void => {
      if (!openSub) return;
      const i = this.contextMenuLayers.indexOf(openSub);
      if (i >= 0) this.contextMenuLayers.splice(i, 1);
      openSub.remove();
      openSub = null;
    };

    for (const item of items) {
      if (item === 'separator') {
        const sep = document.createElement('div');
        Object.assign(sep.style, {
          height: '1px',
          margin: '4px 0',
          background: withAlpha(t.textSecondary, 0.18),
        } satisfies Partial<CSSStyleDeclaration>);
        menu.appendChild(sep);
        continue;
      }
      if (typeof item === 'string') continue; // built-ins resolved above
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '5px 14px 5px 10px',
        cursor: item.disabled ? 'default' : 'pointer',
        color: item.disabled ? t.textTertiary : t.textPrimary,
        whiteSpace: 'nowrap',
      } satisfies Partial<CSSStyleDeclaration>);
      const lead = document.createElement('span');
      if (item.checked) {
        lead.innerHTML = iconSvg('check', 14, undefined, 2.5);
        lead.style.color = t.accent;
      } else if (item.icon) {
        lead.innerHTML = iconSvg(item.icon, 13, undefined, 1.8);
        lead.style.color = t.textSecondary;
      }
      lead.style.width = '15px';
      lead.style.flex = '0 0 15px';
      lead.style.display = 'inline-flex';
      lead.style.alignItems = 'center';
      const name = document.createElement('span');
      name.textContent = item.name;
      name.style.flex = '1';
      row.appendChild(lead);
      row.appendChild(name);
      if (item.shortcut) {
        const sc = document.createElement('span');
        sc.textContent = item.shortcut;
        sc.style.color = t.textTertiary;
        sc.style.marginLeft = '18px';
        row.appendChild(sc);
      }
      if (item.subMenu?.length) {
        const arrow = document.createElement('span');
        arrow.innerHTML = iconSvg('chevron-right', 13);
        arrow.style.color = t.textTertiary;
        arrow.style.display = 'inline-flex';
        arrow.style.alignItems = 'center';
        arrow.style.marginLeft = '10px';
        row.appendChild(arrow);
      }
      if (!item.disabled) {
        row.addEventListener('mouseenter', () => {
          row.style.background = withAlpha(t.accent, 0.15);
          closeSub();
          if (item.subMenu?.length) {
            const sub = this.buildMenuElement(item.subMenu.map((i) => this.resolveMenuItem(i)));
            const r = row.getBoundingClientRect();
            sub.style.left = `${r.right - 2}px`;
            sub.style.top = `${r.top - 5}px`;
            document.body.appendChild(sub);
            const sw = sub.offsetWidth;
            const sh = sub.offsetHeight;
            if (r.right - 2 + sw > window.innerWidth - 4) sub.style.left = `${Math.max(4, r.left - sw + 2)}px`;
            if (r.top - 5 + sh > window.innerHeight - 4) sub.style.top = `${Math.max(4, window.innerHeight - sh - 4)}px`;
            this.contextMenuLayers.push(sub);
            openSub = sub;
          }
        });
        row.addEventListener('mouseleave', () => (row.style.background = 'transparent'));
        if (item.action) {
          const run = item.action;
          row.addEventListener('click', () => {
            this.closeContextMenu();
            run();
          });
        }
      }
      menu.appendChild(row);
    }
    return menu;
  }

  private showContextMenu(items: ContextMenuItem[], clientX: number, clientY: number): void {
    this.closeContextMenu();
    this.closeSetFilter();
    this.closeFloatingFilter();
    this.closeHeaderFilterPopup();
    items = items.map((i) => this.resolveMenuItem(i));
    if (!items.length) return;

    const menu = this.buildMenuElement(items);
    this.contextMenuEl = menu;
    this.contextMenuLayers = [menu];
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;

    document.body.appendChild(menu);
    // Keep the menu on-screen.
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    if (clientX + mw > window.innerWidth - 4) menu.style.left = `${Math.max(4, clientX - mw)}px`;
    if (clientY + mh > window.innerHeight - 4) menu.style.top = `${Math.max(4, clientY - mh)}px`;

    const onDocDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (this.contextMenuEl && !this.contextMenuLayers.some((l) => l.contains(target))) {
        this.closeContextMenu();
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') this.closeContextMenu();
    };
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', this.closeContextMenuBound);
    this.contextMenuCleanup = () => {
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', this.closeContextMenuBound);
    };
  }

  private readonly closeContextMenuBound = (): void => this.closeContextMenu();

  private closeContextMenu(): void {
    if (!this.contextMenuEl) return;
    this.contextMenuCleanup?.();
    this.contextMenuCleanup = null;
    for (const layer of this.contextMenuLayers) layer.remove();
    this.contextMenuLayers = [];
    this.contextMenuEl = null;
  }

  // ── column menu (header ⋮ button, AG new column menu) ─────────────

  /** AG default main-menu items: sort, pin submenu, autosize, choose/reset. */
  private defaultMainMenuItems(col: InternalColumn<TData>): ContextMenuItem[] {
    const isAuto = col.colId === 'ag-Grid-AutoColumn';
    const label = this.displayHeaderBase(col.def.headerName ?? col.def.field ?? col.colId);
    const items: ContextMenuItem[] = [];
    if (col.def.sortable !== false) {
      items.push(
        { name: 'Sort Ascending', icon: 'arrow-up', action: () => this.applyMenuSort(col.colId, 'asc') },
        { name: 'Sort Descending', icon: 'arrow-down', action: () => this.applyMenuSort(col.colId, 'desc') },
        'separator',
      );
    }
    items.push(
      {
        name: 'Pin Column',
        icon: 'pin',
        subMenu: [
          { name: 'Pin Left', checked: col.pinned === 'left', action: () => this.setColumnPinned(col.colId, 'left') },
          { name: 'Pin Right', checked: col.pinned === 'right', action: () => this.setColumnPinned(col.colId, 'right') },
          { name: 'No Pin', checked: col.pinned === null, action: () => this.setColumnPinned(col.colId, null) },
        ],
      },
      'separator',
      { name: 'Autosize This Column', action: () => this.autoSizeColumn(col.colId) },
      { name: 'Autosize All Columns', action: () => this.autoSizeColumns() },
      'separator',
    );
    if (!isAuto && this.canRowGroup(col)) {
      items.push(
        col.def.rowGroup || this.cols.rowGroupColumns().some((c) => c.colId === col.colId)
          ? { name: `Un-Group by ${label}`, icon: 'group', action: () => this.removeRowGroupColumns([col.colId]) }
          : { name: `Group by ${label}`, icon: 'group', action: () => this.addRowGroupColumns([col.colId]) },
        'separator',
      );
    }
    items.push(
      { name: 'Choose Columns', icon: 'columns', action: () => this.showColumnChooser() },
      { name: 'Reset Columns', action: () => this.resetColumnState() },
    );
    return items;
  }

  /** Column-menu sort item: replace the sort model with this direction. */
  private applyMenuSort(colId: string, dir: 'asc' | 'desc'): void {
    this.cols.setSort(colId, dir);
    this.refreshModel();
    this.emit('sortChanged', { sortModel: this.cols.sortModel() });
  }

  private showColumnMenuAt(colId: string, clientX: number, clientY: number): void {
    const col = this.cols.getColumn(colId);
    if (!col) return;
    const defaultItems = this.defaultMainMenuItems(col);
    const items =
      col.def.mainMenuItems ??
      this.options.getMainMenuItems?.({ colId, defaultItems }) ??
      defaultItems;
    this.showContextMenu(items, clientX, clientY);
  }

  /** AG `showColumnMenu(colKey)` — open the column menu below its header cell. */
  showColumnMenu(colKey: string): void {
    const col = this.cols.getColumn(colKey);
    if (!col) return;
    const x = headerCellX(this.env(), col) ?? 0;
    const rect = this.headerCanvas.getBoundingClientRect();
    this.showColumnMenuAt(colKey, rect.left + x, rect.top + this.floatingFilterRowTop());
  }

  // ── header funnel button: anchored column filter popup ─────────────

  /**
   * Filter popup below the header cell (AG funnel button). Text/number
   * columns get an expression input; set columns get search + checkboxes.
   */
  private openHeaderFilter(colId: string, _anchorX: number, cellBottom: number): void {
    this.closeContextMenu();
    this.closeHeaderFilterPopup();
    this.closeSetFilter();
    this.closeFloatingFilter();
    const col = this.cols.getColumn(colId);
    if (!col) return;
    const kind = resolveFilterKind(col, this.options.defaultColDef);
    if (kind === false) return;

    const t = this.theme;
    const width = Math.max(col.width, 200);
    const cellX = headerCellX(this.env(), col) ?? 0;
    const left = Math.max(0, Math.min(cellX, this.viewWidth - width - 2));
    const popup = document.createElement('div');
    this.headerFilterPopup = popup;
    Object.assign(popup.style, {
      position: 'absolute',
      left: `${left}px`,
      top: `${this.headerTop() + cellBottom}px`,
      width: `${width}px`,
      maxHeight: '300px',
      display: 'flex',
      flexDirection: 'column',
      boxSizing: 'border-box',
      background: t.raised,
      border: `1px solid ${withAlpha(t.textSecondary, 0.25)}`,
      borderRadius: '3px',
      boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
      zIndex: '40',
      font: `${t.fontSize - 1}px ${t.fontSans}`,
      color: t.textPrimary,
      padding: '6px',
      gap: '6px',
    } satisfies Partial<CSSStyleDeclaration>);
    popup.addEventListener('mousedown', (e) => e.stopPropagation());

    const mkInput = (placeholder: string): HTMLInputElement => {
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = placeholder;
      Object.assign(input.style, {
        width: '100%',
        boxSizing: 'border-box',
        height: '24px',
        background: t.base,
        color: t.textPrimary,
        border: `1px solid ${t.structural}`,
        borderRadius: '2px',
        outline: 'none',
        margin: '0',
        padding: '0 6px',
        font: `${t.fontSize - 1}px ${t.fontSans}`,
      } satisfies Partial<CSSStyleDeclaration>);
      input.addEventListener('focus', () => (input.style.borderColor = t.accent));
      input.addEventListener('blur', () => (input.style.borderColor = t.structural));
      return input;
    };

    if (kind === 'set') {
      const values = this.getDistinctValues(colId);
      const existing = this.rows.filterModel[colId];
      const selected = existing?.type === 'set' ? new Set(existing.values) : new Set(values);
      const apply = (): void => {
        if (selected.size === values.length) this.setColumnFilter(colId, null);
        else this.setColumnFilter(colId, { type: 'set', values: values.filter((v) => selected.has(v)) });
      };

      const search = mkInput('Search…');
      popup.appendChild(search);

      const list = document.createElement('div');
      Object.assign(list.style, {
        overflowY: 'auto',
        flex: '1',
        margin: '0 -6px -6px',
        padding: '0 0 4px',
      } satisfies Partial<CSSStyleDeclaration>);
      popup.appendChild(list);

      const mkRow = (label: string, checked: boolean, onToggle: (on: boolean) => void) => {
        const row = document.createElement('label');
        Object.assign(row.style, {
          display: 'flex',
          alignItems: 'center',
          gap: '7px',
          padding: `3px ${t.paddingX}px`,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        } satisfies Partial<CSSStyleDeclaration>);
        row.addEventListener('mouseenter', () => (row.style.background = withAlpha(t.accent, 0.12)));
        row.addEventListener('mouseleave', () => (row.style.background = 'transparent'));
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checked;
        cb.style.accentColor = t.accent;
        cb.style.margin = '0';
        cb.addEventListener('change', () => onToggle(cb.checked));
        const span = document.createElement('span');
        span.textContent = label;
        span.style.overflow = 'hidden';
        span.style.textOverflow = 'ellipsis';
        row.appendChild(cb);
        row.appendChild(span);
        return { row, cb };
      };

      const valueRows: { value: string; row: HTMLLabelElement; cb: HTMLInputElement }[] = [];
      const selectAll = mkRow('(Select All)', selected.size === values.length, (on) => {
        selected.clear();
        if (on) for (const v of values) selected.add(v);
        for (const vr of valueRows) vr.cb.checked = on;
        syncSelectAll();
        apply();
      });
      selectAll.row.style.borderBottom = `1px solid ${withAlpha(t.textSecondary, 0.15)}`;
      selectAll.row.style.fontWeight = '600';
      list.appendChild(selectAll.row);

      const syncSelectAll = (): void => {
        selectAll.cb.checked = selected.size === values.length;
        selectAll.cb.indeterminate = selected.size > 0 && selected.size < values.length;
      };
      syncSelectAll();

      for (const v of values) {
        const { row, cb } = mkRow(v, selected.has(v), (on) => {
          if (on) selected.add(v);
          else selected.delete(v);
          syncSelectAll();
          apply();
        });
        valueRows.push({ value: v, row, cb });
        list.appendChild(row);
      }

      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        for (const vr of valueRows) {
          vr.row.style.display = !q || vr.value.toLowerCase().includes(q) ? 'flex' : 'none';
        }
      });
      search.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || e.key === 'Enter') {
          this.closeHeaderFilterPopup();
          this.root.focus();
        }
      });
      this.root.appendChild(popup);
      search.focus();
    } else if (kind === 'date') {
      // AG agDateColumnFilter: operator select + date input(s).
      const existing = this.rows.filterModel[colId];
      const cur = existing && isDateFilter(existing) ? existing : null;

      const select = document.createElement('select');
      Object.assign(select.style, {
        width: '100%',
        boxSizing: 'border-box',
        height: '24px',
        background: t.base,
        color: t.textPrimary,
        border: `1px solid ${t.structural}`,
        borderRadius: '2px',
        outline: 'none',
        padding: '0 4px',
        font: `${t.fontSize - 1}px ${t.fontSans}`,
      } satisfies Partial<CSSStyleDeclaration>);
      const OPTIONS: Array<{ value: DateColumnFilter['type']; label: string }> = [
        { value: 'equals', label: 'Equals' },
        { value: 'notEqual', label: 'Does not equal' },
        { value: 'lessThan', label: 'Before' },
        { value: 'greaterThan', label: 'After' },
        { value: 'inRange', label: 'Between' },
        { value: 'blank', label: 'Blank' },
        { value: 'notBlank', label: 'Not blank' },
      ];
      for (const o of OPTIONS) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        select.appendChild(opt);
      }
      select.value = cur?.type ?? 'equals';

      const mkDate = (): HTMLInputElement => {
        const input = mkInput('');
        input.type = 'date';
        input.style.font = `${t.fontSize - 1}px ${t.fontMono}`;
        return input;
      };
      const from = mkDate();
      const to = mkDate();
      from.value = cur?.dateFrom?.slice(0, 10) ?? '';
      to.value = cur?.dateTo?.slice(0, 10) ?? '';

      const sync = (): void => {
        const type = select.value as DateColumnFilter['type'];
        const needsDates = type !== 'blank' && type !== 'notBlank';
        from.style.display = needsDates ? 'block' : 'none';
        to.style.display = type === 'inRange' ? 'block' : 'none';
      };
      const apply = (): void => {
        const type = select.value as DateColumnFilter['type'];
        if (type === 'blank' || type === 'notBlank') {
          this.setColumnFilter(colId, { filterType: 'date', type, dateFrom: null });
          return;
        }
        if (!from.value) {
          this.setColumnFilter(colId, null);
          return;
        }
        this.setColumnFilter(colId, {
          filterType: 'date',
          type,
          dateFrom: from.value,
          dateTo: type === 'inRange' && to.value ? to.value : null,
        });
      };
      select.addEventListener('change', () => {
        sync();
        apply();
      });
      from.addEventListener('change', apply);
      to.addEventListener('change', apply);
      for (const el of [select, from, to] as HTMLElement[]) {
        el.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter' || e.key === 'Escape') {
            this.closeHeaderFilterPopup();
            this.root.focus();
          }
        });
      }
      sync();
      popup.appendChild(select);
      popup.appendChild(from);
      popup.appendChild(to);
      this.root.appendChild(popup);
      from.focus();
    } else {
      const input = mkInput(kind === 'number' ? 'e.g. > 100' : 'Filter…');
      input.value = formatFilterDisplay(this.rows.filterModel[colId]);
      if (kind === 'number') {
        input.style.font = `${t.fontSize - 1}px ${t.fontMono}`;
        input.style.textAlign = 'right';
      }
      let debounce: ReturnType<typeof setTimeout> | null = null;
      input.addEventListener('input', () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = null;
          this.setColumnFilter(colId, parseFloatingFilterInput(input.value, kind));
        }, 200);
      });
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' || e.key === 'Escape') {
          if (debounce) clearTimeout(debounce);
          if (e.key === 'Enter') this.setColumnFilter(colId, parseFloatingFilterInput(input.value, kind));
          this.closeHeaderFilterPopup();
          this.root.focus();
        }
      });
      popup.appendChild(input);
      this.root.appendChild(popup);
      input.focus();
      input.select();
    }

    const onDocDown = (e: MouseEvent): void => {
      if (this.headerFilterPopup && !this.headerFilterPopup.contains(e.target as Node)) {
        this.closeHeaderFilterPopup();
      }
    };
    document.addEventListener('mousedown', onDocDown, true);
    this.headerFilterPopupCleanup = () => document.removeEventListener('mousedown', onDocDown, true);
  }

  private closeHeaderFilterPopup(): void {
    if (!this.headerFilterPopup) return;
    this.headerFilterPopupCleanup?.();
    this.headerFilterPopupCleanup = null;
    this.headerFilterPopup.remove();
    this.headerFilterPopup = null;
  }

  // ── Choose Columns dialog (column menu → Choose Columns) ───────────

  /** AG `showColumnChooser()` — floating dialog hosting the columns tree. */
  showColumnChooser(): void {
    this.closeColumnChooser();
    const t = this.theme;
    const dlg = document.createElement('div');
    this.columnChooserEl = dlg;
    const width = 260;
    Object.assign(dlg.style, {
      position: 'absolute',
      left: `${Math.max(8, Math.round((this.viewWidth - width) / 2))}px`,
      top: `${this.headerTop() + 32}px`,
      width: `${width}px`,
      maxHeight: '440px',
      display: 'flex',
      flexDirection: 'column',
      boxSizing: 'border-box',
      background: t.overlay,
      border: `1px solid ${withAlpha(t.textSecondary, 0.25)}`,
      borderRadius: '4px',
      boxShadow: '0 8px 28px rgba(0,0,0,0.4)',
      zIndex: '60',
      font: `${t.fontSize}px ${t.fontSans}`,
      color: t.textPrimary,
      overflow: 'hidden',
    } satisfies Partial<CSSStyleDeclaration>);
    dlg.addEventListener('mousedown', (e) => e.stopPropagation());

    const titleBar = document.createElement('div');
    Object.assign(titleBar.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 10px',
      borderBottom: `1px solid ${withAlpha(t.textSecondary, 0.18)}`,
      fontWeight: '600',
      cursor: 'move',
      userSelect: 'none',
      flex: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    const title = document.createElement('span');
    title.textContent = 'Choose Columns';
    const close = document.createElement('button');
    close.type = 'button';
    close.innerHTML = iconSvg('x', 13);
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    Object.assign(close.style, {
      border: 'none',
      background: 'transparent',
      color: t.textSecondary,
      cursor: 'pointer',
      padding: '2px',
      display: 'flex',
      alignItems: 'center',
    } satisfies Partial<CSSStyleDeclaration>);
    close.onmouseenter = () => (close.style.color = t.textPrimary);
    close.onmouseleave = () => (close.style.color = t.textSecondary);
    close.onclick = () => this.closeColumnChooser();
    titleBar.appendChild(title);
    titleBar.appendChild(close);
    dlg.appendChild(titleBar);

    // Drag the dialog by its title bar.
    titleBar.addEventListener('mousedown', (e) => {
      if (e.target === close || close.contains(e.target as Node)) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = parseFloat(dlg.style.left);
      const startTop = parseFloat(dlg.style.top);
      const onMove = (me: MouseEvent): void => {
        dlg.style.left = `${startLeft + me.clientX - startX}px`;
        dlg.style.top = `${Math.max(0, startTop + me.clientY - startY)}px`;
      };
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });

    const body = document.createElement('div');
    Object.assign(body.style, {
      overflowY: 'auto',
      flex: '1',
      minHeight: '0',
    } satisfies Partial<CSSStyleDeclaration>);
    dlg.appendChild(body);

    // Columns tree only — the chooser hides pivot toggle and drop zones.
    const runtime: import('./toolPanels/columnsToolPanel').ColumnToolPanelRuntime = {
      pivotModeVisible: false,
      rowGroupsVisible: false,
      valuesVisible: false,
      pivotVisible: false,
    };
    const host = {
      theme: this.theme,
      api: this,
      cols: this.cols,
      options: this.options,
      headerLabel: this.headerLabel,
      refreshPanels: () => {
        this.renderGroupPanel();
        this.renderPivotPanel();
        this.sideBarCtrl?.refresh();
      },
      rerender: () => {
        body.replaceChildren();
        renderColumnsToolPanel(host, body, undefined, runtime);
      },
    };
    renderColumnsToolPanel(host, body, undefined, runtime);

    this.root.appendChild(dlg);

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') this.closeColumnChooser();
    };
    document.addEventListener('keydown', onKey, true);
    this.columnChooserCleanup = () => document.removeEventListener('keydown', onKey, true);
  }

  /** AG `hideColumnChooser()`. */
  hideColumnChooser(): void {
    this.closeColumnChooser();
  }

  private closeColumnChooser(): void {
    if (!this.columnChooserEl) return;
    this.columnChooserCleanup?.();
    this.columnChooserCleanup = null;
    this.columnChooserEl.remove();
    this.columnChooserEl = null;
  }

  private syncFloatingFilterClearButtons(env: PaintEnv<TData>): void {
    const layer = this.ffClearLayer;
    if (!layer || !this.cols.hasFloatingFilters()) {
      this.removeFloatingFilterClearButtons();
      return;
    }

    layer.style.height = `${this.headerHeight()}px`;

    const activeColIds = new Set(
      Object.keys(this.rows.filterModel).filter((colId) => {
        const col = this.cols.getColumn(colId);
        return col && this.cols.showsFloatingFilter(col);
      }),
    );

    for (const [colId, btn] of this.ffClearButtons) {
      if (!activeColIds.has(colId) || this.floatingFilter?.colId === colId) {
        btn.remove();
        this.ffClearButtons.delete(colId);
      }
    }

    const t = this.theme;
    for (const colId of activeColIds) {
      if (this.floatingFilter?.colId === colId) continue;
      const rect = floatingFilterRect(env, colId);
      if (!rect) continue;

      let btn = this.ffClearButtons.get(colId);
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.innerHTML = iconSvg('x', 13);
        btn.title = 'Clear filter';
        btn.setAttribute('aria-label', 'Clear filter');
        btn.addEventListener('mousedown', (e) => e.stopPropagation());
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          this.setColumnFilter(colId, null);
        });
        this.ffClearButtons.set(colId, btn);
        layer.appendChild(btn);
      }

      // Sits inside the painted input box, flush right (AG clear affordance).
      const geom = floatingFilterInputGeom(rect.w, rect.h);
      const size = FLOATING_FILTER_CLEAR_SIZE;
      const left = rect.x + geom.x + geom.w - size - 1;
      Object.assign(btn.style, {
        position: 'absolute',
        left: `${left}px`,
        top: `${rect.y + geom.y + (geom.h - size) / 2}px`,
        width: `${size}px`,
        height: `${size}px`,
        padding: '0',
        margin: '0',
        border: 'none',
        borderRadius: '2px',
        background: 'transparent',
        color: t.textSecondary,
        cursor: 'pointer',
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      } satisfies Partial<CSSStyleDeclaration>);
      btn.onmouseenter = () => {
        btn!.style.background = withAlpha(t.textSecondary, 0.15);
        btn!.style.color = t.textPrimary;
      };
      btn.onmouseleave = () => {
        btn!.style.background = 'transparent';
        btn!.style.color = t.textSecondary;
      };
    }
  }

  private removeFloatingFilterClearButtons(): void {
    for (const btn of this.ffClearButtons.values()) btn.remove();
    this.ffClearButtons.clear();
  }

  // ── row group panel ───────────────────────────────────────────────

  private canRowGroup(col: InternalColumn<TData> | undefined): boolean {
    return !!col && col.def.enableRowGroup === true && col.def.rowGroup !== true;
  }

  private isOverGroupPanel(clientX: number, clientY: number): boolean {
    if (!this.groupPanel || !this.groupPanelVisible()) return false;
    const r = this.groupPanel.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  /** Rebuild everything after add/remove/reorder of row group columns. */
  private commitRowGroupChange(): void {
    this.emit('columnRowGroupChanged', {
      colIds: this.cols.getRowGroupCols().map((c) => c.colId),
    });
    this.refreshModel(false);
    this.renderGroupPanel();
    this.layout();
  }

  /** AG column-drop title bar: leading icon identifying the panel. */
  private panelTitleIcon(name: IconName): HTMLSpanElement {
    const icon = document.createElement('span');
    icon.innerHTML = iconSvg(name, 16);
    Object.assign(icon.style, {
      color: this.theme.textSecondary,
      display: 'inline-flex',
      alignItems: 'center',
      flex: 'none',
      marginRight: '4px',
      pointerEvents: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    return icon;
  }

  private renderGroupPanel(): void {
    const panel = this.groupPanel;
    if (!panel) return;
    const t = this.theme;
    this.removePanelIndicator();
    panel.innerHTML = '';
    panel.style.background = t.headerBg;
    panel.appendChild(this.panelTitleIcon('group'));

    const groups = this.cols.rowGroupColumns();
    if (!groups.length) {
      const hint = document.createElement('span');
      hint.textContent = 'Drag here to set row groups';
      Object.assign(hint.style, {
        color: t.textTertiary,
        pointerEvents: 'none',
      } satisfies Partial<CSSStyleDeclaration>);
      panel.appendChild(hint);
      return;
    }

    groups.forEach((col, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.innerHTML = iconSvg('chevron-right', 12);
        sep.style.color = t.textTertiary;
        sep.style.pointerEvents = 'none';
        sep.style.display = 'inline-flex';
        sep.style.alignItems = 'center';
        panel.appendChild(sep);
      }

      const chip = document.createElement('div');
      chip.dataset.groupChip = col.colId;
      Object.assign(chip.style, {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '2px 8px',
        borderRadius: '3px',
        border: `1px solid ${t.structural}`,
        background: t.raised,
        color: t.textPrimary,
        cursor: 'grab',
        userSelect: 'none',
      } satisfies Partial<CSSStyleDeclaration>);

      // AG chips lead with a drag grip.
      const grip = document.createElement('span');
      grip.textContent = '⋮⋮';
      Object.assign(grip.style, {
        color: t.textTertiary,
        fontSize: '9px',
        letterSpacing: '1px',
        pointerEvents: 'none',
      } satisfies Partial<CSSStyleDeclaration>);
      chip.appendChild(grip);

      const label = document.createElement('span');
      label.textContent = col.def.headerName ?? col.colId;
      chip.appendChild(label);

      const x = document.createElement('span');
      x.innerHTML = iconSvg('x', 14);
      x.title = 'Remove row group';
      Object.assign(x.style, {
        color: t.textSecondary,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
      } satisfies Partial<CSSStyleDeclaration>);
      x.addEventListener('mouseenter', () => (x.style.color = t.textPrimary));
      x.addEventListener('mouseleave', () => (x.style.color = t.textSecondary));
      x.addEventListener('mousedown', (e) => e.stopPropagation());
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.cols.removeRowGroupColumn(col.colId)) this.commitRowGroupChange();
      });
      chip.appendChild(x);

      chip.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this.chipDrag = { colId: col.colId, startX: e.clientX, startY: e.clientY, moved: false };
      });

      panel.appendChild(chip);
    });
    this.sideBarCtrl?.refresh();
  }

  private ensureDragGhost(label: string): HTMLDivElement {
    if (this.dragGhost) return this.dragGhost;
    const t = this.theme;
    const ghost = document.createElement('div');
    ghost.textContent = label;
    Object.assign(ghost.style, {
      position: 'fixed',
      zIndex: '10000',
      padding: '3px 10px',
      borderRadius: '3px',
      border: `1px solid ${t.accent}`,
      background: t.overlay,
      color: t.textPrimary,
      font: `${t.fontSize}px ${t.fontSans}`,
      pointerEvents: 'none',
      boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
      opacity: '0.9',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(ghost);
    this.dragGhost = ghost;
    // No native text selection while a grid drag is live.
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
    return ghost;
  }

  private moveDragGhost(clientX: number, clientY: number): void {
    if (!this.dragGhost) return;
    // Center the ghost on the pointer (pointer-events: none keeps hit-testing clear).
    this.dragGhost.style.left = `${clientX - this.dragGhost.offsetWidth / 2}px`;
    this.dragGhost.style.top = `${clientY - this.dragGhost.offsetHeight / 2}px`;
  }

  private removeDragGhost(): void {
    if (this.dragGhost) {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
    this.dragGhost?.remove();
    this.dragGhost = null;
    if (this.groupPanel) this.groupPanel.style.background = this.theme.headerBg;
    if (this.pivotPanel) this.pivotPanel.style.background = this.theme.headerBg;
  }

  /** Chip drop: reorder within the panel, or ungroup when dropped outside (AG Grid). */
  private finishChipDrag(e: MouseEvent): void {
    const drag = this.chipDrag!;
    this.chipDrag = null;
    this.removeDragGhost();
    this.removePanelIndicator();
    if (!drag.moved) return;

    if (!this.isOverGroupPanel(e.clientX, e.clientY)) {
      if (this.cols.removeRowGroupColumn(drag.colId)) this.commitRowGroupChange();
      return;
    }

    const order = this.cols.rowGroupColumns().map((c) => c.colId);
    const from = order.indexOf(drag.colId);
    if (from < 0) return;
    order.splice(from, 1);
    const to = this.panelInsertIndexAt(e.clientX, drag.colId);
    if (to === from) return;
    order.splice(to, 0, drag.colId);
    this.cols.setRowGroupColumns(order);
    this.commitRowGroupChange();
  }

  private finishPivotChipDrag(e: MouseEvent): void {
    const drag = this.pivotChipDrag!;
    this.pivotChipDrag = null;
    this.removeDragGhost();
    if (!drag.moved) return;
    if (!this.isOverPivotPanel(e.clientX, e.clientY)) {
      if (this.cols.removePivotColumn(drag.colId)) this.commitPivotChange();
      return;
    }
    const order = this.cols.pivotColumns().map((c) => c.colId);
    const from = order.indexOf(drag.colId);
    if (from < 0) return;
    order.splice(from, 1);
    const chips = this.pivotPanel
      ? [...this.pivotPanel.querySelectorAll<HTMLElement>('[data-pivot-chip]')].filter(
          (c) => c.dataset.pivotChip !== drag.colId,
        )
      : [];
    let to = chips.length;
    for (let i = 0; i < chips.length; i++) {
      const r = chips[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) {
        to = i;
        break;
      }
    }
    if (to === from) return;
    order.splice(to, 0, drag.colId);
    this.cols.setPivotColumns(order);
    this.commitPivotChange();
  }

  /**
   * Insertion slot for a drop at clientX, by chip midpoints (the slot the
   * indicator shows). `excludeColId` ignores the chip being reordered.
   */
  private panelInsertIndexAt(clientX: number, excludeColId?: string): number {
    if (!this.groupPanel) return 0;
    const chips = [...this.groupPanel.querySelectorAll<HTMLElement>('[data-group-chip]')].filter(
      (c) => c.dataset.groupChip !== excludeColId,
    );
    for (let i = 0; i < chips.length; i++) {
      const r = chips[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return chips.length;
  }

  /** Vertical drop-position bar inside the panel. */
  private updatePanelIndicator(clientX: number, excludeColId?: string): void {
    const panel = this.groupPanel;
    if (!panel) return;
    if (!this.panelIndicator) {
      this.panelIndicator = document.createElement('div');
      Object.assign(this.panelIndicator.style, {
        position: 'absolute',
        top: '20%',
        height: '60%',
        width: '2px',
        background: this.theme.accent,
        pointerEvents: 'none',
        borderRadius: '1px',
      } satisfies Partial<CSSStyleDeclaration>);
      panel.appendChild(this.panelIndicator);
    }
    const panelRect = panel.getBoundingClientRect();
    const chips = [...panel.querySelectorAll<HTMLElement>('[data-group-chip]')].filter(
      (c) => c.dataset.groupChip !== excludeColId,
    );
    const idx = this.panelInsertIndexAt(clientX, excludeColId);
    let x: number;
    if (!chips.length) {
      x = this.theme.paddingX + 2;
    } else if (idx >= chips.length) {
      x = chips[chips.length - 1].getBoundingClientRect().right - panelRect.left + 4;
    } else {
      x = chips[idx].getBoundingClientRect().left - panelRect.left - 5;
    }
    this.panelIndicator.style.left = `${Math.max(2, x)}px`;
  }

  private removePanelIndicator(): void {
    this.panelIndicator?.remove();
    this.panelIndicator = null;
  }

  // ── floating filters ──────────────────────────────────────────────

  private openFloatingFilter(colId: string): void {
    this.closeFloatingFilter();
    const col = this.cols.getColumn(colId);
    if (!col) return;
    const rect = floatingFilterRect(this.env(), colId);
    if (!rect) return;

    const t = this.theme;
    const kind = resolveFilterKind(col, this.options.defaultColDef);
    if (kind === 'set') {
      this.openSetFilter(colId);
      return;
    }

    // Register the DOM editor exactly over the painted input box.
    const geom = floatingFilterInputGeom(rect.w, rect.h);
    const baseTop = this.headerTop() + rect.y + geom.y;
    const baseH = geom.h;

    const wrap = document.createElement('div');
    Object.assign(wrap.style, {
      position: 'absolute',
      left: `${rect.x + geom.x}px`,
      top: `${baseTop}px`,
      width: `${geom.w}px`,
      height: `${baseH}px`,
      boxSizing: 'border-box',
      display: 'flex',
      alignItems: 'stretch',
      background: t.base,
      border: `1px solid ${t.accent}`,
      borderRadius: '2px',
      zIndex: '12',
    } satisfies Partial<CSSStyleDeclaration>);

    const input = document.createElement('input');
    input.type = 'text';
    input.value = formatFilterDisplay(this.rows.filterModel[colId]);
    const isNumber = kind === 'number';
    Object.assign(input.style, {
      flex: '1',
      minWidth: '0',
      height: '100%',
      boxSizing: 'border-box',
      background: 'transparent',
      color: t.textPrimary,
      border: 'none',
      borderRadius: '0',
      outline: 'none',
      margin: '0',
      padding: `0 ${Math.max(2, t.paddingX - 2)}px`,
      font: `${t.fontSize - 1}px ${isNumber ? t.fontMono : t.fontSans}`,
      textAlign: isNumber ? 'right' : 'left',
    } satisfies Partial<CSSStyleDeclaration>);

    const state: FloatingFilterState = { colId, input, debounce: null };
    this.floatingFilter = state;
    let clearing = false;

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.innerHTML = iconSvg('x', 11);
    clearBtn.title = 'Clear filter';
    clearBtn.setAttribute('aria-label', 'Clear filter');
    Object.assign(clearBtn.style, {
      flex: `0 0 ${FLOATING_FILTER_CLEAR_SIZE}px`,
      width: `${FLOATING_FILTER_CLEAR_SIZE}px`,
      height: '100%',
      padding: '0',
      margin: '0',
      border: 'none',
      borderRadius: '2px',
      background: withAlpha(t.textSecondary, 0.14),
      color: t.textSecondary,
      cursor: 'pointer',
      alignItems: 'center',
      justifyContent: 'center',
      display: 'none',
    } satisfies Partial<CSSStyleDeclaration>);

    const updateClearBtn = (): void => {
      const show = input.value.length > 0;
      clearBtn.style.display = show ? 'flex' : 'none';
    };

    const scheduleApply = (): void => {
      if (state.debounce) clearTimeout(state.debounce);
      state.debounce = setTimeout(() => {
        state.debounce = null;
        const filter = parseFloatingFilterInput(input.value, kind);
        if (filter) this.rows.filterModel[colId] = filter;
        else delete this.rows.filterModel[colId];
        this.refreshModel();
        this.emit('filterChanged', {
          filterModel: this.rows.filterModel,
          quickFilter: this.rows.quickFilter,
        });
      }, 200);
    };

    const focusWrap = (): void => {
      // Overlap the header/ff seam by 1px so focus ring is a single top edge, not double.
      wrap.style.top = `${baseTop - 1}px`;
      wrap.style.height = `${baseH + 1}px`;
      wrap.style.border = `1px solid ${t.accent}`;
      wrap.style.background = t.overlay;
    };

    input.addEventListener('focus', focusWrap);
    input.addEventListener('input', () => {
      updateClearBtn();
      const filter = parseFloatingFilterInput(input.value, kind);
      this.emit('filterModified', { colId, filter });
      scheduleApply();
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        if (state.debounce) clearTimeout(state.debounce);
        const filter = parseFloatingFilterInput(input.value, kind);
        this.setColumnFilter(colId, filter);
        this.closeFloatingFilter();
        this.root.focus();
      } else if (e.key === 'Escape') {
        if (state.debounce) clearTimeout(state.debounce);
        this.closeFloatingFilter();
        this.root.focus();
      }
    });
    input.addEventListener('blur', () => {
      if (this.floatingFilter !== state || clearing) return;
      if (state.debounce) clearTimeout(state.debounce);
      const filter = parseFloatingFilterInput(input.value, kind);
      this.setColumnFilter(colId, filter);
      this.closeFloatingFilter();
    });

    wrap.appendChild(input);

    clearBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearing = true;
      if (state.debounce) clearTimeout(state.debounce);
      input.value = '';
      updateClearBtn();
      this.setColumnFilter(colId, null);
      clearing = false;
      input.focus();
    });
    clearBtn.onmouseenter = () => {
      clearBtn.style.background = withAlpha(t.accent, 0.2);
      clearBtn.style.color = t.textPrimary;
    };
    clearBtn.onmouseleave = () => {
      clearBtn.style.background = withAlpha(t.textSecondary, 0.14);
      clearBtn.style.color = t.textSecondary;
    };
    wrap.appendChild(clearBtn);
    updateClearBtn();

    this.root.appendChild(wrap);
    this.removeFloatingFilterClearButtons();
    focusWrap();
    input.focus();
    this.requestPaint();
    input.select();
  }

  private closeFloatingFilter(): void {
    const ff = this.floatingFilter;
    if (!ff) return;
    // Null the state *before* touching the DOM: removing the focused input
    // fires a synchronous blur whose handler would otherwise re-enter here.
    this.floatingFilter = null;
    if (ff.debounce) clearTimeout(ff.debounce);
    ff.input.parentElement?.remove();
    this.requestPaint();
  }

  // ── set filter (checkbox dropdown, AG Grid set filter parity) ─────

  /** Distinct stringified values for a column from the unfiltered row set. */
  getDistinctValues(colId: string, limit = 1000): string[] {
    const col = this.cols.getColumn(colId);
    if (!col) return [];
    const seen = new Set<string>();
    const rows = this.rows.sourceRows;
    for (let i = 0; i < rows.length && seen.size < limit; i++) {
      seen.add(setFilterKey(this.valueOf(rows[i], col, i)));
    }
    return [...seen].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  /**
   * Set filter: the floating filter cell becomes the search input and a
   * checkbox dropdown ((Select All) + one row per distinct value) is anchored
   * beneath it. Typing narrows the list; toggles apply live; all-selected
   * clears the filter entirely (AG Grid semantics).
   */
  private openSetFilter(colId: string): void {
    this.closeSetFilter();
    this.closeFloatingFilter();
    const col = this.cols.getColumn(colId);
    const rect = floatingFilterRect(this.env(), colId);
    if (!col || !rect) return;

    const t = this.theme;
    const values = this.getDistinctValues(colId);
    const existing = this.rows.filterModel[colId];
    const selected =
      existing?.type === 'set' ? new Set(existing.values) : new Set(values);

    const apply = (): void => {
      if (selected.size === values.length) this.setColumnFilter(colId, null);
      else this.setColumnFilter(colId, { type: 'set', values: values.filter((v) => selected.has(v)) });
    };

    // ── search input in the floating filter cell itself ──────────────
    const baseTop = this.headerTop() + rect.y;
    const wrap = document.createElement('div');
    Object.assign(wrap.style, {
      position: 'absolute',
      left: `${rect.x}px`,
      // Overlap the header/ff seam by 1px so focus ring is a single top edge.
      top: `${baseTop - 1}px`,
      width: `${rect.w}px`,
      height: `${rect.h + 1}px`,
      boxSizing: 'border-box',
      display: 'flex',
      alignItems: 'stretch',
      background: t.overlay,
      border: `1px solid ${t.accent}`,
      zIndex: '12',
    } satisfies Partial<CSSStyleDeclaration>);

    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = existing?.type === 'set' ? formatFilterDisplay(existing) : 'Search…';
    Object.assign(search.style, {
      flex: '1',
      minWidth: '0',
      height: '100%',
      boxSizing: 'border-box',
      background: 'transparent',
      color: t.textPrimary,
      border: 'none',
      borderRadius: '0',
      outline: 'none',
      margin: '0',
      padding: `0 ${Math.max(2, t.paddingX - 2)}px`,
      font: `${t.fontSize - 1}px ${t.fontSans}`,
      textAlign: 'left',
    } satisfies Partial<CSSStyleDeclaration>);
    wrap.appendChild(search);
    this.root.appendChild(wrap);
    // Registering as the active floating filter hides the painted cell text
    // and lets the shared close path remove the overlay.
    this.floatingFilter = { colId, input: search, debounce: null };

    // ── checkbox dropdown ─────────────────────────────────────────────
    const width = Math.max(rect.w, 200);
    const left = Math.max(0, Math.min(rect.x, this.viewWidth - width - 2));
    const popup = document.createElement('div');
    this.setFilterPopup = popup;
    Object.assign(popup.style, {
      position: 'absolute',
      left: `${left}px`,
      top: `${this.headerTop() + rect.y + rect.h}px`,
      width: `${width}px`,
      maxHeight: '280px',
      display: 'flex',
      flexDirection: 'column',
      boxSizing: 'border-box',
      background: t.raised,
      border: `1px solid ${withAlpha(t.textSecondary, 0.25)}`,
      borderRadius: '0 0 3px 3px',
      boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
      zIndex: '40',
      font: `${t.fontSize - 1}px ${t.fontSans}`,
      color: t.textPrimary,
    } satisfies Partial<CSSStyleDeclaration>);
    popup.addEventListener('mousedown', (e) => e.stopPropagation());

    const list = document.createElement('div');
    Object.assign(list.style, {
      overflowY: 'auto',
      flex: '1',
      padding: '0 0 4px',
    } satisfies Partial<CSSStyleDeclaration>);
    popup.appendChild(list);

    const mkRow = (label: string, checked: boolean, onToggle: (on: boolean) => void) => {
      const row = document.createElement('label');
      Object.assign(row.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '7px',
        padding: `3px ${t.paddingX}px`,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      } satisfies Partial<CSSStyleDeclaration>);
      row.addEventListener('mouseenter', () => (row.style.background = withAlpha(t.accent, 0.12)));
      row.addEventListener('mouseleave', () => (row.style.background = 'transparent'));
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      cb.style.accentColor = t.accent;
      cb.style.margin = '0';
      cb.addEventListener('change', () => {
        onToggle(cb.checked);
        // Hand focus back so the user can keep typing the search text.
        search.focus();
      });
      const span = document.createElement('span');
      span.textContent = label;
      span.style.overflow = 'hidden';
      span.style.textOverflow = 'ellipsis';
      row.appendChild(cb);
      row.appendChild(span);
      return { row, cb };
    };

    const valueRows: { value: string; row: HTMLLabelElement; cb: HTMLInputElement }[] = [];
    const selectAll = mkRow('(Select All)', selected.size === values.length, (on) => {
      selected.clear();
      if (on) for (const v of values) selected.add(v);
      for (const vr of valueRows) vr.cb.checked = on;
      syncSelectAll();
      apply();
    });
    selectAll.row.style.borderBottom = `1px solid ${withAlpha(t.textSecondary, 0.15)}`;
    selectAll.row.style.fontWeight = '600';
    list.appendChild(selectAll.row);

    const syncSelectAll = (): void => {
      selectAll.cb.checked = selected.size === values.length;
      selectAll.cb.indeterminate = selected.size > 0 && selected.size < values.length;
    };
    syncSelectAll();

    for (const v of values) {
      const { row, cb } = mkRow(v, selected.has(v), (on) => {
        if (on) selected.add(v);
        else selected.delete(v);
        syncSelectAll();
        apply();
      });
      valueRows.push({ value: v, row, cb });
      list.appendChild(row);
    }

    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      for (const vr of valueRows) {
        vr.row.style.display = !q || vr.value.toLowerCase().includes(q) ? 'flex' : 'none';
      }
    });
    search.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || e.key === 'Enter') {
        this.closeSetFilter();
        this.closeFloatingFilter();
        this.root.focus();
      }
    });
    this.root.appendChild(popup);
    search.focus();

    const onDocDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (
        this.setFilterPopup &&
        !this.setFilterPopup.contains(target) &&
        !wrap.contains(target)
      ) {
        this.closeSetFilter();
        this.closeFloatingFilter();
      }
    };
    document.addEventListener('mousedown', onDocDown, true);
    this.setFilterCleanup = () => document.removeEventListener('mousedown', onDocDown, true);
    this.requestPaint();
  }

  private closeSetFilter(): void {
    if (!this.setFilterPopup) return;
    this.setFilterCleanup?.();
    this.setFilterCleanup = null;
    this.setFilterPopup.remove();
    this.setFilterPopup = null;
    this.requestPaint();
  }

  // ── editing ───────────────────────────────────────────────────────

  /** Resolve `editable` (boolean or AG-style callback) for one cell. */
  private isCellEditable(col: InternalColumn<TData>, rowIndex: number): boolean {
    const e = col.def.editable;
    if (typeof e === 'function') {
      const node = this.rows.getDisplayedNode(rowIndex);
      return e({ data: node?.data ?? undefined, rowIndex, colDef: col.def });
    }
    return e === true;
  }

  /**
   * DOM editor overlay, pixel-registered to the canvas cell (§7.6): same
   * font, size, padding, and alignment as the painted cell.
   */
  startEdit(rowIndex: number, colId: string, initialChar: string | null): void {
    const col = this.cols.getColumn(colId);
    if (!col || !this.isCellEditable(col, rowIndex)) return;
    const node = this.rows.getDisplayedNode(rowIndex);
    if (!node || node.group || !node.data) return;
    if (this.editor) this.commitEdit();
    this.closeFloatingFilter();

    this.setFocusedCell(rowIndex, colId);
    this.ensureCellVisible(rowIndex, colId);

    const rect = cellRect(this.env(), rowIndex, colId);
    if (!rect) return;

    const t = this.theme;
    const row = node.data;
    const oldValue = this.valueOf(row, col, rowIndex);
    const isNumber = col.def.type === 'number' || typeof oldValue === 'number';

    // Component editor: cellEditorSelector wins, then colDef.cellEditor.
    let editorDef = col.def.cellEditor;
    let editorParams = col.def.cellEditorParams;
    if (col.def.cellEditorSelector) {
      const sel = col.def.cellEditorSelector({
        value: oldValue,
        data: row,
        rowIndex,
        colDef: col.def,
        api: this,
      });
      if (sel?.component !== undefined) {
        editorDef = sel.component;
        if (sel.params !== undefined) editorParams = sel.params;
      }
    }
    if (editorDef !== undefined) {
      const factory =
        typeof editorDef === 'string' ? this.resolveCellEditorFactory(editorDef) : editorDef;
      if (factory) {
        this.startComponentEdit(factory, col, row, rowIndex, rect, oldValue, initialChar, editorParams);
        return;
      }
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.value = initialChar ?? (oldValue == null ? '' : String(oldValue));
    Object.assign(input.style, {
      position: 'absolute',
      left: `${rect.x}px`,
      top: `${this.headerTop() + this.headerHeight() + rect.y}px`,
      width: `${rect.w}px`,
      height: `${rect.h}px`,
      boxSizing: 'border-box',
      background: t.overlay,
      color: t.textPrimary,
      border: `2px solid ${t.accent}`,
      borderRadius: '0',
      outline: 'none',
      margin: '0',
      padding: `0 ${Math.max(0, t.paddingX - 2)}px`,
      font: `500 ${t.fontSize}px ${isNumber ? t.fontMono : t.fontSans}`,
      textAlign: col.def.align ?? (isNumber ? 'right' : 'left'),
      zIndex: '10',
    } satisfies Partial<CSSStyleDeclaration>);

    const state: EditorState = { rowIndex, colId, el: input, input, comp: null, oldValue, canceled: false };
    this.editor = state;

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        this.commitEdit();
        this.root.focus();
        this.moveFocus(1, 0);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        this.commitEdit();
        this.root.focus();
        this.moveFocus(0, e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        this.cancelEdit(state);
      }
    });
    input.addEventListener('blur', () => {
      if (this.editor === state && !state.canceled) this.commitEdit();
    });

    this.root.appendChild(input);
    input.focus();
    if (initialChar === null) {
      input.select(); // Enter/F2/dblclick — replace mode selects all
    } else {
      input.setSelectionRange(input.value.length, input.value.length);
    }
    this.emit('cellEditingStarted', { rowIndex, colId, data: node.data ?? undefined });
  }

  /** Escape pressed — revert, close and notify. */
  private cancelEdit(state: EditorState): void {
    state.canceled = true;
    const data = this.rows.displayed[state.rowIndex] ?? undefined;
    this.closeEditor();
    this.emit('cellEditingStopped', {
      rowIndex: state.rowIndex,
      colId: state.colId,
      data,
      oldValue: state.oldValue,
      newValue: state.oldValue,
      valueChanged: false,
    });
    this.root.focus();
  }

  /** Mount a component cell editor (AG `ICellEditor` contract subset). */
  private startComponentEdit(
    factory: CellEditorFactory<TData>,
    col: InternalColumn<TData>,
    row: TData,
    rowIndex: number,
    rect: { x: number; y: number; w: number; h: number },
    oldValue: unknown,
    initialChar: string | null,
    editorParams?: unknown,
  ): void {
    const state: EditorState = {
      rowIndex,
      colId: col.colId,
      el: null as unknown as HTMLElement,
      input: null,
      comp: null,
      oldValue,
      canceled: false,
    };
    const params: CellEditorParams<TData> = {
      value: oldValue,
      data: row,
      rowIndex,
      colDef: col.def,
      api: this,
      eventKey: initialChar,
      cellEditorParams: editorParams ?? col.def.cellEditorParams,
      stopEditing: (cancel = false) => {
        if (this.editor !== state) return;
        if (cancel) {
          this.cancelEdit(state);
        } else {
          this.commitEdit();
          this.root.focus();
        }
      },
      parseValue: (v: string) => this.parseEditorInput(col, row, oldValue, v),
      formatValue: (v: unknown) =>
        col.def.valueFormatter
          ? col.def.valueFormatter({ value: v, data: row, rowIndex, colDef: col.def, api: this })
          : v == null
            ? ''
            : String(v),
      theme: this.theme,
    };
    const comp = factory(params);
    if (comp.isCancelBeforeStart?.()) return;
    const el = comp.getGui();
    const popup = comp.isPopup?.() === true;
    const under = popup && comp.getPopupPosition?.() === 'under';
    const topBase = this.headerTop() + this.headerHeight() + rect.y;
    Object.assign(el.style, {
      position: 'absolute',
      left: `${rect.x}px`,
      top: `${under ? topBase + rect.h : topBase}px`,
      zIndex: '10',
    } satisfies Partial<CSSStyleDeclaration>);
    if (!popup) {
      el.style.width = `${rect.w}px`;
      el.style.height = `${rect.h}px`;
    }
    state.el = el;
    state.comp = comp;
    this.editor = state;

    el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const inTextArea = e.target instanceof HTMLTextAreaElement;
      if (e.key === 'Enter' && !inTextArea) {
        this.commitEdit();
        this.root.focus();
        this.moveFocus(1, 0);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        this.commitEdit();
        this.root.focus();
        this.moveFocus(0, e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        this.cancelEdit(state);
      }
    });
    el.addEventListener('focusout', (e) => {
      const next = (e as FocusEvent).relatedTarget;
      if (next instanceof Node && el.contains(next)) return;
      if (this.editor === state && !state.canceled) this.commitEdit();
    });

    this.root.appendChild(el);
    comp.afterGuiAttached?.();
    this.emit('cellEditingStarted', { rowIndex, colId: col.colId, data: row });
  }

  /** Shared string → value coercion (valueParser, then numeric columns). */
  private parseEditorInput(
    col: InternalColumn<TData>,
    row: TData,
    oldValue: unknown,
    raw: string,
  ): unknown {
    if (col.def.valueParser) {
      return col.def.valueParser({ newValue: raw, oldValue, data: row });
    }
    if (col.def.type === 'number' || typeof oldValue === 'number') {
      const n = Number(raw.replace(/,/g, ''));
      return Number.isNaN(n) ? oldValue : n;
    }
    return raw;
  }

  private commitEdit(): void {
    const ed = this.editor;
    if (!ed) return;
    const col = this.cols.getColumn(ed.colId);
    const row = this.rows.displayed[ed.rowIndex];
    const raw = ed.input?.value ?? '';
    // Component editors deliver typed values; isCancelAfterEnd can veto.
    const compValue = ed.comp ? ed.comp.getValue() : undefined;
    const compVeto = ed.comp?.isCancelAfterEnd?.() === true;
    this.closeEditor();
    if (!col || row == null) return;
    const stopped = (newValue: unknown, valueChanged: boolean): void =>
      this.emit('cellEditingStopped', {
        rowIndex: ed.rowIndex,
        colId: ed.colId,
        data: row,
        oldValue: ed.oldValue,
        newValue,
        valueChanged,
      });

    let parsed: unknown;
    if (ed.comp) {
      if (compVeto) {
        stopped(ed.oldValue, false);
        return;
      }
      parsed = compValue;
    } else if (col.def.valueParser) {
      parsed = col.def.valueParser({ newValue: raw, oldValue: ed.oldValue, data: row });
    } else if (col.def.type === 'number' || typeof ed.oldValue === 'number') {
      const n = Number(raw.replace(/,/g, ''));
      if (Number.isNaN(n)) {
        stopped(ed.oldValue, false);
        return; // reject — revert silently
      }
      parsed = n;
    } else {
      parsed = raw;
    }
    if (parsed === ed.oldValue) {
      stopped(ed.oldValue, false);
      return;
    }

    const field = col.def.field;
    if (field && !field.includes('.')) {
      (row as Record<string, unknown>)[field] = parsed;
    }
    const rowId = this.rows.getId(row);
    if (typeof parsed === 'number' && typeof ed.oldValue === 'number') {
      this.flashMgr.flash(`${rowId}\u0000${col.colId}`, parsed > ed.oldValue ? 1 : -1);
    } else {
      this.flashMgr.flash(`${rowId}\u0000${col.colId}`, 0);
    }
    this.pushUndo([{ rowId, colId: col.colId, oldValue: ed.oldValue, newValue: parsed }]);
    this.emit('cellValueChanged', {
      data: row,
      colId: col.colId,
      oldValue: ed.oldValue,
      newValue: parsed,
      rowIndex: ed.rowIndex,
    });
    stopped(parsed, true);
    this.updateStatusBar();
    this.requestPaint();
  }

  private closeEditor(): void {
    if (!this.editor) return;
    const { el, comp } = this.editor;
    this.editor = null;
    comp?.destroy?.();
    el.remove();
    this.requestPaint();
  }

  private moveFocus(dr: number, dc: number): void {
    if (!this.focused) return;
    const displayed = this.cols.displayed();
    const ci = displayed.findIndex((c) => c.colId === this.focused!.colId);
    const rowIndex = clampInt(this.focused.rowIndex + dr, 0, this.rows.displayed.length - 1);
    const colIndex = clampInt(ci + dc, 0, displayed.length - 1);
    this.setFocusedCell(rowIndex, displayed[colIndex].colId);
    this.ensureCellVisible(rowIndex, displayed[colIndex].colId);
    this.requestPaint();
  }

  // ── public API ────────────────────────────────────────────────────

  /** AG `getPinnedTopRowCount`. */
  getPinnedTopRowCount(): number {
    return this.options.pinnedTopRowData?.length ?? 0;
  }

  /** AG `getPinnedBottomRowCount`. */
  getPinnedBottomRowCount(): number {
    return this.options.pinnedBottomRowData?.length ?? 0;
  }

  /** AG `getPinnedTopRow` (minimal row-node shape). */
  getPinnedTopRow(index: number): { data: TData; rowIndex: number; rowPinned: 'top' } | undefined {
    const data = this.options.pinnedTopRowData?.[index];
    return data === undefined ? undefined : { data, rowIndex: index, rowPinned: 'top' };
  }

  /** AG `getPinnedBottomRow` (minimal row-node shape). */
  getPinnedBottomRow(
    index: number,
  ): { data: TData; rowIndex: number; rowPinned: 'bottom' } | undefined {
    const data = this.options.pinnedBottomRowData?.[index];
    return data === undefined ? undefined : { data, rowIndex: index, rowPinned: 'bottom' };
  }

  setRowData(rows: TData[]): void {
    this.workerCoord.onRowDataReset(rows);
    this.rows.setRowData(rows);
    this.flashMgr.clear();
    // New data ends a loading state (AG Grid), unless `loading: true` pins it.
    if (this.overlayState === 'loading' && this.options.loading !== true) {
      this.overlayState = 'none';
    }
    this.renderOverlay();
    this.refreshModel();
  }

  private flashCellChange(change: { rowId: string; colKey: string; dir: 1 | -1 | 0 }): void {
    const col = this.cols.getColumn(change.colKey);
    if (!col || !cellChangeFlashEnabled(col.def)) return;
    this.flashMgr.flash(`${change.rowId}\u0000${change.colKey}`, change.dir);
  }

  private snapshotPrevBeforeTransaction(tx: RowDataTransaction<TData>): void {
    for (const row of tx.update ?? []) {
      const id = this.rows.getId(row);
      const old = this.rows.getRowById(id);
      if (!old) continue;
      let bag = this.prevByRow.get(id);
      if (!bag) {
        bag = new Map();
        this.prevByRow.set(id, bag);
      }
      for (const key of Object.keys(row as object)) {
        if (Object.prototype.hasOwnProperty.call(old as object, key)) {
          bag.set(key, (old as Record<string, unknown>)[key]);
        }
      }
    }
  }

  applyTransaction(tx: RowDataTransaction<TData>): void {
    this.snapshotPrevBeforeTransaction(tx);
    const changes = this.rows.applyTransaction(tx);
    this.capturePrevFromChanges(changes);
    if (this.options.enableCellFlash !== false) {
      for (const c of changes) this.flashCellChange(c);
    }
    this.emitTransactionApplied([tx], changes);
    if (tx.add?.length || tx.remove?.length) {
      if (this.workerCoord.dataPlaneActive) {
        this.workerCoord.forwardTransaction(this.workerTransactionPayload(tx));
      }
      this.refreshModel();
    } else if (this.workerCoord.dataPlaneActive) {
      this.workerCoord.forwardTransaction(this.workerTransactionPayload(tx));
      this.requestPaint();
    } else if (!this.reaggregateLiveAfterUpdates()) {
      this.requestPaint();
    }
  }

  /** Batch transactions and flush once per ~60ms window (tick coalescing). */
  applyTransactionAsync(tx: RowDataTransaction<TData>): void {
    this.txQueue.push(tx);
    if (!this.txTimer) {
      this.txTimer = setTimeout(() => this.flushAsyncTransactions(), 60);
    }
  }

  flushAsyncTransactions(): void {
    if (this.txTimer) {
      clearTimeout(this.txTimer);
      this.txTimer = null;
    }
    if (!this.txQueue.length) return;
    const queue = this.txQueue;
    this.txQueue = [];
    let structural = false;
    const updated: TData[] = [];
    const feedActive = (this.listeners.get('transactionApplied')?.size ?? 0) > 0;
    const allChanges: CellChange[] = [];
    for (const tx of queue) {
      this.snapshotPrevBeforeTransaction(tx);
      const changes = this.rows.applyTransaction(tx);
      this.capturePrevFromChanges(changes);
      if (this.options.enableCellFlash !== false) {
        for (const c of changes) this.flashCellChange(c);
      }
      if (feedActive) for (const c of changes) allChanges.push(c);
      if (tx.add?.length || tx.remove?.length) structural = true;
      else if (tx.update?.length) updated.push(...tx.update);
    }
    if (feedActive) this.emitTransactionApplied(queue, allChanges);
    if (structural) {
      if (this.workerCoord.dataPlaneActive) {
        for (const tx of queue) {
          this.workerCoord.forwardTransaction(this.workerTransactionPayload(tx));
        }
      }
      this.refreshModel();
    } else if (this.workerCoord.dataPlaneActive) {
      for (const tx of queue) {
        this.workerCoord.forwardTransaction(this.workerTransactionPayload(tx));
      }
      this.requestPaint();
    } else if (!this.reaggregateLiveAfterUpdates()) {
      this.requestPaint();
    }
    this.emit('asyncTransactionsFlushed', {});
  }

  /**
   * Merge new option values and react to the ones that are dynamic
   * (AG Grid `setGridOption` semantics for the supported subset).
   */
  updateOptions(patch: Partial<GridOptions<TData>>): void {
    Object.assign(this.options, patch);
    if ('loading' in patch) {
      this.overlayState = patch.loading === true ? 'loading' : 'none';
      this.renderOverlay();
      if (patch.loading !== true) this.syncNoRowsOverlay();
    }
    if (patch.rowData) this.setRowData(patch.rowData);
    if ('quickFilterText' in patch) this.setQuickFilter(patch.quickFilterText ?? '');
    if (patch.columnDefs) this.setColumnDefs(patch.columnDefs);
    if (
      'treeData' in patch ||
      'getDataPath' in patch ||
      'treeDataChildrenField' in patch ||
      'excludeChildrenWhenTreeDataFiltering' in patch ||
      'groupDefaultExpanded' in patch
    ) {
      this.cols.treeMode = this.options.treeData === true;
      this.cols.setColumnDefs(this.options.columnDefs, this.options.defaultColDef);
      this.layout();
      this.refreshModel();
    }
    if ('suppressAggFuncInHeader' in patch) this.requestPaint();
    if ('pinnedTopRowData' in patch || 'pinnedBottomRowData' in patch) {
      this.layout();
      this.emit('pinnedRowDataChanged', {});
      this.requestPaint();
    }
    if ('aggFuncs' in patch) {
      this.mergedAggFuncs = undefined;
      this.refreshModel();
    }
    if ('groupTotalRow' in patch || 'grandTotalRow' in patch) {
      this.refreshModel();
    }
    if (
      'pagination' in patch ||
      'paginationPageSize' in patch ||
      'paginationAutoPageSize' in patch ||
      'paginateChildRows' in patch ||
      'paginationPanels' in patch ||
      'paginationNumberFormatter' in patch ||
      'suppressPaginationPanel' in patch
    ) {
      if (this.options.pagination) this.ensurePaginationPanel();
      this.clampCurrentPage();
      this.layout();
      this.requestPaint();
    }
    if ('rowSelection' in patch || 'selectionColumnDef' in patch) {
      this.cols.configureSelectionColumn(this.selectionColumnMode(), this.options.selectionColumnDef);
      this.layout();
      this.requestPaint();
    }
    if ('pivotMode' in patch) {
      const on = patch.pivotMode === true;
      this.cols.setPivotMode(on);
      this.emit('columnPivotModeChanged', { pivotMode: on });
      this.renderPivotPanel();
      this.layout();
      this.refreshModel();
    }
    if ('pivotPanelShow' in patch || 'rowGroupPanelShow' in patch) {
      this.renderGroupPanel();
      this.renderPivotPanel();
      this.layout();
    }
    if ('formatting' in patch) {
      this.rebuildFormatResolver();
      this.requestPaint();
    }
  }

  /** AG Grid-style single-option setter; alias for `updateOptions`. */
  setGridOption<K extends keyof GridOptions<TData>>(key: K, value: GridOptions<TData>[K]): void {
    this.updateOptions({ [key]: value } as Partial<GridOptions<TData>>);
  }

  /** Read a live grid option value. */
  getGridOption<K extends keyof GridOptions<TData>>(key: K): GridOptions<TData>[K] {
    return this.options[key];
  }

  setQuickFilter(text: string): void {
    this.options.quickFilterText = text;
    this.rows.quickFilter = text;
    this.refreshModel();
    this.emit('filterChanged', { filterModel: this.rows.filterModel, quickFilter: text });
  }

  setColumnFilter(colId: string, filter: ColumnFilter | null): void {
    if (filter) this.rows.filterModel[colId] = filter;
    else delete this.rows.filterModel[colId];
    this.refreshModel();
    this.sideBarCtrl?.refresh();
    this.emit('filterChanged', {
      filterModel: this.rows.filterModel,
      quickFilter: this.rows.quickFilter,
    });
  }

  setFilterModel(model: FilterModel): void {
    this.rows.filterModel = { ...model };
    this.refreshModel();
    this.sideBarCtrl?.refresh();
    this.emit('filterChanged', {
      filterModel: this.rows.filterModel,
      quickFilter: this.rows.quickFilter,
    });
  }

  getFilterModel(): FilterModel {
    return { ...this.rows.filterModel };
  }

  /** Notify the grid that an external filter changed and re-run the pipeline. */
  onFilterChanged(): void {
    this.refreshModel();
  }

  setSort(colId: string, sort: SortDir, additive = false): void {
    this.cols.setSort(colId, sort, additive);
    this.refreshModel();
    this.emit('sortChanged', { sortModel: this.cols.sortModel() });
  }

  getSortModel(): SortModelItem[] {
    return this.cols.sortModel();
  }

  setColumnDefs(defs: AnyColDef<TData>[]): void {
    this.options.columnDefs = defs;
    this.cols.setColumnDefs(defs, this.options.defaultColDef);
    this.rebuildCalcResolver();
    this.rebuildFormatResolver();
    if (this.options.pivotMode) this.cols.setPivotMode(true);
    this.renderGroupPanel();
    this.renderPivotPanel();
    this.layout();
    this.refreshModel();
  }

  getColumnState(): ColumnState[] {
    return this.cols.getColumnState();
  }

  applyColumnState(state: ColumnState[]): boolean {
    const ok = this.cols.applyColumnState(state);
    this.layout();
    this.refreshModel();
    return ok;
  }

  moveColumn(colId: string, toIndex: number): boolean {
    if (!this.cols.moveColumn(colId, toIndex)) return false;
    this.emit('columnMoved', { colId, toIndex });
    this.requestPaint();
    return true;
  }

  /** AG-named plural form. */
  moveColumns(colIds: string[], toIndex: number): void {
    colIds.forEach((id, i) => this.moveColumn(id, toIndex + i));
  }

  autoSizeColumn(colId: string, skipHeader?: boolean): void {
    const col = this.cols.getColumn(colId);
    if (!col) return;
    const skip = skipHeader ?? this.options.skipHeaderOnAutoSize === true;
    if (
      this.workerCoord.dataPlaneActive &&
      this.workerCoord.dataClient &&
      col.def.field &&
      !col.def.valueGetter
    ) {
      void this.workerAutosizeColumns([col], skip).catch(() => {
        const width = this.measureColumnContentWidth(col, skip);
        this.cols.autoSizeColumn(colId, width);
        this.updateSpacer();
        this.syncHeaderGeometry();
        this.emit('columnResized', { colId, width });
        this.requestPaint();
      });
      return;
    }
    const width = this.measureColumnContentWidth(col, skip);
    this.cols.autoSizeColumn(colId, width);
    this.updateSpacer();
    this.syncHeaderGeometry();
    this.emit('columnResized', { colId, width });
    this.requestPaint();
  }

  /** AG `autoSizeColumns(keys, skipHeader?)`. */
  autoSizeColumns(colIds?: string[], skipHeader?: boolean): void {
    const ids = colIds ?? this.cols.displayed().map((c) => c.colId);
    if (this.workerCoord.dataPlaneActive && this.workerCoord.dataClient) {
      const cols = ids
        .map((id) => this.cols.getColumn(id))
        .filter((c): c is InternalColumn<TData> => c != null && !!c.def.field && !c.def.valueGetter);
      if (cols.length) {
        const skip = skipHeader ?? this.options.skipHeaderOnAutoSize === true;
        void this.workerAutosizeColumns(cols, skip).catch(() => {
          for (const col of cols) {
            const width = this.measureColumnContentWidth(col, skip);
            this.cols.autoSizeColumn(col.colId, width);
            this.emit('columnResized', { colId: col.colId, width });
          }
          this.updateSpacer();
          this.syncHeaderGeometry();
          this.requestPaint();
        });
        return;
      }
    }
    for (const id of ids) this.autoSizeColumn(id, skipHeader);
  }

  /** AG `autoSizeAllColumns(skipHeader?)`. */
  autoSizeAllColumns(skipHeader?: boolean): void {
    this.autoSizeColumns(undefined, skipHeader);
  }

  sizeColumnsToFit(): void {
    this.cols.sizeColumnsToFit();
    this.updateSpacer();
    this.syncHeaderGeometry();
    this.requestPaint();
  }

  setColumnPinned(colId: string, pinned: Pinned): void {
    this.cols.setColumnPinned(colId, pinned);
    this.updateSpacer();
    this.emit('columnPinned', { colId, pinned });
    this.requestPaint();
  }

  /** AG-named plural form. */
  setColumnsPinned(colIds: string[], pinned: Pinned): void {
    for (const id of colIds) this.setColumnPinned(id, pinned);
  }

  setColumnVisible(colId: string, visible: boolean): void {
    this.cols.setColumnVisible(colId, visible);
    this.emit('columnVisible', { colId, visible });
    this.sideBarCtrl?.refresh();
    this.layout();
    this.refreshModel();
  }

  /** AG-named plural form. */
  setColumnsVisible(colIds: string[], visible: boolean): void {
    for (const id of colIds) this.setColumnVisible(id, visible);
  }

  /** Restore columns to their original defs (order, widths, pins, grouping). */
  resetColumnState(): void {
    this.cols.setColumnDefs(this.options.columnDefs, this.options.defaultColDef);
    this.renderGroupPanel();
    this.layout();
    this.refreshModel();
    this.emit('columnRowGroupChanged', {
      colIds: this.cols.getRowGroupCols().map((c) => c.colId),
    });
  }

  getColumnGroupState(): ColumnGroupStateItem[] {
    return this.cols.getColumnGroupState();
  }

  setColumnGroupState(state: ColumnGroupStateItem[]): void {
    this.cols.setColumnGroupState(state);
    this.layout();
    this.refreshModel();
  }

  setColumnGroupOpened(groupId: string, open: boolean): void {
    this.cols.setColumnGroupOpened(groupId, open);
    this.layout();
    this.emit('columnGroupOpened', { groupId, open });
    this.requestPaint();
  }

  /** Expand or collapse every expandable pivot column group. */
  setPivotColumnGroupsExpanded(open: boolean): void {
    this.cols.setAllPivotColumnGroupsOpened(open);
    this.layout();
    this.requestPaint();
  }

  getCellRange(): { start: CellPosition; end: CellPosition } | null {
    return this.range;
  }

  /** AG-shaped accessor (single-range engine → 0- or 1-element array). */
  getCellRanges(): { start: CellPosition; end: CellPosition }[] {
    return this.range ? [this.range] : [];
  }

  clearCellRange(): void {
    this.setRange(null, null);
  }

  /** AG v32.2+ name for `clearCellRange`. */
  clearCellSelection(): void {
    this.clearCellRange();
  }

  addCellRange(start: CellPosition, end: CellPosition): void {
    this.setRange({ start, end }, start);
    this.setFocusedCell(end.rowIndex, end.colId);
  }

  setTheme(name: ThemeName): void {
    this.theme = resolveTheme(name, this.theme.density, { gridlines: this.theme.gridlines });
    this.layout();
  }

  setDensity(density: Density): void {
    this.theme = resolveTheme(this.theme.name, density, { gridlines: this.theme.gridlines });
    this.cols.setFloatingFilterOptions(
      this.options.floatingFilter === true,
      this.theme.floatingFilterHeight,
    );
    this.layout();
    this.refreshModel();
  }

  setGridlines(gridlines: GridlineMode): void {
    this.theme = { ...this.theme, gridlines };
    this.requestPaint();
  }

  getTheme(): ResolvedTheme {
    return this.theme;
  }

  getSelectedRows(): TData[] {
    const out: TData[] = [];
    for (const id of this.selectedIds) {
      const row = this.rows.getRowById(id);
      if (row !== undefined) out.push(row);
    }
    return out;
  }

  selectAll(): void {
    if (this.rowSelectionMode() !== 'multiple') return;
    this.selectedIds = new Set(this.selectableLeafIds());
    this.emit('selectionChanged', { selectedIds: [...this.selectedIds] });
    this.updateStatusBar();
    this.requestPaint();
  }

  deselectAll(): void {
    this.selectedIds.clear();
    this.emit('selectionChanged', { selectedIds: [] });
    this.updateStatusBar();
    this.requestPaint();
  }

  setFocusedCell(rowIndex: number, colId: string): void {
    const pos = { rowIndex, colId };
    this.focused = pos;
    if (this.editor && (this.editor.rowIndex !== rowIndex || this.editor.colId !== colId)) {
      this.commitEdit();
    }
    if (this.options.cellSelection) {
      this.setRange({ start: pos, end: pos }, pos);
    }
    this.requestPaint();
  }

  clearFocusedCell(): void {
    this.focused = null;
    if (this.editor) this.commitEdit();
    if (this.options.cellSelection) {
      this.setRange(null, null);
    }
    this.hideTooltip();
    this.requestPaint();
  }

  /** AG `flashCells` — programmatic cell highlight. */
  flashCells(params?: FlashCellsParams): void {
    const flashDur = params?.flashDuration ?? this.options.cellFlashDuration ?? 500;
    if (flashDur === 0) return;
    const fadeDur = params?.fadeDuration ?? this.options.cellFadeDuration ?? 1000;
    const prevDur = this.flashMgr.duration;
    this.flashMgr.duration = flashDur + fadeDur;

    const rowSet = params?.rowIndexes ? new Set(params.rowIndexes) : null;
    const colSet = params?.columns
      ? new Set(
          params.columns.map((key) => {
            const col = this.cols.getColumn(key);
            return col?.colId ?? key;
          }),
        )
      : null;

    const displayed = this.cols.displayed();
    for (let r = 0; r < this.rows.displayed.length; r++) {
      if (rowSet && !rowSet.has(r)) continue;
      const rowId = this.rows.displayedIds[r];
      for (const col of displayed) {
        if (colSet && !colSet.has(col.colId)) continue;
        this.flashMgr.flash(`${rowId}\u0000${col.colId}`, 0);
      }
    }

    this.flashMgr.duration = prevDur;
    this.requestPaint();
  }

  getFocusedCell(): { rowIndex: number; colId: string } | null {
    return this.focused;
  }

  private syncScrollFromScroller(): void {
    this.scrollLeft = this.scroller.scrollLeft;
    this.scrollTop = this.logicalScrollTop();
  }

  ensureIndexVisible(rowIndex: number, position: 'top' | 'bottom' | 'middle' | null = null): void {
    if (rowIndex < 0 || rowIndex >= this.rows.displayed.length) return;
    if (this.paginationActive()) {
      const start = this.pageRowStart();
      const end = this.pageRowEnd();
      if (rowIndex < start || rowIndex >= end) {
        const pageSize = this.effectivePageSize();
        if (this.paginateChildRowsActive()) {
          this.goToPage(Math.floor(rowIndex / pageSize), false);
        } else {
          const segments = this.pageableSegmentBounds();
          const segIdx = segments.findIndex((s) => rowIndex >= s.start && rowIndex < s.end);
          if (segIdx >= 0) this.goToPage(Math.floor(segIdx / pageSize), false);
        }
      }
    }
    const rowH = this.rowHeightAt(rowIndex);
    const top = this.pageRowTop(rowIndex);
    const bottom = top + rowH;
    if (position === 'bottom') {
      this.setLogicalScrollTop(Math.max(0, bottom - this.viewHeight));
    } else if (position === 'middle') {
      this.setLogicalScrollTop(Math.max(0, top - (this.viewHeight - rowH) / 2));
    } else if (top < this.scrollTop) {
      this.setLogicalScrollTop(top);
    } else if (bottom > this.scrollTop + this.viewHeight) {
      this.setLogicalScrollTop(bottom - this.viewHeight);
    }
    this.syncScrollFromScroller();
    this.requestPaint();
  }

  /** AG `ensureColumnVisible`. Pinned columns are always visible; no-op scroll. */
  ensureColumnVisible(colKey: string, position: 'auto' | 'start' | 'middle' | 'end' = 'auto'): void {
    const col = this.cols.getColumn(colKey);
    if (!col) return;
    if (col.def.pinned) {
      this.requestPaint();
      return;
    }
    const i = this.cols.center.cols.findIndex((c) => c.colId === colKey);
    if (i < 0) return;
    const x0 = this.cols.center.offsets[i];
    const x1 = this.cols.center.offsets[i + 1];
    const centerView = this.viewWidth - this.cols.left.width - this.cols.right.width;
    const w = x1 - x0;
    if (position === 'end') {
      this.scroller.scrollLeft = Math.max(0, x1 - centerView);
    } else if (position === 'middle') {
      this.scroller.scrollLeft = Math.max(0, x0 - (centerView - w) / 2);
    } else if (x0 < this.scrollLeft) {
      this.scroller.scrollLeft = x0;
    } else if (x1 > this.scrollLeft + centerView) {
      this.scroller.scrollLeft = position === 'start' ? x0 : x1 - centerView;
    }
    this.syncScrollFromScroller();
    this.requestPaint();
  }

  /** AG `ensureNodeVisible` (client-side row lookup by data or predicate). */
  ensureNodeVisible(
    nodeSelector: TData | ((node: { data: TData; rowIndex: number }) => boolean),
    position: 'top' | 'bottom' | 'middle' | null = null,
  ): void {
    let rowIndex = -1;
    if (typeof nodeSelector === 'function') {
      const pred = nodeSelector as (node: { data: TData; rowIndex: number }) => boolean;
      for (let i = 0; i < this.rows.displayed.length; i++) {
        const node = this.rows.getDisplayedNode(i);
        if (node?.data && pred({ data: node.data, rowIndex: i })) {
          rowIndex = i;
          break;
        }
      }
    } else {
      for (let i = 0; i < this.rows.displayed.length; i++) {
        if (this.rows.displayed[i] === nodeSelector) {
          rowIndex = i;
          break;
        }
      }
    }
    if (rowIndex >= 0) this.ensureIndexVisible(rowIndex, position);
  }

  private ensureCellVisible(rowIndex: number, colId: string): void {
    this.ensureIndexVisible(rowIndex);
    this.ensureColumnVisible(colId);
  }

  /** AG `resetRowHeights` — clear cached heights and re-run `getRowHeight`/auto-height. */
  resetRowHeights(): void {
    this.invalidateRowHeights();
    this.updateSpacer();
    this.requestPaint();
  }

  /** AG `onRowHeightChanged` — reposition rows after external height changes. */
  onRowHeightChanged(): void {
    this.resetRowHeights();
  }

  getDisplayedRowCount(): number {
    return this.rows.displayed.length;
  }

  getRowCount(): number {
    return this.rows.rowCount;
  }

  getDisplayedRowAtIndex(i: number): TData | undefined {
    return this.rows.displayed[i] ?? undefined;
  }

  /** Value shown at a displayed row/column (includes group agg and pivot cells). */
  getDisplayedCellValue(rowIndex: number, colId: string): unknown {
    const col = this.cols.getColumn(colId);
    if (!col) return undefined;
    return this.valueAtDisplayed(rowIndex, col);
  }

  expandAll(): void {
    this.rows.expandAll(true);
    this.refreshModel();
  }

  collapseAll(): void {
    this.rows.expandAll(false);
    this.refreshModel();
  }

  setRowNodeExpanded(id: string, expanded: boolean): void {
    // Master rows (master/detail) are addressed by row id.
    if (this.options.masterDetail === true && this.rows.getRowById(id) !== undefined) {
      if ((this.rows.masterExpanded.get(id) === true) === expanded) return;
      this.toggleMasterExpanded(id);
      return;
    }
    this.rows.setGroupExpanded(id, expanded);
    this.refreshModel();
    this.emit('rowGroupOpened', { groupId: id, expanded });
  }

  // ── master / detail API (AG parity) ───────────────────────────────

  getDetailGridInfo(id: string): DetailGridInfo | undefined {
    return this.detailGridInfoStore.get(id);
  }

  forEachDetailGridInfo(callback: (gridInfo: DetailGridInfo, index: number) => void): void {
    let i = 0;
    for (const info of this.detailGridInfoStore.values()) callback(info, i++);
  }

  /** Register a manually-managed detail grid (custom detail renderers). */
  addDetailGridInfo(id: string, gridInfo: DetailGridInfo): void {
    this.detailGridInfoStore.set(id, gridInfo);
  }

  removeDetailGridInfo(id: string): void {
    this.detailGridInfoStore.delete(id);
  }

  getRowGroupColumns(): string[] {
    return this.cols.getRowGroupCols().map((c) => c.colId);
  }

  addRowGroupColumns(colIds: string[]): void {
    let changed = false;
    for (const id of colIds) changed = this.cols.addRowGroupColumn(id) || changed;
    if (changed) this.commitRowGroupChange();
  }

  removeRowGroupColumns(colIds: string[]): void {
    let changed = false;
    for (const id of colIds) changed = this.cols.removeRowGroupColumn(id) || changed;
    if (changed) this.commitRowGroupChange();
  }

  setRowGroupColumns(colIds: string[]): void {
    this.cols.setRowGroupColumns(colIds);
    this.commitRowGroupChange();
  }

  // ── side bar / tool panels ────────────────────────────────────────

  getSideBar(): SideBarDef | undefined {
    return this.sideBarCtrl?.getDef();
  }

  isSideBarVisible(): boolean {
    return this.sideBarCtrl?.isSideBarVisible() ?? false;
  }

  setSideBarVisible(show: boolean): void {
    this.sideBarCtrl?.setVisible(show);
    this.layout();
  }

  setSideBarPosition(position: 'left' | 'right'): void {
    this.sideBarCtrl?.setPosition(position);
    this.layout();
  }

  openToolPanel(key: string, _parent?: HTMLElement | null): void {
    this.sideBarCtrl?.openToolPanel(key, 'api');
    this.layout();
  }

  closeToolPanel(): void {
    this.sideBarCtrl?.closeToolPanel('api');
    this.layout();
  }

  getOpenedToolPanel(): string | null {
    return this.sideBarCtrl?.getOpenedToolPanel() ?? null;
  }

  isToolPanelShowing(): boolean {
    return this.sideBarCtrl?.isToolPanelShowing() ?? false;
  }

  refreshToolPanel(): void {
    this.sideBarCtrl?.refreshToolPanel();
  }

  getToolPanelInstance(id: 'columns'): import('./toolPanels/columnsToolPanel').ColumnToolPanelApi | undefined;
  getToolPanelInstance(id: 'filters'): import('./toolPanels/filtersToolPanel').FiltersToolPanelApi | undefined;
  getToolPanelInstance(id: string):
    | import('./toolPanels/columnsToolPanel').ColumnToolPanelApi
    | import('./toolPanels/filtersToolPanel').FiltersToolPanelApi
    | undefined;
  getToolPanelInstance(id: string) {
    return this.sideBarCtrl?.getToolPanelInstance(id);
  }

  // ── pivot mode ────────────────────────────────────────────────────

  isPivotMode(): boolean {
    return this.cols.pivotMode;
  }

  setPivotMode(on: boolean): void {
    if (this.cols.pivotMode === on) return;
    this.cols.setPivotMode(on);
    this.options.pivotMode = on;
    this.emit('columnPivotModeChanged', { pivotMode: on });
    this.renderPivotPanel();
    this.sideBarCtrl?.refresh();
    this.layout();
    this.refreshModel();
  }

  getPivotColumns(): string[] {
    return this.cols.pivotColumns().map((c) => c.colId);
  }

  setPivotColumns(colIds: string[]): void {
    this.cols.setPivotColumns(colIds);
    this.commitPivotChange();
  }

  addPivotColumns(colIds: string[]): void {
    let changed = false;
    for (const id of colIds) changed = this.cols.addPivotColumn(id) || changed;
    if (changed) this.commitPivotChange();
  }

  removePivotColumns(colIds: string[]): void {
    let changed = false;
    for (const id of colIds) changed = this.cols.removePivotColumn(id) || changed;
    if (changed) this.commitPivotChange();
  }

  getValueColumns(): string[] {
    return this.cols.valueColumns().map((c) => c.colId);
  }

  setValueColumns(colIds: string[]): void {
    this.cols.setValueColumns(colIds);
    this.refreshModel();
  }

  addValueColumns(colIds: string[]): void {
    this.cols.addValueColumns(colIds);
    this.refreshModel();
  }

  removeValueColumns(colIds: string[]): void {
    this.cols.removeValueColumns(colIds);
    this.refreshModel();
  }

  getPivotResultColumn(pivotKeys: string[], valueColKey: string): { colId: string } | null {
    const col = this.cols.lookupPivotResultCol(pivotKeys, valueColKey);
    return col ? { colId: col.colId } : null;
  }

  getPivotResultColumns(): string[] {
    return this.cols.all.filter((c) => c.pivotResult).map((c) => c.colId);
  }

  private commitPivotChange(): void {
    this.emit('columnPivotChanged', { columns: this.getPivotColumns() });
    this.renderPivotPanel();
    this.refreshModel();
    // Pivot panel visibility ('onlyWhenPivoting') may have changed.
    this.layout();
  }

  private canPivot(col: InternalColumn<TData> | undefined): boolean {
    return !!col && col.def.enablePivot === true && col.def.pivot !== true;
  }

  private isOverPivotPanel(clientX: number, clientY: number): boolean {
    if (!this.pivotPanel || !this.pivotPanelVisible()) return false;
    const r = this.pivotPanel.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  private renderPivotPanel(): void {
    const panel = this.pivotPanel;
    if (!panel) return;
    const t = this.theme;
    panel.innerHTML = '';
    panel.style.background = t.headerBg;
    panel.appendChild(this.panelTitleIcon('pivot'));

    const pivots = this.cols.pivotColumns();
    if (!pivots.length) {
      const hint = document.createElement('span');
      // AG wording for the pivot drop panel.
      hint.textContent = 'Drag here to set column labels';
      Object.assign(hint.style, {
        color: t.textTertiary,
        pointerEvents: 'none',
      } satisfies Partial<CSSStyleDeclaration>);
      panel.appendChild(hint);
      return;
    }

    pivots.forEach((col, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.innerHTML = iconSvg('chevron-right', 12);
        sep.style.color = t.textTertiary;
        sep.style.pointerEvents = 'none';
        sep.style.display = 'inline-flex';
        sep.style.alignItems = 'center';
        panel.appendChild(sep);
      }

      const chip = document.createElement('div');
      chip.dataset.pivotChip = col.colId;
      Object.assign(chip.style, {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '2px 8px',
        borderRadius: '3px',
        border: `1px solid ${t.structural}`,
        background: t.raised,
        color: t.textPrimary,
        cursor: 'grab',
        userSelect: 'none',
      } satisfies Partial<CSSStyleDeclaration>);

      const grip = document.createElement('span');
      grip.textContent = '⋮⋮';
      Object.assign(grip.style, {
        color: t.textTertiary,
        fontSize: '9px',
        letterSpacing: '1px',
        pointerEvents: 'none',
      } satisfies Partial<CSSStyleDeclaration>);
      chip.appendChild(grip);

      const label = document.createElement('span');
      label.textContent = col.def.headerName ?? col.colId;
      chip.appendChild(label);

      const x = document.createElement('span');
      x.innerHTML = iconSvg('x', 14);
      x.title = 'Remove pivot column';
      Object.assign(x.style, {
        color: t.textSecondary,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
      } satisfies Partial<CSSStyleDeclaration>);
      x.addEventListener('mousedown', (e) => e.stopPropagation());
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.cols.removePivotColumn(col.colId)) this.commitPivotChange();
      });
      chip.appendChild(x);

      chip.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this.pivotChipDrag = { colId: col.colId, startX: e.clientX, startY: e.clientY, moved: false };
      });

      panel.appendChild(chip);
    });
    this.sideBarCtrl?.refresh();
  }

  // ── pagination ────────────────────────────────────────────────────

  /** AG `paginationIsLastPageFound` — always true for the client-side row model. */
  paginationIsLastPageFound(): boolean {
    return true;
  }

  private ensurePaginationPanel(): void {
    if (this.paginationPanel) return;
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'absolute',
      left: '0',
      right: '0',
      display: 'flex',
      alignItems: 'center',
      // AG parity: the pagination panel is right-aligned.
      justifyContent: 'flex-end',
      boxSizing: 'border-box',
      gap: '24px',
      zIndex: '12',
      userSelect: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    this.root.appendChild(panel);
    this.paginationPanel = panel;
  }

  private renderPaginationPanel(): void {
    if (!this.paginationPanel || this.options.suppressPaginationPanel) return;
    const panels = this.paginationPanels();
    if (!panels.length) {
      this.paginationPanel.style.display = 'none';
      return;
    }
    this.paginationPanel.style.display = 'flex';
    const t = this.theme;
    const panel = this.paginationPanel;
    panel.replaceChildren();

    const pageable = this.pageableRowCount();
    const pageSize = this.effectivePageSize();
    const rowStart = pageable === 0 ? 0 : this.currentPage * pageSize + 1;
    const rowEnd = Math.min(pageable, (this.currentPage + 1) * pageSize);

    const mkBtn = (label: string, action: () => void): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      Object.assign(btn.style, {
        background: 'transparent',
        color: t.textSecondary,
        border: `1px solid ${withAlpha(t.textSecondary, 0.2)}`,
        borderRadius: '2px',
        padding: '2px 8px',
        font: `inherit`,
        cursor: 'pointer',
      } satisfies Partial<CSSStyleDeclaration>);
      btn.addEventListener('click', action);
      return btn;
    };

    for (const p of panels) {
      const kind = typeof p === 'string' ? p : p.type;
      if (kind === 'pageSize') {
        const cfg = typeof p === 'object' && p.type === 'pageSize' ? p : undefined;
        const selector = cfg?.paginationPageSizeSelector ?? this.options.paginationPageSizeSelector;
        const wrap = document.createElement('div');
        Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '8px' } satisfies Partial<CSSStyleDeclaration>);
        const label = document.createElement('span');
        label.textContent = 'Page Size:';
        const select = document.createElement('select');
        Object.assign(select.style, {
          background: t.raised,
          color: t.textPrimary,
          border: `1px solid ${withAlpha(t.textSecondary, 0.25)}`,
          borderRadius: '2px',
          font: `inherit`,
          padding: '2px 4px',
        } satisfies Partial<CSSStyleDeclaration>);
        select.disabled = this.options.paginationAutoPageSize === true;
        select.addEventListener('change', () => {
          const n = Number(select.value);
          if (!Number.isNaN(n) && n > 0) {
            this.options.paginationPageSize = n;
            this.currentPage = 0;
            this.scroller.scrollTop = 0;
            this.updateSpacer();
            this.emitPaginationChanged(true);
            this.layout();
            this.requestPaint();
          }
        });
        const sizes =
          selector === false
            ? [pageSize]
            : Array.isArray(selector)
              ? selector
              : [20, 50, 100];
        for (const s of sizes) {
          const opt = document.createElement('option');
          opt.value = String(s);
          opt.textContent = String(s);
          if (s === pageSize) opt.selected = true;
          select.appendChild(opt);
        }
        if (!sizes.includes(pageSize)) {
          const opt = document.createElement('option');
          opt.value = String(pageSize);
          opt.textContent = String(pageSize);
          opt.selected = true;
          select.appendChild(opt);
        }
        wrap.style.display = selector === false || this.options.paginationAutoPageSize ? 'none' : 'flex';
        wrap.appendChild(label);
        wrap.appendChild(select);
        panel.appendChild(wrap);
      } else if (kind === 'rowSummary') {
        const info = document.createElement('span');
        info.textContent = `${this.formatPaginationNumber(rowStart)} to ${this.formatPaginationNumber(rowEnd)} of ${this.formatPaginationNumber(pageable)}`;
        panel.appendChild(info);
      } else if (kind === 'pageSummary') {
        const suppressNav = typeof p === 'object' && p.type === 'pageSummary' && p.suppressPageInput === true;
        const wrap = document.createElement('div');
        Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '4px' } satisfies Partial<CSSStyleDeclaration>);
        if (!suppressNav) {
          wrap.appendChild(mkBtn('⏮', () => this.paginationGoToFirstPage()));
          wrap.appendChild(mkBtn('◀', () => this.paginationGoToPreviousPage()));
        }
        const pageLabel = document.createElement('span');
        pageLabel.style.padding = '0 6px';
        pageLabel.textContent = `Page ${this.formatPaginationNumber(this.currentPage + 1)} of ${this.formatPaginationNumber(this.totalPages())}`;
        wrap.appendChild(pageLabel);
        if (!suppressNav) {
          wrap.appendChild(mkBtn('▶', () => this.paginationGoToNextPage()));
          wrap.appendChild(mkBtn('⏭', () => this.paginationGoToLastPage()));
        }
        panel.appendChild(wrap);
      }
    }
  }

  private emitPaginationChanged(newPage: boolean, newData = false): void {
    this.emit('paginationChanged', { newPage, newData });
  }

  private goToPage(page: number, newPage = true): void {
    const max = this.totalPages() - 1;
    const next = Math.min(Math.max(0, page), max);
    if (next === this.currentPage && newPage) return;
    this.currentPage = next;
    this.scroller.scrollTop = 0;
    this.updateSpacer();
    this.emitPaginationChanged(newPage);
    this.renderPaginationPanel();
    this.requestPaint();
  }

  paginationGetPageSize(): number {
    return this.effectivePageSize();
  }

  paginationGetCurrentPage(): number {
    return this.currentPage;
  }

  paginationGetTotalPages(): number {
    return this.totalPages();
  }

  paginationGetRowCount(): number {
    return this.pageableRowCount();
  }

  paginationGoToNextPage(): void {
    this.goToPage(this.currentPage + 1);
  }

  paginationGoToPreviousPage(): void {
    this.goToPage(this.currentPage - 1);
  }

  paginationGoToFirstPage(): void {
    this.goToPage(0);
  }

  paginationGoToLastPage(): void {
    this.goToPage(this.totalPages() - 1);
  }

  paginationGoToPage(page: number): void {
    this.goToPage(page);
  }

  private makeExportContext(): ExportContext<TData> {
    return {
      columns: (params) => {
        let cols = params?.allColumns ? [...this.cols.all] : this.cols.displayed();
        cols = cols.filter((c) => c.colId !== 'ag-Grid-AutoColumn' && c.colId !== 'ag-Grid-SelectionColumn');
        if (params?.columnKeys?.length) {
          const set = new Set(params.columnKeys);
          cols = cols.filter((c) => set.has(c.colId));
        }
        return cols.map((c) => ({ colId: c.colId, def: c.def }));
      },
      rows: (params) => {
        const useAll = params?.exportedRows === 'all';
        let indices: number[] = [];
        const total = useAll ? this.rows.sourceRows.length : this.rows.displayed.length;
        for (let i = 0; i < total; i++) {
          if (!useAll && this.rows.getDisplayedNode(i)?.detail) continue; // synthetic detail rows
          indices.push(i);
        }

        const selected = new Set(this.selectedIds);
        const isSelected = (i: number): boolean => {
          if (useAll) {
            const row = this.rows.sourceRows[i];
            return row != null && selected.has(this.rows.getId(row));
          }
          return selected.has(this.rows.displayedIds[i]);
        };

        if (params?.onlySelectedAllPages) {
          indices = indices.filter(isSelected);
        } else if (params?.onlySelected) {
          if (!useAll && this.paginationActive()) {
            const start = this.pageRowStart();
            const end = this.pageRowEnd();
            indices = indices.filter((i) => i >= start && i < end && isSelected(i));
          } else {
            indices = indices.filter(isSelected);
          }
        } else if (!useAll && this.paginationActive()) {
          indices = indices.slice(this.pageRowStart(), this.pageRowEnd());
        }

        return indices.map((i) => this.exportRowNode(i, useAll));
      },
      rawValue: (row, col) => {
        const c = this.cols.getColumn(col.colId);
        if (!c) return '';
        if (row.data != null && !row.group) return this.valueOf(row.data, c, row.rowIndex);
        return this.valueAtDisplayed(row.rowIndex, c);
      },
      formattedValue: (row, col) => {
        const c = this.cols.getColumn(col.colId);
        if (!c) return '';
        if (row.data != null && !row.group) return this.formatValue(row.data, c, row.rowIndex);
        return this.formatDisplayed(row.rowIndex, c);
      },
      headerName: (col) => col.def.headerName ?? col.def.field ?? col.colId,
    };
  }

  private exportRowNode(index: number, useSource: boolean): ExportRowNode<TData> {
    if (useSource) {
      const data = this.rows.sourceRows[index];
      return { rowIndex: index, data, group: false };
    }
    const node = this.rows.getDisplayedNode(index);
    return {
      rowIndex: index,
      data: node?.data ?? undefined,
      group: node?.group === true,
    };
  }

  exportCsv(params?: CsvExportParams<TData>): string {
    const matrix = buildExportMatrix(this.makeExportContext(), params, this);
    return matrixToCsv(matrix, params as CsvExportParams | undefined);
  }

  /** Worker-side CSV export when the data plane is active (W6). */
  private async exportCsvFromWorker(params?: CsvExportParams<TData>): Promise<string> {
    if (!this.workerCoord.dataClient) return this.exportCsv(params);
    const columns = this.workerExportColumns();
    const bytes = await this.workerCoord.dataClient.exportCsv({
      columns,
      columnKeys: params?.columnKeys,
      columnSeparator: params?.columnSeparator,
      skipColumnHeaders: params?.skipColumnHeaders,
      suppressQuotes: params?.suppressQuotes,
      onlySelected: params?.onlySelected,
      selectedIds: params?.onlySelected ? [...this.selectedIds] : undefined,
      skipRowGroups: params?.skipRowGroups,
    });
    return new TextDecoder().decode(bytes);
  }

  private workerAutosizeSpec(col: InternalColumn<TData>): WorkerAutosizeColumn {
    const t = this.theme;
    return {
      colId: col.colId,
      headerName: this.headerLabel(col),
      font: `${t.fontSize}px ${t.fontSans}`,
      padding: t.paddingX * 2 + 18,
      headerPadding: t.paddingX * 2 + 18,
      minWidth: col.def.minWidth ?? 50,
      maxWidth: col.def.maxWidth ?? 10_000,
    };
  }

  private async workerAutosizeColumns(
    cols: InternalColumn<TData>[],
    skipHeader: boolean,
  ): Promise<void> {
    if (!this.workerCoord.dataClient) return;
    const widths = await this.workerCoord.dataClient.autosize(
      cols.map((c) => this.workerAutosizeSpec(c)),
      { skipHeader },
    );
    for (const col of cols) {
      const width = widths[col.colId];
      if (width == null) continue;
      this.cols.autoSizeColumn(col.colId, width);
      this.emit('columnResized', { colId: col.colId, width });
    }
    this.updateSpacer();
    this.syncHeaderGeometry();
    this.requestPaint();
  }

  /** AG-named alias for `exportCsv`. */
  getDataAsCsv(params?: CsvExportParams<TData>): string {
    return this.exportCsv(params);
  }

  /** AG `exportDataAsCsv`: download the CSV as a file. */
  exportDataAsCsv(params?: CsvExportParams<TData>): void {
    if (this.workerCoord.dataPlaneActive && this.workerCoord.dataClient) {
      void this.exportCsvFromWorker(params)
        .then((csv) => downloadText(csv, resolveCsvFileName<TData>(params, this), 'text/csv;charset=utf-8'))
        .catch(() =>
          downloadText(this.exportCsv(params), resolveCsvFileName<TData>(params, this), 'text/csv;charset=utf-8'),
        );
      return;
    }
    downloadText(this.exportCsv(params), resolveCsvFileName<TData>(params, this), 'text/csv;charset=utf-8');
  }

  /** AG `getDataAsExcel`: SpreadsheetML XML string (opens in Excel as .xls). */
  getDataAsExcel(params?: ExcelExportParams<TData>): string {
    const matrix = buildExportMatrix(this.makeExportContext(), params, this);
    return matrixToSpreadsheetXml(matrix, params?.sheetName ?? 'Sheet1');
  }

  /** AG `exportDataAsExcel`: download as Excel-compatible file. */
  exportDataAsExcel(params?: ExcelExportParams<TData>): void {
    if (this.workerCoord.dataPlaneActive && this.workerCoord.dataClient) {
      void this.exportXlsxFromWorker(params)
        .then((bytes) =>
          downloadBytes(
            bytes,
            resolveExcelFileName<TData>(params, this).replace(/\.xls$/i, '.xlsx'),
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          ),
        )
        .catch(() =>
          downloadText(
            this.getDataAsExcel(params),
            resolveExcelFileName<TData>(params, this),
            'application/vnd.ms-excel',
          ),
        );
      return;
    }
    downloadText(
      this.getDataAsExcel(params),
      resolveExcelFileName<TData>(params, this),
      'application/vnd.ms-excel',
    );
  }

  private async exportXlsxFromWorker(params?: ExcelExportParams<TData>): Promise<Uint8Array> {
    if (!this.workerCoord.dataClient) throw new Error('no worker');
    const columns = this.workerExportColumns();
    return this.workerCoord.dataClient.exportXlsx({
      columns,
      columnKeys: params?.columnKeys,
      sheetName: params?.sheetName,
      onlySelected: params?.onlySelected,
      selectedIds: params?.onlySelected ? [...this.selectedIds] : undefined,
      skipRowGroups: params?.skipRowGroups,
    });
  }

  /** AG `startEditingCell({ rowIndex, colKey })`. */
  startEditingCell(params: { rowIndex: number; colKey: string }): void {
    this.startEdit(params.rowIndex, params.colKey, null);
  }

  /** AG `stopEditing(cancel?)`: commit (or discard) the active editor. */
  stopEditing(cancel = false): void {
    if (!this.editor) return;
    if (cancel) {
      this.editor.canceled = true;
      this.closeEditor();
    } else {
      this.commitEdit();
    }
  }

  /** AG `getEditingCells()` (single-editor engine → 0 or 1 entries). */
  getEditingCells(): { rowIndex: number; colId: string }[] {
    return this.editor ? [{ rowIndex: this.editor.rowIndex, colId: this.editor.colId }] : [];
  }

  /** AG `getQuickFilter()`. */
  getQuickFilter(): string {
    return this.options.quickFilterText ?? '';
  }

  destroy(): void {
    if (this.destroyed) return;
    // Flush a pending state autosave before teardown.
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.persistStateNow();
    }
    this.destroyed = true;
    this.formatAttach?.detach();
    this.formatAttach = null;
    this.rulesAttach?.detach();
    this.rulesAttach = null;
    this.workerCoord.teardown();
    this.viewportChunk = null;
    cancelAnimationFrame(this.rafId);
    if (this.navRafId) cancelAnimationFrame(this.navRafId);
    if (this.txTimer) clearTimeout(this.txTimer);
    if (this.wheelAxisIdle) clearTimeout(this.wheelAxisIdle);
    this.hideTooltip();
    this.tooltipEl?.remove();
    this.tooltipEl = null;
    this.ro.disconnect();
    for (const fn of this.cleanups) fn();
    this.cleanups = [];
    this.closeEditor();
    this.closeFloatingFilter();
    this.closeSetFilter();
    this.closeContextMenu();
    this.closeHeaderFilterPopup();
    this.closeColumnChooser();
    this.removeFloatingFilterClearButtons();
    this.removeDragGhost();
    this.removePanelIndicator();
    if (this.ffClearLayer) {
      this.ffClearLayer.remove();
      this.ffClearLayer = null;
    }
    this.statusBar?.remove();
    this.statusBar = null;
    this.paginationPanel?.remove();
    this.paginationPanel = null;
    this.overlayEl?.remove();
    this.overlayEl = null;
    for (const id of [...this.detailInstances.keys()]) this.destroyDetailInstance(id);
    this.detailGridInfoStore.clear();
    this.detailLayer?.remove();
    this.detailLayer = null;
    this.sideBarCtrl?.destroy();
    this.sideBarCtrl = null;
    this.root.innerHTML = '';
    this.root.classList.remove('tabular-root');
    this.listeners.clear();
  }
}

/** Inject the overlay spinner keyframes once per document. */
function ensureOverlayKeyframes(): void {
  if (document.getElementById('tabular-overlay-keyframes')) return;
  const style = document.createElement('style');
  style.id = 'tabular-overlay-keyframes';
  style.textContent = '@keyframes tabular-spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(style);
}

/**
 * True when some element between the wheel target and the detail layer can
 * still scroll in the wheel's direction — i.e. the nested detail content
 * should consume the gesture. At the edges the outer grid takes over.
 */
function detailCanConsumeWheel(e: WheelEvent, layer: HTMLElement): boolean {
  const dy = e.deltaY;
  const dx = e.deltaX;
  let node: Node | null = e.target as Node;
  while (node && node !== layer) {
    if (node instanceof HTMLElement) {
      const el = node;
      if (dy !== 0 && el.scrollHeight > el.clientHeight + 1) {
        if (dy > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
        if (dy < 0 && el.scrollTop > 0) return true;
      }
      if (dx !== 0 && el.scrollWidth > el.clientWidth + 1) {
        if (dx > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
        if (dx < 0 && el.scrollLeft > 0) return true;
      }
    }
    node = node.parentNode;
  }
  return false;
}

/**
 * Always-visible themed scrollbars (AG parity). Styling `::-webkit-scrollbar`
 * opts out of macOS overlay scrollbars, so the grid shows classic scrollbars
 * on every platform. Colors come from CSS vars set per grid root in layout().
 */
function ensureScrollbarStyles(): void {
  if (document.getElementById('tabular-scrollbar-styles')) return;
  const style = document.createElement('style');
  style.id = 'tabular-scrollbar-styles';
  style.textContent = `
.tabular-root ::-webkit-scrollbar { width: 10px; height: 10px; }
.tabular-root ::-webkit-scrollbar-track { background: transparent; }
.tabular-root ::-webkit-scrollbar-corner { background: transparent; }
.tabular-root ::-webkit-scrollbar-thumb {
  background-color: var(--tabular-scrollbar-thumb, rgba(127,127,127,0.5));
  border: 2px solid transparent;
  border-radius: 5px;
  background-clip: content-box;
}
.tabular-root ::-webkit-scrollbar-thumb:hover {
  background-color: var(--tabular-scrollbar-thumb-hover, rgba(127,127,127,0.8));
}
@supports not selector(::-webkit-scrollbar) {
  .tabular-root * {
    scrollbar-width: thin;
    scrollbar-color: var(--tabular-scrollbar-thumb, rgba(127,127,127,0.5)) transparent;
  }
}
`;
  document.head.appendChild(style);
}

function sizeCanvas(canvas: HTMLCanvasElement, cssW: number, cssH: number, dpr: number): void {
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
