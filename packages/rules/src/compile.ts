/**
 * Compile rule conditions via @tabular/expression.
 */
import {
  compile as compileExpr,
  dependenciesFromAst,
  parse,
  type Compiled,
  type EvalContext,
} from '@tabular/expression';
import { transformDeltaRefs, watchedFieldHeads } from './deltaTransform';
import type { AlertRule, AlertTrigger, StyleRule } from './types';

export interface CompiledStyleRule {
  kind: 'style';
  id: string;
  priority: number;
  run: (ctx: EvalContext) => unknown;
  usesDelta: boolean;
  watchedFields: ReadonlySet<string>;
  targetField?: string;
  targetColId?: string;
  style: StyleRule['style'];
  activeDurationMs?: number;
  flash?: StyleRule['flash'];
  indicator?: StyleRule['indicator'];
  compileError?: string;
}

export interface CompiledAlertRule {
  kind: 'alert';
  id: string;
  run: (ctx: EvalContext) => unknown;
  usesDelta: boolean;
  watchedFields: ReadonlySet<string>;
  trigger: AlertTrigger;
  targetField?: string;
  targetColId?: string;
  message: string;
  severity: AlertRule['severity'];
  debounceMs: number;
  compileError?: string;
}

export type CompiledRule = CompiledStyleRule | CompiledAlertRule;

function compileCondition(
  source: string,
): { ok: true; run: Compiled['run']; usesDelta: boolean; watchedFields: ReadonlySet<string> } | { ok: false; error: string } {
  const parsed = parse(source);
  if (!parsed.ok) return { ok: false, error: parsed.error.message };
  const transformed = transformDeltaRefs(parsed.ast);
  const compiled = compileExpr(transformed.ast);
  if (!compiled.ok) return { ok: false, error: compiled.error.message };
  const deps = dependenciesFromAst(parsed.ast);
  const heads = watchedFieldHeads(deps);
  return {
    ok: true,
    run: compiled.compiled.run,
    usesDelta: transformed.usesDelta,
    watchedFields: new Set(heads),
  };
}

function inferTargetField(
  explicit: string | undefined,
  watched: ReadonlySet<string>,
  usesDelta: boolean,
): string | undefined {
  if (explicit) return explicit;
  if (watched.size === 1) return [...watched][0];
  if (usesDelta && watched.size > 0) return [...watched][0];
  return undefined;
}

export function compileStyleRules(rules: StyleRule[] | undefined): CompiledStyleRule[] {
  if (!rules?.length) return [];
  const out: CompiledStyleRule[] = [];
  for (const rule of rules) {
    const compiled = compileCondition(rule.condition);
    if (!compiled.ok) {
      out.push({
        kind: 'style',
        id: rule.id,
        priority: rule.priority ?? 0,
        run: () => false,
        usesDelta: false,
        watchedFields: new Set(),
        style: rule.style,
        compileError: compiled.error,
      });
      continue;
    }
    out.push({
      kind: 'style',
      id: rule.id,
      priority: rule.priority ?? 0,
      run: compiled.run,
      usesDelta: compiled.usesDelta,
      watchedFields: compiled.watchedFields,
      targetField: inferTargetField(rule.field, compiled.watchedFields, compiled.usesDelta),
      targetColId: rule.colId,
      style: rule.style,
      activeDurationMs: rule.activeDurationMs,
      flash: rule.flash,
      indicator: rule.indicator,
    });
  }
  return out;
}

export function compileAlertRules(rules: AlertRule[] | undefined): CompiledAlertRule[] {
  if (!rules?.length) return [];
  const out: CompiledAlertRule[] = [];
  for (const rule of rules) {
    const compiled = compileCondition(rule.condition);
    const trigger = rule.trigger ?? 'dataChange';
    if (!compiled.ok) {
      out.push({
        kind: 'alert',
        id: rule.id,
        run: () => false,
        usesDelta: false,
        watchedFields: new Set(),
        trigger,
        message: rule.message ?? rule.id,
        severity: rule.severity ?? 'warn',
        debounceMs: rule.debounceMs ?? 0,
        compileError: compiled.error,
      });
      continue;
    }
    if (trigger === 'relativeChange' && !compiled.usesDelta) {
      out.push({
        kind: 'alert',
        id: rule.id,
        run: compiled.run,
        usesDelta: false,
        watchedFields: compiled.watchedFields,
        trigger,
        message: rule.message ?? rule.id,
        severity: rule.severity ?? 'warn',
        debounceMs: rule.debounceMs ?? 0,
        compileError: 'relativeChange requires [field.old]/[field.new] refs',
      });
      continue;
    }
    out.push({
      kind: 'alert',
      id: rule.id,
      run: compiled.run,
      usesDelta: compiled.usesDelta,
      watchedFields: compiled.watchedFields,
      trigger,
      targetField: inferTargetField(rule.field, compiled.watchedFields, compiled.usesDelta),
      targetColId: rule.colId,
      message: rule.message ?? rule.id,
      severity: rule.severity ?? 'warn',
      debounceMs: rule.debounceMs ?? 250,
    });
  }
  return out;
}

/** Safe truthy evaluation — never throws. */
export function evalRuleCondition(
  run: (ctx: EvalContext) => unknown,
  row: Record<string, unknown>,
): boolean {
  try {
    const v = run({ row });
    return !!v;
  } catch {
    return false;
  }
}
