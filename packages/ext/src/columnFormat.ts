/**
 * Column format / style chrome — resolve target columns from selection and
 * patch ColDef.format / cellStyle / headerStyle / icons via setColumnDefs.
 */
import type {
  AnyColDef,
  CellIconSpec,
  CellStyle,
  ColDef,
  ColGroupDef,
  Tabular,
} from '@tabular/core';
import { isPresetName, presetCode, type FormatPresetName } from '@tabular/format';

export type Align = 'left' | 'right' | 'center';
export type BorderSide = 'all' | 'top' | 'bottom' | 'left' | 'right';
export type StyleTarget = 'cell' | 'header';

export interface ColumnChromeState {
  colIds: string[];
  format?: string;
  style: CellStyle;
  headerStyle: CellStyle;
  align?: Align;
  cellIcon?: CellIconSpec | null;
  headerIcon?: CellIconSpec | null;
}

function isGroupDef<T>(d: AnyColDef<T>): d is ColGroupDef<T> {
  return Array.isArray((d as ColGroupDef<T>).children);
}

export function leafColId<T>(d: ColDef<T>): string {
  return d.colId ?? d.field ?? '';
}

export function walkLeafCols<T>(
  defs: AnyColDef<T>[] | undefined,
  visit: (col: ColDef<T>) => void,
): void {
  if (!defs) return;
  for (const d of defs) {
    if (isGroupDef(d)) walkLeafCols(d.children, visit);
    else visit(d);
  }
}

export function allLeafColIds<T>(api: Tabular<T>): string[] {
  const ids: string[] = [];
  walkLeafCols(api.getGridOption('columnDefs') as AnyColDef<T>[] | undefined, (c) => {
    const id = leafColId(c);
    if (id) ids.push(id);
  });
  return ids;
}

/** Columns under the current cell range, else the focused cell column. */
export function selectedColIds<T>(api: Tabular<T>): string[] {
  const ids = new Set<string>();
  const ranges = api.getCellRanges();
  if (ranges.length) {
    const order = api.getColumnState().map((c) => c.colId);
    const indexOf = (id: string) => {
      const i = order.indexOf(id);
      return i >= 0 ? i : 0;
    };
    for (const r of ranges) {
      const a = indexOf(r.start.colId);
      const b = indexOf(r.end.colId);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let i = lo; i <= hi; i++) {
        const id = order[i];
        if (id) ids.add(id);
      }
    }
  }
  if (!ids.size) {
    const focused = api.getFocusedCell();
    if (focused?.colId) ids.add(focused.colId);
  }
  return [...ids];
}

export function resolveTargetColIds<T>(
  api: Tabular<T>,
  scope: 'selected' | 'all',
): string[] {
  if (scope === 'all') return allLeafColIds(api);
  return selectedColIds(api);
}

/** Immutable tree map — only clones nodes on the path to patched leaves. */
export function mapLeafCols<T>(
  defs: AnyColDef<T>[],
  colIds: ReadonlySet<string>,
  patch: (col: ColDef<T>) => ColDef<T>,
): AnyColDef<T>[] {
  return defs.map((d) => {
    if (isGroupDef(d)) {
      const children = mapLeafCols(d.children, colIds, patch);
      if (children === d.children) return d;
      return { ...d, children };
    }
    const id = leafColId(d);
    if (!id || !colIds.has(id)) return d;
    return patch(d);
  });
}

function stripSidePrefix(spec: string): string {
  const m = spec.match(/^(all|top|bottom|left|right):(.+)$/i);
  return m ? m[2]!.trim() : spec;
}

/** Merge one side into a multi-side border map (ribbon Borders section). */
export function mergeBorder(
  existing: CellStyle['border'] | undefined,
  side: BorderSide,
  spec: string,
): Partial<Record<BorderSide, string>> {
  const map: Partial<Record<BorderSide, string>> = {};
  if (typeof existing === 'string') {
    const m = existing.match(/^(all|top|bottom|left|right):(.+)$/i);
    if (m) map[m[1]!.toLowerCase() as BorderSide] = m[2]!.trim();
    else map.all = existing;
  } else if (existing && typeof existing === 'object') {
    for (const [k, v] of Object.entries(existing)) {
      if (v) map[k as BorderSide] = stripSidePrefix(v);
    }
  }
  map[side] = stripSidePrefix(spec);
  return map;
}

function mergeBorderIntoStyle(prev: CellStyle | undefined, patchBorder: CellStyle['border']): CellStyle['border'] {
  if (patchBorder == null) return undefined;
  if (typeof patchBorder === 'string') {
    const m = patchBorder.match(/^(all|top|bottom|left|right):(.+)$/i);
    if (m) return mergeBorder(prev?.border, m[1]!.toLowerCase() as BorderSide, m[2]!.trim());
    return mergeBorder(prev?.border, 'all', patchBorder);
  }
  let border = prev?.border;
  for (const [side, spec] of Object.entries(patchBorder)) {
    if (!spec) continue;
    border = mergeBorder(border, side as BorderSide, spec);
  }
  return border;
}

function mergeCellStyle<T>(
  prev: ColDef<T>['cellStyle'],
  patch: CellStyle,
): ColDef<T>['cellStyle'] {
  if (typeof prev === 'function') {
    const prevFn = prev;
    return (params) => {
      const base = prevFn(params) ?? {};
      const next: CellStyle = { ...base, ...patch };
      if (patch.border !== undefined) {
        next.border = mergeBorderIntoStyle(base, patch.border);
      }
      return next;
    };
  }
  const base = prev ?? {};
  const next: CellStyle = { ...base, ...patch };
  if (patch.border !== undefined) {
    next.border = mergeBorderIntoStyle(base, patch.border);
  }
  return next;
}

function mergeHeaderStyle(prev: CellStyle | undefined, patch: CellStyle): CellStyle {
  const next: CellStyle = { ...(prev ?? {}), ...patch };
  if (patch.border !== undefined) {
    next.border = mergeBorderIntoStyle(prev, patch.border);
  }
  return next;
}

function clearStaticStyleKeys(prev: CellStyle | undefined): CellStyle | undefined {
  if (!prev) return undefined;
  const next = { ...prev };
  delete next.color;
  delete next.background;
  delete next.backgroundColor;
  delete next.fontWeight;
  delete next.fontStyle;
  delete next.textDecoration;
  delete next.border;
  delete next.fontSize;
  delete next.textTransform;
  return Object.keys(next).length ? next : undefined;
}

function clearStaticCellStyleKeys<T>(
  prev: ColDef<T>['cellStyle'],
): ColDef<T>['cellStyle'] | undefined {
  if (typeof prev === 'function') return prev;
  return clearStaticStyleKeys(prev);
}

export function applyColumnFormat<T>(
  api: Tabular<T>,
  colIds: string[],
  format: string | null,
): boolean {
  if (!colIds.length) return false;
  const defs = api.getGridOption('columnDefs') as AnyColDef<T>[] | undefined;
  if (!defs?.length) return false;
  const set = new Set(colIds);
  const next = mapLeafCols(defs, set, (col) => {
    const patched = { ...col };
    if (format == null || format === '') delete patched.format;
    else {
      patched.format = format;
      if (!patched.type && looksNumericFormat(format)) patched.type = 'number';
    }
    return patched;
  });
  api.setColumnDefs(next);
  return true;
}

export function applyColumnStyle<T>(
  api: Tabular<T>,
  colIds: string[],
  stylePatch: CellStyle,
  opts?: { clearKeys?: Array<keyof CellStyle> },
): boolean {
  if (!colIds.length) return false;
  const defs = api.getGridOption('columnDefs') as AnyColDef<T>[] | undefined;
  if (!defs?.length) return false;
  const set = new Set(colIds);
  const next = mapLeafCols(defs, set, (col) => {
    let style = mergeCellStyle(col.cellStyle, stylePatch);
    if (opts?.clearKeys?.length && style && typeof style === 'object') {
      const copy = { ...(style as CellStyle) };
      for (const k of opts.clearKeys) delete copy[k];
      style = Object.keys(copy).length ? copy : undefined;
    }
    return { ...col, cellStyle: style };
  });
  api.setColumnDefs(next);
  return true;
}

export function applyColumnHeaderStyle<T>(
  api: Tabular<T>,
  colIds: string[],
  stylePatch: CellStyle,
  opts?: { clearKeys?: Array<keyof CellStyle> },
): boolean {
  if (!colIds.length) return false;
  const defs = api.getGridOption('columnDefs') as AnyColDef<T>[] | undefined;
  if (!defs?.length) return false;
  const set = new Set(colIds);
  const next = mapLeafCols(defs, set, (col) => {
    let style: CellStyle | undefined = mergeHeaderStyle(col.headerStyle, stylePatch);
    if (opts?.clearKeys?.length && style) {
      const copy = { ...style };
      for (const k of opts.clearKeys) delete copy[k];
      style = Object.keys(copy).length ? copy : undefined;
    }
    const patched = { ...col };
    if (!style) delete patched.headerStyle;
    else patched.headerStyle = style;
    return patched;
  });
  api.setColumnDefs(next);
  return true;
}

export function applyColumnIcon<T>(
  api: Tabular<T>,
  colIds: string[],
  icon: CellIconSpec | null,
  target: StyleTarget,
): boolean {
  if (!colIds.length) return false;
  const defs = api.getGridOption('columnDefs') as AnyColDef<T>[] | undefined;
  if (!defs?.length) return false;
  const set = new Set(colIds);
  const key = target === 'header' ? 'headerIcon' : 'cellIcon';
  const next = mapLeafCols(defs, set, (col) => {
    const patched = { ...col };
    if (icon == null) delete patched[key];
    else patched[key] = icon;
    return patched;
  });
  api.setColumnDefs(next);
  return true;
}

export function applyColumnAlign<T>(
  api: Tabular<T>,
  colIds: string[],
  align: Align,
): boolean {
  if (!colIds.length) return false;
  const defs = api.getGridOption('columnDefs') as AnyColDef<T>[] | undefined;
  if (!defs?.length) return false;
  const set = new Set(colIds);
  const next = mapLeafCols(defs, set, (col) => ({ ...col, align }));
  api.setColumnDefs(next);
  return true;
}

export function clearColumnFormatting<T>(api: Tabular<T>, colIds: string[]): boolean {
  if (!colIds.length) return false;
  const defs = api.getGridOption('columnDefs') as AnyColDef<T>[] | undefined;
  if (!defs?.length) return false;
  const set = new Set(colIds);
  const next = mapLeafCols(defs, set, (col) => {
    const patched = { ...col };
    delete patched.format;
    delete patched.cellIcon;
    delete patched.headerIcon;
    const style = clearStaticCellStyleKeys(col.cellStyle);
    if (style === undefined) delete patched.cellStyle;
    else patched.cellStyle = style;
    const hs = clearStaticStyleKeys(col.headerStyle);
    if (hs === undefined) delete patched.headerStyle;
    else patched.headerStyle = hs;
    return patched;
  });
  api.setColumnDefs(next);
  return true;
}

export function readColumnChrome<T>(
  api: Tabular<T>,
  colIds: string[],
): ColumnChromeState {
  const state: ColumnChromeState = { colIds, style: {}, headerStyle: {} };
  if (!colIds.length) return state;
  const want = colIds[0]!;
  walkLeafCols(api.getGridOption('columnDefs') as AnyColDef<T>[] | undefined, (c) => {
    if (leafColId(c) !== want) return;
    state.format = c.format;
    state.align = c.align;
    if (c.cellStyle && typeof c.cellStyle === 'object') state.style = { ...c.cellStyle };
    if (c.headerStyle) state.headerStyle = { ...c.headerStyle };
    state.cellIcon = c.cellIcon ?? null;
    state.headerIcon = c.headerIcon ?? null;
  });
  return state;
}

export function resolveFormatCode(format: string | undefined): string {
  if (!format) return '';
  if (isPresetName(format)) return presetCode(format as FormatPresetName) || format;
  return format;
}

export function decimalsOf(format: string | undefined): number {
  const code = resolveFormatCode(format);
  if (!code) return 2;
  const m = code.match(/\.([0#]+)/);
  return m ? m[1]!.length : 0;
}

/** Plain thousands pattern with N decimals (Excel-style). */
export function numberFormat(decimals: number): string {
  const d = Math.max(0, Math.min(10, Math.floor(decimals)));
  return d === 0 ? '#,##0' : `#,##0.${'0'.repeat(d)}`;
}

export function currencyFormat(decimals: number): string {
  const n = numberFormat(decimals);
  return `$${n};($${n})`;
}

export function percentFormat(decimals: number): string {
  const d = Math.max(0, Math.min(10, Math.floor(decimals)));
  return d === 0 ? '0%' : `0.${'0'.repeat(d)}%`;
}

function looksNumericFormat(format: string): boolean {
  if (isPresetName(format)) {
    return format === 'number' || format === 'currency' || format === 'percent' || format === 'abbreviated';
  }
  return /[#0%]/.test(format) || format.includes('$');
}

/** Adjust decimal places while preserving currency / percent flavour when possible. */
export function adjustDecimals(format: string | undefined, delta: number): string {
  const code = resolveFormatCode(format);
  const next = Math.max(0, Math.min(10, decimalsOf(format) + delta));
  if (!code) return numberFormat(next);
  if (/%/.test(code) || format === 'percent') return percentFormat(next);
  if (/\$/.test(code) || format === 'currency') return currencyFormat(next);
  return numberFormat(next);
}
