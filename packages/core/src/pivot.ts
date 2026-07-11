/**
 * Pivot mode: discover pivot key paths, generate secondary (pivot result)
 * columns, and aggregate group nodes per pivot cell (plan §4.8).
 *
 * Column layout matches AG Grid CSRM pivoting:
 * - Outermost header groups = first pivot column keys (ordered by pivotComparator)
 * - Inner groups = additional pivot levels
 * - Leaf headers = value columns in definition order (gold, silver, bronze…)
 */
import type { AggFunc } from './aggregation';
import { resolveAggFunc } from './aggregation';
import { attachAncestors, type ProvidedColumnGroup } from './columnGroups';
import type { InternalColumn } from './columnModel';
import type { AggColSpec, GroupNode } from './grouping';
import { groupKey } from './grouping';
import type { ColDef } from './types';

export const PIVOT_COL_ID_PREFIX = 'pivot_';

export interface PivotColSpec {
  colId: string;
  field?: string;
  pivotComparator?: (a: string, b: string) => number;
}

type ValueOf<TData> = (row: TData, col: InternalColumn<TData>, rowIndex: number) => unknown;

export function pivotResultColId(pivotKeys: string[], valueColId: string): string {
  const keyPart = pivotKeys.map((k) => encodeURIComponent(k)).join('|');
  return `${PIVOT_COL_ID_PREFIX}${keyPart}__${valueColId}`;
}

export function parsePivotResultColId(
  colId: string,
): { pivotKeys: string[]; valueColId: string } | null {
  if (!colId.startsWith(PIVOT_COL_ID_PREFIX)) return null;
  const rest = colId.slice(PIVOT_COL_ID_PREFIX.length);
  const sep = rest.lastIndexOf('__');
  if (sep < 0) return null;
  const keys = rest
    .slice(0, sep)
    .split('|')
    .map((k) => decodeURIComponent(k));
  return { pivotKeys: keys, valueColId: rest.slice(sep + 2) };
}

/** Unique pivot key paths PRESENT IN THE DATA, sorted hierarchically with
 *  each level's pivotComparator. AG Grid parity: a (sport, year) combo with
 *  no rows gets no pivot result columns — the earlier cartesian product of
 *  per-level keys manufactured hundreds of permanently-blank columns on
 *  sparse datasets and multiplied aggregation work by the same factor. */
export function collectPivotKeyPaths<TData>(
  rows: TData[],
  pivotCols: PivotColSpec[],
  valueOf: ValueOf<TData>,
  cols: { getColumn: (id: string) => InternalColumn<TData> | undefined },
): string[][] {
  if (!pivotCols.length || !rows.length) return [];

  const specCols = pivotCols.map((spec) => cols.getColumn(spec.colId));
  const seen = new Set<string>();
  const paths: string[][] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const path = new Array<string>(pivotCols.length);
    for (let level = 0; level < pivotCols.length; level++) {
      const spec = pivotCols[level];
      const col = specCols[level];
      const raw = col
        ? valueOf(row, col, i)
        : (row as Record<string, unknown>)[spec.field ?? spec.colId];
      path[level] = groupKey(raw);
    }
    const key = path.map((k) => encodeURIComponent(k)).join('|');
    if (!seen.has(key)) {
      seen.add(key);
      paths.push(path);
    }
  }

  const cmps = pivotCols.map(
    (spec) => spec.pivotComparator ?? ((a: string, b: string) => a.localeCompare(b)),
  );
  paths.sort((a, b) => {
    for (let level = 0; level < a.length; level++) {
      const c = cmps[level](a[level], b[level]);
      if (c !== 0) return c;
    }
    return 0;
  });
  return paths;
}

function rowMatchesPivotKeys<TData>(
  row: TData,
  pivotCols: PivotColSpec[],
  pivotKeys: string[],
  valueOf: ValueOf<TData>,
  cols: { getColumn: (id: string) => InternalColumn<TData> | undefined },
): boolean {
  for (let level = 0; level < pivotCols.length; level++) {
    const spec = pivotCols[level];
    const col = cols.getColumn(spec.colId);
    const raw = col
      ? valueOf(row, col, 0)
      : (row as Record<string, unknown>)[spec.field ?? spec.colId];
    if (groupKey(raw) !== pivotKeys[level]) return false;
  }
  return true;
}

export function aggregatePivotTree<TData>(
  roots: GroupNode<TData>[],
  pivotCols: PivotColSpec[],
  valueCols: AggColSpec[],
  pivotKeyPaths: string[][],
  valueOf: ValueOf<TData>,
  cols: { getColumn: (id: string) => InternalColumn<TData> | undefined },
  customAggFuncs?: Record<string, AggFunc>,
): void {
  if (!pivotKeyPaths.length || !valueCols.length) return;

  const walk = (node: GroupNode<TData>): void => {
    for (const ch of node.children) walk(ch);

    for (const path of pivotKeyPaths) {
      for (const agg of valueCols) {
        const fn = resolveAggFunc(agg.aggFunc, customAggFuncs);
        if (!fn) continue;
        const srcCol = cols.getColumn(agg.colId);
        const values: unknown[] = [];
        const weights: unknown[] = [];

        const collect = (n: GroupNode<TData>): void => {
          for (const row of n.leafRows) {
            if (!rowMatchesPivotKeys(row, pivotCols, path, valueOf, cols)) continue;
            const v = srcCol
              ? valueOf(row, srcCol, 0)
              : (row as Record<string, unknown>)[agg.field ?? agg.colId];
            values.push(v);
            if (agg.weightField) {
              weights.push((row as Record<string, unknown>)[agg.weightField]);
            }
          }
          for (const ch of n.children) collect(ch);
        };
        collect(node);

        const useWeights = agg.weightField != null || agg.aggFunc === 'weightedAverage';
        const result = useWeights ? fn(values, weights) : fn(values);
        node.aggData[pivotResultColId(path, agg.colId)] = result;
      }
    }
  };

  for (const r of roots) walk(r);
}

export interface PivotBuildResult<TData = unknown> {
  leaves: InternalColumn<TData>[];
  providedRoots: ProvidedColumnGroup<TData>[];
}

export interface PivotBuildOptions<TData = unknown> {
  pivotDefaultExpanded?: number;
  suppressExpandablePivotGroups?: boolean;
  removePivotHeaderRowWhenSingleValueColumn?: boolean;
  processPivotResultColDef?: (colDef: ColDef<TData>) => ColDef<TData>;
}

export function pivotClosedColId(pivotKeys: string[], valueColId: string): string {
  return `${pivotResultColId(pivotKeys, valueColId)}_closed`;
}

function pivotGroupExpanded(level: number, pivotDefaultExpanded?: number): boolean {
  const depth = pivotDefaultExpanded ?? 0;
  return depth === -1 || level < depth;
}

function pivotGroupsExpandable(pivotColCount: number, suppress?: boolean): boolean {
  return pivotColCount > 1 && suppress !== true;
}

function buildValueLeaves<TData>(
  pivotKeys: string[],
  valueCols: AggColSpec[],
  sourceCols: Map<string, InternalColumn<TData>>,
  processColDef?: (colDef: ColDef<TData>) => ColDef<TData>,
  columnGroupShow: 'open' | 'closed' = 'open',
  pivotChildColIds?: string[],
): InternalColumn<TData>[] {
  const out: InternalColumn<TData>[] = [];
  for (const agg of valueCols) {
    const src = sourceCols.get(agg.colId);
    const colId =
      columnGroupShow === 'closed'
        ? pivotClosedColId(pivotKeys, agg.colId)
        : pivotResultColId(pivotKeys, agg.colId);
    let def: ColDef<TData> = {
      ...(src?.def ?? {}),
      colId,
      field: agg.field ?? agg.colId,
      headerName: src?.def.headerName ?? agg.field ?? agg.colId,
      aggFunc: agg.aggFunc,
      weightField: agg.weightField,
      pivotKeys,
      columnGroupShow,
      pivotChildColIds,
      sortable: false,
      filter: false,
      floatingFilter: false,
      hide: false,
    };
    if (processColDef) {
      const next = processColDef(def);
      if (next) def = next;
    }
    out.push({
      colId,
      def,
      width: src?.width ?? 130,
      flex: src?.flex ?? 1,
      pinned: null,
      sort: null,
      sortIndex: -1,
      hide: false,
      groupHidden: false,
      ancestorGroups: [],
      pivotResult: true,
    });
  }
  return out;
}

function collectLeaves<TData>(
  nodes: (ProvidedColumnGroup<TData> | InternalColumn<TData>)[],
  out: InternalColumn<TData>[],
): void {
  for (const n of nodes) {
    if ('colId' in n) out.push(n);
    else collectLeaves(n.children, out);
  }
}

function keysAtLevel(
  paths: string[][],
  level: number,
  pivotCols: PivotColSpec[],
): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const k = p[level];
    if (!seen.has(k)) {
      seen.add(k);
      order.push(k);
    }
  }
  const cmp = pivotCols[level]?.pivotComparator ?? ((a, b) => a.localeCompare(b));
  return [...order].sort(cmp);
}

function isLeafPivotGroup<TData>(group: ProvidedColumnGroup<TData>): boolean {
  return !group.children.some((ch) => !('colId' in ch));
}

function collectOpenPivotColIds<TData>(
  group: ProvidedColumnGroup<TData>,
  valueColId: string,
): string[] {
  const out: string[] = [];
  const walk = (nodes: (ProvidedColumnGroup<TData> | InternalColumn<TData>)[]): void => {
    for (const n of nodes) {
      if ('colId' in n) {
        if (n.def.columnGroupShow !== 'closed') {
          const parsed = parsePivotResultColId(n.colId);
          if (parsed?.valueColId === valueColId) out.push(n.colId);
        }
      } else {
        walk(n.children);
      }
    }
  };
  walk(group.children);
  return out;
}

/** AG Grid `addExpandablePivotGroups`: closed summary measure cols per group level. */
function addExpandablePivotClosedColumns<TData>(
  roots: ProvidedColumnGroup<TData>[],
  valueCols: AggColSpec[],
  pivotCols: PivotColSpec[],
  sourceCols: Map<string, InternalColumn<TData>>,
  options: PivotBuildOptions<TData>,
): void {
  if (options.suppressExpandablePivotGroups || pivotCols.length < 2) return;

  const removeValueRow =
    options.removePivotHeaderRowWhenSingleValueColumn === true && valueCols.length === 1;

  const walk = (group: ProvidedColumnGroup<TData>): void => {
    for (const ch of group.children) {
      if (!('colId' in ch)) walk(ch);
    }
    const leafGroup = isLeafPivotGroup(group);
    const hasCollapsedLeafGroup = leafGroup && removeValueRow;
    if (leafGroup && !hasCollapsedLeafGroup) return;

    const pivotKeys = group.pivotKeys;
    if (!pivotKeys?.length) return;

    for (const agg of valueCols) {
      const childIds = collectOpenPivotColIds(group, agg.colId);
      const closed = buildValueLeaves(
        pivotKeys,
        [agg],
        sourceCols,
        options.processPivotResultColDef,
        'closed',
        childIds,
      );
      group.children.push(...closed);
    }
  };

  for (const r of roots) walk(r);
}

function buildGroupsAtLevel<TData>(
  paths: string[][],
  level: number,
  pivotCols: PivotColSpec[],
  valueCols: AggColSpec[],
  sourceCols: Map<string, InternalColumn<TData>>,
  options: PivotBuildOptions<TData>,
): (ProvidedColumnGroup<TData> | InternalColumn<TData>)[] {
  const depth = paths[0]?.length ?? 0;
  const keys = keysAtLevel(paths, level, pivotCols);
  const out: (ProvidedColumnGroup<TData> | InternalColumn<TData>)[] = [];
  const expandable =
    pivotGroupsExpandable(pivotCols.length, options.suppressExpandablePivotGroups) &&
    level < pivotCols.length - 1;
  const removeValueRow =
    options.removePivotHeaderRowWhenSingleValueColumn === true && valueCols.length === 1;

  for (const key of keys) {
    const sub = paths.filter((p) => p[level] === key);
    const pivotKeys = sub[0] ?? [];
    if (level === depth - 1) {
      if (removeValueRow) {
        const leaves = buildValueLeaves(pivotKeys, valueCols, sourceCols, options.processPivotResultColDef);
        leaves[0].def.headerName = key;
        out.push(...leaves);
      } else {
        const group: ProvidedColumnGroup<TData> = {
          groupId: `pivot-group-${pivotKeys.join('/')}`,
          headerName: key,
          pivotKeys,
          children: buildValueLeaves(pivotKeys, valueCols, sourceCols, options.processPivotResultColDef),
          level,
          expandable,
          expanded:
            level < pivotCols.length - 1
              ? pivotGroupExpanded(level, options.pivotDefaultExpanded)
              : true,
          padding: false,
          marryChildren: true,
          def: null,
        };
        out.push(group);
      }
    } else {
      const group: ProvidedColumnGroup<TData> = {
        groupId: `pivot-group-${pivotKeys.slice(0, level + 1).join('/')}`,
        headerName: key,
        pivotKeys: pivotKeys.slice(0, level + 1),
        children: buildGroupsAtLevel(sub, level + 1, pivotCols, valueCols, sourceCols, options),
        level,
        expandable,
        expanded:
          level < pivotCols.length - 1
            ? pivotGroupExpanded(level, options.pivotDefaultExpanded)
            : true,
        padding: false,
        marryChildren: true,
        def: null,
      };
      out.push(group);
    }
  }
  return out;
}

/** Build pivot result column tree from discovered key paths × value columns. */
export function buildPivotResultColumns<TData>(
  pivotKeyPaths: string[][],
  valueCols: AggColSpec[],
  sourceCols: InternalColumn<TData>[],
  pivotCols: PivotColSpec[],
  options: PivotBuildOptions<TData> = {},
): PivotBuildResult<TData> {
  if (!pivotKeyPaths.length || !valueCols.length) {
    return { leaves: [], providedRoots: [] };
  }

  const srcMap = new Map(sourceCols.map((c) => [c.colId, c]));
  const skipValueRow =
    options.removePivotHeaderRowWhenSingleValueColumn === true && valueCols.length === 1;
  const top = buildGroupsAtLevel(pivotKeyPaths, 0, pivotCols, valueCols, srcMap, options);

  const providedRoots = top.filter((n): n is ProvidedColumnGroup<TData> => !('colId' in n));
  const flatLeaves = top.filter((n): n is InternalColumn<TData> => 'colId' in n);

  addExpandablePivotClosedColumns(providedRoots, valueCols, pivotCols, srcMap, options);

  for (const r of providedRoots) attachAncestors(r, []);

  const ordered: InternalColumn<TData>[] = [];
  if (providedRoots.length) {
    for (const r of providedRoots) collectLeaves(r.children, ordered);
  } else {
    ordered.push(...flatLeaves);
  }

  return { leaves: ordered, providedRoots: skipValueRow ? [] : providedRoots };
}

/** Grand-total footer with pivot result column aggregations. */
export function buildPivotGrandTotalNode<TData>(
  roots: GroupNode<TData>[],
  pivotCols: PivotColSpec[],
  valueCols: AggColSpec[],
  pivotKeyPaths: string[][],
  valueOf: ValueOf<TData>,
  cols: { getColumn: (id: string) => InternalColumn<TData> | undefined },
  customAggFuncs?: Record<string, AggFunc>,
): import('./grouping').DisplayedNode<TData> | null {
  if (!valueCols.length || !roots.length || !pivotKeyPaths.length) return null;
  const aggData: Record<string, unknown> = {};

  for (const path of pivotKeyPaths) {
    for (const agg of valueCols) {
      const fn = resolveAggFunc(agg.aggFunc, customAggFuncs);
      if (!fn) continue;
      const srcCol = cols.getColumn(agg.colId);
      const values: unknown[] = [];
      const weights: unknown[] = [];
      const collect = (nodes: GroupNode<TData>[]): void => {
        for (const n of nodes) {
          for (const row of n.leafRows) {
            if (!rowMatchesPivotKeys(row, pivotCols, path, valueOf, cols)) continue;
            const v = srcCol
              ? valueOf(row, srcCol, 0)
              : (row as Record<string, unknown>)[agg.field ?? agg.colId];
            values.push(v);
            if (agg.weightField) weights.push((row as Record<string, unknown>)[agg.weightField]);
          }
          collect(n.children);
        }
      };
      collect(roots);
      const useWeights = agg.weightField != null || agg.aggFunc === 'weightedAverage';
      const result = useWeights ? fn(values, weights) : fn(values);
      aggData[pivotResultColId(path, agg.colId)] = result;
    }
  }

  return {
    id: 'grand-total',
    data: null,
    group: true,
    footer: true,
    level: 0,
    expanded: false,
    key: 'Grand Total',
    field: '',
    childCount: 0,
    aggData,
    groupId: null,
  };
}
