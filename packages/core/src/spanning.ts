/**
 * Cell spanning (AG v33+ parity).
 *
 * - `colDef.colSpan(params) => n`: a cell paints across the next n-1 columns
 *   of its own pinned region (spans never cross region boundaries).
 * - `gridOptions.enableCellSpan` + `colDef.spanRows`: vertically-contiguous
 *   leaf cells with equal values (or a custom merge callback) render as one
 *   merged cell. Anchor semantics match AG: the first row of a span is the
 *   anchor, and the merge callback always compares the anchor (`valueA`)
 *   against the next candidate row (`valueB`).
 */
import type { InternalColumn, Region } from './columnModel';
import type { RowModel } from './rowModel';
import type { Tabular } from './grid';
import type { SpanRowsParams } from './types';

/** The slice of PaintEnv the span math needs (structurally satisfied by PaintEnv). */
export interface SpanEnv<TData = unknown> {
  rows: RowModel<TData>;
  api: Tabular<TData>;
  valueAtDisplayed: (rowIndex: number, col: InternalColumn<TData>) => unknown;
  pagination?: { pageStart: number; pageEnd: number };
  enableCellSpan?: boolean;
}

// ── column spanning ─────────────────────────────────────────────────────

/** Number of columns the cell at (rowIndex, region[colIndex]) spans. Min 1. */
export function colSpanCount<TData>(
  env: SpanEnv<TData>,
  rowIndex: number,
  region: Region<TData>,
  colIndex: number,
): number {
  const col = region.cols[colIndex];
  const fn = col?.def.colSpan;
  if (!fn) return 1;
  const node = env.rows.getDisplayedNode(rowIndex);
  if (!node) return 1;
  const span = Math.floor(
    fn({
      value: env.valueAtDisplayed(rowIndex, col),
      data: (node.data ?? undefined) as TData,
      rowIndex,
      colDef: col.def,
      api: env.api,
    }),
  );
  if (!Number.isFinite(span) || span <= 1) return 1;
  // Constrained to the pinned region (AG parity).
  return Math.min(span, region.cols.length - colIndex);
}

/**
 * If (rowIndex, colIndex) is covered by a col-spanning cell to its left,
 * returns the anchor column index; otherwise returns colIndex.
 */
export function colSpanAnchorIndex<TData>(
  env: SpanEnv<TData>,
  rowIndex: number,
  region: Region<TData>,
  colIndex: number,
): number {
  for (let k = colIndex - 1; k >= 0; k--) {
    if (!region.cols[k].def.colSpan) continue;
    if (k + colSpanCount(env, rowIndex, region, k) > colIndex) return k;
  }
  return colIndex;
}

/** True when any column in the region declares `colSpan`. */
export function regionHasColSpan<TData>(region: Region<TData>): boolean {
  return region.cols.some((c) => !!c.def.colSpan);
}

// ── row spanning ────────────────────────────────────────────────────────

/** Row spanning is live for this column (option + colDef, colSpan wins). */
export function spanRowsActive<TData>(env: SpanEnv<TData>, col: InternalColumn<TData>): boolean {
  return env.enableCellSpan === true && !!col.def.spanRows && !col.def.colSpan;
}

/** Anchor-vs-next merge test. Group/footer rows never merge. */
function merges<TData>(
  env: SpanEnv<TData>,
  col: InternalColumn<TData>,
  anchorRow: number,
  nextRow: number,
): boolean {
  const a = env.rows.getDisplayedNode(anchorRow);
  const b = env.rows.getDisplayedNode(nextRow);
  if (!a || !b || a.group || b.group || a.footer || b.footer) return false;
  const valueA = env.valueAtDisplayed(anchorRow, col);
  const valueB = env.valueAtDisplayed(nextRow, col);
  const s = col.def.spanRows;
  if (typeof s === 'function') {
    const params: SpanRowsParams<TData> = {
      nodeA: { data: a.data },
      valueA,
      nodeB: { data: b.data },
      valueB,
      colDef: col.def,
      api: env.api,
    };
    return s(params);
  }
  return valueA != null && valueA === valueB;
}

/**
 * The span [start, end] (inclusive, displayed indices) containing rowIndex
 * for a `spanRows` column. Single-row cells return start === end.
 * Bounded by the pagination page so spans never bleed across pages.
 */
export function rowSpanRange<TData>(
  env: SpanEnv<TData>,
  rowIndex: number,
  col: InternalColumn<TData>,
): { start: number; end: number } {
  const lo = env.pagination?.pageStart ?? 0;
  const hi = (env.pagination?.pageEnd ?? env.rows.displayed.length) - 1;
  const node = env.rows.getDisplayedNode(rowIndex);
  if (!node || node.group || node.footer) return { start: rowIndex, end: rowIndex };

  // Pairwise walk-up finds the top of the contiguous mergeable run…
  let top = rowIndex;
  while (top > lo && merges(env, col, top - 1, top)) top--;
  // …then spans are derived downward with anchor semantics (AG behavior for
  // custom callbacks: valueA is always the span's first row).
  let start = top;
  for (;;) {
    let end = start;
    while (end < hi && merges(env, col, start, end + 1)) end++;
    if (rowIndex <= end) return { start, end };
    start = end + 1;
  }
}
