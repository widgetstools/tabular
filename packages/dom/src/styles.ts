import type { CellStyle, ResolvedTheme } from '@tabular/core';
import { withAlpha } from '@tabular/core';

/** Class names for every DOM-renderer element — single source of truth shared
 * by the base stylesheet below and the element builders. */
export const CLS = {
  root: 'td-root', header: 'td-header', headerCell: 'td-hcell',
  scroller: 'td-scroller', spacer: 'td-spacer', layer: 'td-layer',
  row: 'td-row', cell: 'td-cell', num: 'td-num', group: 'td-group',
  footer: 'td-footer', selected: 'td-selected', focusCell: 'td-focus',
  flashUp: 'td-flash-up', flashDown: 'td-flash-down',
  sortAsc: 'td-sort-asc', sortDesc: 'td-sort-desc',
} as const;

/** Alpha used for gridlines — matches `renderer.ts`'s `gridlineColor(t)` helper. */
const GRIDLINE_ALPHA = 0.85;

/**
 * Sets the `--td-*` custom properties on the grid root from a `ResolvedTheme`.
 * Every value maps 1:1 to a `ThemeTokens`/`DensitySpec` field except
 * `--td-gridline`, which is derived exactly as `renderer.ts`'s
 * `gridlineColor(t)` — `withAlpha(t.gridline, 0.85)`.
 */
export function applyThemeVars(root: HTMLElement, t: ResolvedTheme): void {
  const v: Record<string, string> = {
    '--td-base': t.base, '--td-raised': t.raised, '--td-header-bg': t.headerBg,
    '--td-text': t.textPrimary, '--td-text-2': t.textSecondary,
    '--td-accent': t.accent, '--td-accent-dim': t.accentDim,
    '--td-up': t.up, '--td-down': t.down,
    '--td-font': t.fontSans, '--td-font-mono': t.fontMono,
    '--td-font-size': `${t.fontSize}px`, '--td-header-font-size': `${t.headerFontSize}px`,
    '--td-row-h': `${t.rowHeight}px`, '--td-header-h': `${t.headerHeight}px`,
    '--td-pad-x': `${t.paddingX}px`,
    '--td-gridline': withAlpha(t.gridline, GRIDLINE_ALPHA),
  };
  for (const [k, val] of Object.entries(v)) root.style.setProperty(k, val);
}

const STYLE_ID = 'tabular-dom-styles';

const BASE_CSS = `
.td-root { position: relative; height: 100%; display: flex; flex-direction: column;
  background: var(--td-base); color: var(--td-text);
  font: var(--td-font-size) var(--td-font); user-select: none; }
.td-header { display: flex; flex: none; height: var(--td-header-h);
  background: var(--td-header-bg); border-bottom: 1px solid var(--td-gridline);
  overflow: hidden; position: relative; z-index: 1; }
.td-hcell { flex: none; display: flex; align-items: center; padding: 0 var(--td-pad-x);
  font-size: var(--td-header-font-size); color: var(--td-text-2); font-weight: 500;
  cursor: pointer; position: relative; border-right: 1px solid var(--td-gridline); }
.td-hcell.td-num { justify-content: flex-end; }
.td-hcell.td-sort-asc::after { content: ' \\2191'; color: var(--td-accent); }
.td-hcell.td-sort-desc::after { content: ' \\2193'; color: var(--td-accent); }
.td-scroller { flex: 1; overflow: auto; position: relative; }
.td-spacer { position: absolute; top: 0; left: 0; width: 1px; visibility: hidden; }
.td-layer { position: absolute; top: 0; left: 0; }
.td-row { position: absolute; left: 0; height: var(--td-row-h);
  border-bottom: 1px solid var(--td-gridline); will-change: transform; contain: strict; }
.td-row[data-odd="1"] { background: var(--td-raised); }
.td-row.td-group { background: color-mix(in srgb, var(--td-accent-dim) 8%, transparent); font-weight: 500; }
.td-row.td-footer { background: color-mix(in srgb, var(--td-accent-dim) 14%, transparent); color: var(--td-text-2); }
.td-row.td-selected { background: color-mix(in srgb, var(--td-accent-dim) 18%, var(--td-base)); }
.td-cell { position: absolute; top: 0; height: 100%; display: flex; align-items: center;
  padding: 0 var(--td-pad-x); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.td-cell.td-num { justify-content: flex-end; font-family: var(--td-font-mono);
  font-variant-numeric: tabular-nums; }
.td-cell.td-focus { outline: 1px solid var(--td-accent); outline-offset: -1px; }
@keyframes td-flash-up { 0%,15% { background: color-mix(in srgb, var(--td-up) 22%, transparent); }
  100% { background: transparent; } }
@keyframes td-flash-down { 0%,15% { background: color-mix(in srgb, var(--td-down) 22%, transparent); }
  100% { background: transparent; } }
.td-cell.td-flash-up { animation: td-flash-up 590ms ease-out; }
.td-cell.td-flash-down { animation: td-flash-down 590ms ease-out; }
`;

/** Injects the base stylesheet once per document. */
export function ensureDomGridStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = BASE_CSS;
  document.head.appendChild(el);
}

/**
 * Worker-computed styles arrive as a deduped table; each entry becomes one
 * generated CSS class so per-cell application is a single class token.
 * Id 0 is reserved for "no style".
 *
 * The 1024-id cap, LRU eviction, and warn-once are enforced by the
 * worker-side producer (Task 6's render plane) — this class renders an
 * already-deduped, already-capped table.
 */
export class StyleTable {
  private el: HTMLStyleElement;
  private ver = -1;
  private count = 0;
  constructor(private readonly prefix = `tds${Math.floor(Math.random() * 1e6)}`) {
    this.el = document.createElement('style');
    document.head.appendChild(this.el);
  }
  /** Version of the currently rendered table; -1 until the first `setTable`. */
  get version(): number { return this.ver; }
  /** Returns the class name for a style id, '' for id 0 (no style). */
  className(id: number): string { return id > 0 && id <= this.count ? `${this.prefix}-${id}` : ''; }
  /** Replace table contents for a new version; regenerates the `<style>` rules. */
  setTable(version: number, styles: CellStyle[]): void {
    if (version === this.ver) return;
    this.ver = version;
    this.count = styles.length;
    this.el.textContent = styles
      .map((s, i) => `.${this.prefix}-${i + 1} { ${cssOf(s)} }`)
      .join('\n');
  }
  /** Removes the generated `<style>` element from the document. */
  dispose(): void { this.el.remove(); }
}

/**
 * `CellStyle` → inline CSS declarations. Covers the fields the rules engine
 * (`packages/rules/src/types.ts` `RuleCellStyle`) actually emits: color,
 * background/backgroundColor, fontWeight, fontStyle, fontSize, border (string
 * or per-side map), textDecoration. `textTransform` exists on `CellStyle` but
 * is header-caption-only and not produced by the rules engine, so it's left
 * uncovered here.
 */
function cssOf(s: CellStyle): string {
  const out: string[] = [];
  const bg = s.background ?? s.backgroundColor;
  if (bg) out.push(`background:${bg}`);
  if (s.color) out.push(`color:${s.color}`);
  if (s.fontWeight != null) out.push(`font-weight:${s.fontWeight}`);
  if (s.fontStyle) out.push(`font-style:${s.fontStyle}`);
  if (s.fontSize != null) out.push(`font-size:${s.fontSize}px`);
  if (s.textDecoration) out.push(`text-decoration:${s.textDecoration}`);
  if (s.border) {
    if (typeof s.border === 'string') {
      out.push(`border:${s.border}`);
    } else {
      const b = s.border;
      if (b.all) out.push(`border:${b.all}`);
      if (b.top) out.push(`border-top:${b.top}`);
      if (b.bottom) out.push(`border-bottom:${b.bottom}`);
      if (b.left) out.push(`border-left:${b.left}`);
      if (b.right) out.push(`border-right:${b.right}`);
    }
  }
  return out.join(';');
}
