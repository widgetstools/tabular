/**
 * Pure percent-scroll window math (spec §6). No imports — keeps the render
 * plane free of engine types and independently testable.
 *
 * Browsers cap element heights around ~33.5M px; we clamp the scroll panel at
 * 10M px and map scroll position to row space proportionally, so any row
 * count survives. Element coordinates never see the clamp: rows position
 * window-relatively inside a layer placed at the window top.
 */

/** Hard ceiling for the spacer element height. */
export const MAX_PANEL_PX = 10_000_000;

/** Shared default so viewport and pool sizing stay collision-free when callers omit overscan. */
const DEFAULT_OVERSCAN = 4;

export interface Viewport {
  firstRow: number;
  lastRow: number;
  /** Fractional part of the anchor row, in px — applied as a CSS transform on the row layer. */
  subCellPx: number;
  /**
   * Floored anchor row (the row whose top sits at `scrollTop - subCellPx`).
   * Lets the grid place the row layer as `scrollTop - (anchor - firstRow) *
   * rowHeight` without re-deriving the percent mapping.
   */
  anchor: number;
}

/** Spacer height for rowCount rows: exact until it would exceed MAX_PANEL_PX, clamped after. */
export function panelHeight(rowCount: number, rowHeight: number, headerPx: number): number {
  return Math.min(rowCount * rowHeight + headerPx, MAX_PANEL_PX);
}

/**
 * Map scrollTop to a row window. Exact pixel mapping while the panel is
 * unclamped; once clamped, scroll percent maps onto the scrollable row range
 * so the bottom of the panel lands exactly on the last page.
 */
export function computeViewport(
  scrollTop: number,
  panelH: number,
  clipH: number,
  rowCount: number,
  rowHeight: number,
  overscan: number = DEFAULT_OVERSCAN,
): Viewport {
  if (rowCount <= 0) return { firstRow: 0, lastRow: -1, subCellPx: 0, anchor: 0 };
  const top = Math.max(0, Math.min(scrollTop, panelH - clipH));
  let anchorFloat: number;
  if (rowCount * rowHeight <= panelH) {
    anchorFloat = top / rowHeight;
  } else {
    const scrollable = panelH - clipH;
    const percent = scrollable > 0 ? top / scrollable : 0;
    anchorFloat = percent * (rowCount - clipH / rowHeight);
  }
  const anchor = Math.min(rowCount - 1, Math.max(0, Math.floor(anchorFloat)));
  const firstRow = Math.max(0, anchor - overscan);
  const lastRow = Math.min(rowCount - 1, firstRow + Math.ceil(clipH / rowHeight) + 2 * overscan);
  return { firstRow, lastRow, subCellPx: (anchorFloat % 1) * rowHeight, anchor };
}

/** Slot count that covers any window computeViewport can produce with the same inputs. */
export function poolSize(
  clipH: number,
  rowHeight: number,
  rowCount: number,
  overscan: number = DEFAULT_OVERSCAN,
): number {
  return Math.max(1, Math.min(rowCount, Math.ceil(clipH / rowHeight) + 1 + 2 * overscan));
}

/** Position-keyed slot assignment: consecutive rows never collide within one pool-sized window. */
export function poolSlot(rowIndex: number, size: number): number {
  return rowIndex % size;
}

/**
 * Horizontal window over explicit ColDef widths (no DOM measurement — widths
 * are authoritative, spec §6). leftPx is the accumulated left edge of
 * firstCol, for absolute cell placement.
 */
export function visibleCols(
  scrollLeft: number,
  clipW: number,
  widths: number[],
  overscan: number = DEFAULT_OVERSCAN,
): { firstCol: number; lastCol: number; leftPx: number } {
  if (widths.length === 0) return { firstCol: 0, lastCol: -1, leftPx: 0 };
  let firstCol = 0;
  let leftPx = 0;
  let x = 0;
  for (let i = 0; i < widths.length; i++) {
    if (x + widths[i] > scrollLeft) {
      firstCol = i;
      leftPx = x;
      break;
    }
    x += widths[i];
    firstCol = i + 1;
    leftPx = x;
  }
  if (firstCol >= widths.length) {
    // Scrolled past all columns; pin to the last one.
    firstCol = widths.length - 1;
    leftPx = x - widths[firstCol];
  }
  let lastCol = firstCol;
  let right = leftPx;
  for (let i = firstCol; i < widths.length; i++) {
    lastCol = i;
    right += widths[i];
    if (right >= scrollLeft + clipW) break;
  }
  for (let i = 0; i < overscan && firstCol > 0; i++) {
    firstCol -= 1;
    leftPx -= widths[firstCol];
  }
  lastCol = Math.min(widths.length - 1, lastCol + overscan);
  return { firstCol, lastCol, leftPx };
}
