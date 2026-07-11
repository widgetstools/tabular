/**
 * Column model: def resolution, pinned partition (left | center | right),
 * prefix-sum offsets per region, flex sizing, sort state, column groups.
 */
import type {
  AnyColDef,
  ColDef,
  ColumnGroupStateItem,
  ColumnState,
  Pinned,
  SortDir,
  SortModelItem,
} from './types';
import {
  applyGroupVisibility,
  buildFromDefs,
  columnGroupState,
  fillHeaderSpans,
  findProvidedGroup,
  type HeaderLayout,
  type ProvidedColumnGroup,
} from './columnGroups';
import { columnShowsFloatingFilter, resolveFilterKind, type FilterKind } from './filters';
import { AUTO_GROUP_COL_ID } from './grouping';

export const SELECTION_COL_ID = 'ag-Grid-SelectionColumn';
import type { AggFunc, AggFuncName } from './aggregation';
import type { AggColSpec, GroupColSpec } from './grouping';
import type { PivotBuildResult, PivotColSpec } from './pivot';
import { PIVOT_COL_ID_PREFIX } from './pivot';

export interface InternalColumn<TData = unknown> {
  colId: string;
  def: ColDef<TData>;
  width: number;
  flex: number;
  pinned: Pinned;
  sort: SortDir;
  sortIndex: number;
  hide: boolean;
  /** Hidden by columnGroupShow vs. its group's open/closed state (not user `hide`). */
  groupHidden: boolean;
  ancestorGroups: ProvidedColumnGroup<TData>[];
  /** Dynamically generated pivot result column. */
  pivotResult?: boolean;
}

export interface Region<TData = unknown> {
  cols: InternalColumn<TData>[];
  offsets: number[];
  width: number;
}

export class ColumnModel<TData = unknown> {
  private _all: InternalColumn<TData>[] = [];
  /** Lazy colId → column index; getColumn is on hot per-row paths (pivot
   *  aggregation calls it rows × levels × paths times), so it cannot be a
   *  linear scan over 1000+ pivot result columns. Rebuilt on demand after
   *  any reassignment of `all`; in-place mutations must call
   *  `invalidateColumnIndex()`. */
  private byId: Map<string, InternalColumn<TData>> | null = null;

  get all(): InternalColumn<TData>[] {
    return this._all;
  }

  set all(cols: InternalColumn<TData>[]) {
    this._all = cols;
    this.byId = null;
  }

  private invalidateColumnIndex(): void {
    this.byId = null;
  }

  left: Region<TData> = { cols: [], offsets: [0], width: 0 };
  center: Region<TData> = { cols: [], offsets: [0], width: 0 };
  right: Region<TData> = { cols: [], offsets: [0], width: 0 };
  header: HeaderLayout<TData> | null = null;
  providedRoots: ProvidedColumnGroup<TData>[] = [];

  /** Original `columnDefs` in document order (for tool panels). */
  sourceColumnDefs(): AnyColDef<TData>[] {
    return this.sourceDefs;
  }

  defaultColumnDef(): ColDef<TData> | undefined {
    return this.defaultColDef;
  }

  private viewportWidth = 0;
  private columnHeaderHeight = 34;
  private groupHeaderHeight = 34;
  private floatingFilterHeight = 26;
  private floatingFiltersEnabled = false;
  private defaultColDef?: ColDef<TData>;
  private sourceDefs: AnyColDef<TData>[] = [];
  private groupState = new Map<string, boolean>();

  /** Tree data always shows the auto group column, even with no rowGroup cols. */
  treeMode = false;
  /** User overrides merged into the injected auto group column. */
  autoGroupColumnDef?: ColDef<TData>;
  /** Inject pinned-left checkbox column when row selection checkboxes are on. */
  selectionMode: 'none' | 'single' | 'multiple' = 'none';
  selectionColumnDef?: ColDef<TData>;
  /** Pivot mode strips detail columns and can generate secondary columns. */
  pivotMode = false;
  pivotProvidedRoots: ProvidedColumnGroup<TData>[] = [];
  private valueColumnIds = new Set<string>();
  /** Primary-column visibility captured on entering pivot mode. */
  private prePivotHide: Map<string, boolean> | null = null;

  constructor(
    defs: AnyColDef<TData>[],
    defaultColDef?: ColDef<TData>,
    columnHeaderHeight = 34,
    floatingFilterHeight = 26,
    floatingFiltersEnabled = false,
    treeMode = false,
    autoGroupColumnDef?: ColDef<TData>,
    selectionMode: 'none' | 'single' | 'multiple' = 'none',
    selectionColumnDef?: ColDef<TData>,
  ) {
    this.columnHeaderHeight = columnHeaderHeight;
    this.groupHeaderHeight = columnHeaderHeight;
    this.floatingFilterHeight = floatingFilterHeight;
    this.floatingFiltersEnabled = floatingFiltersEnabled;
    this.treeMode = treeMode;
    this.autoGroupColumnDef = autoGroupColumnDef;
    this.selectionMode = selectionMode;
    this.selectionColumnDef = selectionColumnDef;
    this.setColumnDefs(defs, defaultColDef);
  }

  setFloatingFilterOptions(enabled: boolean, height: number): void {
    const changed = this.floatingFiltersEnabled !== enabled || this.floatingFilterHeight !== height;
    this.floatingFiltersEnabled = enabled;
    this.floatingFilterHeight = height;
    if (changed && this.header) this.rebuildHeaderMetrics();
  }

  setColumnDefs(defs: AnyColDef<TData>[], defaultColDef?: ColDef<TData>): void {
    this.sourceDefs = defs;
    this.defaultColDef = defaultColDef;
    const built = buildFromDefs(defs, defaultColDef, this.groupState, this.columnHeaderHeight);
    this.all = built.leaves;
    this.ensureSelectionColumn();
    this.ensureAutoGroupColumn();
    if (this.pivotMode) this.applyPivotModeVisibility();
    this.header = built.layout;
    this.providedRoots = built.providedRoots;
    applyGroupVisibility(this.providedRoots);
    this.applyFlex();
    this.rebuild();
    this.rebuildHeaderMetrics();
  }

  /** Toggle the injected selection checkbox column without a full def rebuild. */
  configureSelectionColumn(mode: 'none' | 'single' | 'multiple', def?: ColDef<TData>): void {
    this.selectionMode = mode;
    this.selectionColumnDef = def;
    this.ensureSelectionColumn();
    this.applyFlex();
    this.rebuild();
  }

  /** Inject pinned-left checkbox column when row selection is active. */
  private ensureSelectionColumn(): void {
    const needed = this.selectionMode !== 'none';
    const existing = this.all.find((c) => c.colId === SELECTION_COL_ID);
    if (!needed) {
      if (existing) this.all = this.all.filter((c) => c.colId !== SELECTION_COL_ID);
      return;
    }
    if (existing) return;
    const def: ColDef<TData> = {
      headerName: '',
      width: 48,
      minWidth: 48,
      maxWidth: 48,
      pinned: 'left',
      sortable: false,
      filter: false,
      floatingFilter: false,
      resizable: false,
      suppressMovable: true,
      lockPosition: true,
      ...this.selectionColumnDef,
      colId: SELECTION_COL_ID,
    };
    const col: InternalColumn<TData> = {
      colId: SELECTION_COL_ID,
      def,
      width: def.width ?? 48,
      flex: 0,
      pinned: 'left',
      sort: null,
      sortIndex: -1,
      hide: false,
      groupHidden: false,
      ancestorGroups: [],
    };
    this.all = [col, ...this.all];
  }

  /** Inject pinned-left auto group column when grouping or in tree mode. */
  private ensureAutoGroupColumn(): void {
    const needed = this.treeMode || this.all.some((c) => c.def.rowGroup);
    const existing = this.all.find((c) => c.colId === AUTO_GROUP_COL_ID);
    if (!needed) {
      if (existing) this.all = this.all.filter((c) => c.colId !== AUTO_GROUP_COL_ID);
      return;
    }
    if (existing) return;
    const def: ColDef<TData> = {
      headerName: 'Group',
      width: 220,
      minWidth: 120,
      pinned: 'left',
      sortable: false,
      filter: false,
      floatingFilter: false,
      resizable: true,
      suppressMovable: true,
      lockPosition: true,
      ...this.autoGroupColumnDef,
      colId: AUTO_GROUP_COL_ID,
    };
    const auto: InternalColumn<TData> = {
      colId: AUTO_GROUP_COL_ID,
      def,
      width: def.width ?? 220,
      flex: def.flex ?? 0,
      pinned: def.pinned ?? 'left',
      sort: null,
      sortIndex: -1,
      hide: false,
      groupHidden: false,
      ancestorGroups: [],
    };
    // AG order: selection checkbox column first, then the auto group column.
    const selIdx = this.all.findIndex((c) => c.colId === SELECTION_COL_ID);
    this.all.splice(selIdx + 1, 0, auto);
  }

  getRowGroupCols(): GroupColSpec[] {
    return this.rowGroupColumns().map((c) => ({ colId: c.colId, field: c.def.field }));
  }

  rowGroupColumns(): InternalColumn<TData>[] {
    return this.all
      .filter((c) => c.def.rowGroup && c.colId !== AUTO_GROUP_COL_ID)
      .sort((a, b) => (a.def.rowGroupIndex ?? 0) - (b.def.rowGroupIndex ?? 0));
  }

  /** Group by a column (row group panel drop / API). Hides the column, AG Grid style. */
  addRowGroupColumn(colId: string): boolean {
    const col = this.getColumn(colId);
    if (!col || col.colId === AUTO_GROUP_COL_ID || col.def.rowGroup) return false;
    const maxIdx = this.rowGroupColumns().reduce(
      (m, c) => Math.max(m, c.def.rowGroupIndex ?? 0),
      -1,
    );
    col.def.rowGroup = true;
    col.def.rowGroupIndex = maxIdx + 1;
    col.hide = true;
    this.ensureAutoGroupColumn();
    this.applyFlex();
    this.rebuild();
    return true;
  }

  /** Stop grouping by a column; re-shows it unless the def hid it explicitly. */
  removeRowGroupColumn(colId: string): boolean {
    const col = this.getColumn(colId);
    if (!col || !col.def.rowGroup) return false;
    col.def.rowGroup = false;
    col.def.rowGroupIndex = undefined;
    col.hide = !!col.def.hide;
    this.rowGroupColumns().forEach((c, i) => (c.def.rowGroupIndex = i));
    this.ensureAutoGroupColumn();
    this.applyFlex();
    this.rebuild();
    return true;
  }

  /** Reorder / replace the set of row group columns (chip drag within the panel). */
  setRowGroupColumns(colIds: string[]): void {
    const wanted = new Set(colIds);
    for (const c of this.all) {
      if (c.colId === AUTO_GROUP_COL_ID) continue;
      if (wanted.has(c.colId)) {
        if (!c.def.rowGroup) c.hide = true;
        c.def.rowGroup = true;
        c.def.rowGroupIndex = colIds.indexOf(c.colId);
      } else if (c.def.rowGroup) {
        c.def.rowGroup = false;
        c.def.rowGroupIndex = undefined;
        c.hide = !!c.def.hide;
      }
    }
    this.ensureAutoGroupColumn();
    this.applyFlex();
    this.rebuild();
  }

  getAggCols(): AggColSpec[] {
    return this.getValueCols();
  }

  getValueCols(): AggColSpec[] {
    // Columns made value columns at runtime (tool panel / API) default to
    // 'sum' when the def has no aggFunc — AG Grid parity.
    return this.valueColumns().map((c) => ({
      colId: c.colId,
      field: c.def.field,
      aggFunc: (c.def.aggFunc ?? 'sum') as AggFuncName | AggFunc,
      weightField: c.def.weightField,
    }));
  }

  valueColumns(): InternalColumn<TData>[] {
    return this.all.filter(
      (c) =>
        c.colId !== AUTO_GROUP_COL_ID &&
        c.colId !== SELECTION_COL_ID &&
        !c.pivotResult &&
        (c.def.aggFunc != null || this.valueColumnIds.has(c.colId)),
    );
  }

  pivotColumns(): InternalColumn<TData>[] {
    return this.all
      .filter((c) => c.def.pivot && c.colId !== AUTO_GROUP_COL_ID)
      .sort((a, b) => (a.def.pivotIndex ?? 0) - (b.def.pivotIndex ?? 0));
  }

  getPivotCols(): PivotColSpec[] {
    return this.pivotColumns().map((c) => ({
      colId: c.colId,
      field: c.def.field,
      pivotComparator: c.def.pivotComparator,
    }));
  }

  isPivotActive(): boolean {
    return this.pivotMode && this.pivotColumns().length > 0;
  }

  setPivotMode(on: boolean): void {
    if (this.pivotMode === on) return;
    this.pivotMode = on;
    if (on) {
      // Snapshot visibility so leaving pivot mode restores it (AG parity).
      this.prePivotHide = new Map();
      for (const c of this.all) {
        if (c.pivotResult) continue;
        this.prePivotHide.set(c.colId, c.hide);
      }
      this.applyPivotModeVisibility();
    } else {
      for (const c of this.all) {
        if (c.colId === AUTO_GROUP_COL_ID || c.colId === SELECTION_COL_ID) continue;
        if (c.pivotResult) continue;
        c.hide = this.prePivotHide?.get(c.colId) ?? c.def.hide ?? false;
      }
      this.prePivotHide = null;
    }
    this.rebuild();
  }

  addPivotColumn(colId: string): boolean {
    const col = this.getColumn(colId);
    if (!col || col.colId === AUTO_GROUP_COL_ID || col.def.pivot) return false;
    const maxIdx = this.pivotColumns().reduce((m, c) => Math.max(m, c.def.pivotIndex ?? 0), -1);
    col.def.pivot = true;
    col.def.pivotIndex = maxIdx + 1;
    if (this.pivotMode) {
      col.hide = true;
    } else {
      col.hide = col.def.hide ?? false;
    }
    this.applyPivotModeVisibility();
    this.rebuild();
    return true;
  }

  removePivotColumn(colId: string): boolean {
    const col = this.getColumn(colId);
    if (!col || !col.def.pivot) return false;
    col.def.pivot = false;
    col.def.pivotIndex = undefined;
    col.hide = !!col.def.hide;
    this.pivotColumns().forEach((c, i) => (c.def.pivotIndex = i));
    this.clearPivotResultColumns();
    this.applyPivotModeVisibility();
    this.rebuild();
    return true;
  }

  setPivotColumns(colIds: string[]): void {
    const wanted = new Set(colIds);
    for (const c of this.all) {
      if (c.colId === AUTO_GROUP_COL_ID) continue;
      if (wanted.has(c.colId)) {
        if (!c.def.pivot) c.hide = true;
        c.def.pivot = true;
        c.def.pivotIndex = colIds.indexOf(c.colId);
      } else if (c.def.pivot) {
        c.def.pivot = false;
        c.def.pivotIndex = undefined;
        c.hide = !!c.def.hide;
      }
    }
    this.clearPivotResultColumns();
    this.applyPivotModeVisibility();
    this.rebuild();
  }

  setValueColumns(colIds: string[]): void {
    const wanted = new Set(colIds);
    for (const c of this.valueColumns()) {
      if (!wanted.has(c.colId)) c.def.aggFunc = undefined;
    }
    this.valueColumnIds.clear();
    for (const id of colIds) {
      this.valueColumnIds.add(id);
      this.defaultAggFunc(id);
    }
    this.applyPivotModeVisibility();
    this.rebuild();
  }

  addValueColumns(colIds: string[]): void {
    for (const id of colIds) {
      this.valueColumnIds.add(id);
      this.defaultAggFunc(id);
    }
    this.applyPivotModeVisibility();
    this.rebuild();
  }

  removeValueColumns(colIds: string[]): void {
    for (const id of colIds) {
      this.valueColumnIds.delete(id);
      // AG parity: removing a value column clears its aggregation.
      const col = this.getColumn(id);
      if (col) col.def.aggFunc = undefined;
    }
    this.applyPivotModeVisibility();
    this.rebuild();
  }

  /** AG parity: a column made a value column without an aggFunc defaults to 'sum'. */
  private defaultAggFunc(colId: string): void {
    const col = this.getColumn(colId);
    if (col && col.def.aggFunc == null) col.def.aggFunc = 'sum';
  }

  clearPivotResultColumns(): void {
    this.all = this.all.filter((c) => !c.pivotResult);
    this.pivotProvidedRoots = [];
    if (this.header) this.rebuildCombinedHeader();
  }

  applyPivotResult(build: PivotBuildResult<TData>): void {
    this.clearPivotResultColumns();
    const insertAt = this.pivotInsertIndex();
    this.all.splice(insertAt, 0, ...build.leaves);
    this.invalidateColumnIndex();
    this.pivotProvidedRoots = build.providedRoots;
    const restoreGroupState = (g: ProvidedColumnGroup<TData>): void => {
      if (this.groupState.has(g.groupId)) g.expanded = this.groupState.get(g.groupId)!;
      for (const ch of g.children) {
        if (!('colId' in ch)) restoreGroupState(ch);
      }
    };
    for (const r of this.pivotProvidedRoots) restoreGroupState(r);
    this.applyPivotModeVisibility();
    applyGroupVisibility(this.pivotProvidedRoots);
    this.rebuildCombinedHeader();
    this.applyFlex();
    this.rebuild();
  }

  private allProvidedRoots(): ProvidedColumnGroup<TData>[] {
    return [...this.providedRoots, ...this.pivotProvidedRoots];
  }

  /** Document-order slot for generated pivot columns (after pinned-left chrome). */
  private pivotInsertIndex(): number {
    let lastLeft = -1;
    for (let i = 0; i < this.all.length; i++) {
      if (this.all[i].pinned === 'left') lastLeft = i;
    }
    return lastLeft + 1;
  }

  lookupPivotResultCol(pivotKeys: string[], valueColId: string): InternalColumn<TData> | undefined {
    const id = `${PIVOT_COL_ID_PREFIX}${pivotKeys.map((k) => encodeURIComponent(k)).join('|')}__${valueColId}`;
    return this.getColumn(id);
  }

  /** Hide detail / pivot-source columns when pivot mode is active. */
  private applyPivotModeVisibility(): void {
    if (!this.pivotMode) return;
    const valueIds = new Set(this.valueColumns().map((c) => c.colId));
    const pivotIds = new Set(this.pivotColumns().map((c) => c.colId));
    const groupIds = new Set(this.rowGroupColumns().map((c) => c.colId));
    const pivotActive = this.isPivotActive();

    for (const c of this.all) {
      if (c.colId === AUTO_GROUP_COL_ID || c.colId === SELECTION_COL_ID) continue;
      if (c.pivotResult) {
        c.hide = false;
        continue;
      }
      if (groupIds.has(c.colId) || pivotIds.has(c.colId)) {
        c.hide = true;
        continue;
      }
      if (pivotActive) {
        c.hide = true;
      } else if (valueIds.has(c.colId)) {
        c.hide = c.def.hide ?? false;
      } else {
        c.hide = true;
      }
    }
  }

  private rebuildCombinedHeader(): void {
    if (!this.header) return;
    const allRoots = [...this.providedRoots, ...this.pivotProvidedRoots];
    let maxGroupDepth = 0;
    const walk = (g: ProvidedColumnGroup<TData>): void => {
      for (const ch of g.children) {
        if ('colId' in ch) maxGroupDepth = Math.max(maxGroupDepth, ch.ancestorGroups.length);
        else walk(ch);
      }
    };
    for (const r of allRoots) walk(r);
    for (const c of this.all) {
      if (c.pivotResult) maxGroupDepth = Math.max(maxGroupDepth, c.ancestorGroups.length);
    }
    this.header.maxGroupDepth = maxGroupDepth;
    this.header.headerRowCount = maxGroupDepth + 1;
    this.rebuildHeaderMetrics();
  }

  /**
   * Push effective header row heights (theme / options / autoHeaderHeight).
   * Heights only affect layout metrics — spans keep their x/width — so no
   * column rebuild is needed.
   */
  setHeaderHeights(column: number, group: number): void {
    if (column === this.columnHeaderHeight && group === this.groupHeaderHeight) return;
    this.columnHeaderHeight = column;
    this.groupHeaderHeight = group;
    if (this.header) this.rebuildHeaderMetrics();
  }

  private rebuildHeaderMetrics(): void {
    if (!this.header) return;
    const ff = this.hasFloatingFilters() ? this.floatingFilterHeight : 0;
    this.header.columnHeaderHeight = this.columnHeaderHeight;
    this.header.groupHeaderHeight = this.groupHeaderHeight;
    this.header.floatingFilterHeight = ff;
    this.header.floatingFilters = ff > 0;
    this.header.totalHeaderHeight =
      this.header.maxGroupDepth * this.groupHeaderHeight + this.columnHeaderHeight + ff;
  }

  /** Visible = not user-hidden and not gated out by columnGroupShow. */
  private isVisible(c: InternalColumn<TData>): boolean {
    return !c.hide && !c.groupHidden;
  }

  hasFloatingFilters(): boolean {
    if (!this.floatingFiltersEnabled) return false;
    return this.all.some(
      (c) => this.isVisible(c) && columnShowsFloatingFilter(c, true, this.defaultColDef),
    );
  }

  showsFloatingFilter(col: InternalColumn<TData>): boolean {
    return columnShowsFloatingFilter(col, this.floatingFiltersEnabled, this.defaultColDef);
  }

  filterKind(col: InternalColumn<TData>): FilterKind {
    return resolveFilterKind(col, this.defaultColDef);
  }

  get totalHeaderHeight(): number {
    const base = this.header?.totalHeaderHeight ?? this.columnHeaderHeight;
    if (this.header) return base;
    return this.hasFloatingFilters() ? base + this.floatingFilterHeight : base;
  }

  setViewportWidth(w: number): void {
    if (w === this.viewportWidth) return;
    this.viewportWidth = w;
    this.applyFlex();
    this.rebuild();
  }

  private applyFlex(): void {
    if (!this.viewportWidth) return;
    const visible = this.all.filter((c) => this.isVisible(c));
    const flexed = visible.filter((c) => c.flex > 0);
    if (!flexed.length) return;
    const fixed = visible.filter((c) => c.flex <= 0).reduce((s, c) => s + c.width, 0);
    const remaining = Math.max(0, this.viewportWidth - fixed);
    const totalFlex = flexed.reduce((s, c) => s + c.flex, 0);
    for (const c of flexed) {
      const w = Math.floor(remaining * (c.flex / totalFlex));
      c.width = clamp(w, c.def.minWidth ?? 60, c.def.maxWidth ?? Number.POSITIVE_INFINITY);
    }
  }

  rebuild(): void {
    const build = (cols: InternalColumn<TData>[]): Region<TData> => {
      const offsets = new Array<number>(cols.length + 1);
      offsets[0] = 0;
      for (let i = 0; i < cols.length; i++) offsets[i + 1] = offsets[i] + cols[i].width;
      return { cols, offsets, width: offsets[cols.length] };
    };
    const visible = this.all.filter((c) => this.isVisible(c));
    this.left = build(visible.filter((c) => c.pinned === 'left'));
    this.center = build(visible.filter((c) => c.pinned === null));
    this.right = build(visible.filter((c) => c.pinned === 'right'));
    if (this.header) fillHeaderSpans(this.header, this.left, this.center, this.right);
    this.rebuildHeaderMetrics();
  }

  get totalWidth(): number {
    return this.left.width + this.center.width + this.right.width;
  }

  getColumn(colId: string): InternalColumn<TData> | undefined {
    if (!this.byId) {
      this.byId = new Map();
      for (const c of this._all) this.byId.set(c.colId, c);
    }
    return this.byId.get(colId);
  }

  displayed(): InternalColumn<TData>[] {
    return [...this.left.cols, ...this.center.cols, ...this.right.cols];
  }

  colIndexAtX(region: Region<TData>, x: number): number {
    if (x < 0 || x >= region.width) return -1;
    let lo = 0;
    let hi = region.cols.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (region.offsets[mid + 1] <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  visibleRange(region: Region<TData>, x0: number, x1: number): [number, number] {
    if (!region.cols.length || x1 <= 0 || x0 >= region.width) return [0, -1];
    const first = Math.max(0, this.colIndexAtXClamped(region, Math.max(0, x0)));
    let last = this.colIndexAtXClamped(region, Math.min(region.width - 1, x1 - 1));
    if (last < 0) last = region.cols.length - 1;
    return [first, last];
  }

  private colIndexAtXClamped(region: Region<TData>, x: number): number {
    const i = this.colIndexAtX(region, x);
    return i === -1 ? region.cols.length - 1 : i;
  }

  resizeColumn(colId: string, width: number): void {
    const col = this.getColumn(colId);
    if (!col) return;
    col.flex = 0;
    col.width = clamp(Math.round(width), col.def.minWidth ?? 40, col.def.maxWidth ?? 2000);
    this.rebuild();
  }

  moveColumn(colId: string, toIndex: number): boolean {
    const col = this.getColumn(colId);
    if (!col || col.def.lockPosition || col.def.suppressMovable) return false;
    const displayed = this.displayed();
    const from = displayed.findIndex((c) => c.colId === colId);
    if (from < 0) return false;
    const pinnedCols = displayed.filter((c) => c.pinned === col.pinned);
    const pinnedFrom = pinnedCols.findIndex((c) => c.colId === colId);
    let pinnedTo = toIndex;
    if (pinnedTo < 0) pinnedTo = 0;
    if (pinnedTo >= pinnedCols.length) pinnedTo = pinnedCols.length - 1;
    if (pinnedFrom === pinnedTo) return false;
    pinnedCols.splice(pinnedFrom, 1);
    pinnedCols.splice(pinnedTo, 0, col);
    const left = this.all.filter((c) => c.pinned === 'left' && this.isVisible(c));
    const center = this.all.filter((c) => c.pinned === null && this.isVisible(c));
    const right = this.all.filter((c) => c.pinned === 'right' && this.isVisible(c));
    const hidden = this.all.filter((c) => !this.isVisible(c));
    if (col.pinned === 'left') this.all = [...pinnedCols, ...center, ...right, ...hidden];
    else if (col.pinned === 'right') this.all = [...left, ...center, ...pinnedCols, ...hidden];
    else this.all = [...left, ...pinnedCols, ...right, ...hidden];
    this.rebuild();
    return true;
  }

  autoSizeColumn(colId: string, width: number): void {
    this.resizeColumn(colId, width);
  }

  sizeColumnsToFit(): void {
    if (!this.viewportWidth) return;
    const visible = this.all.filter((c) => this.isVisible(c));
    const total = visible.reduce((s, c) => s + c.width, 0);
    if (total <= 0) return;
    const scale = this.viewportWidth / total;
    for (const c of visible) {
      c.flex = 0;
      c.width = clamp(
        Math.round(c.width * scale),
        c.def.minWidth ?? 40,
        c.def.maxWidth ?? 2000,
      );
    }
    this.rebuild();
  }

  getColumnState(): ColumnState[] {
    return this.all.map((c) => ({
      colId: c.colId,
      width: c.width,
      hide: c.hide,
      pinned: c.pinned,
      sort: c.sort,
      sortIndex: c.sortIndex >= 0 ? c.sortIndex : null,
    }));
  }

  applyColumnState(state: ColumnState[]): boolean {
    const order = state.map((s) => s.colId);
    for (const s of state) {
      const col = this.getColumn(s.colId);
      if (!col) continue;
      if (s.width != null) col.width = s.width;
      if (s.hide != null) col.hide = s.hide;
      if (s.pinned !== undefined) col.pinned = s.pinned;
      if (s.sort !== undefined) col.sort = s.sort;
      if (s.sortIndex !== undefined) col.sortIndex = s.sortIndex ?? -1;
    }
    const map = new Map(this.all.map((c) => [c.colId, c]));
    const reordered: InternalColumn<TData>[] = [];
    for (const id of order) {
      const c = map.get(id);
      if (c) {
        reordered.push(c);
        map.delete(id);
      }
    }
    for (const c of map.values()) reordered.push(c);
    this.all = reordered;
    this.normalizeSortIndices();
    this.rebuild();
    return true;
  }

  getColumnGroupState(): ColumnGroupStateItem[] {
    return columnGroupState(this.allProvidedRoots());
  }

  setColumnGroupState(state: ColumnGroupStateItem[]): void {
    for (const s of state) {
      this.groupState.set(s.groupId, s.open);
      const g = findProvidedGroup(this.allProvidedRoots(), s.groupId);
      if (g) g.expanded = s.open;
    }
    this.refreshGroupVisibility();
  }

  setColumnGroupOpened(groupId: string, open: boolean): void {
    this.groupState.set(groupId, open);
    const g = findProvidedGroup(this.allProvidedRoots(), groupId);
    if (g) g.expanded = open;
    this.refreshGroupVisibility();
  }

  setAllPivotColumnGroupsOpened(open: boolean): void {
    const walk = (g: ProvidedColumnGroup<TData>): void => {
      if (g.expandable) {
        g.expanded = open;
        this.groupState.set(g.groupId, open);
      }
      for (const ch of g.children) {
        if (!('colId' in ch)) walk(ch);
      }
    };
    for (const r of this.pivotProvidedRoots) walk(r);
    this.refreshGroupVisibility();
  }

  /**
   * Re-derive columnGroupShow visibility in place — deliberately NOT a full
   * setColumnDefs so runtime state (widths, sorts, panel-driven rowGroup)
   * survives expanding / collapsing a group.
   */
  private refreshGroupVisibility(): void {
    applyGroupVisibility(this.providedRoots);
    applyGroupVisibility(this.pivotProvidedRoots);
    this.applyFlex();
    this.rebuild();
  }

  setColumnPinned(colId: string, pinned: Pinned): void {
    const col = this.getColumn(colId);
    if (!col || col.pinned === pinned) return;
    col.pinned = pinned;
    this.rebuild();
  }

  setColumnVisible(colId: string, visible: boolean): void {
    const col = this.getColumn(colId);
    if (!col || col.hide === !visible) return;
    col.hide = !visible;
    this.applyFlex();
    this.rebuild();
  }

  toggleSort(colId: string, additive: boolean): void {
    const col = this.getColumn(colId);
    if (!col || col.def.sortable === false) return;
    const next: SortDir = col.sort === 'asc' ? 'desc' : col.sort === 'desc' ? null : 'asc';
    if (!additive) {
      for (const c of this.all) {
        if (c !== col) {
          c.sort = null;
          c.sortIndex = -1;
        }
      }
    }
    col.sort = next;
    if (next === null) col.sortIndex = -1;
    else if (col.sortIndex === -1) col.sortIndex = this.maxSortIndex() + 1;
    this.normalizeSortIndices();
  }

  setSort(colId: string, sort: SortDir, additive = false): void {
    const col = this.getColumn(colId);
    if (!col) return;
    if (!additive) {
      for (const c of this.all) {
        if (c !== col) {
          c.sort = null;
          c.sortIndex = -1;
        }
      }
    }
    col.sort = sort;
    col.sortIndex = sort === null ? -1 : col.sortIndex === -1 ? this.maxSortIndex() + 1 : col.sortIndex;
    this.normalizeSortIndices();
  }

  private maxSortIndex(): number {
    return this.all.reduce((m, c) => Math.max(m, c.sortIndex), -1);
  }

  private normalizeSortIndices(): void {
    const sorted = this.all.filter((c) => c.sort !== null).sort((a, b) => a.sortIndex - b.sortIndex);
    sorted.forEach((c, i) => (c.sortIndex = i));
  }

  sortModel(): SortModelItem[] {
    return this.all
      .filter((c): c is InternalColumn<TData> & { sort: 'asc' | 'desc' } => c.sort !== null)
      .sort((a, b) => a.sortIndex - b.sortIndex)
      .map((c) => ({ colId: c.colId, sort: c.sort }));
  }

  sortedColumnCount(): number {
    return this.all.filter((c) => c.sort !== null).length;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
