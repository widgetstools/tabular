/**
 * Worker-side group + aggregate + flatten pass (W4). Field-based columns
 * only; built-in string agg funcs. Output is a flat display descriptor list
 * the main thread maps back to live row objects by id.
 */
import { AGG_FUNCS, type AggFuncName } from '../../aggregation';
import { workerGroupKey } from '../protocol';
import type { RowStore } from '../rowStore';

export interface WorkerGroupCol {
  colId: string;
  field: string;
}

export interface WorkerAggCol {
  colId: string;
  field: string;
  aggFunc: AggFuncName;
  weightField?: string;
}

export interface GroupNode {
  id: string;
  key: string;
  field: string;
  level: number;
  expanded: boolean;
  children: GroupNode[];
  leafIds: string[];
  childCount: number;
  aggData: Record<string, unknown>;
}

/** Serializable display row descriptor (main maps ids → live objects). */
export interface WorkerDisplayEntry {
  id: string;
  kind: 'leaf' | 'group' | 'footer' | 'grandTotal';
  level: number;
  expanded: boolean;
  key: string;
  field: string;
  childCount: number;
  groupId: string | null;
  aggData: Record<string, unknown>;
}

export interface GroupPassOptions {
  groupCols: WorkerGroupCol[];
  aggCols: WorkerAggCol[];
  groupDefaultExpanded: number;
  expandedState: Array<[string, boolean]>;
  groupTotalRow?: 'top' | 'bottom';
  groupSuppressBlankHeader?: boolean;
  grandTotalRow?: 'top' | 'bottom';
  suppressLeafRows?: boolean;
}

export class GroupPass {
  apply(
    store: RowStore,
    ids: string[],
    opts: GroupPassOptions,
    readRow?: (id: string) => Record<string, unknown>,
  ): WorkerDisplayEntry[] {
    const rowOf = readRow ?? ((id: string) => store.getRow(id)!);
    if (!opts.groupCols.length) {
      return ids.map((id) => ({
        id,
        kind: 'leaf' as const,
        level: 0,
        expanded: false,
        key: '',
        field: '',
        childCount: 0,
        groupId: null,
        aggData: {},
      }));
    }

    const expanded = new Map<string, boolean>(opts.expandedState);

    const roots = this.buildTree(rowOf, ids, opts.groupCols, expanded, opts.groupDefaultExpanded);
    this.aggregateRoots(roots, rowOf, opts.aggCols);

    const out = this.flatten(roots, opts);
    if (opts.grandTotalRow && roots.length) {
      const grand = this.grandTotal(rowOf, roots, opts.aggCols);
      if (opts.grandTotalRow === 'top') out.unshift(grand);
      else out.push(grand);
    }
    return out;
  }

  /** Build group tree without aggregating or flattening (for PivotPass). */
  buildTreeOnly(
    store: RowStore,
    ids: string[],
    opts: Pick<GroupPassOptions, 'groupCols' | 'groupDefaultExpanded' | 'expandedState'>,
    readRow?: (id: string) => Record<string, unknown>,
  ): GroupNode[] {
    const rowOf = readRow ?? ((id: string) => store.getRow(id)!);
    const expanded = new Map<string, boolean>(opts.expandedState);
    return this.buildTree(rowOf, ids, opts.groupCols, expanded, opts.groupDefaultExpanded);
  }

  aggregateRoots(
    roots: GroupNode[],
    rowOf: (id: string) => Record<string, unknown>,
    aggCols: WorkerAggCol[],
  ): void {
    this.aggregate(roots, rowOf, aggCols);
  }

  flattenRoots(roots: GroupNode[], opts: GroupPassOptions): WorkerDisplayEntry[] {
    return this.flatten(roots, opts);
  }

  private buildTree(
    rowOf: (id: string) => Record<string, unknown>,
    ids: string[],
    groupCols: WorkerGroupCol[],
    expandedState: Map<string, boolean>,
    groupDefaultExpanded: number,
  ): GroupNode[] {
    const rootChildren: GroupNode[] = [];
    const rootMap = new Map<string, GroupNode>();

    for (const rowId of ids) {
      const row = rowOf(rowId);
      if (!row) continue;
      let parentChildren = rootChildren;
      let parentMap = rootMap;
      let path = '';

      for (let level = 0; level < groupCols.length; level++) {
        const spec = groupCols[level];
        const key = workerGroupKey(row[spec.field]);
        path = path ? `${path}/${key}` : key;
        const id = `g:${spec.colId}:${path}`;

        let node = parentMap.get(key);
        if (!node) {
          const defaultOpen = groupDefaultExpanded === -1 || level < groupDefaultExpanded;
          node = {
            id,
            key,
            field: spec.field,
            level,
            expanded: expandedState.has(id) ? expandedState.get(id)! : defaultOpen,
            children: [],
            leafIds: [],
            childCount: 0,
            aggData: {},
          };
          parentChildren.push(node);
          parentMap.set(key, node);
        }

        if (level === groupCols.length - 1) node.leafIds.push(rowId);

        parentChildren = node.children;
        parentMap = new Map(node.children.map((c) => [c.key, c]));
      }
    }

    const recount = (nodes: GroupNode[]): number => {
      let total = 0;
      for (const n of nodes) {
        const childLeaves = recount(n.children);
        n.childCount = n.leafIds.length + childLeaves;
        total += n.childCount;
      }
      return total;
    };
    recount(rootChildren);
    return rootChildren;
  }

  private aggregate(
    roots: GroupNode[],
    rowOf: (id: string) => Record<string, unknown>,
    aggCols: WorkerAggCol[],
  ): void {
    const walk = (node: GroupNode): void => {
      for (const ch of node.children) walk(ch);
      for (const agg of aggCols) {
        const fn = AGG_FUNCS[agg.aggFunc];
        if (!fn) continue;
        const values: unknown[] = [];
        const weights: unknown[] = [];
        const collect = (n: GroupNode): void => {
          for (const id of n.leafIds) {
            const row = rowOf(id);
            if (!row) continue;
            values.push(row[agg.field]);
            if (agg.weightField) weights.push(row[agg.weightField]);
          }
          for (const ch of n.children) collect(ch);
        };
        collect(node);
        const useWeights = agg.weightField != null || agg.aggFunc === 'weightedAverage';
        const result = useWeights ? fn(values, weights) : fn(values);
        node.aggData[agg.colId] = result;
        if (agg.field !== agg.colId) node.aggData[agg.field] = result;
      }
    };
    for (const r of roots) walk(r);
  }

  private flatten(roots: GroupNode[], opts: GroupPassOptions): WorkerDisplayEntry[] {
    const out: WorkerDisplayEntry[] = [];
    const totalPos = opts.groupTotalRow;
    const suppressLeaf = opts.suppressLeafRows === true;
    const blankHeader = opts.groupSuppressBlankHeader !== true;

    const footerFor = (n: GroupNode): WorkerDisplayEntry => ({
      id: `${n.id}:footer`,
      kind: 'footer',
      level: n.level + 1,
      expanded: false,
      key: n.key ? `Total ${n.key}` : 'Total',
      field: n.field,
      childCount: 0,
      groupId: null,
      aggData: { ...n.aggData },
    });

    const walk = (nodes: GroupNode[]): void => {
      for (const n of nodes) {
        const expandable = n.children.length > 0 || !suppressLeaf;
        const blank = n.expanded && totalPos !== undefined && blankHeader;
        out.push({
          id: n.id,
          kind: 'group',
          level: n.level,
          expanded: n.expanded,
          key: n.key,
          field: n.field,
          childCount: n.childCount,
          groupId: expandable ? n.id : null,
          aggData: blank ? {} : { ...n.aggData },
        });
        if (!n.expanded) continue;
        if (totalPos === 'top') out.push(footerFor(n));
        walk(n.children);
        if (!suppressLeaf) {
          for (const id of n.leafIds) {
            out.push({
              id,
              kind: 'leaf',
              level: n.level + 1,
              expanded: false,
              key: '',
              field: '',
              childCount: 0,
              groupId: null,
              aggData: {},
            });
          }
        }
        if (totalPos === 'bottom') out.push(footerFor(n));
      }
    };
    walk(roots);
    return out;
  }

  private grandTotal(
    rowOf: (id: string) => Record<string, unknown>,
    roots: GroupNode[],
    aggCols: WorkerAggCol[],
  ): WorkerDisplayEntry {
    const leafIds: string[] = [];
    const gather = (nodes: GroupNode[]): void => {
      for (const n of nodes) {
        leafIds.push(...n.leafIds);
        gather(n.children);
      }
    };
    gather(roots);

    const aggData: Record<string, unknown> = {};
    for (const agg of aggCols) {
      const fn = AGG_FUNCS[agg.aggFunc];
      if (!fn) continue;
      const values: unknown[] = [];
      const weights: unknown[] = [];
      for (const id of leafIds) {
        const row = rowOf(id);
        if (!row) continue;
        values.push(row[agg.field]);
        if (agg.weightField) weights.push(row[agg.weightField]);
      }
      const useWeights = agg.weightField != null || agg.aggFunc === 'weightedAverage';
      const result = useWeights ? fn(values, weights) : fn(values);
      aggData[agg.colId] = result;
      if (agg.field !== agg.colId) aggData[agg.field] = result;
    }

    return {
      id: 'grand-total',
      kind: 'grandTotal',
      level: 0,
      expanded: false,
      key: 'Grand Total',
      field: '',
      childCount: leafIds.length,
      groupId: null,
      aggData,
    };
  }
}
