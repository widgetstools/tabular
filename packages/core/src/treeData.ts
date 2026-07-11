/**
 * Tree data (plan §4.14). Not row grouping with a different key source:
 * tree nodes are real rows (a folder IS a record); only synthesized
 * "filler" nodes for missing path segments carry no data.
 *
 * Two supply modes normalize to one TreeNode shape:
 *  - flat rows + `getDataPath(data) => string[]` (fillers for gaps)
 *  - nested rows via `childrenField` (hierarchy intrinsic, no fillers)
 */
import type { AggFunc, AggFuncName } from './aggregation';
import { resolveAggFunc } from './aggregation';
import type { InternalColumn } from './columnModel';
import type { AggColSpec, DisplayedNode } from './grouping';

export interface TreeNode<TData = unknown> {
  id: string;
  /** Path segment / key — what the auto group column renders. */
  key: string;
  level: number;
  /** Real row, or null for a synthesized filler node. */
  data: TData | null;
  children: TreeNode<TData>[];
  parent: TreeNode<TData> | null;
  /** Descendant count (all levels). */
  childCount: number;
  aggData: Record<string, unknown>;
}

export interface TreeRefreshOptions<TData = unknown> {
  getDataPath?: (data: TData) => string[];
  childrenField?: string;
  /**
   * Field whose value the auto group column displays for data-bearing nodes
   * (AG Grid `autoGroupColumnDef.field`). Fillers still show the path key.
   */
  keyField?: string;
  aggCols: AggColSpec[];
  groupDefaultExpanded: number;
  /** true: only matching nodes survive (ancestors kept as context). */
  excludeChildrenWhenTreeDataFiltering: boolean;
  customAggFuncs?: Record<string, AggFunc>;
}

type ValueOf<TData> = (row: TData, col: InternalColumn<TData>, rowIndex: number) => unknown;
type GetCol<TData> = { getColumn: (id: string) => InternalColumn<TData> | undefined };

export function buildTree<TData>(
  rows: TData[],
  opts: TreeRefreshOptions<TData>,
  getId: (row: TData) => string,
): TreeNode<TData>[] {
  return opts.childrenField
    ? buildFromNested(rows, opts.childrenField, opts.keyField, getId)
    : buildFromPaths(rows, opts.getDataPath!, opts.keyField, getId);
}

function buildFromPaths<TData>(
  rows: TData[],
  getDataPath: (data: TData) => string[],
  keyField: string | undefined,
  getId: (row: TData) => string,
): TreeNode<TData>[] {
  const roots: TreeNode<TData>[] = [];
  const byPath = new Map<string, TreeNode<TData>>();

  const ensure = (path: string[], upto: number, parent: TreeNode<TData> | null): TreeNode<TData> => {
    const joined = path.slice(0, upto + 1).join('\u0000');
    let node = byPath.get(joined);
    if (!node) {
      node = {
        id: `t:${joined}`,
        key: path[upto],
        level: upto,
        data: null,
        children: [],
        parent,
        childCount: 0,
        aggData: {},
      };
      byPath.set(joined, node);
      (parent ? parent.children : roots).push(node);
    }
    return node;
  };

  for (const row of rows) {
    const path = getDataPath(row);
    if (!path.length) continue;
    let parent: TreeNode<TData> | null = null;
    for (let d = 0; d < path.length - 1; d++) parent = ensure(path, d, parent);
    const node = ensure(path, path.length - 1, parent);
    // Attach the real row; a previously synthesized filler is upgraded.
    node.data = row;
    node.id = getId(row);
    if (keyField) {
      const v = (row as Record<string, unknown>)[keyField];
      if (v != null) node.key = String(v);
    }
  }
  recount(roots);
  return roots;
}

function buildFromNested<TData>(
  rows: TData[],
  childrenField: string,
  keyField: string | undefined,
  getId: (row: TData) => string,
): TreeNode<TData>[] {
  const walk = (list: TData[], level: number, parent: TreeNode<TData> | null): TreeNode<TData>[] =>
    list.map((row) => {
      const rec = row as Record<string, unknown>;
      const node: TreeNode<TData> = {
        id: getId(row),
        key: keyField ? String(rec[keyField] ?? '') : '',
        level,
        data: row,
        children: [],
        parent,
        childCount: 0,
        aggData: {},
      };
      const kids = rec[childrenField];
      if (Array.isArray(kids) && kids.length) {
        node.children = walk(kids as TData[], level + 1, node);
      }
      return node;
    });
  const roots = walk(rows, 0, null);
  recount(roots);
  return roots;
}

/** Returns total node count (nodes + all descendants); sets childCount. */
function recount<TData>(nodes: TreeNode<TData>[]): number {
  let total = 0;
  for (const n of nodes) {
    n.childCount = recount(n.children);
    total += 1 + n.childCount;
  }
  return total;
}

/**
 * Two-pass tree filter (plan §4.14): a node survives when it matches, has a
 * matching descendant (kept as reachable context), or — unless
 * excludeChildren — has a matching ancestor.
 */
export function filterTree<TData>(
  roots: TreeNode<TData>[],
  pass: (node: TreeNode<TData>) => boolean,
  excludeChildren: boolean,
): TreeNode<TData>[] {
  const prune = (nodes: TreeNode<TData>[], ancestorMatched: boolean): TreeNode<TData>[] => {
    const out: TreeNode<TData>[] = [];
    for (const n of nodes) {
      const selfMatch = pass(n);
      const keepByAncestor = ancestorMatched && !excludeChildren;
      const children = prune(n.children, ancestorMatched || selfMatch);
      if (selfMatch || keepByAncestor || children.length) {
        out.push({ ...n, children });
      }
    }
    return out;
  };
  const pruned = prune(roots, false);
  recount(pruned);
  return pruned;
}

/** Sort siblings recursively; the hierarchy itself never changes. */
export function sortTree<TData>(
  roots: TreeNode<TData>[],
  cmp: (a: TreeNode<TData>, b: TreeNode<TData>) => number,
): void {
  const walk = (nodes: TreeNode<TData>[]): void => {
    nodes.sort(cmp);
    for (const n of nodes) walk(n.children);
  };
  walk(roots);
}

/**
 * Aggregate over descendant *leaves* (nodes without children). Weighted
 * averages weight by leaf values so parents never double-count (§4.14).
 */
export function aggregateTreeData<TData>(
  roots: TreeNode<TData>[],
  aggCols: AggColSpec[],
  valueOf: ValueOf<TData>,
  cols: GetCol<TData>,
  customAggFuncs?: Record<string, AggFunc>,
): void {
  if (!aggCols.length) return;

  const walk = (node: TreeNode<TData>): void => {
    for (const ch of node.children) walk(ch);
    if (!node.children.length) return; // leaves show their own values

    for (const agg of aggCols) {
      const fn = resolveAggFunc(agg.aggFunc as AggFuncName | AggFunc, customAggFuncs);
      if (!fn) continue;
      const col = cols.getColumn(agg.colId);
      const values: unknown[] = [];
      const weights: unknown[] = [];
      const collect = (n: TreeNode<TData>): void => {
        if (!n.children.length) {
          if (n.data != null) {
            values.push(
              col
                ? valueOf(n.data, col, 0)
                : (n.data as Record<string, unknown>)[agg.field ?? agg.colId],
            );
            if (agg.weightField) {
              weights.push((n.data as Record<string, unknown>)[agg.weightField]);
            }
          }
          return;
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

export function flattenTree<TData>(
  roots: TreeNode<TData>[],
  expandedState: Map<string, boolean>,
  groupDefaultExpanded: number,
): DisplayedNode<TData>[] {
  const out: DisplayedNode<TData>[] = [];
  const walk = (nodes: TreeNode<TData>[]): void => {
    for (const n of nodes) {
      const isParent = n.children.length > 0;
      const defaultOpen = groupDefaultExpanded === -1 || n.level < groupDefaultExpanded;
      const expanded = isParent
        ? expandedState.has(n.id)
          ? expandedState.get(n.id)!
          : defaultOpen
        : false;
      out.push({
        id: n.id,
        data: n.data,
        group: isParent,
        level: n.level,
        expanded,
        key: n.key,
        field: '',
        childCount: n.childCount,
        aggData: n.aggData,
        groupId: isParent ? n.id : null,
      });
      if (isParent && expanded) walk(n.children);
    }
  };
  walk(roots);
  return out;
}
