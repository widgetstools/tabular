/**
 * Worker calc pass — lazily evaluates `calc` column values into a row overlay
 * before filter/sort/group. Supports aggregate scopes and PREV([field]).
 * Defensive: failed expressions return null and never throw.
 */
import type { AggSpec } from '@tabular/calc';
import { compileCalcColumn, safeEvaluateCalc } from '@tabular/calc';
import type { PrevStore } from '../prevStore';
import type { WorkerCalcCol } from '../protocol';
import { AggScopeResolver } from './aggScopePass';

export type { WorkerCalcCol };

export class CalcPass {
  private handles = new Map<string, ReturnType<typeof compileCalcColumn>>();
  private cols: WorkerCalcCol[] = [];
  private aggSpecs: AggSpec[] = [];
  private aggResolver: AggScopeResolver | null = null;
  private prevStore: PrevStore | null = null;

  setColumns(cols: WorkerCalcCol[]): void {
    this.cols = cols;
    this.handles.clear();
    this.aggSpecs = [];
    const slotSeen = new Set<number>();
    for (const c of cols) {
      if (!c?.colId || !c.source) continue;
      this.handles.set(c.colId, compileCalcColumn(c.colId, c.source));
      for (const spec of c.prePass ?? []) {
        if (slotSeen.has(spec.slot)) continue;
        slotSeen.add(spec.slot);
        this.aggSpecs.push(spec);
      }
    }
  }

  setPrevStore(store: PrevStore | null): void {
    this.prevStore = store;
  }

  setAggResolver(resolver: AggScopeResolver | null): void {
    this.aggResolver = resolver;
  }

  clear(): void {
    this.cols = [];
    this.handles.clear();
    this.aggSpecs = [];
    this.aggResolver = null;
  }

  hasColumns(): boolean {
    return this.cols.length > 0;
  }

  /** Merge overlay values onto a row copy for filter/sort reads. */
  mergedRow(rowId: string, row: Record<string, unknown>): Record<string, unknown> {
    if (!this.cols.length) return row;
    const aggValues = this.aggResolver?.valuesForRow(rowId) ?? [];
    const prev = this.prevStore?.lookup(rowId) ?? null;
    const bag: Record<string, unknown> = {};
    for (const spec of this.cols) {
      const handle = this.handles.get(spec.colId);
      bag[spec.field] = handle ? safeEvaluateCalc(handle, row, aggValues, prev) : null;
    }
    return { ...row, ...bag };
  }
}
