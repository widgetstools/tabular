/**
 * Client-side row model: filter → sort → group → aggregate → flatten.
 * Transactions apply surgically and report changed numeric cells for flash.
 */
import type { ColumnFilter, FilterModel } from './types';
import type { ColumnModel, InternalColumn } from './columnModel';
import { passesFilter, rowPassesQuickFilter, tokenizeQuickFilter } from './filters';
import type { AggFunc } from './aggregation';
import {
  aggregateTree,
  buildGrandTotalNode,
  buildGroupTree,
  flattenGroupTree,
  type AggColSpec,
  type DisplayedNode,
  type GroupColSpec,
  type GroupNode,
} from './grouping';
import {
  aggregatePivotTree,
  buildPivotGrandTotalNode,
  collectPivotKeyPaths,
  pivotResultColId,
  PIVOT_COL_ID_PREFIX,
  type PivotColSpec,
} from './pivot';
import {
  aggregateTreeData,
  buildTree,
  filterTree,
  flattenTree,
  sortTree,
  type TreeNode,
  type TreeRefreshOptions,
} from './treeData';
import type { WorkerModelOutput } from './worker/protocol';

export interface CellChange {
  rowId: string;
  colKey: string;
  dir: 1 | -1 | 0;
  oldValue: unknown;
  newValue: unknown;
}

export type { DisplayedNode };

type ValueOf<TData> = (row: TData, col: InternalColumn<TData>, rowIndex: number) => unknown;

export interface GroupRefreshOptions<TData = unknown> {
  groupCols: GroupColSpec[];
  aggCols: AggColSpec[];
  groupDefaultExpanded: number;
  customAggFuncs?: Record<string, AggFunc>;
  groupTotalRow?: 'top' | 'bottom' | ((params: { node: { key: string; level: number } }) => 'top' | 'bottom' | undefined);
  groupSuppressBlankHeader?: boolean;
  grandTotalRow?: 'top' | 'bottom' | 'pinnedTop' | 'pinnedBottom';
  /** Pivot mode: never show leaf rows in the display. */
  suppressLeafRows?: boolean;
  pivotMode?: boolean;
  pivotCols?: PivotColSpec[];
  valueCols?: AggColSpec[];
  processPivotResultColDef?: (colDef: import('./types').ColDef<TData>) => import('./types').ColDef<TData>;
  removePivotHeaderRowWhenSingleValueColumn?: boolean;
  columnHeaderHeight?: number;
  onPivotColumnsBuilt?: (paths: string[][]) => void;
}

export class RowModel<TData = unknown> {
  private original: TData[] = [];
  /** When true, row objects live on the worker; main thread keeps ids only. */
  private dataMirrorDropped = false;
  private idOnlyOrder: string[] = [];

  /** Unfiltered source rows (read-only) — empty when the worker owns data. */
  get sourceRows(): readonly TData[] {
    return this.dataMirrorDropped ? [] : this.original;
  }

  get dataMirrorActive(): boolean {
    return this.dataMirrorDropped;
  }
  private byId = new Map<string, TData>();
  private originalIndex = new Map<string, number>();
  /** Flat leaf data after filter+sort (pre-group). */
  private filteredSorted: TData[] = [];
  private filteredSortedIds: string[] = [];

  /** Data rows surviving the filter (independent of expand/collapse). */
  filteredCount = 0;

  /** Displayed rows (leaves and/or group nodes). */
  displayedNodes: DisplayedNode<TData>[] = [];
  /** Convenience: leaf data or null for group rows — same length as displayedNodes. */
  displayed: (TData | null)[] = [];
  displayedIds: string[] = [];
  private displayedIndexOfId = new Map<string, number>();

  quickFilter = '';
  filterModel: FilterModel = {};
  /** Persist expand/collapse across refreshes. */
  groupExpanded = new Map<string, boolean>();
  /** Master/detail: expand state per master row id. */
  masterExpanded = new Map<string, boolean>();
  /**
   * Master/detail config, set by the grid before refresh. When present,
   * data leaves become master rows and expanded masters get a synthetic
   * detail row (`detail_{id}`) inserted after them.
   */
  masterDetail: { isRowMaster?: (data: TData) => boolean } | null = null;
  private groupRoots: GroupNode<TData>[] = [];
  private treeRoots: TreeNode<TData>[] = [];
  /** Pivot key paths from the last full refresh — used to detect structural pivot changes. */
  private lastPivotKeyPaths: string[][] = [];

  private autoIds = new WeakMap<object, string>();
  private autoIdSeq = 0;

  constructor(private readonly getRowIdFn: ((data: TData) => string) | undefined) {}

  getId(row: TData): string {
    if (this.getRowIdFn) return this.getRowIdFn(row);
    const obj = row as object;
    let id = this.autoIds.get(obj);
    if (!id) {
      id = `auto-${this.autoIdSeq++}`;
      this.autoIds.set(obj, id);
    }
    return id;
  }

  setRowData(rows: TData[]): void {
    this.original = rows.slice();
    this.reindex();
  }

  private reindex(): void {
    this.byId.clear();
    this.originalIndex.clear();
    for (let i = 0; i < this.original.length; i++) {
      const id = this.getId(this.original[i]);
      this.byId.set(id, this.original[i]);
      this.originalIndex.set(id, i);
    }
  }

  get rowCount(): number {
    return this.dataMirrorDropped ? this.idOnlyOrder.length : this.original.length;
  }

  getRowById(id: string): TData | undefined {
    if (this.dataMirrorDropped) return undefined;
    return this.byId.get(id);
  }

  /**
   * Drop the main-thread row object mirror (W5). Id order is retained for
   * rowCount and transaction routing; leaf displayed nodes carry null data.
   */
  dropDataMirror(): void {
    if (this.dataMirrorDropped) return;
    this.dataMirrorDropped = true;
    this.idOnlyOrder = this.original.map((r) => this.getId(r));
    this.original = [];
    this.byId.clear();
  }

  /** Restore mirrors after worker fallback tears down the worker path. */
  restoreDataMirror(rows: TData[]): void {
    this.dataMirrorDropped = false;
    this.idOnlyOrder = [];
    this.setRowData(rows);
  }

  getDisplayedNode(index: number): DisplayedNode<TData> | undefined {
    return this.displayedNodes[index];
  }

  /** Filtered+sorted leaf rows (pre-group) — the aggregation input set. */
  get filteredSortedRows(): readonly TData[] {
    return this.filteredSorted;
  }

  get filteredSortedRowIds(): readonly string[] {
    return this.filteredSortedIds;
  }

  /**
   * Patch worker-computed aggregates into live group rows without a model
   * rebuild. Group rows share their `aggData` object with the tree node, so
   * mutating in place is visible to the painter; footer and grand-total
   * displayed nodes hold copies and are patched individually.
   * Returns cell changes for flash (empty when nothing visible changed).
   */
  patchGroupAggregates(
    updates: Array<{ groupId: string; agg: Record<string, unknown> }>,
  ): CellChange[] {
    if (!updates.length) return [];
    let byId: Map<string, GroupNode<TData>> | null = null;
    const indexNodes = (): Map<string, GroupNode<TData>> => {
      const map = new Map<string, GroupNode<TData>>();
      const walk = (nodes: GroupNode<TData>[]): void => {
        for (const n of nodes) {
          map.set(n.id, n);
          walk(n.children);
        }
      };
      walk(this.groupRoots);
      return map;
    };

    const changes: CellChange[] = [];
    const pushDiff = (rowId: string, prev: Record<string, unknown>, next: Record<string, unknown>) => {
      for (const key of Object.keys(next)) {
        const a = prev[key];
        const b = next[key];
        if (a === b) continue;
        const dir: 1 | -1 | 0 =
          typeof a === 'number' && typeof b === 'number' ? (b > a ? 1 : b < a ? -1 : 0) : 0;
        changes.push({ rowId, colKey: key, dir, oldValue: a, newValue: b });
      }
    };

    for (const u of updates) {
      if (u.groupId === 'grand-total') {
        const di = this.displayedIndexOfId.get('grand-total');
        if (di !== undefined) {
          const target = this.displayedNodes[di].aggData;
          pushDiff('grand-total', { ...target }, u.agg);
          Object.assign(target, u.agg);
        }
        continue;
      }
      byId ??= indexNodes();
      const node = byId.get(u.groupId);
      if (!node) continue;
      const prev = { ...node.aggData };
      Object.assign(node.aggData, u.agg);
      // Expanded groups with footers blank the header row (fresh {} in the
      // flatten) and carry the values on the footer copy.
      const fi = this.displayedIndexOfId.get(`${u.groupId}:footer`);
      if (fi !== undefined) {
        const footer = this.displayedNodes[fi].aggData;
        pushDiff(`${u.groupId}:footer`, { ...footer }, u.agg);
        Object.assign(footer, u.agg);
      } else {
        const di = this.displayedIndexOfId.get(u.groupId);
        if (di !== undefined) pushDiff(u.groupId, prev, u.agg);
      }
    }
    return changes;
  }

  /**
   * Fallback-only: main-thread CSRM path when the data worker is inactive
   * or ineligible. When the worker is active, incremental aggregates and
   * pivot rebuilds are handled on the data plane — do not call from grid
   * tick handlers in that mode.
   *
   * Recompute group / pivot / grand-total aggregates after update-only
   * transactions without rebuilding the display tree. Syncs stale leaf
   * object refs first (transactions patch `byId` but not `leafRows`).
   *
   * Returns `{ changes, needsFullRefresh }` — full refresh is needed when
   * pivot key paths change (new secondary columns).
   */
  reaggregateLive(
    opts: GroupRefreshOptions<TData>,
    valueOf: ValueOf<TData>,
    cols: ColumnModel<TData>,
  ): { changes: CellChange[]; needsFullRefresh: boolean } {
    if (!this.groupRoots.length) return { changes: [], needsFullRefresh: false };

    this.syncGroupLeafRows();

    const pivotActive =
      opts.pivotMode === true &&
      (opts.pivotCols?.length ?? 0) > 0 &&
      (opts.valueCols?.length ?? 0) > 0;

    let pivotKeyPaths: string[][] = [];
    if (pivotActive) {
      pivotKeyPaths = collectPivotKeyPaths(
        this.filteredSorted,
        opts.pivotCols!,
        valueOf,
        cols,
      );
      if (!samePivotPaths(pivotKeyPaths, this.lastPivotKeyPaths)) {
        return { changes: [], needsFullRefresh: true };
      }
    }

    const before = new Map<string, Record<string, unknown>>();
    for (const n of this.displayedNodes) {
      if (n.group) before.set(n.id, { ...n.aggData });
    }

    if (pivotActive && pivotKeyPaths.length) {
      // Clear prior pivot cells then rewrite — avoids stale keys if a path
      // was removed without a full refresh (same path set, values only).
      const walkClear = (nodes: GroupNode<TData>[]): void => {
        for (const n of nodes) {
          for (const key of Object.keys(n.aggData)) {
            if (key.startsWith(PIVOT_COL_ID_PREFIX)) delete n.aggData[key];
          }
          walkClear(n.children);
        }
      };
      walkClear(this.groupRoots);
      aggregatePivotTree(
        this.groupRoots,
        opts.pivotCols!,
        opts.valueCols!,
        pivotKeyPaths,
        valueOf,
        cols,
        opts.customAggFuncs,
      );
    } else {
      aggregateTree(this.groupRoots, opts.aggCols, valueOf, cols, opts.customAggFuncs);
    }

    // Footers hold shallow copies — refresh them from the tree node.
    const byNode = new Map<string, GroupNode<TData>>();
    const index = (nodes: GroupNode<TData>[]): void => {
      for (const n of nodes) {
        byNode.set(n.id, n);
        index(n.children);
      }
    };
    index(this.groupRoots);

    for (const n of this.displayedNodes) {
      if (!n.group) continue;
      if (n.id === 'grand-total') continue;
      if (n.footer && n.id.endsWith(':footer')) {
        const groupId = n.id.slice(0, -':footer'.length);
        const node = byNode.get(groupId);
        if (node) {
          for (const k of Object.keys(n.aggData)) delete n.aggData[k];
          Object.assign(n.aggData, node.aggData);
        }
        continue;
      }
      // Non-blank headers share the tree node's aggData reference already.
      // Blank headers keep `{}` while expanded with a footer.
    }

    if (opts.grandTotalRow) {
      const grandAggCols = pivotActive
        ? pivotKeyPaths.flatMap((path) =>
            (opts.valueCols ?? []).map((v) => ({
              colId: pivotResultColId(path, v.colId),
              field: v.field,
              aggFunc: v.aggFunc,
              weightField: v.weightField,
            })),
          )
        : opts.aggCols;
      const grand = pivotActive && pivotKeyPaths.length
        ? buildPivotGrandTotalNode(
            this.groupRoots,
            opts.pivotCols!,
            opts.valueCols!,
            pivotKeyPaths,
            valueOf,
            cols,
            opts.customAggFuncs,
          )
        : buildGrandTotalNode(this.groupRoots, grandAggCols, opts.customAggFuncs);
      const di = this.displayedIndexOfId.get('grand-total');
      if (grand && di !== undefined) {
        const target = this.displayedNodes[di].aggData;
        for (const key of Object.keys(target)) delete target[key];
        Object.assign(target, grand.aggData);
      }
    }

    const changes: CellChange[] = [];
    for (const n of this.displayedNodes) {
      if (!n.group) continue;
      const prev = before.get(n.id);
      if (!prev) continue;
      for (const key of Object.keys(n.aggData)) {
        const a = prev[key];
        const b = n.aggData[key];
        if (a === b) continue;
        const dir: 1 | -1 | 0 =
          typeof a === 'number' && typeof b === 'number' ? (b > a ? 1 : b < a ? -1 : 0) : 0;
        changes.push({ rowId: n.id, colKey: key, dir, oldValue: a, newValue: b });
      }
    }
    return { changes, needsFullRefresh: false };
  }

  /** Refresh group-tree leaf object refs from the current `byId` map. */
  private syncGroupLeafRows(): void {
    for (let i = 0; i < this.filteredSortedIds.length; i++) {
      const row = this.byId.get(this.filteredSortedIds[i]);
      if (row) this.filteredSorted[i] = row;
    }
    const walk = (nodes: GroupNode<TData>[]): void => {
      for (const n of nodes) {
        for (let i = 0; i < n.leafIds.length; i++) {
          const row = this.byId.get(n.leafIds[i]);
          if (row) n.leafRows[i] = row;
        }
        walk(n.children);
      }
    };
    walk(this.groupRoots);
  }

  displayedIndexOf(id: string): number {
    return this.displayedIndexOfId.get(id) ?? -1;
  }

  applyTransaction(tx: { add?: TData[]; update?: TData[]; remove?: TData[] }): CellChange[] {
    if (this.dataMirrorDropped) return this.applyTransactionIdOnly(tx);
    const changes: CellChange[] = [];
    let structural = false;

    for (const row of tx.update ?? []) {
      const id = this.getId(row);
      const idx = this.originalIndex.get(id);
      if (idx === undefined) continue;
      const old = this.original[idx];
      if (old !== row) {
        for (const key of Object.keys(row as object)) {
          const a = (old as Record<string, unknown>)[key];
          const b = (row as Record<string, unknown>)[key];
          if (a !== b) {
            const dir: 1 | -1 | 0 =
              typeof a === 'number' && typeof b === 'number' ? (b > a ? 1 : b < a ? -1 : 0) : 0;
            changes.push({ rowId: id, colKey: key, dir, oldValue: a, newValue: b });
          }
        }
        this.original[idx] = row;
        this.byId.set(id, row);
        const di = this.displayedIndexOfId.get(id);
        if (di !== undefined && this.displayedNodes[di] && !this.displayedNodes[di].group) {
          this.displayedNodes[di] = { ...this.displayedNodes[di], data: row };
          this.displayed[di] = row;
        }
      }
    }
    for (const row of tx.add ?? []) {
      const id = this.getId(row);
      if (this.originalIndex.has(id)) continue;
      this.originalIndex.set(id, this.original.length);
      this.original.push(row);
      this.byId.set(id, row);
      structural = true;
    }
    const removeIds = (tx.remove ?? []).map((r) => this.getId(r));
    if (removeIds.length) {
      const dead = new Set(removeIds);
      this.original = this.original.filter((r) => !dead.has(this.getId(r)));
      structural = true;
    }
    if (structural) this.reindex();
    return changes;
  }

  /**
   * Transaction routing when the worker owns row data — track ids + changes
   * for flash/PREV without retaining row objects on the main thread.
   */
  private applyTransactionIdOnly(tx: {
    add?: TData[];
    update?: TData[];
    remove?: TData[];
  }): CellChange[] {
    const changes: CellChange[] = [];
    const known = new Set(this.idOnlyOrder);

    for (const row of tx.update ?? []) {
      const id = this.getId(row);
      if (!known.has(id)) continue;
      for (const key of Object.keys(row as object)) {
        const neu = (row as Record<string, unknown>)[key];
        changes.push({ rowId: id, colKey: key, dir: 0, oldValue: undefined, newValue: neu });
      }
    }
    for (const row of tx.add ?? []) {
      const id = this.getId(row);
      if (known.has(id)) continue;
      this.idOnlyOrder.push(id);
      known.add(id);
    }
    const removeIds = (tx.remove ?? []).map((r) => this.getId(r));
    if (removeIds.length) {
      const dead = new Set(removeIds);
      this.idOnlyOrder = this.idOnlyOrder.filter((id) => !dead.has(id));
    }
    return changes;
  }

  /**
   * Apply a worker-computed model (filter → sort → group flatten). Maps row
   * ids back to live objects held in `byId` unless the data mirror is dropped.
   */
  applyWorkerModel(output: WorkerModelOutput): void {
    if (output.pivotKeyPaths !== undefined) {
      this.lastPivotKeyPaths = output.pivotKeyPaths;
    }
    this.filteredSorted = [];
    this.filteredSortedIds = [];
    for (const id of output.filteredSortedIds) {
      if (this.dataMirrorDropped) {
        this.filteredSortedIds.push(id);
        continue;
      }
      const row = this.byId.get(id);
      if (row == null) continue;
      this.filteredSorted.push(row);
      this.filteredSortedIds.push(id);
    }
    this.filteredCount = output.filteredCount;
    this.groupRoots = [];
    this.treeRoots = [];

    this.displayedNodes = output.displayed.map((entry) => {
      const grand = entry.kind === 'grandTotal';
      const footer = entry.kind === 'footer' || grand;
      const group = entry.kind === 'group' || footer;
      return {
        id: entry.id,
        data:
          entry.kind === 'leaf' && !this.dataMirrorDropped
            ? (this.byId.get(entry.id) ?? null)
            : null,
        group,
        footer: footer || undefined,
        level: entry.level,
        expanded: entry.expanded,
        key: entry.key,
        field: entry.field,
        childCount: entry.childCount,
        aggData: { ...entry.aggData },
        groupId: entry.groupId,
      };
    });
    this.finalizeDisplayed();
  }

  setGroupExpanded(groupId: string, expanded: boolean): void {
    this.groupExpanded.set(groupId, expanded);
  }

  expandAll(expanded: boolean): void {
    const walk = (nodes: GroupNode<TData>[]): void => {
      for (const n of nodes) {
        this.groupExpanded.set(n.id, expanded);
        walk(n.children);
      }
    };
    walk(this.groupRoots);
    const walkTree = (nodes: TreeNode<TData>[]): void => {
      for (const n of nodes) {
        if (n.children.length) this.groupExpanded.set(n.id, expanded);
        walkTree(n.children);
      }
    };
    walkTree(this.treeRoots);
  }

  /** Re-run filter + sort (+ optional group or tree) into displayed nodes. */
  refresh(
    cols: ColumnModel<TData>,
    valueOf: ValueOf<TData>,
    external?: { present: boolean; pass?: (row: TData) => boolean },
    groupOpts?: GroupRefreshOptions<TData> | null,
    treeOpts?: TreeRefreshOptions<TData> | null,
  ): void {
    const displayedCols = cols.displayed();
    const quickTokens = tokenizeQuickFilter(this.quickFilter);
    const filters = Object.entries(this.filterModel)
      .map(([colId, f]) => ({ col: cols.getColumn(colId), f }))
      .filter((x): x is { col: InternalColumn<TData>; f: ColumnFilter } => !!x.col);

    const externalActive = external?.present && external.pass;
    const needsFilter = quickTokens.length > 0 || filters.length > 0 || externalActive;
    const rowPass = (row: TData, i: number): boolean => {
      for (const { col, f } of filters) {
        if (!passesFilter(valueOf(row, col, i), f)) return false;
      }
      if (quickTokens.length && !rowPassesQuickFilter(row, i, quickTokens, displayedCols, valueOf)) {
        return false;
      }
      if (externalActive && !external!.pass!(row)) return false;
      return true;
    };

    if (treeOpts) {
      // Tree nodes match on their row fields OR their path key (the auto
      // group column's visible value — AG Grid quick filter includes it).
      const nodePass = (n: TreeNode<TData>): boolean => {
        for (const { col, f } of filters) {
          const v = n.data != null ? valueOf(n.data, col, 0) : undefined;
          if (!passesFilter(v, f)) return false;
        }
        if (externalActive && (n.data == null || !external!.pass!(n.data))) return false;
        for (const token of quickTokens) {
          const inKey = n.key.toLowerCase().includes(token);
          const inRow =
            n.data != null && rowPassesQuickFilter(n.data, 0, [token], displayedCols, valueOf);
          if (!inKey && !inRow) return false;
        }
        return true;
      };
      this.refreshTree(cols, valueOf, treeOpts, needsFilter ? nodePass : null);
      return;
    }
    this.treeRoots = [];

    let out: TData[] = needsFilter
      ? this.original.filter((row, i) => rowPass(row, i))
      : this.original.slice();

    const sortModel = cols.sortModel();
    if (sortModel.length) {
      const sortCols = sortModel
        .map((s) => ({ col: cols.getColumn(s.colId), dir: s.sort === 'asc' ? 1 : -1 }))
        .filter((x): x is { col: InternalColumn<TData>; dir: number } => !!x.col);
      const decorated = out.map((row, i) => ({ row, i }));
      decorated.sort((a, b) => {
        for (const { col, dir } of sortCols) {
          const cmp = compareValues(
            valueOf(a.row, col, a.i),
            valueOf(b.row, col, b.i),
            a.row,
            b.row,
            col,
          );
          if (cmp !== 0) return cmp * dir;
        }
        return a.i - b.i;
      });
      out = decorated.map((d) => d.row);
    }

    this.filteredSorted = out;
    this.filteredSortedIds = out.map((r) => this.getId(r));
    this.filteredCount = out.length;

    if (groupOpts && groupOpts.groupCols.length) {
      const pivotActive =
        groupOpts.pivotMode === true &&
        (groupOpts.pivotCols?.length ?? 0) > 0 &&
        (groupOpts.valueCols?.length ?? 0) > 0;
      const pivotKeyPaths = pivotActive
        ? collectPivotKeyPaths(this.filteredSorted, groupOpts.pivotCols!, valueOf, cols)
        : [];
      this.lastPivotKeyPaths = pivotKeyPaths;

      if (pivotActive && pivotKeyPaths.length) {
        groupOpts.onPivotColumnsBuilt?.(pivotKeyPaths);
      } else {
        cols.clearPivotResultColumns();
      }

      this.groupRoots = buildGroupTree(
        this.filteredSorted,
        this.filteredSortedIds,
        groupOpts.groupCols,
        valueOf,
        cols,
        this.groupExpanded,
        groupOpts.groupDefaultExpanded,
      );

      const aggColsForTree = pivotActive ? [] : groupOpts.aggCols;
      aggregateTree(
        this.groupRoots,
        aggColsForTree,
        valueOf,
        cols,
        groupOpts.customAggFuncs,
      );

      if (pivotActive && pivotKeyPaths.length) {
        aggregatePivotTree(
          this.groupRoots,
          groupOpts.pivotCols!,
          groupOpts.valueCols!,
          pivotKeyPaths,
          valueOf,
          cols,
          groupOpts.customAggFuncs,
        );
      }

      this.displayedNodes = flattenGroupTree(
        this.groupRoots,
        groupOpts.groupTotalRow,
        groupOpts.suppressLeafRows,
        groupOpts.groupSuppressBlankHeader,
      );

      const grandAggCols = pivotActive
        ? pivotKeyPaths.flatMap((path) =>
            (groupOpts.valueCols ?? []).map((v) => ({
              colId: pivotResultColId(path, v.colId),
              field: v.field,
              aggFunc: v.aggFunc,
              weightField: v.weightField,
            })),
          )
        : groupOpts.aggCols;

      const grand = groupOpts.grandTotalRow
        ? pivotActive && pivotKeyPaths.length
          ? buildPivotGrandTotalNode(
              this.groupRoots,
              groupOpts.pivotCols!,
              groupOpts.valueCols!,
              pivotKeyPaths,
              valueOf,
              cols,
              groupOpts.customAggFuncs,
            )
          : buildGrandTotalNode(this.groupRoots, grandAggCols, groupOpts.customAggFuncs)
        : null;
      if (grand) {
        const pin = groupOpts.grandTotalRow === 'top' || groupOpts.grandTotalRow === 'pinnedTop';
        if (pin) this.displayedNodes.unshift(grand);
        else this.displayedNodes.push(grand);
      }
    } else {
      this.groupRoots = [];
      this.lastPivotKeyPaths = [];
      this.displayedNodes = this.filteredSorted.map((row, i) => ({
        id: this.filteredSortedIds[i],
        data: row,
        group: false,
        level: 0,
        expanded: false,
        key: '',
        field: '',
        childCount: 0,
        aggData: {},
        groupId: null,
      }));
    }

    this.finalizeDisplayed();
  }

  /** Tree-data pipeline: build → filter (two-pass) → sort siblings → agg → flatten. */
  private refreshTree(
    cols: ColumnModel<TData>,
    valueOf: ValueOf<TData>,
    treeOpts: TreeRefreshOptions<TData>,
    nodePass: ((node: TreeNode<TData>) => boolean) | null,
  ): void {
    this.groupRoots = [];
    let roots = buildTree(this.original, treeOpts, (r) => this.getId(r));

    // Nested-children rows aren't in `original` — index them so selection /
    // getRowById resolve tree descendants too.
    if (treeOpts.childrenField) {
      const index = (nodes: TreeNode<TData>[]): void => {
        for (const n of nodes) {
          if (n.data != null && !this.byId.has(n.id)) this.byId.set(n.id, n.data);
          index(n.children);
        }
      };
      index(roots);
    }

    if (nodePass) {
      roots = filterTree(roots, nodePass, treeOpts.excludeChildrenWhenTreeDataFiltering);
    }

    const sortModel = cols.sortModel();
    if (sortModel.length) {
      const sortCols = sortModel
        .map((s) => ({ col: cols.getColumn(s.colId), dir: s.sort === 'asc' ? 1 : -1 }))
        .filter((x): x is { col: InternalColumn<TData>; dir: number } => !!x.col);
      sortTree(roots, (a, b) => {
        for (const { col, dir } of sortCols) {
          const av = a.data != null ? valueOf(a.data, col, 0) : undefined;
          const bv = b.data != null ? valueOf(b.data, col, 0) : undefined;
          const cmp =
            a.data != null && b.data != null
              ? compareValues(av, bv, a.data, b.data, col)
              : compareValues(av, bv, a.data as TData, b.data as TData, col);
          if (cmp !== 0) return cmp * dir;
        }
        return a.key.localeCompare(b.key);
      });
    }

    aggregateTreeData(roots, treeOpts.aggCols, valueOf, cols, treeOpts.customAggFuncs);
    this.treeRoots = roots;
    const countData = (nodes: TreeNode<TData>[]): number =>
      nodes.reduce((s, n) => s + (n.data != null ? 1 : 0) + countData(n.children), 0);
    this.filteredCount = countData(roots);
    this.displayedNodes = flattenTree(roots, this.groupExpanded, treeOpts.groupDefaultExpanded);
    this.finalizeDisplayed();
  }

  setMasterExpanded(rowId: string, expanded: boolean): void {
    this.masterExpanded.set(rowId, expanded);
  }

  /** Mark master leaves and splice a detail row after each expanded master. */
  private insertDetailRows(): void {
    const md = this.masterDetail;
    if (!md) return;
    const out: DisplayedNode<TData>[] = [];
    for (const node of this.displayedNodes) {
      out.push(node);
      if (node.group || node.footer || node.data == null) continue;
      if (md.isRowMaster && !md.isRowMaster(node.data)) continue;
      node.master = true;
      node.expanded = this.masterExpanded.get(node.id) === true;
      if (!node.expanded) continue;
      out.push({
        id: `detail_${node.id}`,
        data: null,
        group: false,
        level: node.level + 1,
        expanded: false,
        key: '',
        field: '',
        childCount: 0,
        aggData: {},
        groupId: null,
        detail: true,
      });
    }
    this.displayedNodes = out;
  }

  private finalizeDisplayed(): void {
    this.insertDetailRows();
    this.displayed = this.displayedNodes.map((n) => n.data);
    this.displayedIds = this.displayedNodes.map((n) => n.id);
    this.displayedIndexOfId.clear();
    for (let i = 0; i < this.displayedIds.length; i++) {
      this.displayedIndexOfId.set(this.displayedIds[i], i);
    }
  }
}

function compareValues<TData>(
  a: unknown,
  b: unknown,
  rowA: TData,
  rowB: TData,
  col: InternalColumn<TData>,
): number {
  if (col.def.comparator) return col.def.comparator(a, b, rowA, rowB);
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function samePivotPaths(a: string[][], b: string[][]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const pa = a[i];
    const pb = b[i];
    if (pa.length !== pb.length) return false;
    for (let j = 0; j < pa.length; j++) {
      if (pa[j] !== pb[j]) return false;
    }
  }
  return true;
}
