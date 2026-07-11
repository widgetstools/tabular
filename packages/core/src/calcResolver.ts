/**
 * Calc column resolution for the grid engine. Compiles `ColDef.calc`
 * expressions defensively — bad expressions never crash the grid.
 */
import { compileCalcColumn, safeEvaluateCalc, type CalcColumnHandle } from '@tabular/calc';
import type { AggSpec } from '@tabular/calc';
import { isWorkerCalcAggFn } from './worker/passes/aggScopePass';
import type { ColDef } from './types';

export type { CalcColumnHandle };

export interface CalcEvalContext {
  rowId?: string;
  aggValues?: ReadonlyArray<number | null>;
  prev?: (field: string) => unknown;
}

export class CalcResolver {
  private handles = new Map<string, CalcColumnHandle>();

  /** Rebuild compiled handles from column defs. Skips cols with valueGetter. */
  rebuild(cols: Array<{ colId: string; def: ColDef }>): void {
    const next = new Map<string, CalcColumnHandle>();
    for (const col of cols) {
      const expr = col.def.calc;
      if (!expr || col.def.valueGetter) continue;
      next.set(col.colId, compileCalcColumn(col.colId, expr));
    }
    this.handles = next;
  }

  has(colId: string): boolean {
    return this.handles.has(colId);
  }

  watchedColIds(colId: string): ReadonlySet<string> {
    return this.handles.get(colId)?.watchedColIds ?? new Set();
  }

  evaluate(colId: string, row: Record<string, unknown>, ctx?: CalcEvalContext): unknown {
    const handle = this.handles.get(colId);
    if (!handle) return undefined;
    return safeEvaluateCalc(
      handle,
      row,
      ctx?.aggValues ?? [],
      ctx?.prev ? (field) => ctx.prev!(field) : null,
    );
  }

  /** All calc column ids currently compiled. */
  calcColIds(): string[] {
    return [...this.handles.keys()];
  }

  allAggSpecs(): AggSpec[] {
    const out: AggSpec[] = [];
    const seen = new Set<number>();
    for (const h of this.handles.values()) {
      for (const spec of h.compiled?.prePass ?? []) {
        if (seen.has(spec.slot)) continue;
        seen.add(spec.slot);
        out.push(spec);
      }
    }
    return out;
  }

  usesPrev(): boolean {
    for (const h of this.handles.values()) {
      if (h.usesPrev) return true;
    }
    return false;
  }

  /** True when every calc column can run on the worker. */
  isWorkerEligible(dataFields: ReadonlySet<string>): boolean {
    for (const handle of this.handles.values()) {
      for (const spec of handle.compiled?.prePass ?? []) {
        if (!isWorkerCalcAggFn(spec.fn)) return false;
      }
      for (const dep of handle.watchedColIds) {
        if (!dataFields.has(dep)) return false;
      }
    }
    return true;
  }

  /** Worker-safe calc specs for the pipeline config. */
  workerCalcCols(): Array<{
    colId: string;
    source: string;
    field: string;
    prePass?: AggSpec[];
    usesPrev?: boolean;
  }> {
    const out: Array<{
      colId: string;
      source: string;
      field: string;
      prePass?: AggSpec[];
      usesPrev?: boolean;
    }> = [];
    for (const [colId, h] of this.handles) {
      if (!h.compiled) continue;
      out.push({
        colId,
        source: h.source,
        field: `__calc:${colId}`,
        prePass: h.compiled.prePass,
        usesPrev: h.usesPrev,
      });
    }
    return out;
  }

  /** Worker-safe calc specs: colId + source + field dependencies. */
  workerSpecs(): Array<{ colId: string; source: string; deps: string[]; type?: 'number' | 'text' }> {
    const out: Array<{ colId: string; source: string; deps: string[]; type?: 'number' | 'text' }> = [];
    for (const [colId, h] of this.handles) {
      if (!h.compiled) continue;
      out.push({
        colId,
        source: h.source,
        deps: [...h.watchedColIds],
        type: h.compiled.cellDataType === 'string' ? 'text' : 'number',
      });
    }
    return out;
  }
}
