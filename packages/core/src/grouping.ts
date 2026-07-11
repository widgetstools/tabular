/**
 * Row grouping: build group tree → aggregate → flatten to displayed nodes
 * honoring expand/collapse (plan §4.7).
 */
import type { AggFunc, AggFuncName } from './aggregation';
import { resolveAggFunc } from './aggregation';
import type { InternalColumn } from './columnModel';

export interface GroupColSpec {
  colId: string;
  field?: string;
}

export interface AggColSpec {
  colId: string;
  field?: string;
  aggFunc: AggFuncName | AggFunc;
  /** Field used as weight for weightedAverage (e.g. notional). */
  weightField?: string;
}

export interface GroupNode<TData = unknown> {
  id: string;
  key: string;
  field: string;
  level: number;
  expanded: boolean;
  children: GroupNode<TData>[];
  leafRows: TData[];
  leafIds: string[];
  childCount: number;
  aggData: Record<string, unknown>;
  parent: GroupNode<TData> | null;
}

export interface DisplayedNode<TData = unknown> {
  id: string;
  /** Leaf row data, or null for group / footer rows. */
  data: TData | null;
  group: boolean;
  /** Group footer row (`groupTotalRow` / `grandTotalRow`). */
  footer?: boolean;
  level: number;
  expanded: boolean;
  key: string;
  field: string;
  childCount: number;
  aggData: Record<string, unknown>;
  /** Group node id for expand/collapse; null for leaves and footers. */
  groupId: string | null;
  /** Master row with an expandable detail (master/detail). */
  master?: boolean;
  /** Synthetic detail row under an expanded master; id is `detail_{masterId}`. */
  detail?: boolean;
}

type ValueOf<TData> = (row: TData, col: InternalColumn<TData>, rowIndex: number) => unknown;

export function groupKey(value: unknown): string {
  if (value == null) return '(Blank)';
  return String(value);
}

export function buildGroupTree<TData>(
  rows: TData[],
  rowIds: string[],
  groupCols: GroupColSpec[],
  valueOf: ValueOf<TData>,
  cols: { getColumn: (id: string) => InternalColumn<TData> | undefined },
  expandedState: Map<string, boolean>,
  groupDefaultExpanded: number,
): GroupNode<TData>[] {
  if (!groupCols.length) return [];

  const rootChildren: GroupNode<TData>[] = [];
  const rootMap = new Map<string, GroupNode<TData>>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowId = rowIds[i];
    let parentChildren = rootChildren;
    let parentMap = rootMap;
    let parent: GroupNode<TData> | null = null;
    let path = '';

    for (let level = 0; level < groupCols.length; level++) {
      const spec = groupCols[level];
      const col = cols.getColumn(spec.colId);
      const raw = col
        ? valueOf(row, col, i)
        : (row as Record<string, unknown>)[spec.field ?? spec.colId];
      const key = groupKey(raw);
      path = path ? `${path}/${key}` : key;
      const id = `g:${spec.colId}:${path}`;

      let node = parentMap.get(key);
      if (!node) {
        const defaultOpen = groupDefaultExpanded === -1 || level < groupDefaultExpanded;
        node = {
          id,
          key,
          field: spec.field ?? spec.colId,
          level,
          expanded: expandedState.has(id) ? expandedState.get(id)! : defaultOpen,
          children: [],
          leafRows: [],
          leafIds: [],
          childCount: 0,
          aggData: {},
          parent,
        };
        parentChildren.push(node);
        parentMap.set(key, node);
      }

      if (level === groupCols.length - 1) {
        node.leafRows.push(row);
        node.leafIds.push(rowId);
      }

      parent = node;
      parentChildren = node.children;
      parentMap = new Map(node.children.map((c) => [c.key, c]));
    }
  }

  const recount = (nodes: GroupNode<TData>[]): number => {
    let total = 0;
    for (const n of nodes) {
      const childLeaves = recount(n.children);
      n.childCount = n.leafRows.length + childLeaves;
      total += n.childCount;
    }
    return total;
  };
  recount(rootChildren);
  return rootChildren;
}

export function aggregateTree<TData>(
  roots: GroupNode<TData>[],
  aggCols: AggColSpec[],
  valueOf: ValueOf<TData>,
  cols: { getColumn: (id: string) => InternalColumn<TData> | undefined },
  customAggFuncs?: Record<string, AggFunc>,
): void {
  if (!aggCols.length) return;

  const walk = (node: GroupNode<TData>): void => {
    for (const ch of node.children) walk(ch);

    for (const agg of aggCols) {
      const fn = resolveAggFunc(agg.aggFunc, customAggFuncs);
      if (!fn) continue;
      const col = cols.getColumn(agg.colId);
      const values: unknown[] = [];
      const weights: unknown[] = [];

      const collect = (n: GroupNode<TData>): void => {
        for (let i = 0; i < n.leafRows.length; i++) {
          const row = n.leafRows[i];
          const v = col
            ? valueOf(row, col, i)
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
      node.aggData[agg.colId] = result;
      if (agg.field && agg.field !== agg.colId) node.aggData[agg.field] = result;
    }
  };

  for (const r of roots) walk(r);
}

export function flattenGroupTree<TData>(
  roots: GroupNode<TData>[],
  groupTotalRow?: 'top' | 'bottom' | ((params: { node: { key: string; level: number } }) => 'top' | 'bottom' | undefined),
  suppressLeafRows?: boolean,
  groupSuppressBlankHeader?: boolean,
): DisplayedNode<TData>[] {
  const out: DisplayedNode<TData>[] = [];

  // AG labels footers "Total <group>" and indents them one level deeper,
  // aligned with the group's children.
  const footerFor = (n: GroupNode<TData>): DisplayedNode<TData> => ({
    id: `${n.id}:footer`,
    data: null,
    group: true,
    footer: true,
    level: n.level + 1,
    expanded: false,
    key: n.key ? `Total ${n.key}` : 'Total',
    field: n.field,
    childCount: 0,
    aggData: { ...n.aggData },
    groupId: null,
  });

  const resolveTotalPos = (n: GroupNode<TData>): 'top' | 'bottom' | undefined => {
    if (!groupTotalRow) return undefined;
    if (typeof groupTotalRow === 'function') {
      return groupTotalRow({ node: { key: n.key, level: n.level } });
    }
    return groupTotalRow;
  };

  const walk = (nodes: GroupNode<TData>[]): void => {
    for (const n of nodes) {
      const totalPos = resolveTotalPos(n);
      // In pivot mode leaves are suppressed, so a deepest-level group has
      // nothing to reveal — AG hides its expand chevron entirely.
      const expandable = n.children.length > 0 || !suppressLeafRows;
      // AG: while a group with a footer is expanded, the aggregates "move"
      // to the footer and the header goes blank (groupSuppressBlankHeader
      // keeps them in both places).
      const blankHeader = n.expanded && totalPos !== undefined && groupSuppressBlankHeader !== true;
      out.push({
        id: n.id,
        data: null,
        group: true,
        level: n.level,
        expanded: n.expanded,
        key: n.key,
        field: n.field,
        childCount: n.childCount,
        aggData: blankHeader ? {} : n.aggData,
        groupId: expandable ? n.id : null,
      });
      if (!n.expanded) continue;
      if (totalPos === 'top') out.push(footerFor(n));
      walk(n.children);
      if (!suppressLeafRows) {
        for (let i = 0; i < n.leafRows.length; i++) {
          out.push({
            id: n.leafIds[i],
            data: n.leafRows[i],
            group: false,
            level: n.level + 1,
            expanded: false,
            key: '',
            field: '',
            childCount: 0,
            aggData: {},
            groupId: null,
          });
        }
      }
      if (totalPos === 'bottom') out.push(footerFor(n));
    }
  };

  walk(roots);
  return out;
}

/** Build a grand-total footer node aggregating all roots. */
export function buildGrandTotalNode<TData>(
  roots: GroupNode<TData>[],
  aggCols: AggColSpec[],
  customAggFuncs?: Record<string, AggFunc>,
): DisplayedNode<TData> | null {
  if (!aggCols.length || !roots.length) return null;
  const aggData: Record<string, unknown> = {};
  for (const agg of aggCols) {
    const values: unknown[] = [];
    const weights: unknown[] = [];
    const collect = (nodes: GroupNode<TData>[]): void => {
      for (const n of nodes) {
        for (const row of n.leafRows) {
          const v = (row as Record<string, unknown>)[agg.field ?? agg.colId];
          values.push(v);
          if (agg.weightField) {
            weights.push((row as Record<string, unknown>)[agg.weightField]);
          }
        }
        collect(n.children);
      }
    };
    collect(roots);
    const fn = resolveAggFunc(agg.aggFunc, customAggFuncs);
    if (fn) {
      const useWeights = agg.weightField != null || agg.aggFunc === 'weightedAverage';
      const result = useWeights ? fn(values, weights) : fn(values);
      aggData[agg.colId] = result;
      if (agg.field && agg.field !== agg.colId) aggData[agg.field] = result;
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

export const AUTO_GROUP_COL_ID = 'ag-Grid-AutoColumn';
