/**
 * @tabular/rules — conditional styles, indicators, flash, and alerts.
 */
export { RulesEngine, type ActiveCellRule, type RulesEngineHooks } from './engine';
export { AlertManager } from './alerts';
export {
  compileStyleRules,
  compileAlertRules,
  evalRuleCondition,
  type CompiledStyleRule,
  type CompiledAlertRule,
  type CompiledRule,
} from './compile';
export {
  compileRulesBundle,
  evaluateStaticRules,
  evaluateTransactionDelta,
  resolveColId,
  type AlertCandidate,
  type CompiledRulesBundle,
  type DeltaUpdate,
  type RulesEvalResult,
  type StyleMatchResult,
  type StyleRemoveResult,
} from './evaluate';
export { DELTA_ROOT, buildDeltaRow, transformDeltaRefs, watchedFieldHeads } from './deltaTransform';
export type {
  AlertEvent,
  AlertRateLimit,
  AlertRule,
  AlertSeverity,
  AlertTrigger,
  RuleCellStyle,
  RuleFlashMode,
  RuleIconName,
  RuleIndicator,
  RulesConfig,
  RulesStateData,
  StyleRule,
} from './types';
