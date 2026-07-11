/**
 * Parse Excel-style format codes into section-aware tokens.
 *
 * Sections: `positive;negative;zero;text` (1–4). Semicolons inside quotes
 * or escaped with `\` do not split sections.
 *
 * Tier 0: digit placeholders (#, 0, ?), thousands/scaling (,), percent (%),
 * colors in brackets, basic date tokens, literals, `@` text placeholder.
 *
 * // TODO(Tier 1): style tags `[color=]`, `[bg=]`, `[weight=]`, `[if]`, `{icon:name}`
 * // TODO(Tier 2): composite cell fragment definitions
 */
import type {
  DatePart,
  DigitPart,
  FormatSection,
  FormatToken,
  ParsedFormat,
} from './types';

const DATE_PARTS: DatePart[] = [
  'yyyy',
  'yy',
  'mmmm',
  'mmm',
  'mm',
  'm',
  'dd',
  'd',
  'hh',
  'h',
  'ss',
  's',
];

/** Split on unquoted, unescaped semicolons into at most 4 sections. */
export function splitSections(code: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === '"' && !inQuote) {
      inQuote = true;
      cur += ch;
      continue;
    }
    if (ch === '"' && inQuote) {
      inQuote = false;
      cur += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < code.length) {
      cur += ch + code[++i]!;
      continue;
    }
    if (ch === ';' && !inQuote) {
      parts.push(cur);
      cur = '';
      if (parts.length >= 4) {
        // Remainder joins the text section.
        cur = code.slice(i + 1);
        break;
      }
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/**
 * Map Excel / theme color names to theme-token-compatible slots.
 * Prefer token names (`up`, `down`, `accent`, …); raw hex is allowed but
 * discouraged — returned as-is when it looks like `#RRGGBB`.
 */
export function resolveColorToken(raw: string): string {
  const s = raw.trim();
  if (!s) return s;
  if (s.startsWith('#') && /^#[0-9A-Fa-f]{3,8}$/.test(s)) return s;
  const lower = s.toLowerCase();
  // Theme token passthrough
  const tokens = new Set([
    'up',
    'down',
    'accent',
    'accentdim',
    'textprimary',
    'textsecondary',
    'texttertiary',
    'base',
    'raised',
    'hairline',
    'gridline',
  ]);
  if (tokens.has(lower.replace(/[-_]/g, ''))) {
    // Normalize camelCase theme keys
    const map: Record<string, string> = {
      up: 'up',
      down: 'down',
      accent: 'accent',
      accentdim: 'accentDim',
      textprimary: 'textPrimary',
      textsecondary: 'textSecondary',
      texttertiary: 'textTertiary',
      base: 'base',
      raised: 'raised',
      hairline: 'hairline',
      gridline: 'gridline',
    };
    return map[lower.replace(/[-_]/g, '')] ?? s;
  }
  // Excel named colors → theme tokens where possible
  switch (lower) {
    case 'red':
      return 'down';
    case 'green':
      return 'up';
    case 'blue':
      return 'accent';
    case 'yellow':
      return 'accentDim';
    case 'black':
      return 'textPrimary';
    case 'white':
      return 'base';
    case 'cyan':
      return 'accent';
    case 'magenta':
      return 'down';
    default:
      return s;
  }
}

function extractColor(raw: string): { color?: string; body: string } {
  // Leading [Color] or [themeToken] or [#hex]
  const m = raw.match(/^\[([^\]]+)\](.*)$/s);
  if (!m) return { body: raw };
  const inner = m[1]!.trim();
  // Skip Tier-1 style tags for now (color=, bg=, weight=, if …)
  if (/^(color|bg|background|weight|font|if)\s*=/i.test(inner) || /^if\b/i.test(inner)) {
    // TODO(Tier 1): parse style tags
    return { body: m[2] ?? '' };
  }
  return { color: resolveColorToken(inner), body: m[2] ?? '' };
}

function matchDatePart(s: string, i: number): { part: DatePart; len: number } | null {
  const rest = s.slice(i).toLowerCase();
  for (const part of DATE_PARTS) {
    if (rest.startsWith(part)) return { part, len: part.length };
  }
  return null;
}

function flushLiteral(buf: string[], tokens: FormatToken[]): void {
  if (!buf.length) return;
  tokens.push({ kind: 'literal', text: buf.join('') });
  buf.length = 0;
}

function parseNumberRun(
  body: string,
  start: number,
): { token: FormatToken & { kind: 'number' }; end: number } | null {
  const ch0 = body[start];
  if (ch0 !== '#' && ch0 !== '0' && ch0 !== '?' && ch0 !== '.' && ch0 !== ',') return null;

  // Scan a contiguous number pattern: [#0?,]*[#0?]+(\.[#0?]*)?(,)*
  let i = start;
  const int: DigitPart[] = [];
  const frac: DigitPart[] = [];
  let thousands = false;
  let scale = 0;
  let inFrac = false;
  let sawDigit = false;

  while (i < body.length) {
    const ch = body[i]!;
    if (ch === '#' || ch === '0' || ch === '?') {
      if (inFrac) frac.push(ch);
      else int.push(ch);
      sawDigit = true;
      i++;
      continue;
    }
    if (ch === '.' && !inFrac) {
      inFrac = true;
      i++;
      continue;
    }
    if (ch === ',') {
      // Thousands separator if between/after digit placeholders before decimal;
      // trailing commas after the number pattern scale by 1000 each.
      const next = body[i + 1];
      const prevDigit = sawDigit;
      if (!inFrac && next && (next === '#' || next === '0' || next === '?')) {
        thousands = true;
        i++;
        continue;
      }
      if (prevDigit && (!next || (next !== '#' && next !== '0' && next !== '?' && next !== '.'))) {
        // Count trailing scale commas
        while (i < body.length && body[i] === ',') {
          scale++;
          i++;
        }
        break;
      }
      // Comma right after start with no digits yet — treat as thousands flag starter
      if (!sawDigit) {
        thousands = true;
        i++;
        continue;
      }
      break;
    }
    break;
  }

  if (!sawDigit && !inFrac) return null;
  return {
    token: { kind: 'number', int, frac, thousands, scale },
    end: i,
  };
}

/** Parse one section body into tokens. */
export function parseSectionBody(body: string): FormatToken[] {
  const tokens: FormatToken[] = [];
  const lit: string[] = [];
  let i = 0;
  let isDateMode: boolean | null = null;

  while (i < body.length) {
    const ch = body[i]!;

    if (ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < body.length && body[j] !== '"') {
        if (body[j] === '\\' && j + 1 < body.length) {
          text += body[++j];
          j++;
        } else {
          text += body[j++];
        }
      }
      lit.push(text);
      i = j < body.length ? j + 1 : j;
      continue;
    }

    if (ch === '\\' && i + 1 < body.length) {
      lit.push(body[i + 1]!);
      i += 2;
      continue;
    }

    if (ch === '@') {
      flushLiteral(lit, tokens);
      tokens.push({ kind: 'text' });
      i++;
      continue;
    }

    if (ch === '%') {
      flushLiteral(lit, tokens);
      tokens.push({ kind: 'percent' });
      i++;
      continue;
    }

    // Underscore = pad width of next char (Excel); skip both for Tier 0
    if (ch === '_' && i + 1 < body.length) {
      i += 2;
      continue;
    }

    // Asterisk fill — skip for Tier 0 (canvas has no fill-to-width)
    if (ch === '*' && i + 1 < body.length) {
      i += 2;
      continue;
    }

    // Date tokens (y/m/d/h/s runs) — only when not clearly a number pattern
    const dateHit = matchDatePart(body, i);
    if (dateHit && isDateMode !== false) {
      // Prefer date if we see y/d/h/s; bare `m`/`mm` is date when other date tokens exist
      const isStrongDate =
        dateHit.part.startsWith('y') ||
        dateHit.part.startsWith('d') ||
        dateHit.part.startsWith('h') ||
        dateHit.part.startsWith('s') ||
        dateHit.part.startsWith('mmm');
      if (isStrongDate || isDateMode === true) {
        flushLiteral(lit, tokens);
        tokens.push({ kind: 'date', part: dateHit.part });
        isDateMode = true;
        i += dateHit.len;
        continue;
      }
    }

    const num = parseNumberRun(body, i);
    if (num) {
      flushLiteral(lit, tokens);
      tokens.push(num.token);
      isDateMode = false;
      i = num.end;
      continue;
    }

    // Ambiguous m/mm as month when in date mode, else literal
    if (dateHit && isDateMode === true) {
      flushLiteral(lit, tokens);
      tokens.push({ kind: 'date', part: dateHit.part });
      i += dateHit.len;
      continue;
    }

    lit.push(ch);
    i++;
  }

  flushLiteral(lit, tokens);
  return tokens;
}

function sectionHasDate(tokens: FormatToken[]): boolean {
  return tokens.some((t) => t.kind === 'date');
}

/** Parse a full Excel format code into sections + tokens. Never throws. */
export function parseFormat(code: string): ParsedFormat {
  try {
    const raw = String(code ?? '');
    if (!raw.trim()) {
      return { sections: [{ raw: '', empty: true, tokens: [] }], isDate: false };
    }
    const parts = splitSections(raw);
    const sections: FormatSection[] = parts.map((p) => {
      const trimmed = p; // preserve intentional spaces inside section
      if (trimmed === '' && parts.length > 1) {
        return { raw: trimmed, empty: true, tokens: [] };
      }
      const { color, body } = extractColor(trimmed.trimStart());
      const tokens = parseSectionBody(body);
      return { raw: trimmed, color, empty: false, tokens };
    });
    const isDate = sections.some((s) => sectionHasDate(s.tokens));
    return { sections, isDate };
  } catch {
    return { sections: [{ raw: String(code ?? ''), empty: false, tokens: [] }], isDate: false };
  }
}
