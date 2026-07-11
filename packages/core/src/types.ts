/**
 * Public configuration types. Deliberately AG-Grid-shaped (a structural
 * subset) so configs written for AG port with minimal change — API
 * compatibility, not source compatibility.
 */
import type { Tabular } from './grid';

export type Pinned = 'left' | 'right' | null;
export type SortDir = 'asc' | 'desc' | null;
export type Density = 'comfortable' | 'compact' | 'dense';
export type ThemeName = 'dark' | 'light';
/** Cell gridlines: both axes, horizontal only, or none (zebra only). */
export type GridlineMode = 'both' | 'horizontal' | 'none';

export interface CellParams<TData = unknown> {
  value: unknown;
  /** Undefined on synthesized rows (group / tree filler nodes) — AG Grid parity. */
  data: TData | undefined;
  rowIndex: number;
  colDef: ColDef<TData>;
  api: Tabular<TData>;
}

export interface CellStyle {
  color?: string;
  background?: string;
  backgroundColor?: string;
  fontWeight?: number | string;
  fontStyle?: string;
  /** Canvas underline / strikethrough (CSS-named for AG familiarity). */
  textDecoration?: 'none' | 'underline' | 'line-through' | string;
  /** Per-cell font size in px (overrides theme density). */
  fontSize?: number;
  /**
   * CSS border shorthand, side-prefixed `left:3px solid #E34671`, or a
   * multi-side map written by the format ribbon (sides merge independently).
   */
  border?:
    | string
    | Partial<Record<'all' | 'top' | 'bottom' | 'left' | 'right', string>>;
  /** Uppercase / none for header captions when used as `headerStyle`. */
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize' | string;
}

/** Placement for `ColDef.cellIcon` (format-ribbon Icons section). */
export type CellIconPlace = 'prefix' | 'suffix' | 'tl' | 'tr' | 'bl' | 'br';

/** Static cell/header icon or emoji (Tabular extension for the format ribbon). */
export interface CellIconSpec {
  name?: string;
  emoji?: string;
  color?: string;
  place?: CellIconPlace;
}

/** AG `CellClassRules` — class names map to boolean functions or expression strings. */
export type CellClassRules<TData = unknown> = Record<
  string,
  ((params: CellParams<TData>) => boolean) | string
>;

/** AG `RowClassRules`. */
export type RowClassRules<TData = unknown> = Record<
  string,
  ((params: RowStyleParams<TData>) => boolean) | string
>;

export interface RowStyleParams<TData = unknown> {
  data: TData | undefined;
  rowIndex: number;
  api: Tabular<TData>;
  context?: unknown;
  node: { group: boolean; footer?: boolean; level: number; key: string };
}

export type RowStyle = CellStyle;

/** Rect + resolved paint context handed to custom canvas cell renderers. */
export interface CellRenderParams<TData = unknown> extends CellParams<TData> {
  formatted: string;
  x: number;
  y: number;
  width: number;
  height: number;
  selected: boolean;
  focused: boolean;
  theme: import('./theme').ResolvedTheme;
}

/** Present for AG Grid model-shape compatibility; ignored by the engine. */
interface FilterTypeTag {
  filterType?: 'text' | 'number' | 'set';
}

/**
 * AG `agDateColumnFilter` model. Bounds are `YYYY-MM-DD` strings
 * (AG `dateFrom`/`dateTo`); comparisons are date-only, ignoring time.
 */
export interface DateColumnFilter {
  filterType: 'date';
  type: 'equals' | 'notEqual' | 'lessThan' | 'greaterThan' | 'inRange' | 'blank' | 'notBlank';
  dateFrom: string | null;
  dateTo?: string | null;
}

export type ColumnFilter =
  | ({ type: 'contains' | 'notContains' | 'startsWith' | 'endsWith'; filter: string } & FilterTypeTag)
  | ({ type: 'equals' | 'notEqual'; filter: string | number } & FilterTypeTag)
  | ({
      type: 'greaterThan' | 'greaterThanOrEqual' | 'lessThan' | 'lessThanOrEqual';
      filter: number;
    } & FilterTypeTag)
  | ({ type: 'inRange'; filter: number; filterTo: number } & FilterTypeTag)
  | ({ type: 'blank' | 'notBlank' } & FilterTypeTag)
  /** Set filter: row passes when its stringified value is in `values`. `(Blanks)` matches null. */
  | ({ type: 'set'; values: string[] } & FilterTypeTag)
  | DateColumnFilter;

export type FilterModel = Record<string, ColumnFilter>;

export type ColumnGroupShow = 'open' | 'closed';

export interface ColGroupDef<TData = unknown> {
  groupId?: string;
  headerName?: string;
  children: AnyColDef<TData>[];
  openByDefault?: boolean;
  marryChildren?: boolean;
  columnGroupShow?: ColumnGroupShow;
}

export type AnyColDef<TData = unknown> = ColDef<TData> | ColGroupDef<TData>;

export interface ColDef<TData = unknown> {
  field?: string;
  colId?: string;
  headerName?: string;
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  /** Flex weight; flexed columns share leftover viewport width. */
  flex?: number;
  pinned?: Pinned;
  hide?: boolean;
  sortable?: boolean;
  sort?: SortDir;
  resizable?: boolean;
  /** Static or per-row (AG `EditableCallback`-shaped) editability. */
  editable?: boolean | ((params: { data: TData | undefined; rowIndex: number; colDef: ColDef<TData> }) => boolean);
  /** Drives default alignment, font (mono), parsing, and filter kind. */
  type?: 'number' | 'text' | 'date';
  /** `true` infers text/number from the column type (AG `filter: true`). */
  filter?: 'text' | 'number' | 'set' | 'date' | boolean;
  /** Compact filter editor in the floating filter header row. */
  floatingFilter?: boolean;
  align?: 'left' | 'right' | 'center';
  columnGroupShow?: ColumnGroupShow;
  lockPosition?: boolean;
  suppressMovable?: boolean;
  valueGetter?: (params: CellParams<TData>) => unknown;
  /**
   * Calculated column expression (Tabular extension). Alternative to
   * `valueGetter` — uses `[field]` refs and built-in functions. Compiled
   * once at column resolution; invalid expressions fail closed to `null`.
   */
  calc?: string;
  /**
   * Excel-style format code or named preset (`number`, `currency`, `percent`,
   * `date`, `relativeTime`, `abbreviated`). Tabular extension via
   * `@tabular/format` — compiled once; bad codes fail closed to `String(value)`.
   * Runs through the value-format resolver chain before `valueFormatter`.
   */
  format?: string;
  valueFormatter?: (params: CellParams<TData>) => string;
  valueParser?: (params: { newValue: string; oldValue: unknown; data: TData }) => unknown;
  comparator?: (a: unknown, b: unknown, rowA: TData, rowB: TData) => number;
  cellStyle?: CellStyle | ((params: CellParams<TData>) => CellStyle | null | undefined);
  /**
   * Header caption style (Tabular extension — format ribbon Cells↔Header target).
   * Uses the same `CellStyle` vocabulary as body cells.
   */
  headerStyle?: CellStyle;
  /** Static icon/emoji painted in the cell (format ribbon Icons section). */
  cellIcon?: CellIconSpec | null;
  /** Static icon/emoji painted in the header caption. */
  headerIcon?: CellIconSpec | null;
  /** Static CSS class(es) — resolved via `GridOptions.classStyles` for canvas paint. */
  cellClass?: string | string[] | ((params: CellParams<TData>) => string | string[] | undefined);
  /** Dynamic class rules (functions or expression strings). */
  cellClassRules?: CellClassRules<TData>;
  /** AG name: flash when cell data changes. Default false; number cols flash by default in Tabular. */
  enableCellChangeFlash?: boolean;
  /**
   * Custom canvas painter (return false to fall through to default text
   * paint), a registered renderer name (`registerCellRenderer`), or
   * `'agGroupCellRenderer'` to show the master-detail expand chevron in
   * this column (AG parity).
   */
  cellRenderer?:
    | 'agGroupCellRenderer'
    | string
    | ((ctx: CanvasRenderingContext2D, params: CellRenderParams<TData>) => void | boolean);
  /**
   * Per-cell renderer choice (AG `cellRendererSelector`). Return
   * `{ component }` (registered name or paint function) to override the
   * column's `cellRenderer` for this cell; return nothing to use the default.
   * Runs per cell — only defined columns pay for it.
   */
  cellRendererSelector?: (
    params: CellParams<TData>,
  ) => { component?: string | ((ctx: CanvasRenderingContext2D, params: CellRenderParams<TData>) => void | boolean) } | undefined;
  /**
   * DOM cell editor: a registered editor name (`registerCellEditor`) or a
   * factory. Default: the built-in text input editor.
   */
  cellEditor?: string | import('./registry').CellEditorFactory<TData>;
  /** Editor-specific params passed to the cell editor factory. */
  cellEditorParams?: unknown;
  /**
   * Per-cell editor choice (AG `cellEditorSelector`). Return `{ component,
   * params }` to override the column's `cellEditor` for this cell; return
   * nothing to use the default.
   */
  cellEditorSelector?: (params: CellParams<TData>) => {
    component?: string | import('./registry').CellEditorFactory<TData>;
    params?: unknown;
  } | undefined;
  /** @deprecated Use `enableCellChangeFlash`. */
  flashOnChange?: boolean;
  /** Include this column in the row-group hierarchy. */
  rowGroup?: boolean;
  /** Allow dragging this column into the row group panel. Default false (AG Grid parity). */
  enableRowGroup?: boolean;
  /** Order among row-group columns (lower first). */
  rowGroupIndex?: number;
  /** Pivot by this column when `pivotMode` is on. */
  pivot?: boolean;
  /** Order among pivot columns (lower first). */
  pivotIndex?: number;
  /** Allow dragging into the pivot panel. Default false (AG parity). */
  enablePivot?: boolean;
  /** Allow using this column as a value column in pivot mode. */
  enableValue?: boolean;
  /** Comparator for ordering generated pivot column labels. */
  pivotComparator?: (valueA: string, valueB: string) => number;
  /** Internal: pivot keys for generated pivot result columns. */
  pivotKeys?: string[];
  /** Internal: open pivot result col ids summed when this closed header is visible. */
  pivotChildColIds?: string[];
  /** Aggregation when the grid is grouped. */
  aggFunc?: import('./aggregation').AggFuncName | import('./aggregation').AggFunc;
  /** Weight field for weightedAverage (e.g. 'notional'). */
  weightField?: string;
  /** Static cell tooltip (overridden by `tooltipValueGetter`). */
  tooltipField?: string;
  tooltipValueGetter?: (params: CellParams<TData>) => string | null | undefined;
  /** Static header tooltip (overridden by `headerTooltipValueGetter`). */
  headerTooltip?: string;
  headerTooltipValueGetter?: (params: CellParams<TData>) => string | null | undefined;
  /** Exclude this column from keyboard Tab navigation. */
  suppressNavigable?: boolean | ((params: CellParams<TData>) => boolean);
  /** Hide from the Columns tool panel. Default false. */
  suppressColumnsToolPanel?: boolean;
  /** Hide from the Filters tool panel. Default false. */
  suppressFiltersToolPanel?: boolean;
  /** Hide the header ⋮ column-menu button. Default false. */
  suppressHeaderMenuButton?: boolean;
  /** Hide the header funnel filter button. Default false. */
  suppressHeaderFilterButton?: boolean;
  /** Static column-menu items for this column (replaces the defaults). */
  mainMenuItems?: ContextMenuItem[];
  /** Return `true` to cancel the grid's default key handling for this cell. */
  suppressKeyboardEvent?: (params: CellParams<TData> & { event: KeyboardEvent }) => boolean;
  /**
   * Wrap text inside the cell instead of truncating (AG `wrapText`).
   * Typically used with `autoHeight`; without it, overflow is clipped.
   */
  wrapText?: boolean;
  /**
   * Size each row to fit this column's (wrapped) content — the tallest
   * auto-height column wins (AG `autoHeight`). Default false.
   */
  autoHeight?: boolean;
  /**
   * Wrap header names too long for the column width onto the next line
   * (AG `wrapHeaderText`). Default false.
   */
  wrapHeaderText?: boolean;
  /**
   * Grow the column-header row to fit this column's (wrapped) header label —
   * the tallest auto-header column wins (AG `autoHeaderHeight`). Default false.
   */
  autoHeaderHeight?: boolean;
  /**
   * Cells span multiple columns: return the span count for each row
   * (AG `colSpan`). Spans are constrained to the cell's pinned region.
   */
  colSpan?: (params: CellParams<TData>) => number;
  /**
   * Merge vertically-contiguous cells with equal values into one spanned cell
   * (AG `spanRows`). Requires `GridOptions.enableCellSpan`. Provide a callback
   * for custom merge logic. Mutually exclusive with `colSpan`.
   */
  spanRows?: boolean | ((params: SpanRowsParams<TData>) => boolean);
}

/** AG `RowHeightParams` — `getRowHeight` callback input. */
export interface RowHeightParams<TData = unknown> {
  /** Row data; `undefined` on group / footer rows. */
  data: TData | undefined;
  node: { data: TData | null; group: boolean; footer?: boolean; level: number; key: string };
  api: Tabular<TData>;
  context?: unknown;
}

/** AG `IsFullWidthRowParams`. */
export interface IsFullWidthRowParams<TData = unknown> {
  rowNode: { data: TData | null; group: boolean; footer?: boolean; level: number; key: string };
  api: Tabular<TData>;
}

/** Rect + context handed to the canvas full-width row renderer. */
export interface FullWidthCellRenderParams<TData = unknown> {
  data: TData | undefined;
  node: { data: TData | null; group: boolean; footer?: boolean; level: number; key: string };
  rowIndex: number;
  api: Tabular<TData>;
  x: number;
  y: number;
  width: number;
  height: number;
  theme: import('./theme').ResolvedTheme;
}

/** AG `GetDetailRowDataParams` — input to `detailCellRendererParams.getDetailRowData`. */
export interface GetDetailRowDataParams<TData = unknown, TDetail = unknown> {
  /** Master row node for the details request. */
  node: { id: string; data: TData | null; expanded: boolean };
  /** Data for the master row. */
  data: TData;
  /** Success callback: pass the rows back for the detail grid. */
  successCallback(rowData: TDetail[]): void;
}

/** AG `IDetailCellRendererParams` (subset) — config for the default detail grid. */
export interface DetailCellRendererParams<TData = unknown, TDetail = unknown> {
  /** Grid Options to use for the Detail Grid. */
  detailGridOptions: Omit<GridOptions<TDetail>, 'rowData'> & { rowData?: TDetail[] };
  /** Provides the rows to display in the Detail Grid (may resolve async). */
  getDetailRowData: (params: GetDetailRowDataParams<TData, TDetail>) => void;
  /** How detail grids refresh as master data changes. Default `'rows'`. */
  refreshStrategy?: 'rows' | 'everything' | 'nothing';
}

/** Params handed to a custom `detailCellRenderer` (DOM escape hatch). */
export interface DetailCellRendererCustomParams<TData = unknown> {
  data: TData;
  node: { id: string; data: TData | null; expanded: boolean };
  api: Tabular<TData>;
  pinned: null;
}

/** AG `DetailGridInfo` — registered detail grid instance. */
export interface DetailGridInfo {
  /** Id of the detail grid: `detail_{ROW-ID}` of the parent row. */
  id: string;
  /** Grid api of the detail grid. */
  api?: Tabular<unknown>;
}

/** AG `IsRowMaster` callback. */
export type IsRowMaster<TData = unknown> = (dataItem: TData) => boolean;

/** AG `SpanRowsParams` — decides whether two adjacent rows merge. */
export interface SpanRowsParams<TData = unknown> {
  /** First row of the span (represents the spanned cells). */
  nodeA: { data: TData | null } | null;
  valueA: unknown;
  /** Next row of the span to test. */
  nodeB: { data: TData | null } | null;
  valueB: unknown;
  colDef: ColDef<TData>;
  api: Tabular<TData>;
}

export interface SortModelItem {
  colId: string;
  sort: 'asc' | 'desc';
}

export interface ColumnState {
  colId: string;
  width?: number;
  hide?: boolean;
  pinned?: Pinned;
  sort?: SortDir;
  sortIndex?: number | null;
}

export interface ColumnGroupStateItem {
  groupId: string;
  open: boolean;
}

export interface CellPosition {
  rowIndex: number;
  colId: string;
}

export interface RowDataTransaction<TData = unknown> {
  add?: TData[];
  update?: TData[];
  remove?: TData[];
}

/** One changed field on an updated row (transaction delta feed). */
export interface RowDeltaChange {
  key: string;
  oldValue: unknown;
  newValue: unknown;
}

/**
 * Per-row delta from an applied transaction — the read-only feed that rules,
 * tick history, and `PREV()`-style consumers subscribe to via
 * `api.onTransactionApplied` / the `transactionApplied` event. Built only
 * when at least one listener is subscribed.
 */
export interface RowDelta<TData = unknown> {
  rowId: string;
  data: TData;
  changes: RowDeltaChange[];
}

/**
 * Versioned module state slice inside `GridState` — satellites persist
 * through `registerStateModule` without the core knowing their shape.
 */
export interface GridStateModuleSlice {
  version: number;
  data: unknown;
}

/**
 * Unified grid state snapshot (AG `GridState`-shaped subset plus module
 * slices). Produced by `api.getState()`, restored by `api.setState()` or
 * `GridOptions.initialState` (applied before first paint).
 */
export interface GridState {
  /** Snapshot format version (currently 1). */
  version?: number;
  columns?: ColumnState[];
  columnGroups?: ColumnGroupStateItem[];
  filter?: { filterModel: FilterModel; quickFilter?: string };
  rowGroup?: string[];
  pivot?: { pivotMode?: boolean; pivotColumns?: string[]; valueColumns?: string[] };
  sideBar?: { visible: boolean; openToolPanel: string | null };
  pagination?: { page: number };
  /** Versioned satellite slices keyed by module id. */
  modules?: Record<string, GridStateModuleSlice>;
  /**
   * Named layout snapshots (Tabular extension — Phase 7). Each entry is a
   * full `GridState` minus nested `layouts` to avoid recursion.
   */
  layouts?: NamedLayout[];
  /** Currently active named layout id, if any. */
  activeLayoutId?: string | null;
}

/** A named `GridState` snapshot for the layouts menu. */
export interface NamedLayout {
  id: string;
  name: string;
  /** ISO timestamp when last saved. */
  updatedAt: string;
  /** State without nested layouts (to avoid recursion). */
  state: Omit<GridState, 'layouts' | 'activeLayoutId'>;
}

/** A registered provider of one `GridState.modules` slice. */
export interface GridStateModule {
  id: string;
  version: number;
  /** Live state for the slice; return undefined to omit it from snapshots. */
  get(): unknown;
  /** Restore a slice (version is the stored slice's version — migrate as needed). */
  set(data: unknown, version: number): void;
}

export interface CellValueChangedEvent<TData = unknown> {
  data: TData;
  colId: string;
  oldValue: unknown;
  newValue: unknown;
  rowIndex: number;
}

export interface GridEvents<TData = unknown> {
  gridReady: { api: Tabular<TData> };
  firstDataRendered: { api: Tabular<TData> };
  modelUpdated: { rowCount: number; displayedRowCount: number };
  sortChanged: { sortModel: SortModelItem[] };
  filterChanged: { filterModel: FilterModel; quickFilter: string };
  filterModified: { colId: string; filter: ColumnFilter | null };
  selectionChanged: { selectedIds: string[] };
  cellValueChanged: CellValueChangedEvent<TData>;
  cellClicked: { rowIndex: number; colId: string; data: TData | undefined };
  cellDoubleClicked: { rowIndex: number; colId: string; data: TData | undefined };
  columnResized: { colId: string; width: number };
  columnMoved: { colId: string; toIndex: number };
  columnPinned: { colId: string; pinned: Pinned };
  columnVisible: { colId: string; visible: boolean };
  columnGroupOpened: { groupId: string; open: boolean };
  paginationChanged: {
    newPage: boolean;
    animate?: boolean;
    keepRenderedRows?: boolean;
    newData?: boolean;
  };
  cellEditingStarted: { rowIndex: number; colId: string; data: TData | undefined };
  cellEditingStopped: {
    rowIndex: number;
    colId: string;
    data: TData | undefined;
    oldValue: unknown;
    newValue: unknown;
    valueChanged: boolean;
  };
  rangeSelectionChanged: { range: { start: CellPosition; end: CellPosition } | null };
  /** AG v32.2+ name for `rangeSelectionChanged`; both fire. */
  cellSelectionChanged: { range: { start: CellPosition; end: CellPosition } | null };
  /** Fill handle drag released — cells are about to be written (AG `fillStart`). */
  fillStart: {
    initialRange: { start: CellPosition; end: CellPosition };
    direction: 'up' | 'down' | 'left' | 'right';
  };
  /** Fill applied (AG `fillEnd`). */
  fillEnd: {
    initialRange: { start: CellPosition; end: CellPosition };
    finalRange: { start: CellPosition; end: CellPosition };
    direction: 'up' | 'down' | 'left' | 'right';
  };
  rowGroupOpened: {
    /** Group node id (grouping / tree data); undefined for master rows. */
    groupId?: string;
    /** Master row id (master/detail); undefined for group rows. */
    rowId?: string;
    expanded: boolean;
    data?: TData;
  };
  columnRowGroupChanged: { colIds: string[] };
  columnPivotModeChanged: { pivotMode: boolean };
  columnPivotChanged: { columns: string[] };
  cellContextMenu: { rowIndex: number; colId: string; data: TData | undefined };
  /**
   * Read-only feed of applied transactions (old/new values per changed
   * field). Payload is built only when a listener is subscribed.
   */
  transactionApplied: {
    updates: RowDelta<TData>[];
    addedIds: string[];
    removedIds: string[];
  };
  /** Fired when a compiled alert rule matches (token-bucket bounded). */
  alert: import('@tabular/rules').AlertEvent<TData>;
  /** Fired after `setState` / `initialState` restores a snapshot. */
  stateUpdated: Record<string, never>;
  /** Named layout list or active layout changed (Tabular extension). */
  layoutChanged: {
    layouts: NamedLayout[];
    activeLayoutId: string | null;
  };
  /** Pinned row data replaced via `updateOptions` (AG `pinnedRowDataChanged`). */
  pinnedRowDataChanged: Record<string, never>;
  asyncTransactionsFlushed: Record<string, never>;
  pasteStart: Record<string, never>;
  pasteEnd: { cellCount: number };
  tooltipShow: { tooltipText: string; rowIndex?: number; colId?: string };
  tooltipHide: Record<string, never>;
  undoStarted: Record<string, never>;
  undoEnded: { operations: number };
  redoStarted: Record<string, never>;
  redoEnded: { operations: number };
  toolPanelVisibleChanged: {
    visible: boolean;
    source: 'sideBarButtonClicked' | 'sideBarInitializing' | 'api';
    key: string;
    switchingToolPanel: boolean;
  };
  toolPanelSizeChanged: {
    started: boolean;
    ended: boolean;
    width: number;
  };
}

/** AG-Grid-shaped status bar panel config (subset of provided panels). */
export type StatusPanelName =
  | 'agTotalRowCountComponent'
  | 'agTotalAndFilteredRowCountComponent'
  | 'agFilteredRowCountComponent'
  | 'agSelectedRowCountComponent'
  | 'agAggregationComponent';

export type StatusPanelAggFunc = 'count' | 'sum' | 'min' | 'max' | 'avg';

export interface StatusPanelDef {
  statusPanel: StatusPanelName;
  align?: 'left' | 'center' | 'right';
  key?: string;
  statusPanelParams?: { aggFuncs?: StatusPanelAggFunc[] };
}

/** AG `ToolPanelDef` (subset — built-in columns / filters panels). */
export interface ToolPanelDef {
  id: string;
  labelKey?: string;
  labelDefault: string;
  minWidth?: number;
  maxWidth?: number;
  width?: number;
  iconKey?: string;
  toolPanel?: 'agColumnsToolPanel' | 'agFiltersToolPanel' | string;
  toolPanelParams?: ColumnsToolPanelParams | FiltersToolPanelParams | Record<string, unknown>;
}

export interface ColumnsToolPanelParams {
  suppressRowGroups?: boolean;
  suppressValues?: boolean;
  suppressPivots?: boolean;
  suppressPivotMode?: boolean;
  suppressColumnFilter?: boolean;
  suppressColumnSelectAll?: boolean;
  suppressColumnExpandAll?: boolean;
  suppressSyncLayoutWithGrid?: boolean;
  suppressColumnMove?: boolean;
}

export interface FiltersToolPanelParams {
  suppressExpandAll?: boolean;
  suppressFilterSearch?: boolean;
  suppressSyncLayoutWithGrid?: boolean;
}

/** AG `SideBarDef`. */
export interface SideBarDef {
  toolPanels?: (ToolPanelDef | string)[];
  defaultToolPanel?: string;
  hiddenByDefault?: boolean;
  position?: 'left' | 'right';
  hideButtons?: boolean;
}

/** AG v32.2+ row selection config (object form). */
export interface RowSelectionOptions<TData = unknown> {
  mode: 'singleRow' | 'multiRow';
  /** false disables row selection via row clicks (checkbox-style UX). */
  enableClickSelection?: boolean | 'enableDeselection' | 'enableSelection';
  /** true: click toggles selection without Ctrl/Cmd (multiRow only). */
  enableSelectionWithoutKeys?: boolean;
  /** Show row-selection checkboxes (default true for multiRow). */
  checkboxes?: boolean | ((params: { data: TData | undefined; rowIndex: number }) => boolean);
  /** Header checkbox for select-all (multiRow only). Default true when checkboxes on. */
  headerCheckbox?: boolean;
}

/** Params for `FillHandleOptions.setFillValue` (AG `FillOperationParams` subset). */
export interface FillOperationParams<TData = unknown> {
  /** The mouseup event that ended the fill drag. */
  event: MouseEvent;
  /** Values written so far in this fill run (in fill direction). */
  values: unknown[];
  /** The source-range values for this run (in fill direction). */
  initialValues: unknown[];
  currentCellValue: unknown;
  /** 0-based index of the cell being filled, beyond the source run. */
  currentIndex: number;
  direction: 'up' | 'down' | 'left' | 'right';
  colDef: ColDef<TData>;
  data?: TData;
  rowIndex: number;
  api: Tabular<TData>;
}

/** AG `FillHandleOptions` subset (cellSelection.handle with `mode: 'fill'`). */
export interface FillHandleOptions<TData = unknown> {
  mode?: 'fill';
  /** Allowed drag axes. Default `'xy'`. */
  direction?: 'x' | 'y' | 'xy';
  /** Custom fill value; return undefined to fall back to the default series/copy. */
  setFillValue?: (params: FillOperationParams<TData>) => unknown;
  /** Don't clear cells when the drag shrinks the range. Default false. */
  suppressClearOnFillReduction?: boolean;
}

/** AG `CellSelectionOptions` subset (object form of `cellSelection`). */
export interface CellSelectionOptions<TData = unknown> {
  handle?: FillHandleOptions<TData>;
}

/**
 * One entry in a right-click context menu. Strings select AG built-ins:
 * `'copy'`, `'copyWithHeaders'`, `'export'` / `'csvExport'`, `'separator'`.
 */
export type ContextMenuItem =
  | 'separator'
  | 'copy'
  | 'copyWithHeaders'
  | 'export'
  | 'csvExport'
  | {
      name: string;
      /** Omitted for pure submenu parents. */
      action?: () => void;
      disabled?: boolean;
      shortcut?: string;
      /** Show a leading check glyph (e.g. current pin state). */
      checked?: boolean;
      /** Leading icon (ignored when `checked` shows the check glyph). */
      icon?: import('./icons').IconName;
      /** Nested menu opened on hover (AG `subMenu`). */
      subMenu?: ContextMenuItem[];
    };

export interface GetContextMenuItemsParams {
  /** Null when the menu opened from the header. */
  rowIndex: number | null;
  colId: string | null;
  value: unknown;
  defaultItems: ContextMenuItem[];
}

/** Params for `GridOptions.getMainMenuItems` (header ⋮ column menu). */
export interface GetMainMenuItemsParams {
  colId: string;
  defaultItems: ContextMenuItem[];
}

export type GridEventName = keyof GridEvents;

export type PivotColumnGroupTotals = 'before' | 'after';
export type PivotRowTotals = 'before' | 'after';

export type PaginationNumberFormatter<TData = unknown> = (params: {
  value: number;
  api: Tabular<TData>;
}) => string;

export interface PageSummaryPanelParams {
  type: 'pageSummary';
  /** Read-only page label (no navigation buttons). */
  suppressPageInput?: boolean;
}

export interface PageSizePanelParams {
  type: 'pageSize';
  paginationPageSize?: number;
  paginationPageSizeSelector?: number[] | boolean;
}

export interface RowSummaryPanelParams {
  type: 'rowSummary';
}

export type PaginationPanelParams =
  | PageSummaryPanelParams
  | PageSizePanelParams
  | RowSummaryPanelParams;

export type PaginationPanel = 'pageSize' | 'rowSummary' | 'pageSummary' | PaginationPanelParams;

export type ExportFileNameGetter<TData = unknown> = (params?: { api: Tabular<TData> }) => string;

export interface BaseExportParams<TData = unknown> {
  allColumns?: boolean;
  columnKeys?: string[];
  onlySelected?: boolean;
  onlySelectedAllPages?: boolean;
  exportedRows?: 'all' | 'filteredAndSorted';
  skipColumnGroupHeaders?: boolean;
  skipColumnHeaders?: boolean;
  skipRowGroups?: boolean;
  fileName?: string | ExportFileNameGetter<TData>;
  shouldRowBeSkipped?: (params: {
    rowIndex: number;
    data: TData | undefined;
    api: Tabular<TData>;
  }) => boolean;
  processCellCallback?: (params: {
    value: unknown;
    node: { data: TData | undefined; rowIndex: number };
    column: { colId: string; colDef: ColDef<TData> };
    api: Tabular<TData>;
    type: string;
  }) => string;
  processHeaderCallback?: (params: {
    column: { colId: string; colDef: ColDef<TData> };
    api: Tabular<TData>;
  }) => string;
}

export interface FlashCellsParams {
  /** Restrict flash to these row indices (AG `rowNodes` subset). */
  rowIndexes?: number[];
  /** Restrict flash to these column ids / fields. */
  columns?: string[];
  /** Hold duration in ms. Default `cellFlashDuration` (500). */
  flashDuration?: number;
  /** Fade duration in ms after hold. Default `cellFadeDuration` (1000). */
  fadeDuration?: number;
}

export interface CsvExportParams<TData = unknown> extends BaseExportParams<TData> {
  columnSeparator?: string;
  suppressQuotes?: boolean;
}

/** Excel export (SpreadsheetML XML — opens in Excel; intentional deviation from AG OOXML). */
export interface ExcelExportParams<TData = unknown> extends BaseExportParams<TData> {
  sheetName?: string;
  author?: string;
}

export interface GridOptions<TData = unknown> {
  columnDefs: AnyColDef<TData>[];
  rowData?: TData[];
  defaultColDef?: ColDef<TData>;
  /** Stable row identity — required for transactions, selection persistence, flash. */
  getRowId?: (params: { data: TData }) => string;
  /**
   * State snapshot applied at construction, before first paint
   * (AG `initialState`). Takes precedence over persisted state.
   */
  initialState?: GridState;
  /**
   * Tabular extension: autosave `getState()` to localStorage (debounced) and
   * restore it on construction. Requires `gridId`. Default false.
   */
  persistState?: boolean;
  /** Stable id namespacing persisted state (`persistState`). */
  gridId?: string;
  /**
   * Rows pinned above the scrolling viewport (AG `pinnedTopRowData`). Not part
   * of the row model: never sorted, filtered, grouped or selected.
   */
  pinnedTopRowData?: TData[];
  /** Rows pinned below the scrolling viewport (AG `pinnedBottomRowData`). */
  pinnedBottomRowData?: TData[];
  /** Legacy strings or the AG v32.2+ object form (`{ mode: 'multiRow', … }`). */
  rowSelection?: 'single' | 'multiple' | RowSelectionOptions<TData> | null;
  /**
   * Enterprise-style cell range selection. `true` for plain ranges, or the
   * AG v32.2+ object form to enable the fill handle:
   * `{ handle: { mode: 'fill', direction: 'xy' } }`.
   */
  cellSelection?: boolean | CellSelectionOptions<TData>;
  /**
   * When true, row selection ignores body clicks.
   * @deprecated AG v32.2 — use `rowSelection.enableClickSelection: false`.
   */
  suppressRowClickSelection?: boolean;
  theme?: ThemeName;
  density?: Density;
  /** Override density default gridlines. Default: both axes at every density. */
  gridlines?: GridlineMode;
  quickFilterText?: string;
  /** Show floating filter row for filterable columns. */
  floatingFilter?: boolean;
  /** Host-controlled row filter applied after column filters. */
  isExternalFilterPresent?: () => boolean;
  doesExternalFilterPass?: (data: TData) => boolean;
  /** Decaying tick flash on changed cells (the signature). Default true. */
  enableCellFlash?: boolean;
  /** Total flash lifetime in ms (hold + decay). Default 500. AG `cellFlashDuration`. */
  cellFlashDuration?: number;
  /** Fade tail after flash hold (AG `cellFadeDuration`). Default 1000; Tabular folds into decay. */
  cellFadeDuration?: number;
  /**
   * Enables the cell span feature so columns may use `colDef.spanRows`
   * (AG `enableCellSpan`, initial property). Default false.
   */
  enableCellSpan?: boolean;
  /**
   * Tabular extension: cap the canvas backing-store scale at this value
   * (e.g. `1` renders at 1x on a 2x display). Painted-pixel cost is linear in
   * `dpr²`, so capping is the main lever on software-rasterized environments
   * — OpenFin/VDI/Citrix desktops running with the GPU disabled — at the cost
   * of text sharpness. Default: unlimited (native `devicePixelRatio`).
   */
  maxDevicePixelRatio?: number;
  /** Fixed data-row height in px, overriding the theme/density default (AG `rowHeight`). */
  rowHeight?: number;
  /** Column-label header row height in px, overriding the theme (AG `headerHeight`). */
  headerHeight?: number;
  /** Column-group header row height in px; defaults to `headerHeight` (AG `groupHeaderHeight`). */
  groupHeaderHeight?: number;
  /** Floating-filter row height in px, overriding the theme (AG `floatingFiltersHeight`). */
  floatingFiltersHeight?: number;
  /** When true, auto-size APIs ignore the header label (AG `skipHeaderOnAutoSize`). */
  skipHeaderOnAutoSize?: boolean;
  /**
   * Per-row height callback (AG `getRowHeight`). Return a positive number of
   * pixels, or `null`/`undefined` for the default. Takes precedence over
   * `autoHeight` measurement.
   */
  getRowHeight?: (params: RowHeightParams<TData>) => number | null | undefined;
  /** Render matching rows as a single full-width cell (AG `isFullWidthRow`). */
  isFullWidthRow?: (params: IsFullWidthRowParams<TData>) => boolean;
  /** Canvas painter for full-width rows (AG `fullWidthCellRenderer`). */
  fullWidthCellRenderer?: (
    ctx: CanvasRenderingContext2D,
    params: FullWidthCellRenderParams<TData>,
  ) => void;
  /**
   * Maps CSS class names from `cellClass` / `cellClassRules` / `rowClass` / `rowClassRules`
   * to canvas paint styles (canvas grids cannot use external stylesheets per cell).
   */
  classStyles?: Record<string, CellStyle>;
  /** Inline style applied to every row. */
  rowStyle?: RowStyle;
  /** Per-row inline style callback. */
  getRowStyle?: (params: RowStyleParams<TData>) => RowStyle | undefined;
  /** Static CSS class(es) for every row — resolved via `classStyles`. */
  rowClass?: string | string[];
  /** Per-row CSS class callback. */
  getRowClass?: (params: RowStyleParams<TData>) => string | string[] | undefined;
  /** Dynamic row class rules. */
  rowClassRules?: RowClassRules<TData>;
  /** Arbitrary app context passed to style callbacks (AG `context`). */
  context?: unknown;
  /**
   * Row grouping: expand levels by default.
   * `-1` = all expanded; `0` = all collapsed (default, AG parity);
   * `N` = expand first N levels.
   */
  groupDefaultExpanded?: number;
  /** Show the auto group column with chevrons. Default true when any col has rowGroup. */
  groupDisplayType?: 'singleColumn' | 'multipleColumns' | 'groupRows' | 'custom';
  /** Indent per group level in px (auto group column). Default 16. */
  groupIndent?: number;
  /** Sticky group headers while scrolling within a group. Default true. */
  groupSticky?: boolean;
  /**
   * Row group panel above the header: drag column headers into it to group.
   * `'always'` shows it permanently; `'onlyWhenGrouping'` shows it while any
   * column is grouped. Default `'never'`.
   */
  rowGroupPanelShow?: 'always' | 'onlyWhenGrouping' | 'never';
  /** Pivot mode: only aggregated rows; pivot columns generate secondary columns. */
  pivotMode?: boolean;
  /**
   * Pivot panel above the header (like row group panel). Only shown when
   * `pivotMode` is on. Default `'never'`.
   */
  pivotPanelShow?: 'always' | 'onlyWhenPivoting' | 'never';
  /** Expand generated pivot column groups by default. Default 0; `-1` expands all levels. */
  pivotDefaultExpanded?: number;
  /** When true, pivot groups are always expanded (no collapse affordance). Default false. */
  suppressExpandablePivotGroups?: boolean;
  /** Omit the value-column header row when only one value column is pivoted. */
  removePivotHeaderRowWhenSingleValueColumn?: boolean;
  /** Pivot column group totals — not yet implemented; reserved for AG parity. */
  pivotColumnGroupTotals?: PivotColumnGroupTotals;
  /** Pivot row totals — not yet implemented; reserved for AG parity. */
  pivotRowTotals?: PivotRowTotals;
  /** Post-process each generated pivot result column def. */
  processPivotResultColDef?: (colDef: ColDef<TData>) => ColDef<TData>;
  /** Custom aggregation functions keyed by name. */
  aggFuncs?: Record<string, import('./aggregation').AggFunc>;
  /**
   * @deprecated Ignored. Incremental aggregation is always used inside the
   * data-plane worker when eligible. Kept so old configs typecheck.
   * Use `rowDataMode: 'main'` to force main-thread aggregation.
   */
  workerAggregation?: boolean;
  /**
   * Tabular extension: where the row pipeline runs. Default `'worker'`
   * offloads filter/sort/group/calc to the data worker when eligible.
   * `'main'` forces the CSRM on the UI thread (debug, ineligible features,
   * or environments without Worker). Pivot, tree data, external filters,
   * and active sort/filter on JS `valueGetter`/`comparator` columns fall
   * back to main automatically.
   */
  rowDataMode?: 'main' | 'worker';
  /**
   * Dev-only: when the data worker is active, also run the main-thread
   * pipeline and log mismatches (differential testing). Default false.
   */
  workerCompareMode?: boolean;
  /**
   * When the data worker is active and this is true, drop the main-thread row
   * object mirror after the first warm viewport chunk (Extreme / memory mode).
   * Paint then relies on viewport chunks only. Default **false** (cgrid-aligned:
   * keep the mirror for API, rules, and blank-free paint fallback). Forced off
   * when `workerCompareMode` is true.
   */
  workerOwnsRowData?: boolean;
  /** Hide the agg func from headers (`sum(Notional)` → `Notional`). Default false. */
  suppressAggFuncInHeader?: boolean;
  /**
   * Insert a group-total footer row for each group (`'top'` before children,
   * `'bottom'` after). Callback form per AG `UseGroupTotalRow`.
   */
  groupTotalRow?: 'top' | 'bottom' | ((params: { node: { key: string; level: number } }) => 'top' | 'bottom' | undefined);
  /**
   * With footers showing, keep aggregates on the expanded group row too
   * instead of blanking it while the footer shows them (AG parity).
   * Default false.
   */
  groupSuppressBlankHeader?: boolean;
  /**
   * Grand-total row at the grid edge. `'pinnedTop'` / `'pinnedBottom'` pin
   * outside the scroll area (AG parity subset: treated as top/bottom).
   */
  grandTotalRow?: 'top' | 'bottom' | 'pinnedTop' | 'pinnedBottom';
  /** Client-side pagination. Default false. */
  pagination?: boolean;
  /** Rows per page. Default 100 (AG parity). Ignored when `paginationAutoPageSize` is true. */
  paginationPageSize?: number;
  /** Page-size dropdown in the pagination panel. Default true. */
  paginationPageSizeSelector?: number[] | boolean;
  /** Fit page size to the grid viewport height. Default false. */
  paginationAutoPageSize?: boolean;
  /**
   * When false (default), pagination splits on top-level rows only; expanded
   * group/tree children stay with their parent. When true, every displayed row
   * is pageable.
   */
  paginateChildRows?: boolean;
  /** Hide the built-in pagination panel. */
  suppressPaginationPanel?: boolean;
  /**
   * Pagination panel components and order. Default
   * `['pageSize', 'rowSummary', 'pageSummary']`. Empty array hides the panel.
   */
  paginationPanels?: PaginationPanel[];
  /** Format numbers in the pagination panel (row/page counts). */
  paginationNumberFormatter?: PaginationNumberFormatter<TData>;
  /** Overrides merged into the injected selection checkbox column. */
  selectionColumnDef?: ColDef<TData>;
  /**
   * Overrides merged into the auto group column (headerName, width, pinned…).
   * With tree data, `field` selects the value displayed for each node in
   * place of its path key (AG Grid semantics).
   */
  autoGroupColumnDef?: ColDef<TData>;
  /**
   * Master / Detail: expanding a master row reveals a nested detail grid
   * (AG `masterDetail`). Mark a column with
   * `cellRenderer: 'agGroupCellRenderer'` to show the expand chevron.
   * Default false.
   */
  masterDetail?: boolean;
  /** Which rows are masters (AG `isRowMaster`). Default: every data row. */
  isRowMaster?: IsRowMaster<TData>;
  /**
   * Custom detail renderer (AG `detailCellRenderer`): return a DOM element to
   * mount in the detail row instead of the default nested grid.
   */
  detailCellRenderer?: (params: DetailCellRendererCustomParams<TData>) => HTMLElement;
  /**
   * Config for the default detail grid (AG `detailCellRendererParams`) —
   * `detailGridOptions` + `getDetailRowData`. Object or per-row function.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AG types this `any`; detail row type is caller-defined
  detailCellRendererParams?:
    | DetailCellRendererParams<TData, any>
    | ((params: DetailCellRendererCustomParams<TData>) => DetailCellRendererParams<TData, any>);
  /** Fixed detail row height in px (AG `detailRowHeight`). Default 300. */
  detailRowHeight?: number;
  /** Size each detail row to fit its detail grid (AG `detailRowAutoHeight`). Default false. */
  detailRowAutoHeight?: boolean;
  /** Keep detail grid instances alive when collapsed (AG `keepDetailRows`). Default false. */
  keepDetailRows?: boolean;
  /** Max detail instances kept alive with `keepDetailRows` (AG default 10). */
  keepDetailRowsCount?: number;
  /**
   * Tree data (§4.14): rows form a hierarchy. Supply either `getDataPath`
   * (flat rows + path; missing segments become filler nodes) or
   * `treeDataChildrenField` (nested rows).
   */
  treeData?: boolean;
  getDataPath?: (data: TData) => string[];
  treeDataChildrenField?: string;
  /**
   * Tree filtering: false (default) — a matching node keeps all descendants;
   * true — only matching nodes survive (ancestors retained as context).
   */
  excludeChildrenWhenTreeDataFiltering?: boolean;
  /**
   * Bottom status bar. `true` shows the default layout (row counts +
   * selection + range aggregation); an AG-Grid-shaped `{ statusPanels }`
   * config selects individual panels.
   */
  statusBar?: boolean | { statusPanels: StatusPanelDef[] };
  /**
   * Side bar with tool panels. `true` shows default columns + filters panels.
   * @agModule SideBarModule
   */
  sideBar?: SideBarDef | string | string[] | boolean | null;
  /**
   * Allow reordering and pinning columns by dragging from the Columns Tool Panel
   * to the grid. Default false (AG parity).
   */
  allowDragFromColumnsToolPanel?: boolean;
  /**
   * Show/hide the loading overlay (AG Grid v32+ style). Toggle at runtime
   * via `setGridOption('loading', …)` / `updateOptions({ loading: … })`.
   */
  loading?: boolean;
  /** HTML template for the loading overlay. */
  overlayLoadingTemplate?: string;
  /** HTML template for the no-rows overlay. */
  overlayNoRowsTemplate?: string;
  /** Never auto-show the no-rows overlay when the grid is empty. */
  suppressNoRowsOverlay?: boolean;
  /** Disable Ctrl+V TSV paste into cells. */
  suppressClipboardPaste?: boolean;
  /** Column separator used when copying to the clipboard. Default `\t`. */
  clipboardDelimiter?: string;
  /** Include headers on every clipboard copy. Default false. */
  copyHeadersToClipboard?: boolean;
  /** Include column group headers when copying with headers. Default false. */
  copyGroupHeadersToClipboard?: boolean;
  /** Copy cell range / focused cell only — never selected rows. Default false. */
  suppressCopyRowsToClipboard?: boolean;
  /** Disable cut (Ctrl+X). Default false. */
  suppressCutToClipboard?: boolean;
  /** Transform each cell value as it is copied to the clipboard. */
  processCellForClipboard?: (params: {
    value: unknown;
    colDef: ColDef<TData>;
    data: TData | undefined;
  }) => unknown;
  /** Transform each cell value before it is pasted into the grid. */
  processCellFromClipboard?: (params: {
    value: string;
    colDef: ColDef<TData>;
    data: TData | undefined;
  }) => unknown;
  /** Transform (or veto with null) the full clipboard matrix before paste. */
  processDataFromClipboard?: (params: { data: string[][] }) => string[][] | null;
  /** Ctrl+Z / Ctrl+Shift+Z undo-redo of cell edits + pastes. Default false (AG parity). */
  undoRedoCellEditing?: boolean;
  /** Max undo stack depth. Default 10 (AG parity). */
  undoRedoCellEditingLimit?: number;
  /** Single click starts editing (default: double click). */
  singleClickEdit?: boolean;
  /** Disable the built-in right-click context menus. Default false. */
  suppressContextMenu?: boolean;
  /** Customize context menu items; return a new list (may reuse `defaultItems`). */
  getContextMenuItems?: (params: GetContextMenuItemsParams) => ContextMenuItem[];
  /** Customize header ⋮ column-menu items; return a new list (may reuse `defaultItems`). */
  getMainMenuItems?: (params: GetMainMenuItemsParams) => ContextMenuItem[];
  /** Override default arrow-key navigation destination. */
  navigateToNextCell?: (params: {
    key: string;
    previousCellPosition: CellPosition;
    nextCellPosition: CellPosition | null;
    event: KeyboardEvent | null;
    api: Tabular<TData>;
  }) => CellPosition | null;
  /** Delay (ms) before tooltips appear on hover. Default 2000 (AG parity). */
  tooltipShowDelay?: number;
  /** Delay (ms) before tooltips hide after show. Default 10000 (AG parity). */
  tooltipHideDelay?: number;
  /** `hover` (default) or `focus`. */
  tooltipTrigger?: 'hover' | 'focus';
  /** `standard` (default) or `whenTruncated`. */
  tooltipShowMode?: 'standard' | 'whenTruncated';
  onGridReady?: (e: GridEvents<TData>['gridReady']) => void;
  onCellValueChanged?: (e: CellValueChangedEvent<TData>) => void;
  onSelectionChanged?: (e: GridEvents<TData>['selectionChanged']) => void;
  onSortChanged?: (e: GridEvents<TData>['sortChanged']) => void;
  onToolPanelVisibleChanged?: (e: GridEvents<TData>['toolPanelVisibleChanged']) => void;
  onToolPanelSizeChanged?: (e: GridEvents<TData>['toolPanelSizeChanged']) => void;
  onRowGroupOpened?: (e: GridEvents<TData>['rowGroupOpened']) => void;
  /**
   * Tabular extension: conditional style rules + alerts (`@tabular/rules`).
   * Conditions compile at config time; evaluation runs on the RowDelta feed.
   */
  rules?: import('@tabular/rules').RulesConfig;
  /** Callback when an alert rule fires (also emitted as `alert` event). */
  onAlert?: (e: import('@tabular/rules').AlertEvent<TData>) => void;
  /**
   * Tabular extension: format DSL defaults (`@tabular/format`). Locale/currency
   * for presets; optional named preset overrides for the ext format picker.
   */
  formatting?: import('@tabular/format').FormatConfig;
}
