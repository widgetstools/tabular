/**
 * Rules engine — evaluates compiled conditions on the RowDelta feed and
 * materializes matched styles into a per-cell active-rule map (paint reads
 * precomputed state; no expression eval at paint time).
 */
import { AlertManager } from './alerts';
import {
  compileAlertRules,
  compileStyleRules,
  type CompiledAlertRule,
  type CompiledStyleRule,
} from './compile';
import {
  evaluateStaticRules,
  evaluateTransactionDelta,
  type RulesEvalResult,
} from './evaluate';
import type {
  AlertEvent,
  RuleIndicator,
  RulesConfig,
  RulesStateData,
  RuleCellStyle,
} from './types';

export interface ActiveCellRule {
  ruleId: string;
  priority: number;
  style: RuleCellStyle;
  matchedAt: number;
  activeDurationMs?: number;
  flash?: 'fade' | 'pulse' | 'glow';
  indicator?: RuleIndicator;
}

export interface RulesEngineHooks<TData = unknown> {
  getColIdForField: (field: string) => string | undefined;
  getFieldForColId: (colId: string) => string | undefined;
  forEachDisplayedRow: (fn: (rowId: string, data: TData) => void) => void;
  onAlert?: (event: AlertEvent<TData>) => void;
  ruleFlash?: (
    key: string,
    opts: { mode: 'fade' | 'pulse' | 'glow'; durationMs: number; dir?: 1 | -1 | 0 },
  ) => void;
  requestPaint?: () => void;
}

export class RulesEngine<TData = unknown> {
  private styleRules: CompiledStyleRule[] = [];
  private alertRules: CompiledAlertRule[] = [];
  private readonly active = new Map<string, ActiveCellRule[]>();
  private readonly alerts: AlertManager<TData>;
  private readonly hooks: RulesEngineHooks<TData>;
  /** When true, skip local eval — worker ships RulesEvalResult instead. */
  workerEval = false;

  constructor(config: RulesConfig | undefined, hooks: RulesEngineHooks<TData>) {
    this.hooks = hooks;
    this.alerts = new AlertManager(config?.alertRateLimit);
    this.rebuild(config);
  }

  rebuild(config: RulesConfig | undefined): void {
    this.styleRules = compileStyleRules(config?.style);
    this.alertRules = compileAlertRules(config?.alerts);
    for (const r of [...this.styleRules, ...this.alertRules]) {
      if (r.compileError) {
        console.warn(`[tabular/rules] rule "${r.id}" compile error: ${r.compileError}`);
      }
    }
    this.active.clear();
    if (!this.workerEval) this.refreshStaticRules();
  }

  getAlertHistory(): readonly AlertEvent<TData>[] {
    return this.alerts.getHistory();
  }

  getIndicator(rowId: string, colId: string): RuleIndicator | undefined {
    const key = cellKey(rowId, colId);
    const rules = this.active.get(key);
    if (!rules?.length) return undefined;
    const sorted = [...rules].sort((a, b) => b.priority - a.priority);
    for (const r of sorted) {
      if (r.indicator) return r.indicator;
    }
    return undefined;
  }

  hasTimedRules(now = performance.now()): boolean {
    for (const rules of this.active.values()) {
      for (const r of rules) {
        if (r.activeDurationMs != null && now - r.matchedAt < r.activeDurationMs) return true;
        if (r.flash) return true;
      }
    }
    return false;
  }

  pruneExpired(now = performance.now()): void {
    let changed = false;
    for (const [key, rules] of this.active) {
      const kept = rules.filter(
        (r) => r.activeDurationMs == null || now - r.matchedAt < r.activeDurationMs,
      );
      if (kept.length !== rules.length) {
        changed = true;
        if (kept.length) this.active.set(key, kept);
        else this.active.delete(key);
      }
    }
    if (changed) this.hooks.requestPaint?.();
  }

  private fieldToColIdMap(): Map<string, string> {
    const m = new Map<string, string>();
    // Build from style/alert target fields via hook.
    for (const rule of this.styleRules) {
      if (rule.targetField) {
        const colId = this.hooks.getColIdForField(rule.targetField);
        if (colId) m.set(rule.targetField, colId);
      }
    }
    for (const rule of this.alertRules) {
      if (rule.targetField) {
        const colId = this.hooks.getColIdForField(rule.targetField);
        if (colId) m.set(rule.targetField, colId);
      }
    }
    return m;
  }

  refreshStaticRules(): void {
    if (this.workerEval) return;
    const rows: Array<{ rowId: string; row: Record<string, unknown> }> = [];
    this.hooks.forEachDisplayedRow((rowId, data) => {
      rows.push({ rowId, row: data as Record<string, unknown> });
    });
    const result = evaluateStaticRules(
      { style: this.styleRules, alerts: this.alertRules },
      rows,
      this.fieldToColIdMap(),
    );
    this.applyEvalResult(result);
  }

  applyTransactionDelta(
    updates: ReadonlyArray<{
      rowId: string;
      data: TData;
      changes: ReadonlyArray<{ key: string; oldValue: unknown; newValue: unknown }>;
    }>,
    addedIds: readonly string[],
    removedIds: readonly string[],
    getRowById: (id: string) => TData | undefined,
  ): void {
    if (this.workerEval) return;
    const result = evaluateTransactionDelta(
      { style: this.styleRules, alerts: this.alertRules },
      updates.map((u) => ({
        rowId: u.rowId,
        data: u.data as Record<string, unknown>,
        changes: u.changes,
      })),
      addedIds,
      removedIds,
      (id) => getRowById(id) as Record<string, unknown> | undefined,
      this.fieldToColIdMap(),
    );
    this.applyEvalResult(result);
  }

  /** Materialize worker-evaluated (or shared) results on the main thread. */
  applyWorkerResults(result: RulesEvalResult): void {
    this.applyEvalResult(result);
  }

  private applyEvalResult(result: RulesEvalResult): void {
    const now = performance.now();

    if (result.staticPass) {
      for (const [key, rules] of this.active) {
        const kept = rules.filter((r) => {
          const def = this.styleRules.find((s) => s.id === r.ruleId);
          return def?.usesDelta;
        });
        if (kept.length !== rules.length) {
          if (kept.length) this.active.set(key, kept);
          else this.active.delete(key);
        }
      }
    }

    for (const id of result.rowRemoves) {
      const prefix = `${id}\u0000`;
      for (const key of [...this.active.keys()]) {
        if (key.startsWith(prefix)) this.active.delete(key);
      }
    }

    for (const rem of result.styleRemoves) {
      const key = cellKey(rem.rowId, rem.colId);
      const list = this.active.get(key);
      if (!list) continue;
      const next = list.filter((r) => r.ruleId !== rem.ruleId);
      if (next.length) this.active.set(key, next);
      else this.active.delete(key);
    }

    for (const m of result.styleUpserts) {
      const key = cellKey(m.rowId, m.colId);
      let list = this.active.get(key);
      if (!list) {
        list = [];
        this.active.set(key, list);
      }
      const entry: ActiveCellRule = {
        ruleId: m.ruleId,
        priority: m.priority,
        style: m.style,
        matchedAt: now,
        activeDurationMs: m.activeDurationMs,
        flash: m.flash,
        indicator: m.indicator,
      };
      const idx = list.findIndex((r) => r.ruleId === m.ruleId);
      if (idx >= 0) list[idx] = entry;
      else list.push(entry);

      if (m.flash && this.hooks.ruleFlash) {
        this.hooks.ruleFlash(key, {
          mode: m.flash,
          durationMs: m.activeDurationMs ?? 500,
          dir: m.flashDir ?? 0,
        });
      }
    }

    for (const a of result.alertCandidates) {
      const event = this.alerts.tryFire({
        ruleId: a.ruleId,
        rowId: a.rowId,
        data: a.data as TData,
        message: a.message,
        severity: a.severity,
        debounceMs: a.debounceMs,
      });
      if (event) this.hooks.onAlert?.(event);
    }

    this.pruneExpired(now);
    this.hooks.requestPaint?.();
  }

  styleResolver = (
    params: { colId: string; rowId: string },
    style: RuleCellStyle,
  ): void => {
    const key = cellKey(params.rowId, params.colId);
    const rules = this.active.get(key);
    if (!rules?.length) return;
    const now = performance.now();
    const sorted = [...rules]
      .filter((r) => r.activeDurationMs == null || now - r.matchedAt < r.activeDurationMs)
      .sort((a, b) => a.priority - b.priority);
    for (const r of sorted) {
      Object.assign(style, r.style);
    }
  };

  getState(): RulesStateData {
    const active: Record<string, string[]> = {};
    for (const [key, rules] of this.active) {
      active[key] = rules.map((r) => r.ruleId);
    }
    return { active };
  }

  restoreState(data: RulesStateData | undefined): void {
    if (!data?.active) return;
    this.active.clear();
    void data;
  }
}

function cellKey(rowId: string, colId: string): string {
  return `${rowId}\u0000${colId}`;
}
