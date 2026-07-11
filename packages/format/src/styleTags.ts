/**
 * Tier 1 — style tags embedded in format strings / ColDef.formatStyle.
 *
 * Supported tags (compiled at config time):
 *   [color=token|hex]  [bg=…]  [weight=bold|number]  [if=expr]
 *   {icon:name}        — Lucide icon name for inline paint
 *
 * Conditions use a tiny subset: comparisons against the cell value (`x`)
 * or field refs via a provided row bag. Fail closed on parse errors.
 */
import type { FormatCellStyle } from './types';

export interface StyleTagIcon {
  name: string;
}

export interface CompiledStyleTags {
  /** Base style from unconditional tags. */
  style: FormatCellStyle;
  /** Conditional style overlays evaluated at paint/format time. */
  conditionals: Array<{
    test: (value: unknown, row?: Record<string, unknown>) => boolean;
    style: FormatCellStyle;
  }>;
  icons: StyleTagIcon[];
  /** Remaining plain format code after tags are stripped (may be empty). */
  formatCode: string;
}

const TAG_RE =
  /\[(color|bg|weight|if)=([^\]]*)\]|\{icon:([a-z0-9-]+)\}/gi;

/**
 * Parse Tier 1 tags from a format string. Returns compiled tags + residual
 * Excel format code (Tier 0). Never throws.
 */
export function compileStyleTags(source: string): CompiledStyleTags {
  const style: FormatCellStyle = {};
  const conditionals: CompiledStyleTags['conditionals'] = [];
  const icons: StyleTagIcon[] = [];
  let formatCode = source;

  try {
    const matches = [...source.matchAll(TAG_RE)];
    for (const m of matches) {
      formatCode = formatCode.replace(m[0], '');
      if (m[3]) {
        icons.push({ name: m[3] });
        continue;
      }
      const key = (m[1] ?? '').toLowerCase();
      const raw = (m[2] ?? '').trim();
      if (key === 'if') {
        const test = compileIf(raw);
        // Look ahead: following tags until next [if=] apply to this condition.
        // Simplified: if body is `cond:styleTags` e.g. `x<0:[color=down]`
        const colon = raw.indexOf(':');
        if (colon >= 0) {
          const cond = raw.slice(0, colon).trim();
          const body = raw.slice(colon + 1).trim();
          const inner = compileStyleTags(body);
          conditionals.push({
            test: compileIf(cond),
            style: inner.style,
          });
        } else {
          conditionals.push({ test, style: {} });
        }
        continue;
      }
      applyTag(style, key, raw);
    }
    formatCode = formatCode.trim();
  } catch {
    return { style: {}, conditionals: [], icons: [], formatCode: source };
  }

  return { style, conditionals, icons, formatCode };
}

function applyTag(style: FormatCellStyle, key: string, raw: string): void {
  switch (key) {
    case 'color':
      style.color = raw;
      break;
    case 'bg':
      style.backgroundColor = raw;
      break;
    case 'weight':
      style.fontWeight = raw === 'bold' ? 700 : Number(raw) || raw;
      break;
  }
}

/** Tiny condition compiler: `x<0`, `x>=100`, `x=="A"`, `[field]>0`. */
function compileIf(src: string): (value: unknown, row?: Record<string, unknown>) => boolean {
  const s = src.trim();
  if (!s) return () => true;
  const m = s.match(/^(x|\[[^\]]+\])\s*(==|!=|<=|>=|<|>)\s*(.+)$/);
  if (!m) return () => false;
  const left = m[1]!;
  const op = m[2]!;
  const rightRaw = m[3]!.trim();
  const right = parseLiteral(rightRaw);
  return (value, row) => {
    try {
      const lv = left === 'x' ? value : row?.[left.slice(1, -1)];
      return compare(lv, op, right);
    } catch {
      return false;
    }
  };
}

function parseLiteral(raw: string): unknown {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
}

function compare(a: unknown, op: string, b: unknown): boolean {
  switch (op) {
    case '==':
      return a == b;
    case '!=':
      return a != b;
    case '<':
      return Number(a) < Number(b);
    case '<=':
      return Number(a) <= Number(b);
    case '>':
      return Number(a) > Number(b);
    case '>=':
      return Number(a) >= Number(b);
    default:
      return false;
  }
}

/** Merge base + matching conditional styles for a value. */
export function resolveStyleTags(
  tags: CompiledStyleTags,
  value: unknown,
  row?: Record<string, unknown>,
): FormatCellStyle | undefined {
  const out: FormatCellStyle = { ...tags.style };
  for (const c of tags.conditionals) {
    if (c.test(value, row)) Object.assign(out, c.style);
  }
  return Object.keys(out).length ? out : undefined;
}
