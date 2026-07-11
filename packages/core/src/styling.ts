/**
 * Canvas styling: resolves AG-shaped cell/row class rules and inline styles
 * into paint attributes. CSS classes map through `GridOptions.classStyles`.
 */
import type { CellParams, CellStyle, ColDef, GridOptions, RowStyleParams } from './types';

export type ClassRule<TData = unknown> =
  | string
  | ((params: CellParams<TData>) => boolean);

export type RowClassRule<TData = unknown> =
  | string
  | ((params: RowStyleParams<TData>) => boolean);

export type RowStyle = CellStyle;

function evalCellRule<TData>(rule: ClassRule<TData>, params: CellParams<TData>): boolean {
  if (typeof rule === 'function') return !!rule(params);
  try {
    const fn = new Function(
      'x',
      'data',
      'rowIndex',
      'api',
      'ctx',
      'colDef',
      `return !!(${rule})`,
    ) as (x: unknown, data: unknown, rowIndex: number, api: unknown, ctx: unknown, colDef: unknown) => boolean;
    return fn(params.value, params.data, params.rowIndex, params.api, undefined, params.colDef);
  } catch {
    return false;
  }
}

function evalRowRule<TData>(rule: RowClassRule<TData>, params: RowStyleParams<TData>): boolean {
  if (typeof rule === 'function') return !!rule(params);
  try {
    const fn = new Function(
      'data',
      'rowIndex',
      'api',
      'ctx',
      'node',
      `return !!(${rule})`,
    ) as (data: unknown, rowIndex: number, api: unknown, ctx: unknown, node: unknown) => boolean;
    return fn(params.data, params.rowIndex, params.api, params.context, params.node);
  } catch {
    return false;
  }
}

function classesFromRules<TData>(
  rules: Record<string, ClassRule<TData>> | undefined,
  params: CellParams<TData>,
): string[] {
  if (!rules) return [];
  const out: string[] = [];
  for (const [cls, rule] of Object.entries(rules)) {
    if (evalCellRule(rule, params)) out.push(cls);
  }
  return out;
}

function rowClassesFromRules<TData>(
  rules: Record<string, RowClassRule<TData>> | undefined,
  params: RowStyleParams<TData>,
): string[] {
  if (!rules) return [];
  const out: string[] = [];
  for (const [cls, rule] of Object.entries(rules)) {
    if (evalRowRule(rule, params)) out.push(cls);
  }
  return out;
}

function normalizeClasses<TData>(
  cellClass: string | string[] | ((params: CellParams<TData>) => string | string[] | undefined) | undefined,
  params: CellParams<TData>,
): string[] {
  if (!cellClass) return [];
  const raw = typeof cellClass === 'function' ? cellClass(params) : cellClass;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function normalizeRowClasses<TData>(
  rowClass: string | string[] | ((params: RowStyleParams<TData>) => string | string[] | undefined) | undefined,
  params: RowStyleParams<TData>,
): string[] {
  if (!rowClass) return [];
  const raw = typeof rowClass === 'function' ? rowClass(params) : rowClass;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function stylesForClasses(
  classes: string[],
  classStyles: Record<string, CellStyle> | undefined,
): CellStyle | undefined {
  if (!classStyles || !classes.length) return undefined;
  const merged: CellStyle = {};
  for (const cls of classes) {
    const s = classStyles[cls];
    if (s) Object.assign(merged, s);
  }
  return Object.keys(merged).length ? merged : undefined;
}

function mergeStyles(...parts: (CellStyle | null | undefined)[]): CellStyle | undefined {
  const merged: CellStyle = {};
  for (const p of parts) {
    if (!p) continue;
    Object.assign(merged, p);
  }
  return Object.keys(merged).length ? merged : undefined;
}

export function resolveCellPaintStyle<TData>(
  colDef: ColDef<TData>,
  params: CellParams<TData>,
  classStyles: Record<string, CellStyle> | undefined,
): CellStyle | undefined {
  const ruleClasses = classesFromRules(colDef.cellClassRules, params);
  const staticClasses = normalizeClasses(colDef.cellClass, params);
  const inline =
    typeof colDef.cellStyle === 'function' ? colDef.cellStyle(params) : colDef.cellStyle;
  return mergeStyles(
    stylesForClasses(staticClasses, classStyles),
    stylesForClasses(ruleClasses, classStyles),
    inline,
  );
}

export function resolveRowPaintStyle<TData>(
  options: Pick<
    GridOptions<TData>,
    'rowStyle' | 'getRowStyle' | 'rowClass' | 'getRowClass' | 'rowClassRules' | 'classStyles' | 'context'
  >,
  params: RowStyleParams<TData>,
): CellStyle | undefined {
  const staticClasses = normalizeRowClasses(options.rowClass, params);
  const dynamicClasses = normalizeRowClasses(options.getRowClass, params);
  const ruleClasses = rowClassesFromRules(options.rowClassRules, params);
  const inline = options.getRowStyle?.(params) ?? options.rowStyle;
  return mergeStyles(
    stylesForClasses(staticClasses, options.classStyles),
    stylesForClasses(dynamicClasses, options.classStyles),
    stylesForClasses(ruleClasses, options.classStyles),
    inline,
  );
}

/** Params handed to cell-style / value-format resolver chain entries. */
export type ResolverCellParams<TData = unknown> = CellParams<TData> & {
  colId: string;
  /** Stable row id when available (worker-owned mode may lack `data`). */
  rowId?: string;
};

/**
 * One entry in the cell-style resolver chain (Phase 0 seam). Entries mutate
 * `style` in place — rules and format tiers write computed attributes here.
 * Registered via `api.addCellStyleResolver`; the chain is skipped entirely
 * (single length check) when empty.
 */
export type CellStyleResolver<TData = unknown> = (
  params: ResolverCellParams<TData>,
  style: CellStyle,
) => void;

/**
 * One entry in the value-format resolver chain. First entry returning a
 * string wins (priority order); undefined falls through to `valueFormatter`
 * and the default numeric/text formatting.
 */
export type ValueFormatResolver<TData = unknown> = (
  params: ResolverCellParams<TData>,
) => string | undefined;

// Pooled scratch style — resolver output is consumed within the same cell
// iteration, so one module-level object serves every cell with zero per-cell
// allocation. Cleared (not reallocated) between cells.
const SCRATCH_STYLE: Record<string, unknown> = {};

/** Run the style chain over a base style into the pooled scratch object. */
export function applyCellStyleChain<TData>(
  chain: ReadonlyArray<CellStyleResolver<TData>>,
  params: ResolverCellParams<TData>,
  base: CellStyle | undefined,
): CellStyle | undefined {
  for (const key of Object.keys(SCRATCH_STYLE)) delete SCRATCH_STYLE[key];
  if (base) Object.assign(SCRATCH_STYLE, base);
  for (const entry of chain) entry(params, SCRATCH_STYLE as CellStyle);
  return Object.keys(SCRATCH_STYLE).length ? (SCRATCH_STYLE as CellStyle) : undefined;
}

/** Whether a column should flash on data change (AG `enableCellChangeFlash`). */
export function cellChangeFlashEnabled<TData>(colDef: ColDef<TData>): boolean {
  if (colDef.enableCellChangeFlash === true) return true;
  if (colDef.flashOnChange === true) return true;
  if (colDef.enableCellChangeFlash === false || colDef.flashOnChange === false) return false;
  // Tabular default: number columns flash on change (signature blotter behaviour).
  return colDef.type === 'number';
}
