/**
 * Injected stylesheet + CSS-variable theming (spec §4). Structure follows the
 * repo's dom renderer (absolute rows, translate3d, contain: strict, flash as
 * retriggerable @keyframes classes); dark defaults match the showcase's
 * Cursor-Dark tokens. Module-load is DOM-free so node test scripts can import
 * anything that imports this — the document is only touched inside calls.
 */

/** Class names for every pgrid element — single source of truth shared by the stylesheet and the element builders. */
export const CLS = {
  root: 'pg-root',
  header: 'pg-header',
  hcell: 'pg-hcell',
  hgroup: 'pg-hgroup',
  panel: 'pg-panel',
  chip: 'pg-chip',
  scroller: 'pg-scroller',
  spacer: 'pg-spacer',
  layer: 'pg-layer',
  row: 'pg-row',
  cell: 'pg-cell',
  num: 'pg-num',
  group: 'pg-group',
  chevron: 'pg-chevron',
  flashUp: 'pg-flash-up',
  flashDown: 'pg-flash-down',
  sortAsc: 'pg-sort-asc',
  sortDesc: 'pg-sort-desc',
  sidebar: 'pg-sidebar',
  sidebarRow: 'pg-sidebar-row',
  toggle: 'pg-toggle',
} as const;

/** Color tokens per theme; geometry/font vars live as dark-independent defaults on `.pg-root`. */
const THEME_VARS: Record<'dark' | 'light', Record<string, string>> = {
  dark: {
    '--pg-base': '#141414',
    '--pg-raised': '#1B1B1B',
    '--pg-text': '#F0F0F0',
    '--pg-text-2': '#A8A8A8',
    '--pg-accent': '#81A1C1',
    '--pg-up': '#7CB88C',
    '--pg-down': '#C87878',
    '--pg-gridline': 'rgba(69, 69, 69, 0.85)',
  },
  light: {
    '--pg-base': '#FCFCFC',
    '--pg-raised': '#F3F3F3',
    '--pg-text': '#141414',
    '--pg-text-2': '#6E6E6E',
    '--pg-accent': '#3C7CAB',
    '--pg-up': '#1F8A65',
    '--pg-down': '#CF2D56',
    '--pg-gridline': 'rgba(194, 194, 194, 0.85)',
  },
};

/** Sets the `--pg-*` color variables for a theme on the grid root. */
export function applyTheme(root: HTMLElement, theme: 'dark' | 'light'): void {
  for (const [k, v] of Object.entries(THEME_VARS[theme])) root.style.setProperty(k, v);
}

const STYLE_ID = 'pgrid-styles';

const BASE_CSS = `
.${CLS.root}, .${CLS.root} * { box-sizing: border-box; }
.${CLS.root} { position: relative; height: 100%; display: flex; flex-direction: column;
  --pg-base: #141414; --pg-raised: #1B1B1B; --pg-text: #F0F0F0; --pg-text-2: #A8A8A8;
  --pg-accent: #81A1C1; --pg-up: #7CB88C; --pg-down: #C87878;
  --pg-gridline: rgba(69, 69, 69, 0.85);
  --pg-row-h: 26px; --pg-header-h: 30px;
  --pg-font: 'IBM Plex Sans', 'Inter', system-ui, -apple-system, sans-serif;
  --pg-font-size: 12px;
  background: var(--pg-base); color: var(--pg-text);
  font: var(--pg-font-size) var(--pg-font); user-select: none; }
.${CLS.header} { flex: none; background: var(--pg-raised);
  border-bottom: 1px solid var(--pg-gridline); overflow: hidden; position: relative; z-index: 1; }
.${CLS.hcell} { flex: none; display: flex; align-items: center; height: var(--pg-header-h);
  padding: 0 8px; color: var(--pg-text-2); font-weight: 500; cursor: pointer;
  position: relative; border-right: 1px solid var(--pg-gridline);
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.${CLS.hcell}.${CLS.num} { justify-content: flex-end; }
.${CLS.hcell}.${CLS.sortAsc}::after { content: ' \\2191'; color: var(--pg-accent); }
.${CLS.hcell}.${CLS.sortDesc}::after { content: ' \\2193'; color: var(--pg-accent); }
.${CLS.hgroup} { flex: none; display: flex; align-items: center; justify-content: center;
  height: var(--pg-header-h); padding: 0 8px; color: var(--pg-text-2); font-weight: 600;
  border-right: 1px solid var(--pg-gridline); border-bottom: 1px solid var(--pg-gridline);
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.${CLS.panel} { flex: none; display: flex; align-items: center; gap: 4px; min-height: 28px;
  padding: 2px 8px; background: var(--pg-raised); border-bottom: 1px solid var(--pg-gridline);
  color: var(--pg-text-2); }
.${CLS.chip} { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px;
  border: 1px solid var(--pg-gridline); border-radius: 2px; background: var(--pg-base);
  color: var(--pg-text); cursor: grab; white-space: nowrap; }
.${CLS.chip} > button { border: none; background: none; color: var(--pg-text-2);
  cursor: pointer; padding: 0; font: inherit; line-height: 1; }
.${CLS.chip} > button:hover { color: var(--pg-text); }
.${CLS.chip}[data-ghost="1"] { position: fixed; pointer-events: none; opacity: 0.85; z-index: 1000; }
.${CLS.panel}[data-drop="1"] { outline: 1px dashed var(--pg-accent); outline-offset: -2px; }
.${CLS.sidebar} { flex: none; width: 200px; overflow: auto; background: var(--pg-raised);
  border-left: 1px solid var(--pg-gridline); }
.${CLS.sidebarRow} { display: flex; align-items: center; gap: 4px; padding: 3px 8px;
  border-bottom: 1px solid var(--pg-gridline); }
.${CLS.sidebarRow} > span { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.${CLS.toggle} { flex: none; width: 18px; height: 18px; padding: 0; font-size: 10px; line-height: 1;
  border: 1px solid var(--pg-gridline); border-radius: 2px; background: none;
  color: var(--pg-text-2); cursor: pointer; }
.${CLS.toggle}[data-on="1"] { border-color: var(--pg-accent); color: var(--pg-accent); }
.${CLS.toggle}:disabled { opacity: 0.35; cursor: default; }
.${CLS.scroller} { flex: 1; overflow: auto; position: relative; }
.${CLS.spacer} { position: absolute; top: 0; left: 0; width: 1px; visibility: hidden; }
.${CLS.layer} { position: sticky; top: 0; left: 0; height: 0; overflow: visible;
  z-index: 1; will-change: transform;
  /* Sticky = compositor-pinned: async (wheel/momentum) scrolling cannot move
     painted rows before the main-thread sync runs — the structural fix for
     scroll flicker/blank; regular-table clip-pins its table the same way. */ }
.${CLS.row} { position: absolute; left: 0; height: var(--pg-row-h);
  border-bottom: 1px solid var(--pg-gridline); will-change: transform; contain: strict; }
.${CLS.row}[data-odd="1"] { background: var(--pg-raised); }
.${CLS.row}.${CLS.group} { background: color-mix(in srgb, var(--pg-accent) 8%, transparent);
  font-weight: 500; }
.${CLS.cell} { position: absolute; top: 0; height: 100%; display: flex; align-items: center;
  padding: 0 8px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.${CLS.cell}.${CLS.num} { justify-content: flex-end; font-variant-numeric: tabular-nums; }
.${CLS.chevron} { position: absolute; top: 0; height: 100%; width: 20px; display: none;
  align-items: center; justify-content: center; cursor: pointer;
  z-index: 1; /* cells are later siblings painting above — keep clicks landing on the chevron */ }
.${CLS.row}.${CLS.group} > .${CLS.chevron} { display: flex; }
.${CLS.chevron}::before { content: ''; width: 0; height: 0;
  border-top: 4px solid transparent; border-bottom: 4px solid transparent;
  border-left: 5px solid var(--pg-text-2); transition: transform 120ms ease-out; }
.${CLS.chevron}[data-expanded="1"]::before { transform: rotate(90deg); }
@keyframes pg-flash-up { 0%,15% { background: color-mix(in srgb, var(--pg-up) 22%, transparent); }
  100% { background: transparent; } }
@keyframes pg-flash-down { 0%,15% { background: color-mix(in srgb, var(--pg-down) 22%, transparent); }
  100% { background: transparent; } }
.${CLS.cell}.${CLS.flashUp} { animation: pg-flash-up 590ms ease-out; }
.${CLS.cell}.${CLS.flashDown} { animation: pg-flash-down 590ms ease-out; }
`;

/** Injects the base stylesheet once per document (idempotent by element id). */
export function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = BASE_CSS;
  document.head.appendChild(el);
}
