/**
 * Format-picker catalog — pure data + helpers (no DOM).
 * Excel codes and @tabular/format named presets only.
 * Skips TICK*, `=expr` value formatters, and other cgrid-only DSL.
 */

export type FormatDataType = 'number' | 'text' | 'date' | 'boolean';

export type FormatCategory =
  | 'number'
  | 'currency'
  | 'percent'
  | 'negatives'
  | 'conditional'
  | 'date'
  | 'text';

export interface FormatPreset {
  id: string;
  category: FormatCategory;
  label: string;
  hint?: string;
  format: string;
  sample?: unknown;
}

export const CATEGORY_LABELS: Record<FormatCategory, string> = {
  number: 'Number',
  currency: 'Currency',
  percent: 'Percent',
  negatives: 'Negatives & P&L',
  conditional: 'Conditional',
  date: 'Date & time',
  text: 'Text',
};

export function categoriesForDataType(dt: FormatDataType): FormatCategory[] {
  switch (dt) {
    case 'number':
      return ['number', 'currency', 'negatives', 'conditional', 'percent'];
    case 'date':
      return ['date'];
    case 'text':
      return ['text'];
    case 'boolean':
      return ['text'];
    default:
      return ['number'];
  }
}

const PRESETS: FormatPreset[] = [
  // ── Number
  { id: 'num-integer', category: 'number', label: 'Integer', format: '#,##0' },
  { id: 'num-2dp', category: 'number', label: '2 decimals', format: '#,##0.00' },
  { id: 'num-4dp', category: 'number', label: '4 decimals', format: '#,##0.0000' },
  { id: 'num-plain', category: 'number', label: 'No thousands', format: '0.00' },
  { id: 'num-sci', category: 'number', label: 'Scientific', format: '0.00E+00' },
  { id: 'num-preset', category: 'number', label: 'Number (preset)', hint: 'named', format: 'number' },
  {
    id: 'num-abbr',
    category: 'number',
    label: 'Abbreviated (K/M/B)',
    hint: 'named',
    format: 'abbreviated',
    sample: 1_250_000,
  },

  // ── Negatives & P&L
  { id: 'neg-parens', category: 'negatives', label: 'Parens negative', format: '#,##0.00;(#,##0.00)' },
  {
    id: 'neg-red-parens',
    category: 'negatives',
    label: 'Red parens neg',
    format: '#,##0.00;[Red](#,##0.00)',
  },
  { id: 'neg-red', category: 'negatives', label: 'Red negative', format: '#,##0.00;[Red]#,##0.00' },
  {
    id: 'neg-green-red',
    category: 'negatives',
    label: 'Green / Red (no sign)',
    format: '[Green]#,##0.00;[Red]#,##0.00',
  },
  {
    id: 'neg-green-red-usd',
    category: 'negatives',
    label: 'Green / Red $ (no sign)',
    format: '[Green]$#,##0.00;[Red]$#,##0.00',
  },
  {
    id: 'neg-zero-dash',
    category: 'negatives',
    label: 'Zero as dash',
    format: '#,##0.00;(#,##0.00);"—"',
    sample: 0,
  },

  // ── Conditional (Excel section colors only — no [>n] / =expr)
  {
    id: 'cond-green-red',
    category: 'conditional',
    label: 'Green pos / red neg',
    format: '[Green]#,##0.00;[Red]#,##0.00',
    sample: -12.5,
  },
  {
    id: 'cond-arrows',
    category: 'conditional',
    label: 'Green up / red down',
    format: '[Green]▲#,##0.00;[Red]▼#,##0.00;0.00',
    sample: -12.5,
  },
  {
    id: 'cond-arrows-usd',
    category: 'conditional',
    label: 'Green up / red down $',
    format: '[Green]▲$#,##0.00;[Red]▼$#,##0.00;$0.00',
    sample: 42.5,
  },

  // ── Percent
  { id: 'pct-0', category: 'percent', label: 'Percent (0dp)', format: '0%', sample: 0.12 },
  { id: 'pct-2', category: 'percent', label: 'Percent (2dp)', format: '0.00%', sample: 0.1234 },
  {
    id: 'pct-bps',
    category: 'percent',
    label: 'Basis points label',
    hint: '12.34 bps',
    format: '0.00 "bps"',
    sample: 12.34,
  },
  { id: 'pct-preset', category: 'percent', label: 'Percent (preset)', hint: 'named', format: 'percent', sample: 0.1234 },

  // ── Currency
  { id: 'cur-usd', category: 'currency', label: 'USD', format: '$#,##0.00' },
  { id: 'cur-usd-parens', category: 'currency', label: 'USD parens neg', format: '$#,##0.00;($#,##0.00)' },
  {
    id: 'cur-usd-red',
    category: 'currency',
    label: 'USD red negative',
    format: '$#,##0.00;[Red]-$#,##0.00',
  },
  { id: 'cur-usd-0dp', category: 'currency', label: 'USD (0dp)', format: '$#,##0' },
  { id: 'cur-eur', category: 'currency', label: 'EUR', format: '€#,##0.00' },
  { id: 'cur-eur-parens', category: 'currency', label: 'EUR parens neg', format: '€#,##0.00;(€#,##0.00)' },
  { id: 'cur-gbp', category: 'currency', label: 'GBP', format: '"£"#,##0.00' },
  {
    id: 'cur-gbp-parens',
    category: 'currency',
    label: 'GBP parens neg',
    format: '"£"#,##0.00;("£"#,##0.00)',
  },
  { id: 'cur-jpy', category: 'currency', label: 'JPY (0dp)', format: '"¥"#,##0' },
  { id: 'cur-inr', category: 'currency', label: 'INR', format: '"₹"#,##0.00' },
  { id: 'cur-chf', category: 'currency', label: 'CHF', format: '"CHF "#,##0.00' },
  {
    id: 'cur-chf-parens',
    category: 'currency',
    label: 'CHF parens neg',
    format: '"CHF "#,##0.00;("CHF "#,##0.00)',
  },
  {
    id: 'cur-preset',
    category: 'currency',
    label: 'Currency (preset)',
    hint: 'named · locale',
    format: 'currency',
  },

  // ── Date & time
  { id: 'date-iso', category: 'date', label: 'ISO (yyyy-mm-dd)', format: 'yyyy-mm-dd' },
  { id: 'date-us', category: 'date', label: 'US (mm/dd/yyyy)', format: 'mm/dd/yyyy' },
  { id: 'date-eu', category: 'date', label: 'EU (dd-mmm-yy)', format: 'dd-mmm-yy' },
  { id: 'date-long', category: 'date', label: 'Long', format: 'dd mmmm yyyy' },
  { id: 'date-iso-time', category: 'date', label: 'ISO with time', format: 'yyyy-mm-dd hh:nn:ss' },
  { id: 'date-us-short', category: 'date', label: 'US short', format: 'mm/dd/yy h:nn AM/PM' },
  { id: 'date-preset', category: 'date', label: 'Date (preset)', hint: 'named', format: 'date' },
  {
    id: 'date-rel',
    category: 'date',
    label: 'Relative time',
    hint: 'named',
    format: 'relativeTime',
    sample: Date.now() - 3_600_000,
  },

  // ── Text (Excel @ / literals only)
  { id: 'str-default', category: 'text', label: 'Default (pass-through)', format: '@' },
  { id: 'str-prefix-px', category: 'text', label: 'Prefix: PX', format: '"PX "@' },
  { id: 'str-suffix-units', category: 'text', label: 'Suffix: units', format: '@" units"' },
];

export function presetsForCategory(cat: FormatCategory): FormatPreset[] {
  return PRESETS.filter((p) => p.category === cat);
}

export function presetsForDataType(dt: FormatDataType): FormatPreset[] {
  return categoriesForDataType(dt).flatMap(presetsForCategory);
}

export function findPresetByFormat(format: string | undefined): FormatPreset | undefined {
  if (format === undefined) return undefined;
  const f = format.trim();
  return PRESETS.find((p) => p.format === f);
}

export function defaultSampleValue(dt: FormatDataType): unknown {
  switch (dt) {
    case 'date':
      return new Date('2026-04-17T09:30:00Z');
    case 'text':
      return 'sample';
    case 'boolean':
      return true;
    default:
      return 1234.5678;
  }
}

export function filterPresets(presets: FormatPreset[], query: string): FormatPreset[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return presets.filter((p) =>
    `${p.label} ${p.hint ?? ''} ${p.format}`.toLowerCase().includes(q),
  );
}

export function codeText(format: string): string {
  return format;
}

export const CURRENCY_QUICK_INSERT: ReadonlyArray<{ label: string; symbol: string }> = [
  { label: '$', symbol: '$' },
  { label: '€', symbol: '€' },
  { label: '£', symbol: '"£"' },
  { label: '¥', symbol: '"¥"' },
  { label: '₹', symbol: '"₹"' },
  { label: 'CHF', symbol: '"CHF "' },
];

const CURRENCY_SYMBOL_RE = /("£"|"¥"|"₹"|"[A-Z]{3} ?"|[$€])/g;

export function applyCurrencySymbol(draft: string, symbol: string): string {
  const d = draft.trim();
  if (!d) return `${symbol}#,##0.00`;
  if (CURRENCY_SYMBOL_RE.test(d)) {
    CURRENCY_SYMBOL_RE.lastIndex = 0;
    return d.replace(CURRENCY_SYMBOL_RE, symbol);
  }
  return `${symbol}${d}`;
}

export interface ExcelExample {
  label: string;
  format: string;
  sample: string;
}

export interface ExcelExampleSection {
  title: string;
  rows: ExcelExample[];
}

/** Static reference rows for the Custom tab — samples are decorative strings. */
export const EXCEL_EXAMPLES: ExcelExampleSection[] = [
  {
    title: 'Numbers & decimals',
    rows: [
      { label: 'Integer w/ thousands', format: '#,##0', sample: '1,235' },
      { label: '2 decimals', format: '#,##0.00', sample: '1,234.57' },
      { label: '4 decimals', format: '#,##0.0000', sample: '1,234.5678' },
      { label: 'No thousands', format: '0.00', sample: '1234.57' },
      { label: 'Scientific', format: '0.00E+00', sample: '1.23E+03' },
    ],
  },
  {
    title: 'Currency',
    rows: [
      { label: 'USD', format: '$#,##0.00', sample: '$1,234.57' },
      { label: 'USD parens neg', format: '$#,##0.00;($#,##0.00)', sample: '($1,234.57)' },
      { label: 'USD red negative', format: '$#,##0.00;[Red]-$#,##0.00', sample: '-$1,234.57 (red)' },
      { label: 'EUR', format: '€#,##0.00', sample: '€1,234.57' },
    ],
  },
  {
    title: 'Percent',
    rows: [
      { label: 'Percent', format: '0.00%', sample: '12.34%' },
      { label: 'Percent (0dp)', format: '0%', sample: '12%' },
      { label: 'Basis points', format: '0.00 "bps"', sample: '12.34 bps' },
    ],
  },
  {
    title: 'Negatives in parens / red',
    rows: [
      { label: 'Parens negative', format: '#,##0.00;(#,##0.00)', sample: '(1,234.57)' },
      { label: 'Red parens', format: '#,##0.00;[Red](#,##0.00)', sample: '(1,234.57)' },
      { label: 'Red only', format: '#,##0.00;[Red]#,##0.00', sample: '[Red]1,234.57' },
      {
        label: 'Green / Red (no sign)',
        format: '[Green]#,##0.00;[Red]#,##0.00',
        sample: '[Green]1,234.57 · [Red]1,234.57',
      },
      { label: 'Zero as dash', format: '#,##0.00;(#,##0.00);"—"', sample: '—' },
    ],
  },
  {
    title: 'Dates & times',
    rows: [
      { label: 'ISO date', format: 'yyyy-mm-dd', sample: '2026-04-17' },
      { label: 'US date', format: 'mm/dd/yyyy', sample: '04/17/2026' },
      { label: 'Euro short', format: 'dd-mmm-yy', sample: '17-Apr-26' },
      { label: 'ISO with time', format: 'yyyy-mm-dd hh:nn:ss', sample: '2026-04-17 09:30:00' },
      { label: 'US with AM/PM', format: 'mm/dd/yy h:nn AM/PM', sample: '04/17/26 9:30 AM' },
    ],
  },
  {
    title: 'Text',
    rows: [
      { label: 'Pass-through', format: '@', sample: 'value' },
      { label: 'Suffix text', format: '@" units"', sample: 'value units' },
      { label: 'Prefix text', format: '"PX "@', sample: 'PX value' },
    ],
  },
];
