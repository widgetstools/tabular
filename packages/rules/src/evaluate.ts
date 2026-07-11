/**
 * Pure rule evaluation — shared by main-thread RulesEngine and the worker
 * RulesPass. Produces serializable match/alert candidates; materialization
 * (active map, flash, AlertManager) stays on the consumer side.
 */
import {
  compileAlertRules,
  compileStyleRules,
  evalRuleCondition,
  type CompiledAlertRule,
  type CompiledStyleRule,
} from './compile';
import { buildDeltaRow } from './deltaTransform';
import type {
  AlertSeverity,
  RuleCellStyle,
  RuleFlashMode,
  RuleIndicator,
  RulesConfig,
} from './types';

export interface StyleMatchResult {
  rowId: string;
  colId: string;
  ruleId: string;
  priority: number;
  style: RuleCellStyle;
  activeDurationMs?: number;
  flash?: RuleFlashMode;
  indicator?: RuleIndicator;
  flashDir?: 1 | -1 | 0;
}

export interface StyleRemoveResult {
  rowId: string;
  colId: string;
  ruleId: string;
}

export interface AlertCandidate {
  ruleId: string;
  rowId: string;
  message: string;
  severity: AlertSeverity;
  debounceMs: number;
  /** Row snapshot for onAlert when the main-thread mirror is dropped. */
  data: Record<string, unknown>;
}

export interface RulesEvalResult {
  styleUpserts: StyleMatchResult[];
  styleRemoves: StyleRemoveResult[];
  rowRemoves: string[];
  alertCandidates: AlertCandidate[];
  /** When true, consumer should clear prior static (non-delta) matches first. */
  staticPass?: boolean;
}

export interface CompiledRulesBundle {
  style: CompiledStyleRule[];
  alerts: CompiledAlertRule[];
}

export function compileRulesBundle(config: RulesConfig | undefined): CompiledRulesBundle {
  return {
    style: compileStyleRules(config?.style),
    alerts: compileAlertRules(config?.alerts),
  };
}

export function resolveColId(
  rule: { targetColId?: string; targetField?: string },
  fieldToColId: ReadonlyMap<string, string> | Record<string, string>,
): string | undefined {
  if (rule.targetColId) return rule.targetColId;
  if (!rule.targetField) return undefined;
  if (fieldToColId instanceof Map) return fieldToColId.get(rule.targetField);
  return (fieldToColId as Record<string, string>)[rule.targetField];
}

function flashDirFromRow(row: Record<string, unknown>, field?: string): 1 | -1 | 0 {
  if (!field) return 0;
  const delta = row.__tabularDelta as Record<string, { old: unknown; new: unknown }> | undefined;
  const bag = delta?.[field];
  if (!bag || typeof bag.old !== 'number' || typeof bag.new !== 'number') return 0;
  return bag.new > bag.old ? 1 : bag.new < bag.old ? -1 : 0;
}

function pushStyleMatch(
  out: StyleMatchResult[],
  rule: CompiledStyleRule,
  rowId: string,
  row: Record<string, unknown>,
  fieldToColId: ReadonlyMap<string, string> | Record<string, string>,
): void {
  const colId = resolveColId(rule, fieldToColId);
  if (!colId) return;
  out.push({
    rowId,
    colId,
    ruleId: rule.id,
    priority: rule.priority,
    style: rule.style,
    activeDurationMs: rule.activeDurationMs,
    flash: rule.flash,
    indicator: rule.indicator,
    flashDir: rule.flash ? flashDirFromRow(row, rule.targetField) : undefined,
  });
}

/** Evaluate non-delta rules over a set of displayed leaf rows. */
export function evaluateStaticRules(
  bundle: CompiledRulesBundle,
  rows: ReadonlyArray<{ rowId: string; row: Record<string, unknown> }>,
  fieldToColId: ReadonlyMap<string, string> | Record<string, string>,
): RulesEvalResult {
  const styleUpserts: StyleMatchResult[] = [];
  const alertCandidates: AlertCandidate[] = [];
  const staticStyle = bundle.style.filter((r) => !r.usesDelta && !r.compileError);
  const staticAlert = bundle.alerts.filter(
    (r) => !r.usesDelta && r.trigger !== 'rowChange' && !r.compileError,
  );
  if (!staticStyle.length && !staticAlert.length) {
    return { styleUpserts, styleRemoves: [], rowRemoves: [], alertCandidates, staticPass: true };
  }

  for (const { rowId, row } of rows) {
    for (const rule of staticStyle) {
      if (evalRuleCondition(rule.run, row)) {
        pushStyleMatch(styleUpserts, rule, rowId, row, fieldToColId);
      }
    }
    for (const rule of staticAlert) {
      if (evalRuleCondition(rule.run, row)) {
        alertCandidates.push({
          ruleId: rule.id,
          rowId,
          message: rule.message,
          severity: rule.severity ?? 'warn',
          debounceMs: rule.debounceMs,
          data: row,
        });
      }
    }
  }

  return {
    styleUpserts,
    styleRemoves: [],
    rowRemoves: [],
    alertCandidates,
    staticPass: true,
  };
}

export interface DeltaUpdate {
  rowId: string;
  data: Record<string, unknown>;
  changes: ReadonlyArray<{ key: string; oldValue: unknown; newValue: unknown }>;
}

function ruleIntersects(watched: ReadonlySet<string>, changed: ReadonlySet<string>): boolean {
  if (!watched.size) return true;
  for (const f of watched) {
    if (changed.has(f)) return true;
  }
  return false;
}

/** Evaluate delta / relativeChange / rowChange rules for a transaction. */
export function evaluateTransactionDelta(
  bundle: CompiledRulesBundle,
  updates: ReadonlyArray<DeltaUpdate>,
  addedIds: readonly string[],
  removedIds: readonly string[],
  getRow: (id: string) => Record<string, unknown> | undefined,
  fieldToColId: ReadonlyMap<string, string> | Record<string, string>,
): RulesEvalResult {
  const styleUpserts: StyleMatchResult[] = [];
  const styleRemoves: StyleRemoveResult[] = [];
  const alertCandidates: AlertCandidate[] = [];
  const rowRemoves = [...removedIds];

  const deltaStyle = bundle.style.filter((r) => r.usesDelta && !r.compileError);
  const deltaAlert = bundle.alerts.filter(
    (r) => (r.usesDelta || r.trigger === 'relativeChange') && !r.compileError,
  );
  const rowChangeAlerts = bundle.alerts.filter((r) => r.trigger === 'rowChange' && !r.compileError);

  for (const id of addedIds) {
    const data = getRow(id);
    if (!data) continue;
    for (const rule of rowChangeAlerts) {
      if (evalRuleCondition(rule.run, data)) {
        alertCandidates.push({
          ruleId: rule.id,
          rowId: id,
          message: rule.message,
          severity: rule.severity ?? 'warn',
          debounceMs: rule.debounceMs,
          data,
        });
      }
    }
  }

  for (const upd of updates) {
    const changedKeys = new Set(upd.changes.map((c) => c.key));
    const row = buildDeltaRow(upd.data, upd.changes);

    for (const rule of deltaStyle) {
      if (!ruleIntersects(rule.watchedFields, changedKeys)) continue;
      const colId = resolveColId(rule, fieldToColId);
      if (!colId) continue;
      if (evalRuleCondition(rule.run, row)) {
        pushStyleMatch(styleUpserts, rule, upd.rowId, row, fieldToColId);
      } else {
        styleRemoves.push({ rowId: upd.rowId, colId, ruleId: rule.id });
      }
    }

    for (const rule of deltaAlert) {
      if (rule.trigger === 'rowChange') continue;
      if (rule.usesDelta && !ruleIntersects(rule.watchedFields, changedKeys)) continue;
      if (evalRuleCondition(rule.run, row)) {
        alertCandidates.push({
          ruleId: rule.id,
          rowId: upd.rowId,
          message: rule.message,
          severity: rule.severity ?? 'warn',
          debounceMs: rule.debounceMs,
          data: upd.data,
        });
      }
    }
  }

  return { styleUpserts, styleRemoves, rowRemoves, alertCandidates };
}
