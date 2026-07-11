/**
 * Wire @tabular/format into the grid: ColDef.format → value-format + style
 * resolver chains. Bad format codes never crash the grid.
 */
import {
  resolveFormat,
  type CompiledFormat,
  type FormatConfig,
} from '@tabular/format';
import type { ThemeTokens } from './theme';
import type { CellStyle, ColDef, GridOptions } from './types';

export interface FormatHost<TData> {
  addValueFormatResolver: (
    fn: (params: {
      value: unknown;
      data: TData | undefined;
      rowIndex: number;
      colDef: ColDef<TData>;
      colId: string;
    }) => string | undefined,
    priority?: number,
  ) => () => void;
  addCellStyleResolver: (
    fn: (
      params: {
        value: unknown;
        data: TData | undefined;
        rowIndex: number;
        colDef: ColDef<TData>;
        colId: string;
      },
      style: CellStyle,
    ) => void,
    priority?: number,
  ) => () => void;
  getThemeTokens: () => ThemeTokens;
}

/**
 * Resolve a format color (theme token name or hex) to a paint-ready color.
 * Prefer theme tokens (`up`, `down`, `accent`, …); raw hex is allowed but
 * discouraged in docs / picker UI.
 */
export function resolveFormatColor(color: string, theme: ThemeTokens): string {
  if (!color) return color;
  if (color.startsWith('#') || color.startsWith('rgb') || color.startsWith('hsl')) return color;
  const key = color as keyof ThemeTokens;
  const hit = theme[key];
  return typeof hit === 'string' ? hit : color;
}

/**
 * Compiles `ColDef.format` codes/presets and serves lookups by colId.
 * Rebuild when column defs change (same cadence as CalcResolver).
 */
export class FormatResolver {
  private handles = new Map<string, CompiledFormat>();
  private config: FormatConfig | undefined;

  setConfig(cfg: FormatConfig | undefined): void {
    this.config = cfg;
  }

  rebuild(cols: Array<{ colId: string; def: ColDef }>): void {
    const next = new Map<string, CompiledFormat>();
    for (const col of cols) {
      const code = col.def.format;
      if (!code) continue;
      try {
        next.set(col.colId, resolveFormat(code, this.config));
      } catch {
        // Fail closed: skip this column's format (falls through to default).
      }
    }
    this.handles = next;
  }

  has(colId: string): boolean {
    return this.handles.has(colId);
  }

  get(colId: string): CompiledFormat | undefined {
    return this.handles.get(colId);
  }

  /** True when any column currently has a compiled format. */
  active(): boolean {
    return this.handles.size > 0;
  }
}

/**
 * Attach format resolvers once. The host's FormatResolver must be rebuilt
 * whenever column defs change; resolvers read the live map.
 */
export function attachFormat<TData>(
  host: FormatHost<TData>,
  resolver: FormatResolver,
  options: Pick<GridOptions<TData>, 'formatting'>,
): { detach: () => void } {
  resolver.setConfig(options.formatting);

  const cleanups: Array<() => void> = [];

  // Priority 20: after any higher-priority custom resolvers, before valueFormatter.
  cleanups.push(
    host.addValueFormatResolver((params) => {
      const compiled = resolver.get(params.colId);
      if (!compiled) return undefined;
      try {
        return compiled.format(params.value, {
          locale: options.formatting?.locale,
          currency: options.formatting?.currency,
        });
      } catch {
        return params.value == null ? '' : String(params.value);
      }
    }, 20),
  );

  // Style from section colors (e.g. [Red] / [down]). Priority below rules (50).
  cleanups.push(
    host.addCellStyleResolver((params, style) => {
      const compiled = resolver.get(params.colId);
      if (!compiled) return;
      try {
        const fmtStyle = compiled.styleFor(params.value) ?? compiled.style;
        if (!fmtStyle) return;
        const theme = host.getThemeTokens();
        if (fmtStyle.color) style.color = resolveFormatColor(fmtStyle.color, theme);
        if (fmtStyle.fontWeight != null) style.fontWeight = fmtStyle.fontWeight;
        if (fmtStyle.fontStyle != null) style.fontStyle = fmtStyle.fontStyle;
        if (fmtStyle.background != null) {
          style.background = resolveFormatColor(fmtStyle.background, theme);
        }
        if (fmtStyle.backgroundColor != null) {
          style.backgroundColor = resolveFormatColor(fmtStyle.backgroundColor, theme);
        }
      } catch {
        // ignore
      }
    }, 30),
  );

  return {
    detach: () => {
      for (const fn of cleanups) fn();
    },
  };
}
