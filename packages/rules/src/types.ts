/**
 * @tabular/rules — conditional styles, indicators, flash, and alerts.
 */

/** Paint attributes written by matched style rules (AG `CellStyle` subset). */
export interface RuleCellStyle {
  color?: string;
  background?: string;
  backgroundColor?: string;
  fontWeight?: number | string;
  fontStyle?: string;
  border?:
    | string
    | Partial<Record<'all' | 'top' | 'bottom' | 'left' | 'right', string>>;
  textDecoration?: string;
  fontSize?: number;
}

/** Lucide icon names supported by rule indicators (subset of core icons). */
export type RuleIconName =
  | 'arrow-up'
  | 'arrow-down'
  | 'alert-triangle'
  | 'trending-down';

export type RuleFlashMode = 'fade' | 'pulse' | 'glow';

export type AlertTrigger = 'dataChange' | 'relativeChange' | 'rowChange';

export type AlertSeverity = 'info' | 'warn' | 'error';

export interface RuleIndicator {
  icon: RuleIconName;
  /** Where to paint the badge. Default `cell`. */
  position?: 'cell' | 'row-start' | 'row-end';
  color?: string;
}

export interface StyleRule {
  id: string;
  condition: string;
  style: RuleCellStyle;
  priority?: number;
  /** Limit to one data field / column. */
  field?: string;
  colId?: string;
  /** Auto-expire matched style after this many ms (uses flash decay clock). */
  activeDurationMs?: number;
  flash?: RuleFlashMode;
  indicator?: RuleIndicator;
}

export interface AlertRule {
  id: string;
  condition: string;
  message?: string;
  severity?: AlertSeverity;
  /** Default `dataChange`. `relativeChange` requires delta refs in the condition. */
  trigger?: AlertTrigger;
  debounceMs?: number;
  field?: string;
  colId?: string;
}

export interface AlertRateLimit {
  /** Max alerts per window. Default 20. */
  tokens?: number;
  /** Refill window in ms. Default 1000. */
  perMs?: number;
}

export interface RulesConfig {
  style?: StyleRule[];
  alerts?: AlertRule[];
  alertRateLimit?: AlertRateLimit;
}

export interface AlertEvent<TData = unknown> {
  ruleId: string;
  rowId: string;
  data: TData;
  message: string;
  severity: AlertSeverity;
  at: number;
}

export interface RulesStateData {
  /** Active style rule ids per cell key (`rowId\0colId`). */
  active: Record<string, string[]>;
}
