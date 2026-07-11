/**
 * Canvas painting for header + body. Repaints the visible window per
 * invalidation (rAF-coalesced by the grid). Text measurement is LRU-cached;
 * truncation decisions are cached per (font, string, width).
 */
import { AUTO_GROUP_COL_ID } from './grouping';
import { SELECTION_COL_ID, type ColumnModel, type InternalColumn, type Region } from './columnModel';
import type { HeaderGroupSpan, HeaderLayout } from './columnGroups';
import type { RowModel } from './rowModel';
import type { FlashManager } from './flash';
import type { ResolvedTheme } from './theme';
import { withAlpha } from './theme';
import { formatFilterDisplay } from './filters';
import { drawIcon, type IconName } from './icons';
import type {
  CellParams,
  CellPosition,
  CellRenderParams,
  CellStyle,
  FullWidthCellRenderParams,
  RowStyleParams,
} from './types';
import type { Tabular } from './grid';
import type { CellRendererComp } from './registry';
import {
  applyCellStyleChain,
  cellChangeFlashEnabled,
  resolveCellPaintStyle,
  resolveRowPaintStyle,
  type CellStyleResolver,
} from './styling';
import {
  colSpanAnchorIndex,
  colSpanCount,
  regionHasColSpan,
  rowSpanRange,
  spanRowsActive,
} from './spanning';

/** Grid borders render at 85% opacity. */
const GRIDLINE_ALPHA = 0.85;
const gridlineColor = (t: ResolvedTheme): string => withAlpha(t.gridline, GRIDLINE_ALPHA);
/** Clear control width in floating filter cells. */
export const FLOATING_FILTER_CLEAR_SIZE = 18;
/** Funnel button lane to the right of the floating-filter input (AG parity). */
export const FLOATING_FILTER_FUNNEL_SIZE = 16;
const FLOATING_FILTER_PAD = 5;

/** Inner input-box geometry of a floating filter cell (cell-relative). */
export function floatingFilterInputGeom(
  cellW: number,
  cellH: number,
): { x: number; y: number; w: number; h: number } {
  const w = Math.max(12, cellW - FLOATING_FILTER_PAD * 2 - FLOATING_FILTER_FUNNEL_SIZE - 4);
  const h = Math.min(cellH - 8, 24);
  return { x: FLOATING_FILTER_PAD, y: (cellH - h) / 2, w, h };
}

export interface PaintEnv<TData = unknown> {
  theme: ResolvedTheme;
  cols: ColumnModel<TData>;
  rows: RowModel<TData>;
  flash: FlashManager;
  scrollLeft: number;
  scrollTop: number;
  viewWidth: number;
  viewHeight: number;
  focused: { rowIndex: number; colId: string } | null;
  selectedIds: ReadonlySet<string>;
  filteredColIds: ReadonlySet<string>;
  api: Tabular<TData>;
  valueOf: (row: TData, col: InternalColumn<TData>, rowIndex: number) => unknown;
  formatValue: (row: TData, col: InternalColumn<TData>, rowIndex: number) => string;
  valueAtDisplayed: (rowIndex: number, col: InternalColumn<TData>) => unknown;
  formatDisplayed: (rowIndex: number, col: InternalColumn<TData>) => string;
  enableFlash: boolean;
  range: { start: CellPosition; end: CellPosition } | null;
  /** Draw the fill handle at the range's bottom-right corner. */
  fillHandle: boolean;
  /** Fill-drag target preview (dashed outline), in displayed row/col indices. */
  fillPreview: { row0: number; row1: number; col0: number; col1: number } | null;
  /** Column with an open floating-filter DOM editor — skip canvas paint for that cell. */
  editingFloatingFilterColId: string | null;
  groupIndent: number;
  /** Header caption incl. agg func decoration, e.g. `sum(Notional)`. */
  headerLabel: (col: InternalColumn<TData>) => string;
  /** Client-side pagination slice (global row indices). */
  pagination?: { pageStart: number; pageEnd: number };
  /** Sticky group headers while scrolling within a group. Default true. */
  groupSticky?: boolean;
  /** Cell span feature flag — enables `colDef.spanRows` merging. */
  enableCellSpan?: boolean;
  /** Default data-row height (`options.rowHeight` ?? theme). */
  uniformRowHeight: number;
  /** Content offset of a displayed row from the top of the current page. */
  rowTop: (rowIndex: number) => number;
  /** Height of a displayed row (uniform unless getRowHeight / autoHeight). */
  rowHeightAt: (rowIndex: number) => number;
  /** Displayed row index at a page-local content Y (clamped). */
  rowAtY: (localY: number) => number;
  /** Total content height of the current page. */
  contentHeight: number;
  /** Full-width row test (AG `isFullWidthRow`), when configured. */
  isFullWidthRow?: (rowIndex: number) => boolean;
  /** Canvas painter for full-width rows. */
  fullWidthCellRenderer?: (
    ctx: CanvasRenderingContext2D,
    params: FullWidthCellRenderParams<TData>,
  ) => void;
  /** multiRow + header checkbox enabled. */
  headerCheckbox?: boolean;
  selectionAllSelected?: boolean;
  selectionSomeSelected?: boolean;
  classStyles?: Record<string, CellStyle>;
  rowStyle?: CellStyle;
  getRowStyle?: (params: RowStyleParams<TData>) => CellStyle | undefined;
  rowClass?: string | string[];
  getRowClass?: (params: RowStyleParams<TData>) => string | string[] | undefined;
  rowClassRules?: Record<string, string | ((params: RowStyleParams<TData>) => boolean)>;
  context?: unknown;
  /**
   * Resolve the effective canvas renderer for a cell (registered names,
   * `cellRendererSelector`). Column-level resolution is cached by the grid;
   * only columns with a selector pay a per-cell call.
   */
  rendererFor: (
    col: InternalColumn<TData>,
    params: CellParams<TData>,
  ) => CellRendererComp<TData> | null;
  /** Cell-style resolver chain (Phase 0 seam); null when no entries registered. */
  cellStyleChain: ReadonlyArray<CellStyleResolver<TData>> | null;
  /** Rule indicator badge lookup (Phase 4 — @tabular/rules). */
  ruleIndicator?: (rowId: string, colId: string) => {
    icon: string;
    position?: 'cell' | 'row-start' | 'row-end';
    color?: string;
  } | undefined;
}

function rowY<TData>(env: PaintEnv<TData>, rowIndex: number): number {
  return env.rowTop(rowIndex) - env.scrollTop;
}

/** Line height for wrapped cell text — shared with auto-height measurement. */
export function wrapLineHeight(t: ResolvedTheme): number {
  return Math.round(t.fontSize * 1.45);
}

/** Sticky group header for the current scroll position, if any. */
export function findStickyGroup<TData>(
  env: PaintEnv<TData>,
  firstRow: number,
): import('./grouping').DisplayedNode<TData> | null {
  if (env.groupSticky === false) return null;
  // Flat data has no group rows: skip the upward scan entirely (it would walk
  // all the way to row 0 on every paint once scrolled deep into the grid).
  if (!env.rows.hasGroupRows) return null;
  let groupIdx = -1;
  for (let r = firstRow; r >= 0; r--) {
    const n = env.rows.getDisplayedNode(r);
    if (n?.group && !n.footer) {
      groupIdx = r;
      break;
    }
  }
  if (groupIdx < 0 || groupIdx >= firstRow) return null;
  const first = env.rows.getDisplayedNode(firstRow);
  const group = env.rows.getDisplayedNode(groupIdx);
  if (!first || !group || first.level <= group.level) return null;
  return group;
}

function paintCheckbox(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  checked: boolean,
  t: ResolvedTheme,
  indeterminate = false,
): void {
  const size = 14;
  const cx = x + (w - size) / 2;
  const cy = y + (h - size) / 2;
  ctx.strokeStyle = checked || indeterminate ? t.accent : withAlpha(t.textSecondary, 0.55);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(cx + 0.75, cy + 0.75, size - 1.5, size - 1.5);
  if (checked || indeterminate) {
    ctx.fillStyle = checked ? t.accent : withAlpha(t.accent, 0.45);
    ctx.fillRect(cx + 2, cy + 2, size - 4, size - 4);
  }
  if (checked) {
    ctx.strokeStyle = t.base;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx + 3, cy + size / 2);
    ctx.lineTo(cx + size / 2 - 0.5, cy + size - 4);
    ctx.lineTo(cx + size - 3, cy + 3);
    ctx.stroke();
  } else if (indeterminate) {
    ctx.fillStyle = t.base;
    ctx.fillRect(cx + 3, cy + size / 2 - 1, size - 6, 2);
  }
}

const measureCache = new Map<string, number>();
const truncCache = new Map<string, string>();
const MAX_CACHE = 20_000;

function measure(ctx: CanvasRenderingContext2D, font: string, text: string): number {
  const key = `${font}\u0000${text}`;
  let w = measureCache.get(key);
  if (w === undefined) {
    if (measureCache.size > MAX_CACHE) measureCache.clear();
    w = ctx.measureText(text).width;
    measureCache.set(key, w);
  }
  return w;
}

function truncate(
  ctx: CanvasRenderingContext2D,
  font: string,
  text: string,
  maxWidth: number,
): string {
  if (measure(ctx, font, text) <= maxWidth) return text;
  const key = `${font}\u0000${text}\u0000${Math.round(maxWidth)}`;
  let out = truncCache.get(key);
  if (out === undefined) {
    if (truncCache.size > MAX_CACHE) truncCache.clear();
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (measure(ctx, font, text.slice(0, mid) + '…') <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    out = lo <= 0 ? '' : text.slice(0, lo) + '…';
    truncCache.set(key, out);
  }
  return out;
}

/** Underline / strikethrough for CellStyle.textDecoration (canvas has no CSS). */
function paintTextDecoration(
  ctx: CanvasRenderingContext2D,
  decoration: string | undefined,
  text: string,
  anchorX: number,
  baselineY: number,
  align: 'left' | 'right' | 'center',
  color: string,
): void {
  if (!decoration || decoration === 'none') return;
  const w = ctx.measureText(text).width;
  if (w <= 0) return;
  let left = anchorX;
  if (align === 'right') left = anchorX - w;
  else if (align === 'center') left = anchorX - w / 2;
  const prev = ctx.strokeStyle;
  const prevW = ctx.lineWidth;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  if (decoration.includes('underline')) {
    const y = Math.round(baselineY + 4) + 0.5;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + w, y);
    ctx.stroke();
  }
  if (decoration.includes('line-through')) {
    const y = Math.round(baselineY) + 0.5;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + w, y);
    ctx.stroke();
  }
  ctx.strokeStyle = prev;
  ctx.lineWidth = prevW;
}

/** Paint CellStyle.border — string or multi-side map from the format ribbon. */
function paintCellBorder(
  ctx: CanvasRenderingContext2D,
  border: CellStyle['border'] | undefined,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  if (!border) return;
  const edges: Array<{ side: 'all' | 'top' | 'bottom' | 'left' | 'right'; spec: string }> = [];
  if (typeof border === 'string') {
    edges.push({ side: 'all', spec: border });
  } else {
    for (const side of ['all', 'top', 'bottom', 'left', 'right'] as const) {
      const spec = border[side];
      if (spec) edges.push({ side, spec });
    }
  }
  for (const { side: sideKey, spec } of edges) {
    const sideMatch = spec.match(/^(all|top|bottom|left|right):(\d+(?:\.\d+)?)px\s+(\w+)\s+(.+)$/i);
    const allMatch = !sideMatch ? spec.match(/^(\d+(?:\.\d+)?)px\s+(\w+)\s+(.+)$/i) : null;
    let side: 'all' | 'top' | 'bottom' | 'left' | 'right' = sideKey;
    let width = 1;
    let style = 'solid';
    let color = spec;
    if (sideMatch) {
      side = sideMatch[1]!.toLowerCase() as typeof side;
      width = Math.max(1, Number(sideMatch[2]) || 1);
      style = sideMatch[3]!.toLowerCase();
      color = sideMatch[4]!.trim();
    } else if (allMatch) {
      width = Math.max(1, Number(allMatch[1]) || 1);
      style = allMatch[2]!.toLowerCase();
      color = allMatch[3]!.trim();
    } else {
      continue;
    }
    const drawSide = (s: 'top' | 'bottom' | 'left' | 'right') => {
      if (style === 'dashed' || style === 'dotted') {
        const prev = ctx.strokeStyle;
        const prevW = ctx.lineWidth;
        const prevDash = ctx.getLineDash();
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.setLineDash(style === 'dotted' ? [width, width * 2] : [width * 3, width * 2]);
        ctx.beginPath();
        if (s === 'top') {
          ctx.moveTo(x, y + width / 2);
          ctx.lineTo(x + w, y + width / 2);
        } else if (s === 'bottom') {
          ctx.moveTo(x, y + h - width / 2);
          ctx.lineTo(x + w, y + h - width / 2);
        } else if (s === 'left') {
          ctx.moveTo(x + width / 2, y);
          ctx.lineTo(x + width / 2, y + h);
        } else {
          ctx.moveTo(x + w - width / 2, y);
          ctx.lineTo(x + w - width / 2, y + h);
        }
        ctx.stroke();
        ctx.setLineDash(prevDash);
        ctx.strokeStyle = prev;
        ctx.lineWidth = prevW;
        return;
      }
      const prev = ctx.fillStyle;
      ctx.fillStyle = color;
      if (s === 'top') ctx.fillRect(x, y, w, width);
      else if (s === 'bottom') ctx.fillRect(x, y + h - width, w, width);
      else if (s === 'left') ctx.fillRect(x, y, width, h);
      else ctx.fillRect(x + w - width, y, width, h);
      ctx.fillStyle = prev;
    };
    if (side === 'all') {
      drawSide('top');
      drawSide('bottom');
      drawSide('left');
      drawSide('right');
    } else {
      drawSide(side);
    }
  }
}

/** Paint ColDef.cellIcon / headerIcon. */
function paintCellIcon(
  ctx: CanvasRenderingContext2D,
  icon: import('./types').CellIconSpec | null | undefined,
  x: number,
  y: number,
  w: number,
  h: number,
  pad: number,
): number {
  if (!icon) return 0;
  const size = Math.min(14, Math.max(10, h - 8));
  const place = icon.place ?? 'prefix';
  let ix = x + pad;
  let iy = y + (h - size) / 2;
  if (place === 'suffix') ix = x + w - pad - size;
  else if (place === 'tl') {
    ix = x + 3;
    iy = y + 3;
  } else if (place === 'tr') {
    ix = x + w - size - 3;
    iy = y + 3;
  } else if (place === 'bl') {
    ix = x + 3;
    iy = y + h - size - 3;
  } else if (place === 'br') {
    ix = x + w - size - 3;
    iy = y + h - size - 3;
  }
  const color = icon.color ?? '#81A1C1';
  if (icon.emoji) {
    ctx.save();
    ctx.font = `${size}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(icon.emoji, ix, iy + size / 2);
    ctx.restore();
  } else if (icon.name) {
    try {
      drawIcon(ctx, icon.name as IconName, ix, iy, size, color);
    } catch {
      /* unknown icon name */
    }
  }
  // Reserve horizontal space only for inline prefix/suffix
  if (place === 'prefix') return size + 4;
  if (place === 'suffix') return size + 4;
  return 0;
}

const wrapCache = new Map<string, string[]>();

/**
 * Greedy word wrap for canvas text (AG `wrapText`). Words longer than the
 * available width are broken mid-word. Newlines in the value are honoured.
 */
export function wrapLines(
  ctx: CanvasRenderingContext2D,
  font: string,
  text: string,
  maxWidth: number,
): string[] {
  const key = `${font}\u0000${text}\u0000${Math.round(maxWidth)}`;
  let out = wrapCache.get(key);
  if (out !== undefined) return out;
  if (wrapCache.size > MAX_CACHE) wrapCache.clear();
  ctx.font = font;
  out = [];
  for (const para of text.split('\n')) {
    if (measure(ctx, font, para) <= maxWidth) {
      out.push(para);
      continue;
    }
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    const pushWord = (word: string): void => {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(ctx, font, candidate) <= maxWidth) {
        line = candidate;
        return;
      }
      if (line) out!.push(line);
      // Break oversized words by character.
      if (measure(ctx, font, word) <= maxWidth) {
        line = word;
        return;
      }
      let chunk = '';
      for (const ch of word) {
        if (measure(ctx, font, chunk + ch) <= maxWidth && chunk.length < 512) chunk += ch;
        else {
          if (chunk) out!.push(chunk);
          chunk = ch;
        }
      }
      line = chunk;
    };
    for (const w of words) pushWord(w);
    if (line) out.push(line);
    if (words.length === 0) out.push('');
  }
  if (out.length === 0) out.push('');
  wrapCache.set(key, out);
  return out;
}

// ── header ─────────────────────────────────────────────────────────────

/** Columns without group ancestors span every header row (AG auto-column / pinned chrome). */
function headerSpansAllRows<TData>(
  col: InternalColumn<TData>,
  layout: HeaderLayout<TData> | null | undefined,
): boolean {
  return !!layout && layout.maxGroupDepth > 0 && col.ancestorGroups.length === 0;
}

/**
 * Consecutive padding groups directly above a leaf (balanced tree filler).
 * AG stretches the leaf header cell up through these rows.
 */
export function trailingPaddingLevels<TData>(col: InternalColumn<TData>): number {
  const a = col.ancestorGroups;
  let n = 0;
  for (let i = a.length - 1; i >= 0 && a[i].padding; i--) n++;
  return n;
}

// ── header column-menu (⋮) / funnel filter buttons (AG new column menu) ──

export const HEADER_BUTTON_ICON = 12;
/** Icon plus inter-button gap; also the square hit box around each icon. */
export const HEADER_BUTTON_SLOT = 18;

export interface HeaderButtons {
  /** Icon x of the ⋮ menu button, or null when hidden. */
  menuX: number | null;
  /** Icon x of the funnel filter button, or null when hidden. */
  filterX: number | null;
  /** Width reserved for the buttons at the label's trailing side. */
  reservedW: number;
}

const NO_HEADER_BUTTONS: HeaderButtons = { menuX: null, filterX: null, reservedW: 0 };

/**
 * Positions of the always-visible header buttons for one leaf header cell.
 * AG places them at the label's trailing side: right edge for left-aligned
 * labels, left edge for right-aligned (numeric) ones, order mirrored.
 */
export function headerButtons<TData>(
  env: PaintEnv<TData>,
  col: InternalColumn<TData>,
  x: number,
  w: number,
): HeaderButtons {
  if (col.colId === SELECTION_COL_ID) return NO_HEADER_BUTTONS;
  if (col.def.suppressHeaderMenuButton === true) return NO_HEADER_BUTTONS;
  if (w < HEADER_BUTTON_SLOT * 2 + 20) return NO_HEADER_BUTTONS;
  // The funnel is redundant when the column already shows a floating filter
  // row — filter access lives there instead.
  const filterOn =
    col.def.suppressHeaderFilterButton !== true &&
    col.colId !== AUTO_GROUP_COL_ID &&
    env.cols.filterKind(col) !== false &&
    !env.cols.showsFloatingFilter(col) &&
    w >= HEADER_BUTTON_SLOT * 3 + 20;
  const pad = env.theme.paddingX;
  const align = col.def.align ?? (col.def.type === 'number' ? 'right' : 'left');
  // From the first icon's leading edge to the padding edge, plus a small gap.
  const reservedW = HEADER_BUTTON_ICON + (filterOn ? HEADER_BUTTON_SLOT : 0) + 4;
  if (align === 'right') {
    return {
      menuX: x + pad,
      filterX: filterOn ? x + pad + HEADER_BUTTON_SLOT : null,
      reservedW,
    };
  }
  return {
    menuX: x + w - pad - HEADER_BUTTON_ICON,
    filterX: filterOn ? x + w - pad - HEADER_BUTTON_ICON - HEADER_BUTTON_SLOT : null,
    reservedW,
  };
}

function paintHeaderButtons<TData>(
  ctx: CanvasRenderingContext2D,
  env: PaintEnv<TData>,
  col: InternalColumn<TData>,
  btns: HeaderButtons,
  cellTop: number,
  cellH: number,
): void {
  const t = env.theme;
  const cy = cellTop + cellH / 2;
  if (btns.menuX != null) {
    drawIcon(ctx, 'kebab', btns.menuX, cy - HEADER_BUTTON_ICON / 2, HEADER_BUTTON_ICON, t.textSecondary, 2.6);
  }
  if (btns.filterX != null) {
    const active = env.filteredColIds.has(col.colId);
    drawIcon(
      ctx,
      'filter',
      btns.filterX,
      cy - HEADER_BUTTON_ICON / 2,
      HEADER_BUTTON_ICON,
      active ? t.accent : t.textSecondary,
      1.8,
    );
  }
}

export interface HeaderButtonHit {
  colId: string;
  kind: 'menu' | 'filter';
  /** Button box in header-view coordinates (for anchoring popups). */
  x: number;
  y: number;
  size: number;
  /** Bottom of the leaf header cell (menu popup anchor line). */
  cellBottom: number;
}

/** Hit-test the header ⋮ / funnel buttons at header-canvas (vx, vy). */
export function headerButtonAt<TData>(
  env: PaintEnv<TData>,
  vx: number,
  vy: number,
): HeaderButtonHit | null {
  const layout = env.cols.header;
  const colRowTop = layout ? layout.maxGroupDepth * layout.groupHeaderHeight : 0;
  const colRowH = layout?.columnHeaderHeight ?? env.theme.headerHeight;
  if (vy >= colRowTop + colRowH) return null; // floating filter row or below

  const col = colAtViewX(env, vx);
  if (!col) return null;

  let cellTop: number;
  let cellH: number;
  if (headerSpansAllRows(col, layout)) {
    cellTop = 0;
    cellH = colRowTop + colRowH;
  } else {
    const stretch = layout ? trailingPaddingLevels(col) * layout.groupHeaderHeight : 0;
    cellTop = colRowTop - stretch;
    cellH = colRowH + stretch;
  }
  if (vy < cellTop) return null; // a group header row above this leaf cell

  const colX = headerCellX(env, col);
  if (colX == null) return null;
  const btns = headerButtons(env, col, colX, col.width);
  const cy = cellTop + cellH / 2;
  if (Math.abs(vy - cy) > HEADER_BUTTON_SLOT / 2) return null;

  const boxFor = (iconX: number, kind: 'menu' | 'filter'): HeaderButtonHit | null => {
    const bx = iconX - (HEADER_BUTTON_SLOT - HEADER_BUTTON_ICON) / 2;
    if (vx < bx || vx >= bx + HEADER_BUTTON_SLOT) return null;
    return {
      colId: col.colId,
      kind,
      x: bx,
      y: cy - HEADER_BUTTON_SLOT / 2,
      size: HEADER_BUTTON_SLOT,
      cellBottom: cellTop + cellH,
    };
  };
  if (btns.menuX != null) {
    const hit = boxFor(btns.menuX, 'menu');
    if (hit) return hit;
  }
  if (btns.filterX != null) {
    const hit = boxFor(btns.filterX, 'filter');
    if (hit) return hit;
  }
  return null;
}

/** Header-view x of a displayed column's left edge (region-aware). */
export function headerCellX<TData>(env: PaintEnv<TData>, col: InternalColumn<TData>): number | null {
  const { cols, viewWidth, scrollLeft } = env;
  const rightStart = viewWidth - cols.right.width;
  let i = cols.left.cols.indexOf(col);
  if (i >= 0) return cols.left.offsets[i];
  i = cols.right.cols.indexOf(col);
  if (i >= 0) return rightStart + cols.right.offsets[i];
  i = cols.center.cols.indexOf(col);
  if (i >= 0) return cols.left.width + cols.center.offsets[i] - scrollLeft;
  return null;
}

export function paintHeader<TData>(ctx: CanvasRenderingContext2D, env: PaintEnv<TData>): void {
  const { theme: t, cols, viewWidth } = env;
  const layout = cols.header;
  const totalH = layout?.totalHeaderHeight ?? t.headerHeight;
  const groupRowH = layout?.groupHeaderHeight ?? 0;
  const colRowH = layout?.columnHeaderHeight ?? t.headerHeight;
  const colRowTop = layout ? layout.maxGroupDepth * groupRowH : 0;

  // Opaque context (`alpha: false`): the background fill replaces clearRect.
  // Fill the full backing width — the header canvas extends over the
  // scrollbar gutter, which otherwise shows as an unpainted strip.
  ctx.fillStyle = t.headerBg;
  ctx.fillRect(0, 0, Math.max(viewWidth, ctx.canvas.width), totalH);

  const centerViewX0 = cols.left.width;
  const centerViewX1 = viewWidth - cols.right.width;

  if (layout && layout.maxGroupDepth > 0) {
    for (let level = 0; level < layout.maxGroupDepth; level++) {
      const y = level * groupRowH;
      paintGroupSpans(ctx, env, cols.left, layout.left[level] ?? [], 0, y, groupRowH);
      ctx.save();
      ctx.beginPath();
      ctx.rect(centerViewX0, y, Math.max(0, centerViewX1 - centerViewX0), groupRowH);
      ctx.clip();
      paintGroupSpans(
        ctx,
        env,
        cols.center,
        layout.center[level] ?? [],
        centerViewX0 - env.scrollLeft,
        y,
        groupRowH,
      );
      ctx.restore();
      paintGroupSpans(ctx, env, cols.right, layout.right[level] ?? [], centerViewX1, y, groupRowH);
    }

    // Row separators under each group header row (AG draws a bottom border on
    // every real group cell). Skipped where a leaf header stretches through
    // padding rows or pinned chrome spans the full header.
    paintGroupRowSeparators(ctx, env, cols.left, 0, 0, cols.left.width, layout);
    ctx.save();
    ctx.beginPath();
    ctx.rect(centerViewX0, 0, Math.max(0, centerViewX1 - centerViewX0), totalH);
    ctx.clip();
    paintGroupRowSeparators(
      ctx,
      env,
      cols.center,
      centerViewX0 - env.scrollLeft,
      env.scrollLeft,
      env.scrollLeft + (centerViewX1 - centerViewX0),
      layout,
    );
    ctx.restore();
    paintGroupRowSeparators(ctx, env, cols.right, centerViewX1, 0, cols.right.width, layout);
  }

  const headerBodyH = colRowTop + colRowH;

  ctx.save();
  ctx.beginPath();
  // Clip spans the full header body: leaf cells may stretch up through
  // balanced-tree padding rows above the leaf row.
  ctx.rect(centerViewX0, 0, Math.max(0, centerViewX1 - centerViewX0), colRowTop + colRowH);
  ctx.clip();
  paintColumnHeaderRow(
    ctx,
    env,
    cols.center,
    centerViewX0 - env.scrollLeft,
    env.scrollLeft,
    env.scrollLeft + (centerViewX1 - centerViewX0),
    colRowTop,
    colRowH,
    layout,
  );
  ctx.restore();

  paintColumnHeaderRow(ctx, env, cols.left, 0, 0, cols.left.width, colRowTop, colRowH, layout);
  paintColumnHeaderRow(ctx, env, cols.right, centerViewX1, 0, cols.right.width, colRowTop, colRowH, layout);

  paintSpanningHeaderColumns(ctx, env, cols.left, 0, 0, cols.left.width, headerBodyH, layout);
  ctx.save();
  ctx.beginPath();
  ctx.rect(centerViewX0, 0, Math.max(0, centerViewX1 - centerViewX0), headerBodyH);
  ctx.clip();
  paintSpanningHeaderColumns(
    ctx,
    env,
    cols.center,
    centerViewX0 - env.scrollLeft,
    env.scrollLeft,
    env.scrollLeft + (centerViewX1 - centerViewX0),
    headerBodyH,
    layout,
  );
  ctx.restore();
  paintSpanningHeaderColumns(
    ctx,
    env,
    cols.right,
    centerViewX1,
    0,
    cols.right.width,
    headerBodyH,
    layout,
  );

  if (layout?.floatingFilters && layout.floatingFilterHeight > 0) {
    const ffTop = colRowTop + colRowH;
    const ffH = layout.floatingFilterHeight;
    ctx.fillStyle = t.raised;
    ctx.fillRect(0, ffTop, viewWidth, ffH);
    ctx.save();
    ctx.beginPath();
    ctx.rect(centerViewX0, ffTop, Math.max(0, centerViewX1 - centerViewX0), ffH);
    ctx.clip();
    paintFloatingFilterRow(
      ctx,
      env,
      cols.center,
      centerViewX0 - env.scrollLeft,
      env.scrollLeft,
      env.scrollLeft + (centerViewX1 - centerViewX0),
      ffTop,
      ffH,
    );
    ctx.restore();
    paintFloatingFilterRow(ctx, env, cols.left, 0, 0, cols.left.width, ffTop, ffH);
    paintFloatingFilterRow(ctx, env, cols.right, centerViewX1, 0, cols.right.width, ffTop, ffH);
    ctx.fillStyle = t.structural;
    ctx.fillRect(0, ffTop + ffH - 1, viewWidth, 1);
  }

  ctx.fillStyle = t.structural;
  ctx.fillRect(0, totalH - 1, viewWidth, 1);
  if (cols.left.width > 0) ctx.fillRect(centerViewX0 - 1, 0, 1, totalH);
  if (cols.right.width > 0) ctx.fillRect(centerViewX1, 0, 1, totalH);
}

/**
 * Bottom border of every group header row, per leaf column (AG draws these on
 * each group cell). Omitted where the leaf header cell stretches up through
 * balanced-tree padding rows, and under pinned chrome spanning all rows.
 */
function paintGroupRowSeparators<TData>(
  ctx: CanvasRenderingContext2D,
  env: PaintEnv<TData>,
  region: Region<TData>,
  originX: number,
  rx0: number,
  rx1: number,
  layout: HeaderLayout<TData>,
): void {
  const rowH = layout.groupHeaderHeight;
  const [first, last] = env.cols.visibleRange(region, rx0, rx1);
  ctx.fillStyle = env.theme.structural;
  for (let i = first; i <= last; i++) {
    const col = region.cols[i];
    if (headerSpansAllRows(col, layout)) continue;
    const x = originX + region.offsets[i];
    const lines = layout.maxGroupDepth - trailingPaddingLevels(col);
    for (let k = 1; k <= lines; k++) {
      ctx.fillRect(x, k * rowH - 1, col.width, 1);
    }
  }
}

function paintGroupSpans<TData>(
  ctx: CanvasRenderingContext2D,
  env: PaintEnv<TData>,
  _region: Region<TData>,
  spans: HeaderGroupSpan<TData>[],
  originX: number,
  y: number,
  h: number,
): void {
  const t = env.theme;
  const font = `450 ${Math.max(10, t.headerFontSize - 1)}px ${t.fontSans}`;
  ctx.textBaseline = 'middle';
  for (const span of spans) {
    if (span.padding) continue;
    const x = originX + span.left;
    ctx.fillStyle = gridlineColor(t);
    ctx.fillRect(x + span.width - 1, y + 4, 1, h - 8);
    if (!span.headerName) continue;
    ctx.font = font;
    ctx.fillStyle = t.textTertiary;
    const iconSize = span.expandable ? 14 : 0;
    const iconGap = span.expandable ? 4 : 0;
    const avail = span.width - t.paddingX * 2 - iconSize - iconGap;
    const text = truncate(ctx, font, span.headerName, Math.max(8, avail));
    ctx.textAlign = 'left';
    ctx.fillText(text, x + t.paddingX, y + h / 2 + 0.5);
    if (span.expandable) {
      // Caret trails the caption: expanded groups collapse leftward (‹),
      // collapsed groups expand rightward (›) — AG Grid convention.
      drawIcon(
        ctx,
        span.expanded ? 'chevron-left' : 'chevron-right',
        x + t.paddingX + measure(ctx, font, text) + iconGap,
        y + h / 2 - iconSize / 2,
        iconSize,
        t.textSecondary,
      );
    }
  }
}

function paintColumnHeaderRow<TData>(
  ctx: CanvasRenderingContext2D,
  env: PaintEnv<TData>,
  region: Region<TData>,
  originX: number,
  rx0: number,
  rx1: number,
  rowTop: number,
  rowH: number,
  layout: HeaderLayout<TData> | null | undefined,
): void {
  const { theme: t, cols } = env;
  const [first, last] = cols.visibleRange(region, rx0, rx1);
  const multiSort = cols.sortedColumnCount() > 1;
  ctx.textBaseline = 'middle';

  for (let i = first; i <= last; i++) {
    const col = region.cols[i];
    if (headerSpansAllRows(col, layout)) continue;
    const x = originX + region.offsets[i];
    const w = col.width;
    const filtered = env.filteredColIds.has(col.colId);

    // Leaf header cells stretch up through balanced-tree padding rows (AG
    // merges the empty filler rows into the leaf cell).
    const stretch = layout ? trailingPaddingLevels(col) * layout.groupHeaderHeight : 0;
    const cellTop = rowTop - stretch;
    const cellH = rowH + stretch;

    // Column separator.
    ctx.fillStyle = gridlineColor(t);
    ctx.fillRect(x + w - 1, cellTop + 6, 1, cellH - 12);

    // Accent underline under the header label. Skip when floating filters are
    // on — the bar sits on the header/ff seam and reads as a double top border
    // on the filter cell (filter text + × already show active state).
    if (filtered && !env.cols.header?.floatingFilters) {
      ctx.fillStyle = t.accent;
      ctx.fillRect(x, rowTop + rowH - 3, w, 2);
    }

    const sorted = col.sort !== null;

    if (col.colId === SELECTION_COL_ID && env.headerCheckbox) {
      const all = env.selectionAllSelected === true;
      const some = env.selectionSomeSelected === true;
      paintCheckbox(ctx, x, cellTop, w, cellH, all, t, some && !all);
      continue;
    }

    let indicatorW = 0;
    if (sorted) indicatorW = multiSort ? 22 : 14;

    // Always-visible ⋮ menu / funnel buttons at the label's trailing side.
    const btns = headerButtons(env, col, x, w);
    paintHeaderButtons(ctx, env, col, btns, cellTop, cellH);

    const hs = col.def.headerStyle;
    if (hs?.background || hs?.backgroundColor) {
      ctx.fillStyle = hs.background ?? hs.backgroundColor!;
      ctx.fillRect(x, cellTop, w, cellH);
    }
    paintCellBorder(ctx, hs?.border, x, cellTop, w, cellH);

    let labelText = env.headerLabel(col);
    if (hs?.textTransform === 'uppercase') labelText = labelText.toUpperCase();
    else if (hs?.textTransform === 'lowercase') labelText = labelText.toLowerCase();

    const weight = hs?.fontWeight ?? 500;
    const fs = hs?.fontSize ?? t.headerFontSize;
    const labelFontStyled = `${hs?.fontStyle ?? ''} ${weight} ${fs}px ${t.fontSans}`.trim();
    ctx.font = labelFontStyled;
    ctx.fillStyle = hs?.color ?? (filtered || sorted ? t.textPrimary : t.textSecondary);
    const align = col.def.align ?? (col.def.type === 'number' ? 'right' : 'left');
    const iconReserve = paintCellIcon(ctx, col.def.headerIcon, x, cellTop, w, cellH, t.paddingX);
    const avail = w - t.paddingX * 2 - indicatorW - btns.reservedW - iconReserve;
    // Trailing-side inset the label/indicator so they clear the buttons.
    const trailInset = btns.reservedW;
    const labelPad = t.paddingX + (col.def.headerIcon?.place === 'prefix' || !col.def.headerIcon?.place ? iconReserve : 0);

    let lastLineEnd: number; // x where the sort indicator trails the label
    if (col.def.wrapHeaderText) {
      // Wrapped header label (AG `wrapHeaderText`): block is vertically
      // centered when it fits, top-aligned and clipped when it does not.
      const lineH = Math.round(fs * 1.45);
      const lines = wrapLines(ctx, labelFontStyled, labelText, Math.max(8, avail));
      const blockH = lines.length * lineH;
      const clip = blockH > cellH;
      if (clip) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, cellTop, w, cellH);
        ctx.clip();
      }
      let ty = clip ? cellTop + lineH / 2 + 2 : cellTop + (cellH - blockH) / 2 + lineH / 2 + 0.5;
      let widest = 0;
      for (const line of lines) {
        if (align === 'right') {
          ctx.textAlign = 'right';
          ctx.fillText(line, x + w - t.paddingX - indicatorW, ty);
        } else {
          ctx.textAlign = 'left';
          ctx.fillText(line, x + labelPad, ty);
        }
        widest = Math.max(widest, measure(ctx, labelFontStyled, line));
        ty += lineH;
      }
      if (clip) ctx.restore();
      const tx0 = align === 'right' ? x + w - t.paddingX - indicatorW : x + labelPad;
      lastLineEnd = tx0 + widest;
    } else {
      const text = truncate(ctx, labelFontStyled, labelText, Math.max(8, avail));
      let tx: number;
      if (align === 'right') {
        ctx.textAlign = 'right';
        tx = x + w - t.paddingX - indicatorW;
      } else {
        ctx.textAlign = 'left';
        tx = x + labelPad;
      }
      const ty = cellTop + cellH / 2 + 0.5;
      ctx.fillText(text, tx, ty);
      paintTextDecoration(ctx, hs?.textDecoration, text, tx, ty, align === 'right' ? 'right' : 'left', ctx.fillStyle as string);
      lastLineEnd = tx + measure(ctx, labelFontStyled, text);
    }

    void trailInset;
    if (sorted) {
      const iconSize = Math.max(12, t.headerFontSize + 1);
      const gx =
        align === 'right'
          ? x + w - t.paddingX - indicatorW + 4
          : Math.min(lastLineEnd + 5, x + w - t.paddingX - trailInset - indicatorW + 4);
      drawIcon(
        ctx,
        col.sort === 'asc' ? 'arrow-up' : 'arrow-down',
        gx,
        cellTop + cellH / 2 - iconSize / 2,
        iconSize,
        t.accent,
        2.5,
      );
      if (multiSort) {
        ctx.font = `${Math.max(7, t.headerFontSize - 4)}px ${t.fontMono}`;
        ctx.fillStyle = t.accent;
        ctx.textAlign = 'left';
        ctx.fillText(String(col.sortIndex + 1), gx + iconSize + 1, cellTop + cellH / 2 - 3);
      }
    }
  }
}

/** Auto-group / pinned chrome: one label centered across group + column header rows. */
function paintSpanningHeaderColumns<TData>(
  ctx: CanvasRenderingContext2D,
  env: PaintEnv<TData>,
  region: Region<TData>,
  originX: number,
  rx0: number,
  rx1: number,
  headerBodyH: number,
  layout: HeaderLayout<TData> | null | undefined,
): void {
  if (!layout || layout.maxGroupDepth === 0) return;
  const { theme: t, cols } = env;
  const [first, last] = cols.visibleRange(region, rx0, rx1);
  const multiSort = cols.sortedColumnCount() > 1;
  const labelFont = `500 ${t.headerFontSize}px ${t.fontSans}`;
  ctx.textBaseline = 'middle';

  for (let i = first; i <= last; i++) {
    const col = region.cols[i];
    if (!headerSpansAllRows(col, layout)) continue;
    const x = originX + region.offsets[i];
    const w = col.width;
    const filtered = env.filteredColIds.has(col.colId);

    ctx.fillStyle = gridlineColor(t);
    ctx.fillRect(x + w - 1, 4, 1, headerBodyH - 8);

    if (filtered && !layout.floatingFilters) {
      ctx.fillStyle = t.accent;
      ctx.fillRect(x, headerBodyH - 3, w, 2);
    }

    const label = env.headerLabel(col);
    const sorted = col.sort !== null;

    if (col.colId === SELECTION_COL_ID && env.headerCheckbox) {
      const all = env.selectionAllSelected === true;
      const some = env.selectionSomeSelected === true;
      paintCheckbox(ctx, x, 0, w, headerBodyH, all, t, some && !all);
      continue;
    }

    let indicatorW = 0;
    if (sorted) indicatorW = multiSort ? 22 : 14;

    const btns = headerButtons(env, col, x, w);
    paintHeaderButtons(ctx, env, col, btns, 0, headerBodyH);

    ctx.font = labelFont;
    ctx.fillStyle = filtered || sorted ? t.textPrimary : t.textSecondary;
    const align = col.def.align ?? (col.def.type === 'number' ? 'right' : 'left');
    const avail = w - t.paddingX * 2 - indicatorW - btns.reservedW;
    const text = truncate(ctx, labelFont, label, Math.max(8, avail));
    let tx: number;
    if (align === 'right') {
      ctx.textAlign = 'right';
      tx = x + w - t.paddingX - indicatorW;
    } else {
      ctx.textAlign = 'left';
      tx = x + t.paddingX;
    }
    ctx.fillText(text, tx, headerBodyH / 2 + 0.5);

    if (sorted) {
      const iconSize = Math.max(12, t.headerFontSize + 1);
      const gx =
        align === 'right'
          ? x + w - t.paddingX - indicatorW + 4
          : Math.min(
              tx + measure(ctx, labelFont, text) + 5,
              x + w - t.paddingX - btns.reservedW - indicatorW + 4,
            );
      drawIcon(
        ctx,
        col.sort === 'asc' ? 'arrow-up' : 'arrow-down',
        gx,
        headerBodyH / 2 - iconSize / 2,
        iconSize,
        t.accent,
        2.5,
      );
      if (multiSort) {
        ctx.font = `${Math.max(7, t.headerFontSize - 4)}px ${t.fontMono}`;
        ctx.fillStyle = t.accent;
        ctx.textAlign = 'left';
        ctx.fillText(String(col.sortIndex + 1), gx + iconSize + 1, headerBodyH / 2 - 3);
      }
    }
  }
}

function paintFloatingFilterRow<TData>(
  ctx: CanvasRenderingContext2D,
  env: PaintEnv<TData>,
  region: Region<TData>,
  originX: number,
  rx0: number,
  rx1: number,
  rowTop: number,
  rowH: number,
): void {
  const { theme: t, cols, rows } = env;
  const [first, last] = cols.visibleRange(region, rx0, rx1);
  const font = `${t.fontSize - 1}px ${t.fontSans}`;
  ctx.font = font;
  ctx.textBaseline = 'middle';

  for (let i = first; i <= last; i++) {
    const col = region.cols[i];
    if (!cols.showsFloatingFilter(col)) continue;
    const x = originX + region.offsets[i];
    const w = col.width;
    const active = env.filteredColIds.has(col.colId);
    const label = formatFilterDisplay(rows.filterModel[col.colId]);
    const isNumber = col.def.type === 'number';
    const isSet = cols.filterKind(col) === 'set';

    // Column separator.
    ctx.fillStyle = gridlineColor(t);
    ctx.fillRect(x + w - 1, rowTop + 4, 1, rowH - 8);

    if (env.editingFloatingFilterColId === col.colId) continue;

    // AG-style bordered input box with a trailing funnel button.
    const geom = floatingFilterInputGeom(w, rowH);
    const funnelW = FLOATING_FILTER_FUNNEL_SIZE;
    const inputX = x + geom.x;
    const inputW = geom.w;
    const inputH = geom.h;
    const inputY = rowTop + geom.y;
    ctx.beginPath();
    ctx.roundRect(inputX + 0.5, inputY + 0.5, inputW - 1, inputH - 1, 2);
    ctx.fillStyle = t.base;
    ctx.fill();
    ctx.strokeStyle = active ? t.accent : t.structural;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Funnel button to the right of the input (AG floating filter button).
    const funnelIcon = 12;
    drawIcon(
      ctx,
      'filter',
      inputX + inputW + 4 + (funnelW - funnelIcon) / 2,
      rowTop + (rowH - funnelIcon) / 2,
      funnelIcon,
      active ? t.textPrimary : t.textTertiary,
      1.8,
    );

    const clearW = active ? FLOATING_FILTER_CLEAR_SIZE : 0;
    const chevW = isSet && !active ? 14 : 0;
    // Dropdown affordance on set-filter cells (when the × isn't showing).
    if (isSet && !active) {
      const iconSize = 12;
      drawIcon(
        ctx,
        'chevron-down',
        inputX + inputW - 4 - iconSize,
        rowTop + rowH / 2 - iconSize / 2,
        iconSize,
        t.textSecondary,
      );
    }
    const avail = inputW - 10 - clearW - chevW;
    const text = label ? truncate(ctx, font, label, Math.max(8, avail)) : '';
    if (text) {
      ctx.font = font;
      ctx.fillStyle = active ? t.textPrimary : t.textTertiary;
      if (isNumber) {
        ctx.textAlign = 'right';
        ctx.fillText(text, inputX + inputW - 5 - clearW, rowTop + rowH / 2 + 0.5);
      } else {
        ctx.textAlign = 'left';
        ctx.fillText(text, inputX + 5, rowTop + rowH / 2 + 0.5);
      }
    }
  }
}

/** Rect of a floating filter cell in header-canvas coordinates. */
export function floatingFilterRect<TData>(
  env: PaintEnv<TData>,
  colId: string,
): { x: number; y: number; w: number; h: number } | null {
  const col = env.cols.getColumn(colId);
  const layout = env.cols.header;
  if (!col || !layout?.floatingFilters || !env.cols.showsFloatingFilter(col)) return null;

  const rowTop = layout.maxGroupDepth * layout.groupHeaderHeight + layout.columnHeaderHeight;
  const rowH = layout.floatingFilterHeight;
  const leftW = env.cols.left.width;
  const rightStart = env.viewWidth - env.cols.right.width;

  const inRegion = (
    region: Region<TData>,
    originX: number,
  ): { x: number; y: number; w: number; h: number } | null => {
    const i = region.cols.findIndex((c) => c.colId === colId);
    if (i < 0) return null;
    return {
      x: originX + region.offsets[i],
      y: rowTop,
      w: col.width,
      h: rowH,
    };
  };

  if (env.cols.left.cols.some((c) => c.colId === colId)) return inRegion(env.cols.left, 0);
  if (env.cols.right.cols.some((c) => c.colId === colId)) return inRegion(env.cols.right, rightStart);
  return inRegion(env.cols.center, leftW - env.scrollLeft);
}

/** Hit-test the floating-filter clear (×) control; returns colId or null. */
export function floatingFilterClearAt<TData>(
  env: PaintEnv<TData>,
  vx: number,
  vy: number,
): string | null {
  const layout = env.cols.header;
  if (!layout?.floatingFilters) return null;
  const rowTop = layout.maxGroupDepth * layout.groupHeaderHeight + layout.columnHeaderHeight;
  const rowH = layout.floatingFilterHeight;
  if (vy < rowTop || vy >= rowTop + rowH) return null;

  const col = colAtViewX(env, vx);
  if (!col || !env.cols.showsFloatingFilter(col) || !env.filteredColIds.has(col.colId)) return null;

  const cell = floatingFilterRect(env, col.colId);
  if (!cell) return null;
  const geom = floatingFilterInputGeom(cell.w, cell.h);
  const clearX = cell.x + geom.x + geom.w - FLOATING_FILTER_CLEAR_SIZE;
  if (vx >= clearX && vx < cell.x + geom.x + geom.w) return col.colId;
  return null;
}

function colAtViewX<TData>(env: PaintEnv<TData>, vx: number): InternalColumn<TData> | null {
  const { cols, viewWidth, scrollLeft } = env;
  const leftW = cols.left.width;
  const rightStart = viewWidth - cols.right.width;
  if (vx < leftW) {
    const i = cols.colIndexAtX(cols.left, vx);
    return i >= 0 ? cols.left.cols[i] : null;
  }
  if (vx >= rightStart) {
    const i = cols.colIndexAtX(cols.right, vx - rightStart);
    return i >= 0 ? cols.right.cols[i] : null;
  }
  const i = cols.colIndexAtX(cols.center, vx - leftW + scrollLeft);
  return i >= 0 ? cols.center.cols[i] : null;
}

/** Overlay layer: range wash + focus ring (§2.1). */
export function paintOverlay<TData>(ctx: CanvasRenderingContext2D, env: PaintEnv<TData>): void {
  const { theme: t, cols, viewWidth, viewHeight, range, focused } = env;
  ctx.clearRect(0, 0, viewWidth, viewHeight);

  const displayed = cols.displayed();
  const bounds = range ? normalizeRangeBounds(range, displayed) : null;
  const isSingleCell =
    bounds != null && bounds.row0 === bounds.row1 && bounds.col0 === bounds.col1;

  const strokeCell = (rowIndex: number, colId: string): void => {
    // Full-width rows focus as a whole row (AG parity).
    const rect = env.isFullWidthRow?.(rowIndex)
      ? { x: 0, y: env.rowTop(rowIndex) - env.scrollTop, w: viewWidth, h: env.rowHeightAt(rowIndex) }
      : cellRect(env, rowIndex, colId);
    if (!rect) return;
    ctx.strokeStyle = t.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
  };

  if (bounds) {
    paintCellRangeFill(ctx, env, bounds, displayed, t);
    if (isSingleCell) {
      strokeCell(bounds.row0, displayed[bounds.col0].colId);
    } else {
      paintUnifiedRangeStroke(ctx, env, bounds, displayed, t);
    }
    if (env.fillHandle) paintFillHandle(ctx, env, bounds, displayed, t);
  } else if (focused) {
    strokeCell(focused.rowIndex, focused.colId);
  }

  // Dashed outline previewing the fill target while dragging the handle.
  if (env.fillPreview) {
    const p = env.fillPreview;
    const tl = cellRect(env, p.row0, displayed[p.col0].colId);
    const br = cellRect(env, p.row1, displayed[p.col1].colId);
    if (tl && br) {
      ctx.save();
      ctx.strokeStyle = t.accent;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(tl.x + 0.5, tl.y + 0.5, br.x + br.w - tl.x - 1, br.y + br.h - tl.y - 1);
      ctx.restore();
    }
  }
}

/** Small accent square at the bottom-right corner of the range (AG fill handle). */
function paintFillHandle<TData>(
  ctx: CanvasRenderingContext2D,
  env: PaintEnv<TData>,
  bounds: NormalizedRangeBounds,
  displayed: InternalColumn<TData>[],
  t: ResolvedTheme,
): void {
  const rect = fillHandleRect(env, bounds, displayed);
  if (!rect) return;
  ctx.fillStyle = t.accent;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.strokeStyle = t.base;
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
}

export const FILL_HANDLE_SIZE = 6;

/** Viewport rect of the fill handle for the given range bounds (null off-screen). */
export function fillHandleRect<TData>(
  env: PaintEnv<TData>,
  bounds: { row0: number; row1: number; col0: number; col1: number },
  displayed: InternalColumn<TData>[],
): { x: number; y: number; w: number; h: number } | null {
  const br = cellRect(env, bounds.row1, displayed[bounds.col1].colId);
  if (!br) return null;
  const s = FILL_HANDLE_SIZE;
  return { x: br.x + br.w - s + 1, y: br.y + br.h - s + 1, w: s, h: s };
}

interface NormalizedRangeBounds {
  row0: number;
  row1: number;
  col0: number;
  col1: number;
}

function normalizeRangeBounds<TData>(
  range: { start: CellPosition; end: CellPosition },
  displayed: InternalColumn<TData>[],
): NormalizedRangeBounds | null {
  const c0 = displayed.findIndex((c) => c.colId === range.start.colId);
  const c1 = displayed.findIndex((c) => c.colId === range.end.colId);
  if (c0 < 0 || c1 < 0) return null;
  return {
    row0: Math.min(range.start.rowIndex, range.end.rowIndex),
    row1: Math.max(range.start.rowIndex, range.end.rowIndex),
    col0: Math.min(c0, c1),
    col1: Math.max(c0, c1),
  };
}

function paintCellRangeFill<TData>(
  ctx: CanvasRenderingContext2D,
  env: PaintEnv<TData>,
  bounds: NormalizedRangeBounds,
  displayed: InternalColumn<TData>[],
  t: ResolvedTheme,
): void {
  const fill = withAlpha(t.accentDim, 0.14);
  for (let r = bounds.row0; r <= bounds.row1; r++) {
    for (let c = bounds.col0; c <= bounds.col1; c++) {
      const rect = cellRect(env, r, displayed[c].colId);
      if (!rect) continue;
      ctx.fillStyle = fill;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
  }
}

/** Single outer stroke around the whole range (not per-cell boxes). */
function paintUnifiedRangeStroke<TData>(
  ctx: CanvasRenderingContext2D,
  env: PaintEnv<TData>,
  bounds: NormalizedRangeBounds,
  displayed: InternalColumn<TData>[],
  t: ResolvedTheme,
): void {
  const tl = cellRect(env, bounds.row0, displayed[bounds.col0].colId);
  const br = cellRect(env, bounds.row1, displayed[bounds.col1].colId);
  if (!tl || !br) return;
  const x = tl.x;
  const y = tl.y;
  const w = br.x + br.w - tl.x;
  const h = br.y + br.h - tl.y;
  ctx.strokeStyle = t.accent;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

// ── body ───────────────────────────────────────────────────────────────

/** Previous-frame state enabling the vertical-scroll blit fast path. */
export interface BodyBlit {
  prevScrollTop: number;
  dpr: number;
}

export function paintBody<TData>(
  ctx: CanvasRenderingContext2D,
  env: PaintEnv<TData>,
  blit?: BodyBlit | null,
): void {
  const { theme: t, cols, rows, viewWidth, viewHeight, scrollTop } = env;
  const now = performance.now();

  const pageStart = env.pagination?.pageStart ?? 0;
  const pageEnd = env.pagination?.pageEnd ?? rows.displayed.length;
  const empty = pageEnd <= pageStart || scrollTop >= env.contentHeight;

  let firstRow = empty ? 0 : env.rowAtY(scrollTop);
  let lastRow = empty ? -1 : Math.min(pageEnd - 1, env.rowAtY(scrollTop + viewHeight - 1));
  const sticky = empty || lastRow < firstRow ? null : findStickyGroup(env, firstRow);

  // Vertical-scroll fast path: nothing changed since the last paint except
  // scrollTop — shift the previous frame's pixels with a self-drawImage and
  // repaint only the rows the scroll exposed. This turns per-frame paint cost
  // from O(viewport cells) into O(scrolled-in cells), which is what keeps
  // scrolling usable on CPU-rasterized environments (OpenFin/VDI with the GPU
  // disabled, occluded-window recovery, low-end hardware). Bails out whenever
  // any viewport-position-dependent painting is active (sticky group header,
  // merged row spans) or the device-pixel delta is fractional.
  let blitted = false;
  if (blit && !empty && lastRow >= firstRow && !sticky && !env.enableCellSpan) {
    const dy = scrollTop - blit.prevScrollTop;
    if (dy === 0) return; // previous frame's pixels are already correct
    const dyDev = dy * blit.dpr;
    if (Math.abs(dy) < viewHeight && Number.isInteger(dyDev)) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(ctx.canvas, 0, -dyDev);
      ctx.restore();
      // Narrow the paint window to rows intersecting the exposed band. A row
      // straddling the copy seam is repainted whole — identical pixels land
      // over the copied region, so no visible seam.
      if (dy > 0) firstRow = Math.max(firstRow, env.rowAtY(scrollTop + viewHeight - dy));
      else lastRow = Math.min(lastRow, env.rowAtY(scrollTop - dy - 1));
      const bandY0 = rowY(env, firstRow);
      const bandY1 = dy > 0 ? viewHeight : rowY(env, lastRow) + env.rowHeightAt(lastRow);
      ctx.fillStyle = t.base;
      ctx.fillRect(0, bandY0, viewWidth, bandY1 - bandY0);
      blitted = true;
    }
  }

  if (!blitted) {
    // Opaque context (`alpha: false`): the background fill replaces clearRect.
    ctx.fillStyle = t.base;
    ctx.fillRect(0, 0, viewWidth, viewHeight);
    if (empty || lastRow < firstRow) return;
  }

  const centerViewX0 = cols.left.width;
  const centerViewX1 = viewWidth - cols.right.width;
  // AG parity: row backgrounds and gridlines stop at the last column instead
  // of running to the viewport edge.
  const contentEndX = Math.min(
    centerViewX1,
    centerViewX0 + Math.max(0, cols.center.width - env.scrollLeft),
  );
  const fillRowBand = (y: number, h: number): void => {
    ctx.fillRect(0, y, contentEndX, h);
    if (cols.right.cols.length) ctx.fillRect(centerViewX1, y, cols.right.width, h);
  };

  // Row backgrounds (zebra + row styles + selection) span the row width.
  for (let r = firstRow; r <= lastRow; r++) {
    const y = rowY(env, r);
    const rowH = env.rowHeightAt(r);
    const node = rows.getDisplayedNode(r);
    if (r % 2 === 1) {
      ctx.fillStyle = t.raised;
      fillRowBand(y, rowH);
    }
    if (node) {
      const rowParams: RowStyleParams<TData> = {
        data: node.data ?? undefined,
        rowIndex: r,
        api: env.api,
        context: env.context,
        node: {
          group: node.group,
          footer: node.footer,
          level: node.level,
          key: node.key,
        },
      };
      const rowStyle = resolveRowPaintStyle(
        {
          rowStyle: env.rowStyle,
          getRowStyle: env.getRowStyle,
          rowClass: env.rowClass,
          getRowClass: env.getRowClass,
          rowClassRules: env.rowClassRules,
          classStyles: env.classStyles,
          context: env.context,
        },
        rowParams,
      );
      const rowBg = rowStyle?.background ?? rowStyle?.backgroundColor;
      if (rowBg) {
        ctx.fillStyle = rowBg;
        fillRowBand(y, rowH);
      }
    }
    if (env.selectedIds.has(rows.displayedIds[r])) {
      ctx.fillStyle = withAlpha(t.accentDim, 0.18);
      fillRowBand(y, rowH);
    }
  }

  // Center region (clipped + scrolled).
  ctx.save();
  ctx.beginPath();
  ctx.rect(centerViewX0, 0, Math.max(0, centerViewX1 - centerViewX0), viewHeight);
  ctx.clip();
  paintBodyRegion(ctx, env, cols.center, centerViewX0 - env.scrollLeft, env.scrollLeft, env.scrollLeft + (centerViewX1 - centerViewX0), firstRow, lastRow, now);
  ctx.restore();

  // Pinned regions.
  if (cols.left.cols.length) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cols.left.width, viewHeight);
    ctx.clip();
    paintBodyRegion(ctx, env, cols.left, 0, 0, cols.left.width, firstRow, lastRow, now);
    ctx.restore();
  }
  if (cols.right.cols.length) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(centerViewX1, 0, cols.right.width, viewHeight);
    ctx.clip();
    paintBodyRegion(ctx, env, cols.right, centerViewX1, 0, cols.right.width, firstRow, lastRow, now);
    ctx.restore();
  }

  // Full-width rows: one cell across the whole viewport (pinned regions included).
  if (env.isFullWidthRow) {
    for (let r = firstRow; r <= lastRow; r++) {
      if (!env.isFullWidthRow(r)) continue;
      const node = rows.getDisplayedNode(r);
      if (!node) continue;
      const y = rowY(env, r);
      const h = env.rowHeightAt(r);
      if (env.fullWidthCellRenderer) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, y, viewWidth, h);
        ctx.clip();
        env.fullWidthCellRenderer(ctx, {
          data: (node.data ?? undefined) as TData,
          node: { data: node.data, group: node.group, footer: node.footer, level: node.level, key: node.key },
          rowIndex: r,
          api: env.api,
          x: 0,
          y,
          width: viewWidth,
          height: h,
          theme: t,
        });
        ctx.restore();
      }
    }
  }

  // Horizontal gridlines.
  if (t.gridlines !== 'none') {
    ctx.fillStyle = gridlineColor(t);
    for (let r = firstRow; r <= lastRow; r++) {
      const y = rowY(env, r) + env.rowHeightAt(r);
      fillRowBand(y - 1, 1);
    }
  }

  // Merged (row-spanning) cells — painted over the gridlines so a span reads
  // as one cell with a single bottom border.
  if (env.enableCellSpan) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(centerViewX0, 0, Math.max(0, centerViewX1 - centerViewX0), viewHeight);
    ctx.clip();
    paintRowSpanRegion(ctx, env, cols.center, centerViewX0 - env.scrollLeft, env.scrollLeft, env.scrollLeft + (centerViewX1 - centerViewX0), firstRow, lastRow);
    ctx.restore();
    if (cols.left.cols.length) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, cols.left.width, viewHeight);
      ctx.clip();
      paintRowSpanRegion(ctx, env, cols.left, 0, 0, cols.left.width, firstRow, lastRow);
      ctx.restore();
    }
    if (cols.right.cols.length) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(centerViewX1, 0, cols.right.width, viewHeight);
      ctx.clip();
      paintRowSpanRegion(ctx, env, cols.right, centerViewX1, 0, cols.right.width, firstRow, lastRow);
      ctx.restore();
    }
  }

  // Sticky group header (one row pinned to the top of the viewport).
  if (sticky) {
    const stickyIdx = rows.displayedNodes.indexOf(sticky);
    if (stickyIdx >= 0) {
      const stickyH = env.rowHeightAt(stickyIdx);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, viewWidth, stickyH);
      ctx.clip();
      // Opaque band — translucent tints alone let scrolled rows bleed through.
      ctx.fillStyle = t.base;
      ctx.fillRect(0, 0, viewWidth, stickyH);
      ctx.fillStyle = withAlpha(t.accentDim, 0.08);
      ctx.fillRect(0, 0, viewWidth, stickyH);
      if (cols.left.cols.length) {
        paintBodyRegion(ctx, env, cols.left, 0, 0, cols.left.width, stickyIdx, stickyIdx, now, 0);
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(centerViewX0, 0, Math.max(0, centerViewX1 - centerViewX0), stickyH);
      ctx.clip();
      paintBodyRegion(ctx, env, cols.center, centerViewX0 - env.scrollLeft, env.scrollLeft, env.scrollLeft + (centerViewX1 - centerViewX0), stickyIdx, stickyIdx, now, 0);
      ctx.restore();
      if (cols.right.cols.length) {
        paintBodyRegion(ctx, env, cols.right, centerViewX1, 0, cols.right.width, stickyIdx, stickyIdx, now, 0);
      }
      ctx.fillStyle = gridlineColor(t);
      ctx.fillRect(0, stickyH - 1, viewWidth, 1);
      ctx.restore();
    }
  }

  // Pinned-region structural edges.
  ctx.fillStyle = t.structural;
  if (cols.left.width > 0) ctx.fillRect(centerViewX0 - 1, 0, 1, viewHeight);
  if (cols.right.width > 0) ctx.fillRect(centerViewX1, 0, 1, viewHeight);
}

/**
 * Pinned rows band (AG `pinnedTopRowData` / `pinnedBottomRowData`): plain data
 * rows painted on a dedicated canvas above/below the scrolling viewport.
 * Not part of the row model — no sort/filter/group/selection — matching AG.
 */
export function paintPinnedRows<TData>(
  ctx: CanvasRenderingContext2D,
  env: PaintEnv<TData>,
  data: TData[],
  which: 'top' | 'bottom',
): void {
  const { theme: t, cols, viewWidth } = env;
  const rowH = env.uniformRowHeight;
  const bandH = data.length * rowH + 1;
  // Opaque context (`alpha: false`): the background fill replaces clearRect.
  ctx.fillStyle = t.base;
  ctx.fillRect(0, 0, Math.max(viewWidth, ctx.canvas.width), bandH);

  const centerViewX0 = cols.left.width;
  const centerViewX1 = viewWidth - cols.right.width;
  const verticalLines = t.gridlines === 'both';
  ctx.textBaseline = 'middle';
  // Separator offset: the bottom band draws its structural edge at the top.
  const yBase = which === 'bottom' ? 1 : 0;

  const paintRegion = (region: Region<TData>, originX: number, rx0: number, rx1: number): void => {
    const [first, last] = cols.visibleRange(region, rx0, rx1);
    if (last < first) return;
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const y = yBase + i * rowH;
      for (let c = first; c <= last; c++) {
        const col = region.cols[c];
        if (col.colId === SELECTION_COL_ID) continue; // no selection UI on pinned rows (AG)
        const x = originX + region.offsets[c];
        const w = col.width;
        const value = env.valueOf(row, col, i);
        const isNumber = col.def.type === 'number' || typeof value === 'number';
        const cellParams = {
          value,
          data: row,
          rowIndex: i,
          colDef: col.def,
          api: env.api,
          colId: col.colId,
        };
        let style = resolveCellPaintStyle(col.def, cellParams, env.classStyles);
        if (env.cellStyleChain) style = applyCellStyleChain(env.cellStyleChain, cellParams, style);
        const cellBg = style?.background ?? style?.backgroundColor;
        if (cellBg) {
          ctx.fillStyle = cellBg;
          ctx.fillRect(x, y, w, rowH);
        }
        paintCellBorder(ctx, style?.border, x, y, w, rowH);
        const formatted = env.formatValue(row, col, i);
        if (formatted) {
          const weight = style?.fontWeight ?? 500; // match body rows (AG parity)
          const fs = style?.fontSize ?? t.fontSize;
          const font = `${style?.fontStyle ?? ''} ${weight} ${fs}px ${isNumber ? t.fontMono : t.fontSans}`.trim();
          ctx.font = font;
          const color = style?.color ?? t.textPrimary;
          ctx.fillStyle = color;
          const align = col.def.align ?? (isNumber ? 'right' : 'left');
          const text = truncate(ctx, font, formatted, Math.max(4, w - t.paddingX * 2));
          let tx: number;
          if (align === 'right') {
            ctx.textAlign = 'right';
            tx = x + w - t.paddingX;
          } else if (align === 'center') {
            ctx.textAlign = 'center';
            tx = x + w / 2;
          } else {
            ctx.textAlign = 'left';
            tx = x + t.paddingX;
          }
          const ty = y + rowH / 2 + 0.5;
          ctx.fillText(text, tx, ty);
          paintTextDecoration(ctx, style?.textDecoration, text, tx, ty, align, color);
        }
        if (verticalLines) {
          ctx.fillStyle = gridlineColor(t);
          ctx.fillRect(x + w - 1, y, 1, rowH);
        }
      }
    }
  };

  if (cols.left.cols.length) paintRegion(cols.left, 0, 0, cols.left.width);
  ctx.save();
  ctx.beginPath();
  ctx.rect(centerViewX0, 0, Math.max(0, centerViewX1 - centerViewX0), bandH);
  ctx.clip();
  paintRegion(
    cols.center,
    centerViewX0 - env.scrollLeft,
    env.scrollLeft,
    env.scrollLeft + (centerViewX1 - centerViewX0),
  );
  ctx.restore();
  if (cols.right.cols.length) paintRegion(cols.right, centerViewX1, 0, cols.right.width);

  // Horizontal gridlines between pinned rows.
  if (t.gridlines !== 'none') {
    ctx.fillStyle = gridlineColor(t);
    for (let i = 1; i < data.length; i++) ctx.fillRect(0, yBase + i * rowH - 1, viewWidth, 1);
  }
  // Pinned-column structural edges.
  ctx.fillStyle = t.structural;
  if (cols.left.width > 0) ctx.fillRect(centerViewX0 - 1, 0, 1, bandH);
  if (cols.right.width > 0) ctx.fillRect(centerViewX1, 0, 1, bandH);
  // Bold separator between the band and the scrolling body.
  ctx.fillRect(0, which === 'top' ? bandH - 1 : 0, viewWidth, 1);
}

function paintBodyRegion<TData>(
  ctx: CanvasRenderingContext2D,
  env: PaintEnv<TData>,
  region: Region<TData>,
  originX: number,
  rx0: number,
  rx1: number,
  firstRow: number,
  lastRow: number,
  now: number,
  yOverride?: number,
): void {
  const { theme: t, cols, rows } = env;
  const [firstCol, lastCol] = cols.visibleRange(region, rx0, rx1);
  if (lastCol < firstCol) return;

  const verticalLines = t.gridlines === 'both';
  const hasColSpan = regionHasColSpan(region);
  ctx.textBaseline = 'middle';

  for (let r = firstRow; r <= lastRow; r++) {
    const node = rows.getDisplayedNode(r);
    if (!node) continue;
    if (env.isFullWidthRow?.(r)) continue; // painted as one full-width cell
    if (node.detail) continue; // punched out — the DOM detail layer covers it
    const rowId = node.id;
    const rowH = env.rowHeightAt(r);
    const y = yOverride ?? rowY(env, r);
    const isGroup = node.group;
    const isFooter = node.footer === true;

    if (isGroup) {
      ctx.fillStyle = withAlpha(t.accentDim, isFooter ? 0.14 : 0.08);
      ctx.fillRect(originX + region.offsets[firstCol], y, region.offsets[lastCol + 1] - region.offsets[firstCol], rowH);
    }

    // A col-spanning cell may start left of the visible window — back up to its anchor.
    const startCol = hasColSpan ? colSpanAnchorIndex(env, r, region, firstCol) : firstCol;

    for (let c = startCol; c <= lastCol; c++) {
      const col = region.cols[c];
      const x = originX + region.offsets[c];
      let w = col.width;
      if (hasColSpan && col.def.colSpan) {
        const span = colSpanCount(env, r, region, c);
        if (span > 1) {
          w = region.offsets[c + span] - region.offsets[c];
          c += span - 1; // covered columns paint nothing
        }
      }
      // Merged (row-spanning) leaf cells paint in a dedicated pass after gridlines.
      if (!isGroup && !isFooter && spanRowsActive(env, col)) continue;
      // AG parity: in rows taller than the default, content keeps the default
      // line box and sits at the top rather than centering in the tall row.
      const lineBoxH = Math.min(rowH, env.uniformRowHeight);
      const value = env.valueAtDisplayed(r, col);
      const isNumber = col.def.type === 'number' || typeof value === 'number';
      const isAutoGroup = col.colId === AUTO_GROUP_COL_ID;
      const isSelection = col.colId === SELECTION_COL_ID;

      if (isSelection) {
        // AG shows checkboxes on group rows too (groupSelects 'self'); only
        // footers and DOM detail rows go without one.
        if (!node.footer && !node.detail && (node.group || node.data != null)) {
          paintCheckbox(ctx, x, y, w, lineBoxH, env.selectedIds.has(rowId), t);
        }
        if (verticalLines) {
          ctx.fillStyle = gridlineColor(t);
          ctx.fillRect(x + w - 1, y, 1, rowH);
        }
        continue;
      }

      let dirColor: string | null = null;
      const flashKey = `${rowId}\u0000${col.colId}`;
      const sample = env.flash.sample(flashKey, now);
      if (sample) {
        const isRuleCurve = sample.curve != null && sample.curve !== 'tick';
        const tickFlash = env.enableFlash && cellChangeFlashEnabled(col.def);
        if (isRuleCurve || tickFlash) {
          if (sample.alpha > 0.004) {
            const base =
              sample.curve === 'glow' ? t.accent : sample.dir >= 0 ? t.up : t.down;
            ctx.fillStyle = withAlpha(base, sample.alpha);
            ctx.fillRect(x, y, w, rowH);
          }
          if (sample.dir !== 0) dirColor = sample.dir > 0 ? t.up : t.down;
        }
      }

      const cellParams = {
        value,
        data: (node.data ?? undefined) as TData,
        rowIndex: r,
        colDef: col.def,
        api: env.api,
        colId: col.colId,
        rowId,
      };
      let style = resolveCellPaintStyle(col.def, cellParams, env.classStyles);
      if (env.cellStyleChain) {
        style = applyCellStyleChain(env.cellStyleChain, cellParams, style);
      }
      const cellBg = style?.background ?? style?.backgroundColor;
      if (cellBg) {
        ctx.fillStyle = cellBg;
        ctx.fillRect(x, y, w, rowH);
      }
      paintCellBorder(ctx, style?.border, x, y, w, rowH);
      const iconPad = paintCellIcon(ctx, col.def.cellIcon, x, y, w, rowH, t.paddingX);

      const formatted = env.formatDisplayed(r, col);

      if (isAutoGroup && isGroup) {
        const indent = node.level * env.groupIndent;
        const chevronX = x + t.paddingX + indent;
        const iconSize = 14;
        if (!isFooter && node.groupId) {
          drawIcon(
            ctx,
            node.expanded ? 'chevron-down' : 'chevron-right',
            chevronX - 2,
            y + lineBoxH / 2 - iconSize / 2,
            iconSize,
            t.textPrimary,
          );
        }
        ctx.font = `500 ${t.fontSize}px ${t.fontSans}`;
        ctx.fillStyle = t.textSecondary;
        ctx.textAlign = 'left';
        const label = truncate(
          ctx,
          ctx.font,
          formatted,
          Math.max(4, w - t.paddingX * 2 - indent - (isFooter ? 0 : 16)),
        );
        ctx.fillStyle = isFooter ? t.textSecondary : t.textPrimary;
        ctx.fillText(label, chevronX + (isFooter ? 0 : 16), y + lineBoxH / 2 + 0.5);
        if (verticalLines) {
          ctx.fillStyle = gridlineColor(t);
          ctx.fillRect(x + w - 1, y, 1, rowH);
        }
        continue;
      }

      if (isAutoGroup && !isGroup) {
        // Tree-data leaves carry a key: paint it indented, aligned with the
        // labels of expandable siblings (chevron slot left empty).
        if (formatted) {
          const indent = node.level * env.groupIndent;
          ctx.font = `500 ${t.fontSize}px ${t.fontSans}`;
          ctx.fillStyle = t.textPrimary;
          ctx.textAlign = 'left';
          const label = truncate(
            ctx,
            ctx.font,
            formatted,
            Math.max(4, w - t.paddingX * 2 - indent - 16),
          );
          ctx.fillText(label, x + t.paddingX + indent + 14, y + lineBoxH / 2 + 0.5);
        }
        if (verticalLines) {
          ctx.fillStyle = gridlineColor(t);
          ctx.fillRect(x + w - 1, y, 1, rowH);
        }
        continue;
      }

      // Master/detail expand column (AG `agGroupCellRenderer`): chevron on
      // master rows, value indented so all rows in the column stay aligned.
      if (col.def.cellRenderer === 'agGroupCellRenderer') {
        const iconSize = 14;
        if (node.master) {
          drawIcon(
            ctx,
            node.expanded ? 'chevron-down' : 'chevron-right',
            x + t.paddingX - 2,
            y + lineBoxH / 2 - iconSize / 2,
            iconSize,
            t.textPrimary,
          );
        }
        if (formatted) {
          ctx.font = `500 ${t.fontSize}px ${isNumber ? t.fontMono : t.fontSans}`;
          ctx.fillStyle = style?.color ?? dirColor ?? t.textPrimary;
          ctx.textAlign = 'left';
          const label = truncate(ctx, ctx.font, formatted, Math.max(4, w - t.paddingX * 2 - 16));
          ctx.fillText(label, x + t.paddingX + 16, y + lineBoxH / 2 + 0.5);
        }
        if (verticalLines) {
          ctx.fillStyle = gridlineColor(t);
          ctx.fillRect(x + w - 1, y, 1, rowH);
        }
        continue;
      }

      // Cheap property check keeps renderer-less columns off the map lookup.
      const renderer =
        col.def.cellRenderer !== undefined || col.def.cellRendererSelector !== undefined
          ? env.rendererFor(col, cellParams)
          : null;
      if (renderer && node.data) {
        const handled = renderer.paint(ctx, {
          value,
          formatted,
          data: node.data,
          rowIndex: r,
          colDef: col.def,
          api: env.api,
          x,
          y,
          width: w,
          height: rowH,
          selected: env.selectedIds.has(rowId),
          focused: env.focused?.rowIndex === r && env.focused.colId === col.colId,
          theme: t,
        } as CellRenderParams<TData>);
        if (handled !== false) {
          if (verticalLines) {
            ctx.fillStyle = gridlineColor(t);
            ctx.fillRect(x + w - 1, y, 1, rowH);
          }
          continue;
        }
      }

      if (formatted) {
        const weight = style?.fontWeight ?? (dirColor ? 600 : isGroup ? 600 : 500);
        const family = isNumber ? t.fontMono : t.fontSans;
        const fs = style?.fontSize ?? t.fontSize;
        const font = `${style?.fontStyle ?? ''} ${weight} ${fs}px ${family}`.trim();
        ctx.font = font;
        const align = col.def.align ?? (isNumber ? 'right' : 'left');
        const prefixPad =
          col.def.cellIcon && (col.def.cellIcon.place ?? 'prefix') === 'prefix' ? iconPad : 0;
        const suffixPad =
          col.def.cellIcon && col.def.cellIcon.place === 'suffix' ? iconPad : 0;
        const avail = w - t.paddingX * 2 - prefixPad - suffixPad;
        if (col.def.wrapText) {
          paintWrappedText(ctx, env, formatted, font, align, x + prefixPad, y, w - prefixPad - suffixPad, rowH);
        } else {
          const text = truncate(ctx, font, formatted, Math.max(4, avail));
          const color = style?.color ?? dirColor ?? (isGroup ? t.textSecondary : t.textPrimary);
          ctx.fillStyle = color;
          let tx: number;
          if (align === 'right') {
            ctx.textAlign = 'right';
            tx = x + w - t.paddingX - suffixPad;
          } else if (align === 'center') {
            ctx.textAlign = 'center';
            tx = x + (prefixPad + w - suffixPad) / 2;
          } else {
            ctx.textAlign = 'left';
            tx = x + t.paddingX + prefixPad;
          }
          const ty = y + lineBoxH / 2 + 0.5;
          ctx.fillText(text, tx, ty);
          paintTextDecoration(ctx, style?.textDecoration, text, tx, ty, align, color);
        }
      }

      const indicator = env.ruleIndicator?.(rowId, col.colId);
      if (indicator && indicator.position !== 'row-end') {
        const iconSize = 12;
        const iconName = indicator.icon as IconName;
        const ix =
          indicator.position === 'row-start'
            ? x + t.paddingX
            : x + w - t.paddingX - iconSize;
        drawIcon(
          ctx,
          iconName,
          ix,
          y + lineBoxH / 2 - iconSize / 2,
          iconSize,
          indicator.color ?? t.accent,
        );
      }

      if (verticalLines) {
        ctx.fillStyle = gridlineColor(t);
        ctx.fillRect(x + w - 1, y, 1, rowH);
      }
    }
  }
}

/** Multi-line cell text (`wrapText`): top-aligned, clipped to the cell (AG parity). */
function paintWrappedText<TData>(
  ctx: CanvasRenderingContext2D,
  env: PaintEnv<TData>,
  formatted: string,
  font: string,
  align: 'left' | 'right' | 'center',
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const t = env.theme;
  const lineH = wrapLineHeight(t);
  const lines = wrapLines(ctx, font, formatted, Math.max(4, w - t.paddingX * 2));
  const blockH = lines.length * lineH;
  const clip = blockH > h;
  if (clip) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
  }
  ctx.font = font;
  // First line sits where a single-line cell's text would (top of the row).
  const pad = Math.max(2, (Math.min(h, env.uniformRowHeight) - lineH) / 2);
  let ty = y + pad + lineH / 2 + 0.5;
  for (const line of lines) {
    if (align === 'right') {
      ctx.textAlign = 'right';
      ctx.fillText(line, x + w - t.paddingX, ty);
    } else if (align === 'center') {
      ctx.textAlign = 'center';
      ctx.fillText(line, x + w / 2, ty);
    } else {
      ctx.textAlign = 'left';
      ctx.fillText(line, x + t.paddingX, ty);
    }
    ty += lineH;
    if (ty - lineH > y + h) break;
  }
  if (clip) ctx.restore();
}

/** Leaf cells of `spanRows` columns paint here, after the gridline pass. */
function paintRowSpanRegion<TData>(
  ctx: CanvasRenderingContext2D,
  env: PaintEnv<TData>,
  region: Region<TData>,
  originX: number,
  rx0: number,
  rx1: number,
  firstRow: number,
  lastRow: number,
): void {
  const { cols, rows } = env;
  const [firstCol, lastCol] = cols.visibleRange(region, rx0, rx1);
  if (lastCol < firstCol) return;
  const now = performance.now();
  ctx.textBaseline = 'middle';

  for (let c = firstCol; c <= lastCol; c++) {
    const col = region.cols[c];
    if (!spanRowsActive(env, col)) continue;
    const x = originX + region.offsets[c];
    for (let r = firstRow; r <= lastRow; ) {
      const node = rows.getDisplayedNode(r);
      if (!node || node.group || node.footer) {
        r++;
        continue;
      }
      const { start, end } = rowSpanRange(env, r, col);
      paintSpanCell(ctx, env, col, x, col.width, start, end, now);
      r = end + 1;
    }
  }
}

function paintSpanCell<TData>(
  ctx: CanvasRenderingContext2D,
  env: PaintEnv<TData>,
  col: InternalColumn<TData>,
  x: number,
  w: number,
  start: number,
  end: number,
  now: number,
): void {
  const { theme: t, rows } = env;
  const rowH = env.rowHeightAt(start);
  const node = rows.getDisplayedNode(start);
  if (!node) return;
  const rowId = node.id;
  const merged = end > start;
  const y = rowY(env, start);
  const h = env.rowTop(end + 1) - env.rowTop(start);
  const verticalLines = t.gridlines === 'both';

  // A merged cell owns its background: erase the per-row zebra + gridlines.
  if (merged) {
    ctx.fillStyle = t.base;
    ctx.fillRect(x, y, w, h);
    if (env.selectedIds.has(rowId)) {
      ctx.fillStyle = withAlpha(t.accentDim, 0.18);
      ctx.fillRect(x, y, w, h);
    }
  }

  const value = env.valueAtDisplayed(start, col);
  const isNumber = col.def.type === 'number' || typeof value === 'number';

  let dirColor: string | null = null;
  const flashKey = `${rowId}\u0000${col.colId}`;
  const sample = env.flash.sample(flashKey, now);
  if (sample) {
    const isRuleCurve = sample.curve != null && sample.curve !== 'tick';
    const tickFlash = env.enableFlash && cellChangeFlashEnabled(col.def);
    if (isRuleCurve || tickFlash) {
      if (sample.alpha > 0.004) {
        const base = sample.curve === 'glow' ? t.accent : sample.dir >= 0 ? t.up : t.down;
        ctx.fillStyle = withAlpha(base, sample.alpha);
        ctx.fillRect(x, y, w, h);
      }
      if (sample.dir !== 0) dirColor = sample.dir > 0 ? t.up : t.down;
    }
  }

  const cellParams = {
    value,
    data: (node.data ?? undefined) as TData,
    rowIndex: start,
    colDef: col.def,
    api: env.api,
    colId: col.colId,
    rowId,
  };
  let style = resolveCellPaintStyle(col.def, cellParams, env.classStyles);
  if (env.cellStyleChain) {
    style = applyCellStyleChain(env.cellStyleChain, cellParams, style);
  }
  const cellBg = style?.background ?? style?.backgroundColor;
  if (cellBg) {
    ctx.fillStyle = cellBg;
    ctx.fillRect(x, y, w, h);
  }

  const paintBorders = (): void => {
    if (verticalLines) {
      ctx.fillStyle = gridlineColor(t);
      ctx.fillRect(x + w - 1, y, 1, h);
    }
    if (merged && t.gridlines !== 'none') {
      ctx.fillStyle = gridlineColor(t);
      ctx.fillRect(x, y + h - 1, w, 1);
    }
  };

  const formatted = env.formatDisplayed(start, col);

  const renderer =
    col.def.cellRenderer !== undefined || col.def.cellRendererSelector !== undefined
      ? env.rendererFor(col, cellParams)
      : null;
  if (renderer && node.data) {
    const handled = renderer.paint(ctx, {
      value,
      formatted,
      data: node.data,
      rowIndex: start,
      colDef: col.def,
      api: env.api,
      x,
      y,
      width: w,
      height: h,
      selected: env.selectedIds.has(rowId),
      focused: env.focused?.rowIndex === start && env.focused.colId === col.colId,
      theme: t,
    } as CellRenderParams<TData>);
    if (handled !== false) {
      paintBorders();
      return;
    }
  }

  if (formatted) {
    const weight = style?.fontWeight ?? (dirColor ? 600 : 500);
    const family = isNumber ? t.fontMono : t.fontSans;
    const font = `${style?.fontStyle ?? ''} ${weight} ${t.fontSize}px ${family}`.trim();
    ctx.font = font;
    ctx.fillStyle = style?.color ?? dirColor ?? t.textPrimary;
    const align = col.def.align ?? (isNumber ? 'right' : 'left');
    const avail = w - t.paddingX * 2;
    const text = truncate(ctx, font, formatted, Math.max(4, avail));
    // AG parity: span content sits on the first row and stays sticky while
    // the span scrolls, pinned to the viewport top until the span's end.
    let cy = y + rowH / 2 + 0.5;
    if (merged && cy < rowH / 2) cy = Math.min(rowH / 2 + 0.5, y + h - rowH / 2 + 0.5);
    if (align === 'right') {
      ctx.textAlign = 'right';
      ctx.fillText(text, x + w - t.paddingX, cy);
    } else if (align === 'center') {
      ctx.textAlign = 'center';
      ctx.fillText(text, x + w / 2, cy);
    } else {
      ctx.textAlign = 'left';
      ctx.fillText(text, x + t.paddingX, cy);
    }
  }

  paintBorders();
}

/**
 * Viewport-space rect of a cell, or null when out of view / unknown col.
 * Span anchors return the full merged rect (colSpan width / spanRows height).
 */
export function cellRect<TData>(
  env: PaintEnv<TData>,
  rowIndex: number,
  colId: string,
): { x: number; y: number; w: number; h: number } | null {
  const { cols } = env;
  const centerViewX1 = env.viewWidth - cols.right.width;

  const inRegion = (region: Region<TData>): number => region.cols.findIndex((c) => c.colId === colId);

  const build = (
    region: Region<TData>,
    i: number,
    regionOriginX: number,
  ): { x: number; y: number; w: number; h: number } => {
    const col = region.cols[i];
    let w = col.width;
    if (col.def.colSpan) {
      const span = colSpanCount(env, rowIndex, region, i);
      if (span > 1) w = region.offsets[i + span] - region.offsets[i];
    }
    let y = rowY(env, rowIndex);
    let h = env.rowHeightAt(rowIndex);
    if (spanRowsActive(env, col)) {
      const range = rowSpanRange(env, rowIndex, col);
      y = rowY(env, range.start);
      h = env.rowTop(range.end + 1) - env.rowTop(range.start);
    }
    return { x: regionOriginX + region.offsets[i], y, w, h };
  };

  let i = inRegion(cols.left);
  if (i >= 0) return build(cols.left, i, 0);
  i = inRegion(cols.center);
  if (i >= 0) return build(cols.center, i, cols.left.width - env.scrollLeft);
  i = inRegion(cols.right);
  if (i >= 0) return build(cols.right, i, centerViewX1);
  return null;
}
