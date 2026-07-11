/**
 * Named format presets for the ext format picker and ColDef.format shortcuts.
 *
 * Built-ins: number, currency, percent, date, relativeTime, abbreviated (K/M/B).
 */
import { compileFormat } from './compile';
import { compileStyleTags, resolveStyleTags } from './styleTags';
import type {
  CompiledFormat,
  FormatConfig,
  FormatContext,
  FormatPresetName,
} from './types';

const BUILTIN_CODES: Record<FormatPresetName, string> = {
  number: '#,##0.00',
  currency: '$#,##0.00;($#,##0.00)',
  percent: '0.00%',
  date: 'yyyy-mm-dd',
  // relativeTime / abbreviated are custom closures, not Excel codes
  relativeTime: '',
  abbreviated: '',
};

function formatRelativeTime(value: unknown, ctx?: FormatContext): string {
  const now = ctx?.now ?? Date.now();
  let then: number | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) then = value;
  else if (value instanceof Date) then = value.getTime();
  else if (typeof value === 'string' && value.trim()) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) then = t;
  }
  if (then == null || !Number.isFinite(then)) return value == null ? '' : String(value);

  const diffMs = then - now;
  const abs = Math.abs(diffMs);
  const past = diffMs <= 0;
  const sec = Math.round(abs / 1000);
  const min = Math.round(abs / 60_000);
  const hr = Math.round(abs / 3_600_000);
  const day = Math.round(abs / 86_400_000);

  let label: string;
  if (sec < 45) label = 'just now';
  else if (min < 60) label = `${min}m`;
  else if (hr < 48) label = `${hr}h`;
  else if (day < 60) label = `${day}d`;
  else {
    const months = Math.round(day / 30);
    if (months < 24) label = `${months}mo`;
    else label = `${Math.round(months / 12)}y`;
  }
  if (label === 'just now') return label;
  return past ? `${label} ago` : `in ${label}`;
}

function formatAbbreviated(value: unknown, ctx?: FormatContext): string {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) return value == null ? '' : String(value);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const locale = ctx?.locale;
  const fmt = (v: number, suffix: string) => {
    const rounded = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
    const trimmed = rounded.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
    return `${sign}${trimmed}${suffix}`;
  };
  if (abs >= 1e12) return fmt(abs / 1e12, 'T');
  if (abs >= 1e9) return fmt(abs / 1e9, 'B');
  if (abs >= 1e6) return fmt(abs / 1e6, 'M');
  if (abs >= 1e3) return fmt(abs / 1e3, 'K');
  try {
    return sign + abs.toLocaleString(locale);
  } catch {
    return sign + String(abs);
  }
}

function compileCurrency(cfg?: FormatConfig): CompiledFormat {
  const code = BUILTIN_CODES.currency;
  const base = compileFormat(code);
  return {
    format(value, ctx) {
      const currency = ctx?.currency ?? cfg?.currency ?? 'USD';
      const locale = ctx?.locale ?? cfg?.locale;
      const n =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && value.trim()
            ? Number(value)
            : NaN;
      if (Number.isFinite(n)) {
        try {
          return new Intl.NumberFormat(locale, {
            style: 'currency',
            currency,
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          }).format(n);
        } catch {
          return base.format(value, ctx);
        }
      }
      return base.format(value, ctx);
    },
    styleFor: (v) => base.styleFor(v),
    style: base.style,
  };
}

function compileRelativeTime(): CompiledFormat {
  return {
    format: formatRelativeTime,
    styleFor: () => undefined,
  };
}

function compileAbbreviated(): CompiledFormat {
  return {
    format: formatAbbreviated,
    styleFor: () => undefined,
  };
}

const PRESET_COMPILERS: Record<
  FormatPresetName,
  (cfg?: FormatConfig) => CompiledFormat
> = {
  number: () => compileFormat(BUILTIN_CODES.number),
  currency: (cfg) => compileCurrency(cfg),
  percent: () => compileFormat(BUILTIN_CODES.percent),
  date: () => compileFormat(BUILTIN_CODES.date),
  relativeTime: () => compileRelativeTime(),
  abbreviated: () => compileAbbreviated(),
};

/** List built-in preset names. */
export function listPresets(): FormatPresetName[] {
  return Object.keys(PRESET_COMPILERS) as FormatPresetName[];
}

/** Excel code (or empty) backing a built-in preset, when applicable. */
export function presetCode(name: FormatPresetName): string {
  return BUILTIN_CODES[name] ?? '';
}

export function isPresetName(name: string): name is FormatPresetName {
  return Object.prototype.hasOwnProperty.call(PRESET_COMPILERS, name);
}

/**
 * Compile a named preset. Unknown names fall back to treating `name` as an
 * Excel format code via `compileFormat`.
 */
export function compilePreset(name: string, cfg?: FormatConfig): CompiledFormat {
  try {
    // Custom / overridden presets from FormatConfig
    const override = cfg?.presets?.[name];
    if (override != null) {
      if (isPresetName(override)) return PRESET_COMPILERS[override](cfg);
      return compileFormat(override);
    }
    if (isPresetName(name)) return PRESET_COMPILERS[name](cfg);
    return compileFormat(name);
  } catch {
    return compileFormat('');
  }
}

/**
 * Resolve `ColDef.format`: preset name, config override, or raw Excel code.
 * Tier 1 style tags are stripped and folded into the compiled style.
 */
export function resolveFormat(codeOrPreset: string, cfg?: FormatConfig): CompiledFormat {
  const key = codeOrPreset.trim();
  if (!key) {
    return {
      format: (v) => (v == null ? '' : String(v)),
      styleFor: () => undefined,
    };
  }

  // Presets don't carry Tier 1 tags.
  if (cfg?.presets?.[key] != null || isPresetName(key)) {
    return compilePreset(key, cfg);
  }

  const tags = compileStyleTags(key);
  const base =
    tags.formatCode && (cfg?.presets?.[tags.formatCode] != null || isPresetName(tags.formatCode))
      ? compilePreset(tags.formatCode, cfg)
      : compileFormat(tags.formatCode || '');

  const hasTags =
    Object.keys(tags.style).length > 0 || tags.conditionals.length > 0 || tags.icons.length > 0;
  if (!hasTags) return base;

  return {
    format: (v, ctx) => base.format(v, ctx),
    styleFor(value) {
      const fromTags = resolveStyleTags(tags, value);
      const fromSection = base.styleFor(value) ?? base.style;
      if (!fromTags && !fromSection) return undefined;
      return { ...fromSection, ...fromTags };
    },
    style: { ...base.style, ...tags.style },
    icons: tags.icons.length ? tags.icons : undefined,
  };
}
