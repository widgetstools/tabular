/**
 * Worker-side filter pass (W2). Reuses main-thread `passesFilter` /
 * `rowPassesQuickFilter` with field-only value access — columns with
 * `valueGetter` are excluded at eligibility time.
 */
import type { ColumnFilter, FilterModel } from '../../types';
import { passesFilter } from '../../filters';
import type { RowStore } from '../rowStore';
import { readField } from '../fieldRead';

export interface WorkerFilterCol {
  colId: string;
  field: string;
}

export class FilterPass {
  constructor(
    private readonly cols: WorkerFilterCol[],
    private readonly quickTerms: string[],
  ) {}

  /** Return row ids that pass all active filters. */
  apply(
    store: RowStore,
    filterModel: FilterModel,
    readRow?: (id: string) => Record<string, unknown>,
  ): string[] {
    const rowOf = readRow ?? ((id: string) => store.getRow(id)!);
    const filters = this.cols
      .map((c) => ({ col: c, f: filterModel[c.colId] }))
      .filter((x): x is { col: WorkerFilterCol; f: ColumnFilter } => x.f != null);

    const needsFilter = this.quickTerms.length > 0 || filters.length > 0;
    if (!needsFilter) return store.ids();

    const out: string[] = [];
    for (const id of store.ids()) {
      const row = rowOf(id);
      if (!row) continue;
      let pass = true;
      for (const { col, f } of filters) {
        if (!passesFilter(readField(row, col.field), f)) {
          pass = false;
          break;
        }
      }
      if (!pass) continue;
      if (this.quickTerms.length) {
        let hit = true;
        for (const token of this.quickTerms) {
          let tokenHit = false;
          for (const col of this.cols) {
            const v = readField(row, col.field);
            if (v != null && String(v).toLowerCase().includes(token)) {
              tokenHit = true;
              break;
            }
          }
          if (!tokenHit) {
            hit = false;
            break;
          }
        }
        if (!hit) continue;
      }
      out.push(id);
    }
    return out;
  }
}
