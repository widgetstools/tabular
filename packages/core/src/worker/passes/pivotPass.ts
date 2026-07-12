/**
 * Worker-side pivot aggregation (field-based). Discovers pivot key paths from
 * filtered rows, writes pivot result cells into group aggData, and builds
 * grand-total pivot aggregates. Uses shared pivotResultColId encoding.
 */
import { AGG_FUNCS } from '../../aggregation';
import { pivotResultColId } from '../../pivot';
import { workerGroupKey, type WorkerAggFuncName } from '../protocol';
import { readField } from '../fieldRead';

export interface WorkerPivotCol {
  colId: string;
  field: string;
}

export interface WorkerValueCol {
  colId: string;
  field: string;
  aggFunc: WorkerAggFuncName;
  weightField?: string;
}

/** Minimal group node shape consumed from GroupPass. */
export interface PivotGroupNode {
  children: PivotGroupNode[];
  leafIds: string[];
  aggData: Record<string, unknown>;
}

function rowMatchesPivotKeys(
  row: Record<string, unknown>,
  pivotCols: WorkerPivotCol[],
  pivotKeys: string[],
): boolean {
  for (let level = 0; level < pivotCols.length; level++) {
    if (workerGroupKey(readField(row, pivotCols[level]!.field)) !== pivotKeys[level]) return false;
  }
  return true;
}

export class PivotPass {
  /** Unique pivot key paths present in filtered data, sorted lexicographically. */
  collectKeyPaths(
    ids: string[],
    pivotCols: WorkerPivotCol[],
    readRow: (id: string) => Record<string, unknown>,
  ): string[][] {
    if (!pivotCols.length || !ids.length) return [];

    const seen = new Set<string>();
    const paths: string[][] = [];

    for (const id of ids) {
      const row = readRow(id);
      if (!row) continue;
      const path = pivotCols.map((c) => workerGroupKey(readField(row, c.field)));
      const key = path.map((k) => encodeURIComponent(k)).join('|');
      if (!seen.has(key)) {
        seen.add(key);
        paths.push(path);
      }
    }

    paths.sort((a, b) => {
      for (let level = 0; level < a.length; level++) {
        const c = a[level]!.localeCompare(b[level]!);
        if (c !== 0) return c;
      }
      return 0;
    });
    return paths;
  }

  /** Write pivot result col aggregations into each group node's aggData. */
  apply(
    roots: PivotGroupNode[],
    pivotCols: WorkerPivotCol[],
    valueCols: WorkerValueCol[],
    pivotKeyPaths: string[][],
    readRow: (id: string) => Record<string, unknown>,
  ): void {
    if (!pivotKeyPaths.length || !valueCols.length) return;

    const walk = (node: PivotGroupNode): void => {
      for (const ch of node.children) walk(ch);

      for (const path of pivotKeyPaths) {
        for (const agg of valueCols) {
          const fn = AGG_FUNCS[agg.aggFunc];
          if (!fn) continue;
          const values: unknown[] = [];
          const weights: unknown[] = [];

          const collect = (n: PivotGroupNode): void => {
            for (const rowId of n.leafIds) {
              const row = readRow(rowId);
              if (!row || !rowMatchesPivotKeys(row, pivotCols, path)) continue;
              values.push(readField(row, agg.field));
              if (agg.weightField) weights.push(readField(row, agg.weightField));
            }
            for (const ch of n.children) collect(ch);
          };
          collect(node);

          const useWeights = agg.weightField != null || agg.aggFunc === 'weightedAverage';
          node.aggData[pivotResultColId(path, agg.colId)] = useWeights
            ? fn(values, weights)
            : fn(values);
        }
      }
    };

    for (const r of roots) walk(r);
  }

  /** Grand-total aggData keyed by pivot result col ids. */
  grandTotalAggData(
    roots: PivotGroupNode[],
    pivotCols: WorkerPivotCol[],
    valueCols: WorkerValueCol[],
    pivotKeyPaths: string[][],
    readRow: (id: string) => Record<string, unknown>,
  ): Record<string, unknown> {
    const aggData: Record<string, unknown> = {};
    if (!pivotKeyPaths.length || !valueCols.length || !roots.length) return aggData;

    for (const path of pivotKeyPaths) {
      for (const agg of valueCols) {
        const fn = AGG_FUNCS[agg.aggFunc];
        if (!fn) continue;
        const values: unknown[] = [];
        const weights: unknown[] = [];

        const collect = (nodes: PivotGroupNode[]): void => {
          for (const n of nodes) {
            for (const rowId of n.leafIds) {
              const row = readRow(rowId);
              if (!row || !rowMatchesPivotKeys(row, pivotCols, path)) continue;
              values.push(readField(row, agg.field));
              if (agg.weightField) weights.push(readField(row, agg.weightField));
            }
            collect(n.children);
          }
        };
        collect(roots);

        const useWeights = agg.weightField != null || agg.aggFunc === 'weightedAverage';
        aggData[pivotResultColId(path, agg.colId)] = useWeights
          ? fn(values, weights)
          : fn(values);
      }
    }
    return aggData;
  }
}
