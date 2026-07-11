/**
 * Pure viewport-window math for the recycled row pool. DOM-free so it is
 * testable with a plain tsx script (repo convention — no test framework).
 */

export interface ViewportWindow {
  firstRow: number;
  lastRow: number;
}

/** Rows the pool must currently display, including overscan on both edges. */
export function computeWindow(
  scrollTop: number,
  viewportH: number,
  rowHeight: number,
  rowCount: number,
  overscan = 8,
): ViewportWindow {
  if (rowCount <= 0) return { firstRow: 0, lastRow: -1 };
  const visible = Math.ceil(viewportH / rowHeight);
  const anchor = Math.floor(scrollTop / rowHeight);
  const first = Math.max(0, anchor - overscan);
  const last = Math.min(rowCount - 1, anchor + visible - 1 + overscan);
  return { firstRow: Math.min(first, last), lastRow: last };
}

/** Fixed element count covering every window the viewport can produce. */
export function poolSize(
  viewportH: number,
  rowHeight: number,
  rowCount: number,
  overscan = 8,
): number {
  const visible = Math.ceil(viewportH / rowHeight);
  return Math.max(1, Math.min(rowCount, visible + 1 + overscan * 2));
}

/**
 * Stable slot assignment: rows `size` apart share a slot, so advancing the
 * window by one row rebinds exactly one element (DOM analog of the canvas
 * scroll blit).
 */
export function poolSlot(rowIndex: number, size: number): number {
  return rowIndex % size;
}
