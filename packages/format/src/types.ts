/**
 * @tabular/format — Excel-style format codes, presets, and compile output.
 */

/** Paint attributes a format may contribute (AG `CellStyle` subset). */
export interface FormatCellStyle {
  color?: string;
  background?: string;
  backgroundColor?: string;
  fontWeight?: number | string;
  fontStyle?: string;
  border?: string;
}

/** Optional runtime context for locale-aware formatting. */
export interface FormatContext {
  locale?: string;
  currency?: string;
  /** Wall-clock for relativeTime (ms since epoch). Defaults to Date.now(). */
  now?: number;
}

/**
 * Grid-level formatting options (`GridOptions.formatting`).
 * Presets and ColDef.format codes resolve against this config.
 */
export interface FormatConfig {
  /** Default locale (BCP 47). Falls back to runtime default. */
  locale?: string;
  /** ISO 4217 currency for the `currency` preset. Default `USD`. */
  currency?: string;
  /**
   * Named format overrides / custom presets. Values are Excel format codes
   * or built-in preset names. Consumed by the ext format picker later.
   */
  presets?: Record<string, string>;
}

/** Built-in preset names. */
export type FormatPresetName =
  | 'number'
  | 'currency'
  | 'percent'
  | 'date'
  | 'relativeTime'
  | 'abbreviated';

/**
 * Compiled format closure. Bad codes never throw — `format` falls back to
 * `String(value)` (empty string for null/undefined).
 */
export interface CompiledFormat {
  /** Format a cell value to display text. */
  format(value: unknown, ctx?: FormatContext): string;
  /**
   * Per-value style (section colors like `[Red]` / `[up]`). Prefer this over
   * static `style` when colors differ by positive/negative/zero/text section.
   */
  styleFor(value: unknown): Partial<FormatCellStyle> | undefined;
  /**
   * Static style when the code has a single non-conditional color.
   * Prefer theme token names (`up`, `down`, `accent`, …); raw hex is allowed
   * but discouraged.
   */
  style?: Partial<FormatCellStyle>;
  /** Tier 1 inline icons (painted by the format/composite path). */
  icons?: Array<{ name: string }>;
}

/** One of up to four Excel sections: positive; negative; zero; text. */
export interface FormatSection {
  /** Raw section source (trimmed). */
  raw: string;
  /** Bracket color / theme token, if any. */
  color?: string;
  /** Whether this section is empty (skipped with `;;`). */
  empty: boolean;
  /** Parsed tokens for this section. */
  tokens: FormatToken[];
}

export type FormatToken =
  | { kind: 'literal'; text: string }
  | { kind: 'text' } // `@`
  | { kind: 'percent' }
  | { kind: 'number'; int: DigitPart[]; frac: DigitPart[]; thousands: boolean; scale: number }
  | { kind: 'date'; part: DatePart };

export type DigitPart = '#' | '0' | '?';

export type DatePart =
  | 'yyyy'
  | 'yy'
  | 'mmmm'
  | 'mmm'
  | 'mm'
  | 'm'
  | 'dd'
  | 'd'
  | 'hh'
  | 'h'
  | 'ss'
  | 's';

export interface ParsedFormat {
  sections: FormatSection[];
  /** True when any section contains date tokens. */
  isDate: boolean;
}
