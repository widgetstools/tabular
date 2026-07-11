/**
 * `TabularDom` — the DOM-renderer grid entry point (Task 5). Owns the models,
 * the recycled row pool, and all DOM/event wiring, and drives everything from a
 * synchronous `MainMaterializer` (fallback mode). The worker-backed path
 * (`WorkerMaterializer`) is a later task; this class is the always-correct main
 * reference.
 *
 * Scope note: this task covers a single unpinned column region, leaf/group/
 * footer rows, sort, selection/focus, group expand/collapse, and async
 * transactions. Editing, pivot, tree data, master/detail, pinned columns, and
 * the other canvas features are intentionally out of scope and their options
 * are ignored.
 */

import type {
  AggTransactionPayload,
  GridOptions,
  GroupRefreshOptions,
  InternalColumn,
  RenderDeltas,
} from '@tabular/core';
import { ColumnModel, RowModel, WorkerCoordinator, resolveTheme } from '@tabular/core';
import type { ResolvedTheme } from '@tabular/core';
import { CLS, StyleTable, applyThemeVars, ensureDomGridStyles } from './styles';
import { computeWindow, poolSize } from './window';
import { RowPool, type PoolGeometry } from './rowPool';
import { MainMaterializer, readFieldValue } from './mainMaterializer';
import type { RenderView } from './renderView';
import { WorkerMaterializer } from './workerMaterializer';
import { buildRenderConfig, buildWorkerConfig } from './workerFeed';

/** Px of extra left padding per group nesting level (added to the base cell padding). */
const GROUP_INDENT = 16;
/** Hard cap on spacer height so extreme row counts stay within browser layout limits. */
const MAX_SPACER_HEIGHT = 15_000_000;
/** Async transaction coalescing window, matching `grid.ts`'s `txTimer` interval. */
const TX_FLUSH_MS = 60;

/** Sort states cycled by a header click: none → asc → desc → none. */
type SortDir = 'asc' | 'desc' | null;

/** Pending, coalesced transaction batch. */
interface TxBatch<TData> {
  add: TData[];
  update: TData[];
  remove: TData[];
}

/**
 * DOM data grid. Construct with a root element and `GridOptions`, then feed
 * rows via `setRowData` / `applyTransactionAsync`. Call `destroy()` to release
 * all listeners, observers, timers, and generated styles.
 */
export class TabularDom<TData = unknown> {
  private readonly theme: ResolvedTheme;
  private readonly cols: ColumnModel<TData>;
  private readonly rows: RowModel<TData>;
  private readonly styleTable: StyleTable;
  /** Synchronous main-thread view; always-correct fallback. */
  private readonly mainMat: MainMaterializer<TData>;
  /** Active read model the pool binds from (main or worker). */
  private view: RenderView<TData>;
  private readonly pool: RowPool<TData>;

  /** Current render path. Worker mode stamps only precomputed cells. */
  private mode: 'main' | 'worker' = 'main';
  private readonly workerCoord: WorkerCoordinator;
  private workerMat: WorkerMaterializer<TData> | null = null;
  /** Latched after a worker fallback so we never re-init the worker. */
  private workerFellBack = false;
  private destroyed = false;
  /** rAF handle coalescing worker repaints (agg pushes / model syncs). */
  private workerRepaintRaf: number | null = null;

  private readonly headerEl: HTMLDivElement;
  private readonly headerInner: HTMLDivElement;
  private readonly scrollerEl: HTMLDivElement;
  private readonly spacerEl: HTMLDivElement;
  private readonly layerEl: HTMLDivElement;

  private readonly abort = new AbortController();
  private readonly ro: ResizeObserver;
  private rafScroll: number | null = null;
  private txTimer: ReturnType<typeof setTimeout> | null = null;
  private txBatch: TxBatch<TData> = { add: [], update: [], remove: [] };

  private viewWidth = 0;
  private viewHeight = 0;
  private offsets: number[] = [0];
  private geo: PoolGeometry<TData>;
  private curPoolSize = -1;
  private curColCount = -1;

  private readonly selectedIds = new Set<string>();
  private focused: { rowIndex: number; colId: string } | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly options: GridOptions<TData>,
  ) {
    ensureDomGridStyles();
    this.theme = resolveTheme(options.theme ?? 'dark', options.density ?? 'compact', {
      gridlines: options.gridlines,
    });

    // DOM skeleton: root → header(inner) + scroller(spacer + layer).
    root.classList.add(CLS.root);
    applyThemeVars(root, this.theme);
    this.headerEl = document.createElement('div');
    this.headerEl.className = CLS.header;
    this.headerInner = document.createElement('div');
    this.headerInner.style.display = 'flex';
    this.headerInner.style.position = 'absolute';
    this.headerInner.style.top = '0';
    this.headerInner.style.left = '0';
    this.headerInner.style.height = '100%';
    this.headerEl.appendChild(this.headerInner);
    this.scrollerEl = document.createElement('div');
    this.scrollerEl.className = CLS.scroller;
    this.spacerEl = document.createElement('div');
    this.spacerEl.className = CLS.spacer;
    this.layerEl = document.createElement('div');
    this.layerEl.className = CLS.layer;
    this.scrollerEl.appendChild(this.spacerEl);
    this.scrollerEl.appendChild(this.layerEl);
    root.appendChild(this.headerEl);
    root.appendChild(this.scrollerEl);

    // Models — mirrors grid.ts:365-376 argument order. Selection column,
    // floating filter, and tree data are out of scope (fixed to off).
    this.cols = new ColumnModel<TData>(
      options.columnDefs,
      options.defaultColDef,
      this.theme.headerHeight,
      this.theme.floatingFilterHeight,
      false,
      false,
      options.autoGroupColumnDef,
      'none',
      options.selectionColumnDef,
    );
    const getRowId = options.getRowId;
    this.rows = new RowModel<TData>(getRowId ? (d) => getRowId({ data: d }) : undefined);
    this.rows.quickFilter = options.quickFilterText ?? '';
    this.styleTable = new StyleTable();
    this.mainMat = new MainMaterializer<TData>(this.rows, this.cols, this.styleTable, options.formatting);
    this.view = this.mainMat;
    this.workerCoord = new WorkerCoordinator(this.buildWorkerHost());
    this.pool = new RowPool<TData>(this.layerEl);
    this.geo = this.buildGeometry();

    this.installListeners();
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.scrollerEl);

    if (options.rowData) this.setRowData(options.rowData);
    else {
      this.refreshModel();
    }
  }

  /** The scrollable viewport element (for callers that need scroll access). */
  get scrollerElement(): HTMLElement {
    return this.scrollerEl;
  }

  /** Replaces all row data and rebuilds the displayed model. */
  setRowData(rows: TData[]): void {
    this.workerCoord.onRowDataReset(rows);
    this.rows.setRowData(rows);
    this.refreshModel();
  }

  /**
   * Queues an add/update/remove transaction, coalesced over a {@link TX_FLUSH_MS}
   * window. Update-only flushes patch changed cells in place; structural
   * changes (add/remove) trigger a full model refresh.
   */
  applyTransactionAsync(tx: { add?: TData[]; update?: TData[]; remove?: TData[] }): void {
    if (tx.add) this.txBatch.add.push(...tx.add);
    if (tx.update) this.txBatch.update.push(...tx.update);
    if (tx.remove) this.txBatch.remove.push(...tx.remove);
    if (!this.txTimer) {
      this.txTimer = setTimeout(() => this.flushTransactions(), TX_FLUSH_MS);
    }
  }

  /**
   * Re-runs the displayed model and repaints. Prefers the worker render plane
   * when eligible (`rowDataMode !== 'main'`, no ineligible configs, no prior
   * fallback); otherwise runs the synchronous main-thread path.
   */
  refreshModel(): void {
    if (this.syncWorker()) return;
    // Main-thread path (fallback / ineligible).
    if (this.workerCoord.dataPlaneActive) this.workerCoord.teardown();
    this.mode = 'main';
    this.view = this.mainMat;
    const groupCols = this.cols.getRowGroupCols();
    const groupOpts: GroupRefreshOptions<TData> | null =
      groupCols.length > 0
        ? {
            groupCols,
            aggCols: this.cols.getAggCols(),
            groupDefaultExpanded: this.options.groupDefaultExpanded ?? 0,
            groupTotalRow: this.options.groupTotalRow,
            grandTotalRow: this.options.grandTotalRow,
          }
        : null;
    this.rows.refresh(this.cols, this.valueOf, undefined, groupOpts, null);
    this.mainMat.refreshColumns();
    this.pool.invalidate();
    this.layout();
  }

  /**
   * Drive the worker render plane for the current model, returning true when
   * the worker path is taken. Builds the pipeline + render configs; on any
   * ineligibility (or a prior fallback) it returns false so the caller runs
   * the main path. The worker's model output arrives asynchronously via the
   * coordinator host's `applyWorkerModel`.
   */
  private syncWorker(): boolean {
    if (this.workerFellBack || this.options.rowDataMode === 'main') return false;
    const workerConfig = buildWorkerConfig(this.cols, this.rows, this.options);
    const renderConfig = workerConfig ? buildRenderConfig(this.cols) : null;
    if (!workerConfig || !renderConfig) {
      if (this.options.rowDataMode === 'worker') this.workerCoord.logIneligibleWarning();
      return false;
    }

    const ids: string[] = [];
    const rowsArr: unknown[] = [];
    for (const row of this.rows.sourceRows) {
      ids.push(this.rows.getId(row));
      rowsArr.push(row);
    }
    this.workerCoord.syncDataPlane(workerConfig, ids, rowsArr);
    const client = this.workerCoord.dataClient;
    if (!client || !this.workerCoord.dataPlaneActive) {
      // Construction failed → coordinator already fired fallbackToMain.
      return false;
    }
    // Ship the render config, then bind through a fresh worker view. Ordering:
    // this posts setRenderConfig before the first renderWindow (both synchronous).
    void client.setRenderConfig(renderConfig).catch(() => {
      /* fallback handled by the coordinator op-chain */
    });
    this.workerMat = new WorkerMaterializer<TData>(
      this.rows,
      () => this.workerCoord.dataClient,
      renderConfig,
      this.styleTable,
      { onDelta: (rowIndex, colIndex, dir) => this.onWorkerDelta(rowIndex, colIndex, dir) },
    );
    this.workerMat.onUpdate(() => this.onWorkerWindowUpdate());
    this.view = this.workerMat;
    this.mode = 'worker';
    this.mainMat.refreshColumns(); // keep the fallback view column-current
    this.pool.invalidate();
    this.layout();
    return true;
  }

  /** Releases every resource: listeners, observer, rAF, timer, pool, styles, DOM. */
  destroy(): void {
    this.destroyed = true;
    this.abort.abort();
    this.ro.disconnect();
    if (this.rafScroll != null) cancelAnimationFrame(this.rafScroll);
    if (this.workerRepaintRaf != null) cancelAnimationFrame(this.workerRepaintRaf);
    if (this.txTimer != null) clearTimeout(this.txTimer);
    this.workerCoord.teardown();
    this.pool.clear();
    this.styleTable.dispose();
    this.root.innerHTML = '';
    this.root.classList.remove(CLS.root);
  }

  // — internals —

  /** Value accessor shared with the row model for filter/sort/group. */
  private valueOf = (row: TData, col: InternalColumn<TData>, _rowIndex: number): unknown => {
    const field = col.def.field;
    if (!field) return undefined;
    return readFieldValue(row, field);
  };

  private buildGeometry(): PoolGeometry<TData> {
    const cols = this.cols.displayed();
    const offsets: number[] = new Array(cols.length + 1);
    offsets[0] = 0;
    for (let i = 0; i < cols.length; i++) offsets[i + 1] = offsets[i] + cols[i].width;
    this.offsets = offsets;
    return {
      cols,
      colLeft: (i) => this.offsets[i] ?? 0,
      rowHeight: this.theme.rowHeight,
      groupIndent: GROUP_INDENT,
      totalWidth: this.cols.totalWidth,
    };
  }

  /** Measures the viewport, resyncs geometry/pool/header, then binds the window. */
  private layout(): void {
    const rect = this.scrollerEl.getBoundingClientRect();
    this.viewWidth = rect.width;
    this.viewHeight = rect.height;
    this.cols.setViewportWidth(this.viewWidth);
    this.mainMat.refreshColumns();
    this.geo = this.buildGeometry();

    const rowCount = this.view.rowCount();
    const colCount = this.geo.cols.length;
    const size = poolSize(this.viewHeight || this.theme.rowHeight, this.theme.rowHeight, rowCount);
    if (size !== this.curPoolSize || colCount !== this.curColCount) {
      this.pool.setSize(size, colCount);
      this.curPoolSize = size;
      this.curColCount = colCount;
    } else {
      // Content may have changed under an unchanged pool shape (e.g. resize
      // with a stable window); force a full re-stamp.
      this.pool.invalidate();
    }

    this.spacerEl.style.height = `${Math.min(rowCount * this.theme.rowHeight, MAX_SPACER_HEIGHT)}px`;
    this.layerEl.style.width = `${this.geo.totalWidth}px`;
    this.headerInner.style.width = `${this.geo.totalWidth}px`;
    this.rebuildHeader();
    this.syncViewport();
  }

  private rebuildHeader(): void {
    this.headerInner.replaceChildren();
    const cols = this.geo.cols;
    for (const col of cols) {
      const h = document.createElement('div');
      const isNum = col.def.type === 'number';
      h.className = `${CLS.headerCell}${isNum ? ` ${CLS.num}` : ''}`;
      if (col.sort === 'asc') h.classList.add(CLS.sortAsc);
      else if (col.sort === 'desc') h.classList.add(CLS.sortDesc);
      h.dataset.colId = col.colId;
      h.style.width = `${col.width}px`;
      h.textContent = col.def.headerName ?? col.def.field ?? col.colId;
      this.headerInner.appendChild(h);
    }
  }

  /** Coalesced scroll → window recompute + rebind; also syncs header scroll. */
  private syncViewport(): void {
    const scrollTop = this.scrollerEl.scrollTop;
    const scrollLeft = this.scrollerEl.scrollLeft;
    this.headerInner.style.transform = `translateX(${-scrollLeft}px)`;
    const rowCount = this.view.rowCount();
    const { firstRow, lastRow } = computeWindow(
      scrollTop,
      this.viewHeight || this.theme.rowHeight,
      this.theme.rowHeight,
      rowCount,
    );
    this.pool.bindWindow(firstRow, lastRow, this.view, this.geo, this.selectedIds, this.focused);
  }

  private installListeners(): void {
    const signal = this.abort.signal;

    this.scrollerEl.addEventListener(
      'scroll',
      () => {
        if (this.rafScroll == null) {
          this.rafScroll = requestAnimationFrame(() => {
            this.rafScroll = null;
            this.syncViewport();
          });
        }
      },
      { passive: true, signal },
    );

    this.headerEl.addEventListener(
      'click',
      (e) => this.onHeaderClick(e),
      { signal },
    );

    this.scrollerEl.addEventListener(
      'mousedown',
      (e) => this.onRowMouseDown(e),
      { signal },
    );

    this.scrollerEl.addEventListener(
      'click',
      (e) => this.onRowClick(e),
      { signal },
    );
  }

  private onHeaderClick(e: MouseEvent): void {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const hc = target.closest<HTMLElement>('[data-col-id]');
    const colId = hc?.dataset.colId;
    if (!colId) return;
    const col = this.cols.getColumn(colId);
    const cur = col?.sort ?? null;
    const next: SortDir = cur === null ? 'asc' : cur === 'asc' ? 'desc' : null;
    this.cols.setSort(colId, next, e.shiftKey);
    this.refreshModel();
  }

  private onRowMouseDown(e: MouseEvent): void {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const rowEl = target.closest<HTMLElement>('[data-row]');
    if (!rowEl) return;
    const rowIndex = Number(rowEl.dataset.row);
    const meta = this.view.rowMeta(rowIndex);
    if (!meta) return;
    const colIndex = this.colIndexAtClientX(e.clientX);
    const col = this.geo.cols[colIndex];
    if (!col) return;

    if (e.ctrlKey || e.metaKey) {
      if (this.selectedIds.has(meta.id)) this.selectedIds.delete(meta.id);
      else this.selectedIds.add(meta.id);
    } else {
      this.selectedIds.clear();
      this.selectedIds.add(meta.id);
    }
    this.focused = { rowIndex, colId: col.colId };
    this.syncViewport();
  }

  private onRowClick(e: MouseEvent): void {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const rowEl = target.closest<HTMLElement>('[data-row]');
    if (!rowEl) return;
    const rowIndex = Number(rowEl.dataset.row);
    const meta = this.view.rowMeta(rowIndex);
    if (!meta || meta.kind !== 'group') return;
    // Only the first cell (the auto group column) toggles the group.
    if (this.colIndexAtClientX(e.clientX) !== 0) return;
    // Key the toggle on the node's groupId (null for footers and
    // non-expandable groups), matching grid.ts's chevron handler.
    const groupId = this.rows.getDisplayedNode(rowIndex)?.groupId;
    if (!groupId) return;
    this.rows.setGroupExpanded(groupId, !meta.expanded);
    this.refreshModel();
  }

  /** Binary-searches the accumulated column offsets for the column under `clientX`. */
  private colIndexAtClientX(clientX: number): number {
    const rect = this.layerEl.getBoundingClientRect();
    const x = clientX - rect.left;
    const n = this.geo.cols.length;
    if (n === 0) return -1;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.offsets[mid] ?? 0) <= x) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private flushTransactions(): void {
    this.txTimer = null;
    const batch = this.txBatch;
    this.txBatch = { add: [], update: [], remove: [] };

    if (this.mode === 'worker' && this.workerCoord.dataPlaneActive) {
      // Worker mode: forward the raw transaction. Visible-cell updates arrive
      // back as renderDeltas — the single source of truth. Keep the main row
      // mirror in sync (structural adds/removes drive a fresh worker rebuild,
      // and it backs a clean fallback), but never rebind from CellChanges here.
      this.rows.applyTransaction(batch);
      this.workerCoord.forwardTransaction(this.workerTransactionPayload(batch));
      if (batch.add.length > 0 || batch.remove.length > 0) this.refreshModel();
      return;
    }

    const changes = this.rows.applyTransaction(batch);
    if (batch.add.length > 0 || batch.remove.length > 0) {
      this.refreshModel();
      return;
    }
    // Update-only: patch each changed cell in place.
    for (const ch of changes) {
      const rowIndex = this.rows.displayedIndexOf(ch.rowId);
      if (rowIndex < 0) continue;
      const colIndex = this.colIndexOfKey(ch.colKey);
      if (colIndex < 0) continue;
      this.pool.rebindCell(rowIndex, colIndex, this.view, this.geo, ch.dir);
    }
  }

  /** Build the worker transaction payload from a coalesced batch (mirrors grid.ts). */
  private workerTransactionPayload(batch: TxBatch<TData>): AggTransactionPayload {
    const payload: AggTransactionPayload = {};
    if (batch.add.length) {
      payload.addIds = batch.add.map((r) => this.rows.getId(r));
      payload.add = batch.add as unknown[];
    }
    if (batch.update.length) {
      payload.updateIds = batch.update.map((r) => this.rows.getId(r));
      payload.update = batch.update as unknown[];
    }
    if (batch.remove.length) {
      payload.removeIds = batch.remove.map((r) => this.rows.getId(r));
    }
    return payload;
  }

  // — worker glue —

  /** Coordinator host mirroring grid.ts:379-411 (DOM no-ops where noted). */
  private buildWorkerHost(): ConstructorParameters<typeof WorkerCoordinator>[0] {
    const grid = this;
    return {
      get destroyed() {
        return grid.destroyed;
      },
      // Worker agg / model pushes → coalesced re-request of the render window.
      requestPaint: () => grid.scheduleWorkerRepaint(),
      invalidateViewportPrefetch: () => {},
      workerOwnsRowData: false,
      updateStatusBar: () => {},
      flashCellChange: () => {},
      enableCellFlash: false,
      applyWorkerModel: (output) => {
        if (grid.destroyed) return;
        grid.rows.applyWorkerModel(output);
        grid.workerMat?.invalidate();
        grid.layout();
      },
      patchGroupAggregates: (updates) => grid.rows.patchGroupAggregates(updates),
      fallbackToMain: () => {
        grid.workerFellBack = true;
        grid.mode = 'main';
        grid.view = grid.mainMat;
        grid.refreshModel();
      },
      onRenderDeltas: (deltas) => grid.onRenderDeltas(deltas),
      get dataMirrorActive() {
        return grid.rows.dataMirrorActive;
      },
      restoreDataMirror: (rows) => grid.rows.restoreDataMirror(rows as TData[]),
      syncWorkerRulesConfig: () => Promise.resolve(),
    };
  }

  /** A pushed render-delta batch → patch the worker view + restamp cells. */
  private onRenderDeltas(deltas: RenderDeltas): void {
    if (this.destroyed || this.mode !== 'worker') return;
    this.workerMat?.applyDeltas(deltas);
  }

  /** One patched worker cell → restamp it in place (if currently bound). */
  private onWorkerDelta(rowIndex: number, colIndex: number, dir: 1 | -1 | 0): void {
    this.pool.rebindCell(rowIndex, colIndex, this.view, this.geo, dir);
  }

  /**
   * A fresh render window arrived → re-stamp the visible window from the cache.
   * The pool must be invalidated first: the slots for these rows are already
   * bound (the initial pre-fetch bind stamped placeholders), so without marking
   * them dirty `bindWindow` would skip re-stamping and the freshly materialized
   * text/styles would never reach the DOM.
   */
  private onWorkerWindowUpdate(): void {
    if (this.destroyed || this.mode !== 'worker') return;
    this.pool.invalidate();
    this.syncViewport();
  }

  /**
   * Coalesce worker-driven repaints (aggregate pushes, non-structural model
   * syncs) to one refetch per frame: invalidate the cached window so the next
   * bind refetches, then rebind.
   */
  private scheduleWorkerRepaint(): void {
    if (this.destroyed || this.mode !== 'worker' || this.workerRepaintRaf != null) return;
    this.workerRepaintRaf = requestAnimationFrame(() => {
      this.workerRepaintRaf = null;
      if (this.destroyed || this.mode !== 'worker') return;
      this.workerMat?.invalidate();
      this.syncViewport();
    });
  }

  /** Maps a `CellChange.colKey` (a data field name) to a display column index. */
  private colIndexOfKey(key: string): number {
    const cols = this.geo.cols;
    for (let i = 0; i < cols.length; i++) {
      if (cols[i].def.field === key || cols[i].colId === key) return i;
    }
    return -1;
  }
}
