/**
 * Worker-side rules evaluation. Compiles RulesConfig on the worker and
 * evaluates after each model rebuild / transaction; results ship with
 * modelUpdated for main-thread materialization.
 */
import {
  compileRulesBundle,
  evaluateStaticRules,
  evaluateTransactionDelta,
  type CompiledRulesBundle,
  type RulesEvalResult,
} from '@tabular/rules';
import type { AggTransactionPayload } from '../protocol';
import type { DataPipeline } from '../pipeline';

export interface WorkerRulesConfigPayload {
  style?: import('@tabular/rules').StyleRule[];
  alerts?: import('@tabular/rules').AlertRule[];
  fieldToColId: Record<string, string>;
}

export class RulesPass {
  private bundle: CompiledRulesBundle | null = null;
  private fieldToColId: Record<string, string> = {};
  private lastTx: AggTransactionPayload | null = null;

  setConfig(payload: WorkerRulesConfigPayload | null): void {
    if (!payload) {
      this.bundle = null;
      this.fieldToColId = {};
      return;
    }
    this.fieldToColId = payload.fieldToColId;
    this.bundle = compileRulesBundle({ style: payload.style, alerts: payload.alerts });
  }

  noteTransaction(tx: AggTransactionPayload): void {
    this.lastTx = tx;
  }

  /** Evaluate after pipeline.rebuild(); clears lastTx. */
  evaluate(pipeline: DataPipeline): RulesEvalResult | null {
    if (!this.bundle) return null;
    const fieldMap = this.fieldToColId;
    const getRow = (id: string) => pipeline.getRow(id);

    const tx = this.lastTx;
    this.lastTx = null;

    if (tx) {
      const updates: Array<{
        rowId: string;
        data: Record<string, unknown>;
        changes: Array<{ key: string; oldValue: unknown; newValue: unknown }>;
      }> = [];
      const updateIds = tx.updateIds ?? [];
      const updateRows = tx.update ?? [];
      for (let i = 0; i < updateIds.length; i++) {
        const rowId = updateIds[i]!;
        const next = (updateRows[i] ?? getRow(rowId)) as Record<string, unknown> | undefined;
        if (!next) continue;
        const changes: Array<{ key: string; oldValue: unknown; newValue: unknown }> = [];
        for (const key of Object.keys(next)) {
          const newValue = next[key];
          const oldValue = pipeline.getPrevValue(rowId, key);
          if (oldValue !== newValue) {
            changes.push({ key, oldValue, newValue });
          }
        }
        const data = getRow(rowId) ?? next;
        updates.push({ rowId, data, changes });
      }

      return evaluateTransactionDelta(
        this.bundle,
        updates,
        tx.addIds ?? [],
        tx.removeIds ?? [],
        getRow,
        fieldMap,
      );
    }

    const staticRows = displayedLeafRows(pipeline);
    return evaluateStaticRules(this.bundle, staticRows, fieldMap);
  }
}

function displayedLeafRows(
  pipeline: DataPipeline,
): Array<{ rowId: string; row: Record<string, unknown> }> {
  const out: Array<{ rowId: string; row: Record<string, unknown> }> = [];
  for (const entry of pipeline.displayed) {
    if (entry.kind !== 'leaf') continue;
    const row = pipeline.getRow(entry.id);
    if (row) out.push({ rowId: entry.id, row });
  }
  return out;
}
