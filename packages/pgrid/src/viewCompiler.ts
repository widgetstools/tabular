/**
 * Pure GridState → Perspective view-config compiler (spec §4). Mirrors the
 * engine's config shape without importing from @finos/perspective — this
 * module sits above the P4 engine-swap seam (Global Constraints).
 */
import type { GridState } from './types';

/** Structural mirror of the engine view config; keep free of @finos imports. */
export interface PspViewConfig {
  group_by: string[];
  split_by: string[];
  columns: string[];
  aggregates: Record<string, string>;
  sort: string[][];
  filter: (string | number | boolean)[][];
}

/**
 * Engine meta columns that must never leak as user columns (spec §5.2 —
 * per-level `__ROW_PATH_n__` variants can appear inline in window reads).
 */
export const META_COLUMN_RE = /^__(?:ROW_PATH(?:_\d+)?|ID|GROUPING_ID)__$/;

/** Filter ops that map 1:1 onto engine filter tuples. */
const PASSTHROUGH_OPS = new Set(['==', '!=', '<', '<=', '>', '>=', 'contains']);

/** Compile grid state into the single view config that IS the row model. */
export function compileView(state: GridState): PspViewConfig {
  const group_by = [...state.rowGroupCols];
  // split_by only applies in pivot mode; pivotCols persist as latent state.
  const split_by = state.pivotMode ? [...state.pivotCols] : [];
  const aggregated = group_by.length > 0 || split_by.length > 0;
  const columns = aggregated
    ? state.valueCols.map((v) => v.field)
    : state.columnDefs.map((d) => d.field);
  const aggregates: Record<string, string> = {};
  for (const v of state.valueCols) aggregates[v.field] = v.aggFunc;
  // Sort tuples pass through only for columns the view exposes; grouped views
  // sort on the aggregated values (engine semantics), same tuple encoding.
  const sort = state.sortModel
    .filter((s) => columns.includes(s.colId))
    .map((s) => [s.colId, s.sort]);
  const filter: (string | number | boolean)[][] = [];
  for (const [field, f] of Object.entries(state.filterModel)) {
    if (f.op === 'isNull') {
      filter.push([field, 'is null']); // engine null test is a two-element tuple
    } else if (PASSTHROUGH_OPS.has(f.op)) {
      filter.push([field, f.op, f.value as string | number | boolean]);
    } else {
      throw new Error(`pgrid: unsupported filter op '${f.op}' on '${field}'`);
    }
  }
  return { group_by, split_by, columns, aggregates, sort, filter };
}

/**
 * Key-order-insensitive for aggregates and filter rows (sets by nature),
 * order-sensitive everywhere else (group/split/column/sort order is meaning).
 */
function normalize(cfg: PspViewConfig): PspViewConfig {
  return {
    group_by: cfg.group_by,
    split_by: cfg.split_by,
    columns: cfg.columns,
    aggregates: Object.fromEntries(
      Object.entries(cfg.aggregates).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    sort: cfg.sort,
    filter: [...cfg.filter]
      .map((row) => JSON.stringify(row))
      .sort()
      .map((row) => JSON.parse(row) as (string | number | boolean)[]),
  };
}

/** Equivalence fast-path: true → the live view can be reused (spec §5.5). */
export function isEquivalent(a: PspViewConfig, b: PspViewConfig): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

/**
 * Index of the measure name inside a split column path — defined ONCE here
 * (spec §5.6); never repeat `split_by.length` inline elsewhere.
 */
export function measureIndex(cfg: PspViewConfig): number {
  return cfg.split_by.length;
}

/** Split a pivot column path "A|B|measure" into its group parts and measure. */
export function splitPath(path: string, cfg: PspViewConfig): { groups: string[]; measure: string } {
  const parts = path.split('|');
  const mi = measureIndex(cfg);
  return { groups: parts.slice(0, mi), measure: parts[mi] ?? path };
}
