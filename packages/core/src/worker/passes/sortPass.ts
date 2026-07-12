/**
 * Worker-side sort pass (W3). Field-based comparators only — columns with
 * JS `comparator` or `valueGetter` force main-thread fallback at eligibility.
 */
import type { SortModelItem } from '../../types';
import type { RowStore } from '../rowStore';
import { readField } from '../fieldRead';

export interface WorkerSortCol {
  colId: string;
  field: string;
  type?: 'number' | 'text' | 'date';
}

function compareField(a: unknown, b: unknown, type?: string): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (type === 'number' || (typeof a === 'number' && typeof b === 'number')) {
    return (a as number) - (b as number);
  }
  return String(a).localeCompare(String(b));
}

export class SortPass {
  constructor(private readonly colById: Map<string, WorkerSortCol>) {}

  /** Sort `ids` in place (returns new array) using the sort model. */
  apply(
    store: RowStore,
    ids: string[],
    sortModel: SortModelItem[],
    readRow?: (id: string) => Record<string, unknown>,
  ): string[] {
    if (!sortModel.length) return ids;
    const rowOf = readRow ?? ((id: string) => store.getRow(id)!);
    const sortCols = sortModel
      .map((s) => ({ col: this.colById.get(s.colId), dir: s.sort === 'asc' ? 1 : -1 }))
      .filter((x): x is { col: WorkerSortCol; dir: number } => !!x.col);
    if (!sortCols.length) return ids;

    const orderIndex = new Map<string, number>();
    for (let i = 0; i < ids.length; i++) orderIndex.set(ids[i], i);

    return ids.slice().sort((idA, idB) => {
      const rowA = rowOf(idA);
      const rowB = rowOf(idB);
      if (!rowA || !rowB) return 0;
      for (const { col, dir } of sortCols) {
        const cmp = compareField(readField(rowA, col.field), readField(rowB, col.field), col.type);
        if (cmp !== 0) return cmp * dir;
      }
      return (orderIndex.get(idA) ?? 0) - (orderIndex.get(idB) ?? 0);
    });
  }
}
