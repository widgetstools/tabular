/**
 * Compile Excel-style format codes to closures. No eval — fail closed to
 * String(value) on any error.
 */
import { parseFormat, resolveColorToken } from './parse';
import type {
  CompiledFormat,
  DatePart,
  DigitPart,
  FormatCellStyle,
  FormatContext,
  FormatSection,
  FormatToken,
  ParsedFormat,
} from './types';

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function fallback(value: unknown): string {
  if (value == null) return '';
  return String(value);
}

function isBlank(value: unknown): boolean {
  return value == null || value === '';
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const s = value.trim();
    // Date-only ISO (yyyy-mm-dd) — parse as local calendar date to avoid
    // UTC midnight shifting the day in western timezones.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return Number.isFinite(d.getTime()) ? d : null;
    }
    const d = new Date(s);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

function pickSection(parsed: ParsedFormat, value: unknown): FormatSection {
  const secs = parsed.sections;
  const n = secs.length;
  if (n === 0) return { raw: '', empty: true, tokens: [] };

  if (typeof value === 'string' || (value != null && typeof value !== 'number' && !(value instanceof Date) && typeof value !== 'bigint')) {
    // Text section (4th) when present; else first
    if (n >= 4) return secs[3]!;
    // Non-numeric non-date: still try number path if coercible
    const num = asNumber(value);
    if (num == null && !(value instanceof Date) && typeof value !== 'string') {
      return n >= 4 ? secs[3]! : secs[0]!;
    }
  }

  if (typeof value === 'string') {
    const num = asNumber(value);
    if (num == null) {
      return n >= 4 ? secs[3]! : secs[0]!;
    }
    return pickNumericSection(secs, num);
  }

  if (parsed.isDate) {
    // Date formats usually have one section
    return secs[0]!;
  }

  const num = asNumber(value);
  if (num == null) {
    return n >= 4 ? secs[3]! : secs[0]!;
  }
  return pickNumericSection(secs, num);
}

function pickNumericSection(secs: FormatSection[], num: number): FormatSection {
  const n = secs.length;
  if (n === 1) return secs[0]!;
  if (n === 2) {
    // positive+zero | negative
    return num < 0 ? secs[1]! : secs[0]!;
  }
  if (n === 3) {
    if (num > 0) return secs[0]!;
    if (num < 0) return secs[1]!;
    return secs[2]!;
  }
  // 4 sections
  if (num > 0) return secs[0]!;
  if (num < 0) return secs[1]!;
  if (num === 0) return secs[2]!;
  return secs[3]!;
}

function formatDigits(absInt: string, pattern: DigitPart[]): string {
  if (!pattern.length) return absInt === '0' ? '' : absInt;
  const digits = absInt.replace(/^0+(?=\d)/, '') || '0';
  const out: string[] = [];
  let di = digits.length - 1;
  for (let pi = pattern.length - 1; pi >= 0; pi--) {
    const p = pattern[pi]!;
    if (di >= 0) {
      out.push(digits[di--]!);
    } else if (p === '0') {
      out.push('0');
    } else if (p === '?') {
      out.push(' ');
    }
    // '#' → omit
  }
  // Leftover high-order digits
  while (di >= 0) out.push(digits[di--]!);
  return out.reverse().join('');
}

function formatFrac(fracDigits: string, pattern: DigitPart[]): string {
  if (!pattern.length) return '';
  const padded = fracDigits.padEnd(pattern.length, '0').slice(0, pattern.length);
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    const d = padded[i] ?? '0';
    if (p === '0') out += d;
    else if (p === '#') {
      // Trailing # omit zeros — strip later
      out += d;
    } else if (p === '?') {
      out += d === '0' ? ' ' : d;
    }
  }
  // Trim trailing zeros for # placeholders at end
  if (pattern.every((p) => p === '#')) {
    out = out.replace(/0+$/, '');
  } else if (pattern.includes('#')) {
    // Trim only trailing # positions that are zero
    let end = out.length;
    for (let i = pattern.length - 1; i >= 0; i--) {
      if (pattern[i] === '#' && (out[i] === '0' || out[i] === undefined)) end = i;
      else break;
    }
    out = out.slice(0, end);
  }
  return out;
}

function addThousands(intPart: string): string {
  const neg = intPart.startsWith('-');
  const s = neg ? intPart.slice(1) : intPart;
  const withSep = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? `-${withSep}` : withSep;
}

function roundTo(n: number, fracLen: number): number {
  const f = 10 ** fracLen;
  return Math.round(n * f) / f;
}

function renderNumber(n: number, token: Extract<FormatToken, { kind: 'number' }>, percentMul: boolean): string {
  let v = Math.abs(n);
  if (percentMul) v *= 100;
  if (token.scale > 0) v /= 1000 ** token.scale;
  const fracLen = token.frac.length;
  v = roundTo(v, fracLen);
  const [intStr, fracStr = ''] = v.toFixed(fracLen).split('.');
  let intOut = formatDigits(intStr!, token.int);
  if (token.thousands && intOut.trim()) intOut = addThousands(intOut.replace(/ /g, ''));
  // Edge: all-# integer pattern and value 0 → empty int
  if (!token.int.some((p) => p === '0') && !token.int.includes('?') && Number(intStr) === 0 && fracLen === 0) {
    intOut = intOut || '';
  }
  if (fracLen === 0) return intOut || (token.int.some((p) => p === '0') ? '0' : intOut);
  const fracOut = formatFrac(fracStr, token.frac);
  if (!fracOut) return intOut || '0';
  return `${intOut || '0'}.${fracOut}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function renderDatePart(d: Date, part: DatePart): string {
  switch (part) {
    case 'yyyy':
      return String(d.getFullYear());
    case 'yy':
      return pad2(d.getFullYear() % 100);
    case 'mmmm':
      return MONTHS_LONG[d.getMonth()]!;
    case 'mmm':
      return MONTHS_SHORT[d.getMonth()]!;
    case 'mm':
      return pad2(d.getMonth() + 1);
    case 'm':
      return String(d.getMonth() + 1);
    case 'dd':
      return pad2(d.getDate());
    case 'd':
      return String(d.getDate());
    case 'hh':
      return pad2(d.getHours());
    case 'h':
      return String(d.getHours());
    case 'ss':
      return pad2(d.getSeconds());
    case 's':
      return String(d.getSeconds());
  }
}

function renderSection(section: FormatSection, value: unknown, parsed: ParsedFormat): string {
  if (section.empty) return '';
  const tokens = section.tokens;
  if (!tokens.length) return fallback(value);

  const hasPercent = tokens.some((t) => t.kind === 'percent');
  const hasNumber = tokens.some((t) => t.kind === 'number');
  const hasDate = tokens.some((t) => t.kind === 'date');
  const hasText = tokens.some((t) => t.kind === 'text');

  if (hasDate || (parsed.isDate && !hasNumber)) {
    const d = asDate(value);
    if (!d) return fallback(value);
    let out = '';
    for (const t of tokens) {
      if (t.kind === 'literal') out += t.text;
      else if (t.kind === 'date') out += renderDatePart(d, t.part);
      else if (t.kind === 'text') out += fallback(value);
    }
    return out;
  }

  if (hasText && !hasNumber) {
    const text = fallback(value);
    let out = '';
    for (const t of tokens) {
      if (t.kind === 'literal') out += t.text;
      else if (t.kind === 'text') out += text;
    }
    return out || text;
  }

  const num = asNumber(value);
  if (num == null && hasNumber) return fallback(value);

  // For negative section, Excel typically does not include the minus in the
  // number token (caller may put "-" as literal). Use absolute value.
  const n = num ?? 0;
  const abs = Math.abs(n);

  let out = '';
  for (const t of tokens) {
    if (t.kind === 'literal') out += t.text;
    else if (t.kind === 'percent') out += '%';
    else if (t.kind === 'text') out += fallback(value);
    else if (t.kind === 'number') out += renderNumber(abs, t, hasPercent);
    else if (t.kind === 'date') {
      const d = asDate(value);
      if (d) out += renderDatePart(d, t.part);
    }
  }

  // Single-section formats: preserve minus when no explicit negative section
  // and the pattern didn't include a leading "-" literal.
  if (parsed.sections.length === 1 && n < 0 && !out.startsWith('-') && !out.startsWith('(')) {
    out = `-${out}`;
  }

  return out;
}

function styleFromSection(section: FormatSection | undefined): Partial<FormatCellStyle> | undefined {
  if (!section?.color) return undefined;
  return { color: resolveColorToken(section.color) };
}

/**
 * Compile an Excel format code (or empty string) to a formatter closure.
 * Never throws.
 */
export function compileFormat(code: string): CompiledFormat {
  try {
    const parsed = parseFormat(code);
    const staticColors = new Set(
      parsed.sections.filter((s) => s.color).map((s) => resolveColorToken(s.color!)),
    );
    const staticStyle =
      staticColors.size === 1
        ? ({ color: [...staticColors][0]! } satisfies Partial<FormatCellStyle>)
        : undefined;

    const compiled: CompiledFormat = {
      format(value: unknown, _ctx?: FormatContext): string {
        try {
          if (isBlank(value) && !parsed.sections.some((s) => s.tokens.length)) return '';
          const section = pickSection(parsed, value);
          return renderSection(section, value, parsed);
        } catch {
          return fallback(value);
        }
      },
      styleFor(value: unknown): Partial<FormatCellStyle> | undefined {
        try {
          const section = pickSection(parsed, value);
          return styleFromSection(section);
        } catch {
          return undefined;
        }
      },
      style: staticStyle,
    };
    return compiled;
  } catch {
    return {
      format: (value) => fallback(value),
      styleFor: () => undefined,
    };
  }
}

/** Resolve a color string the same way parse does (for bridges / tests). */
export { resolveColorToken };
