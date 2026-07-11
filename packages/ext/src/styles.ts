/**
 * TabularExt chrome stylesheet — instrument-console aesthetic.
 * Colours come from CSS vars synced from the grid theme (see applyThemeVars).
 */
import type { ResolvedTheme } from '@tabular/core';

const STYLE_ID = 'tabular-ext-styles';

export function applyThemeVars(el: HTMLElement, t: ResolvedTheme): void {
  const s = el.style;
  s.setProperty('--tx-base', t.base);
  s.setProperty('--tx-raised', t.raised);
  s.setProperty('--tx-header', t.headerBg);
  s.setProperty('--tx-overlay', t.overlay);
  s.setProperty('--tx-sunken', t.sunken);
  s.setProperty('--tx-hairline', t.hairline);
  s.setProperty('--tx-structural', t.structural);
  s.setProperty('--tx-fg', t.textPrimary);
  s.setProperty('--tx-muted', t.textSecondary);
  s.setProperty('--tx-faint', t.textTertiary);
  s.setProperty('--tx-accent', t.accent);
  s.setProperty('--tx-accent-dim', t.accentDim);
  s.setProperty('--tx-up', t.up);
  s.setProperty('--tx-down', t.down);
  s.setProperty('--tx-font-sans', t.fontSans);
  s.setProperty('--tx-font-mono', t.fontMono);
  s.setProperty('--tx-fs', `${t.fontSize}px`);
  s.setProperty('--tx-fs-sm', `${Math.max(10, t.fontSize - 1)}px`);
  s.setProperty('--tx-fs-xs', `${Math.max(9, t.fontSize - 2)}px`);
  el.dataset.txTheme = t.name;
}

export function injectExtStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = EXT_CSS;
  document.head.appendChild(style);
}

const EXT_CSS = `
/* ── shell ─────────────────────────────────────────────────────────── */
.tx-root {
  --tx-radius: 2px;
  --tx-control-h: 28px;
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: var(--tx-base);
  color: var(--tx-fg);
  font: var(--tx-fs) / 1.35 var(--tx-font-sans);
  -webkit-font-smoothing: antialiased;
}
.tx-root *, .tx-root *::before, .tx-root *::after { box-sizing: border-box; }

.tx-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}
.tx-grid-mount {
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

/* ── title bar ─────────────────────────────────────────────────────── */
.tx-titlebar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 40px;
  padding: 0 10px;
  flex-shrink: 0;
  background: var(--tx-header);
  border-bottom: 1px solid var(--tx-hairline);
  z-index: 5;
}
/* Signature: thin accent rail */
.tx-titlebar::after {
  content: '';
  position: absolute;
  left: 0; right: 0; bottom: -1px;
  height: 1px;
  background: linear-gradient(
    90deg,
    var(--tx-accent) 0%,
    color-mix(in srgb, var(--tx-accent) 35%, transparent) 28%,
    transparent 62%
  );
  pointer-events: none;
}

.tx-brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding-right: 4px;
  user-select: none;
}
.tx-brand-mark {
  width: 18px;
  height: 18px;
  border-radius: var(--tx-radius);
  background:
    linear-gradient(135deg, var(--tx-accent) 0%, var(--tx-accent-dim) 100%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tx-fg) 12%, transparent);
  position: relative;
}
.tx-brand-mark::after {
  content: '';
  position: absolute;
  inset: 4px 4px 4px 7px;
  border-left: 1.5px solid color-mix(in srgb, #fff 85%, transparent);
  border-bottom: 1.5px solid color-mix(in srgb, #fff 85%, transparent);
  transform: rotate(-45deg) translateY(-1px);
  opacity: 0.9;
}
.tx-brand-name {
  font-weight: 650;
  font-size: 13px;
  letter-spacing: -0.02em;
  color: var(--tx-fg);
}
.tx-brand-collapse {
  width: 22px;
  height: 22px;
}

.tx-tb-cluster {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.tx-tb-spacer { flex: 1; min-width: 8px; }

/* icon button */
.tx-iconbtn {
  appearance: none;
  width: var(--tx-control-h);
  height: var(--tx-control-h);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--tx-radius);
  background: transparent;
  color: var(--tx-muted);
  cursor: pointer;
  position: relative;
  transition: background 100ms ease, color 100ms ease;
}
.tx-iconbtn:hover {
  background: color-mix(in srgb, var(--tx-fg) 6%, transparent);
  color: var(--tx-fg);
}
.tx-iconbtn:focus-visible {
  outline: 1px solid var(--tx-accent);
  outline-offset: 1px;
}
.tx-iconbtn.is-active,
.tx-iconbtn[aria-pressed="true"] {
  background: color-mix(in srgb, var(--tx-accent) 16%, transparent);
  color: var(--tx-accent);
}
.tx-iconbtn:disabled { opacity: 0.4; cursor: default; }
.tx-iconbtn:disabled:hover { background: transparent; color: var(--tx-muted); }

.tx-badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--tx-down);
  color: #fff;
  font: 600 9px / 14px var(--tx-font-sans);
  text-align: center;
  pointer-events: none;
}

/* expandable search */
.tx-search {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.tx-search.is-open {
  background: var(--tx-sunken);
  border: 1px solid var(--tx-hairline);
  border-radius: var(--tx-radius);
  padding-left: 2px;
}
.tx-search-input {
  width: 0;
  height: 24px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--tx-fg);
  font: var(--tx-fs-sm) var(--tx-font-sans);
  opacity: 0;
  transition: width 140ms ease, opacity 100ms ease, padding 140ms ease;
}
.tx-search.is-open .tx-search-input {
  width: 220px;
  padding: 0 8px 0 4px;
  opacity: 1;
}
.tx-search-input:focus { outline: none; }
.tx-search-input::placeholder { color: var(--tx-faint); }

/* save chip */
.tx-save {
  appearance: none;
  height: var(--tx-control-h);
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--tx-hairline);
  border-radius: var(--tx-radius);
  background: var(--tx-base);
  color: var(--tx-muted);
  font: 500 var(--tx-fs-sm) var(--tx-font-sans);
  cursor: pointer;
  transition: border-color 100ms ease, color 100ms ease, background 100ms ease;
}
.tx-save:hover { border-color: var(--tx-structural); color: var(--tx-fg); }
.tx-save.is-dirty {
  border-color: color-mix(in srgb, var(--tx-accent) 55%, var(--tx-hairline));
  color: var(--tx-accent);
  background: color-mix(in srgb, var(--tx-accent) 8%, var(--tx-base));
}
.tx-save-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--tx-accent);
  opacity: 0;
}
.tx-save.is-dirty .tx-save-dot { opacity: 1; }

.tx-date {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: var(--tx-control-h);
  padding: 0 8px;
  border: 1px solid var(--tx-hairline);
  border-radius: var(--tx-radius);
  color: var(--tx-muted);
  font: var(--tx-fs-xs) / 1 var(--tx-font-mono);
  letter-spacing: 0.02em;
}

/* ── menus / popovers (body-mounted) ───────────────────────────────── */
.tx-menu {
  position: fixed;
  z-index: 10000;
  min-width: 220px;
  max-width: 360px;
  max-height: min(70vh, 480px);
  overflow: auto;
  padding: 4px;
  background: var(--tx-overlay);
  border: 1px solid var(--tx-hairline);
  border-radius: var(--tx-radius);
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--tx-fg) 4%, transparent),
    0 12px 32px rgba(0, 0, 0, 0.45);
  color: var(--tx-fg);
  font: var(--tx-fs-sm) / 1.35 var(--tx-font-sans);
}
.tx-menu-list { display: flex; flex-direction: column; gap: 1px; }
.tx-menu-item {
  appearance: none;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  border: none;
  border-radius: var(--tx-radius);
  background: transparent;
  color: var(--tx-fg);
  padding: 7px 8px;
  font: inherit;
  cursor: pointer;
}
.tx-menu-item:hover { background: color-mix(in srgb, var(--tx-fg) 6%, transparent); }
.tx-menu-item.is-active { color: var(--tx-accent); }
.tx-menu-item.is-danger { color: var(--tx-down); }
.tx-menu-item .tx-menu-check { margin-left: auto; color: var(--tx-accent); }
.tx-menu-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--tx-hairline);
}
.tx-menu-label {
  padding: 6px 8px 4px;
  font: 600 var(--tx-fs-xs) / 1 var(--tx-font-mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--tx-faint);
}

/* alerts feed */
.tx-alerts {
  width: 320px;
  padding: 0;
}
.tx-alerts-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--tx-hairline);
}
.tx-alerts-title {
  font: 600 12px / 1 var(--tx-font-sans);
  letter-spacing: -0.01em;
}
.tx-alerts-clear {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--tx-muted);
  font: var(--tx-fs-xs) var(--tx-font-sans);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: var(--tx-radius);
}
.tx-alerts-clear:hover { color: var(--tx-fg); background: color-mix(in srgb, var(--tx-fg) 6%, transparent); }
.tx-alerts-body { max-height: 320px; overflow: auto; padding: 4px; }
.tx-alert-row {
  display: grid;
  grid-template-columns: 6px 1fr auto;
  gap: 8px;
  align-items: start;
  padding: 8px;
  border-radius: var(--tx-radius);
}
.tx-alert-row:hover { background: color-mix(in srgb, var(--tx-fg) 4%, transparent); }
.tx-alert-dot {
  width: 6px;
  height: 6px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--tx-accent);
}
.tx-alert-dot.warn { background: #d4a017; }
.tx-alert-dot.error { background: var(--tx-down); }
.tx-alert-dot.info { background: var(--tx-accent); }
.tx-alert-msg {
  font: 500 var(--tx-fs-sm) / 1.35 var(--tx-font-sans);
  color: var(--tx-fg);
}
.tx-alert-meta {
  margin-top: 2px;
  font: var(--tx-fs-xs) / 1.3 var(--tx-font-mono);
  color: var(--tx-faint);
}
.tx-alert-sev {
  font: 600 9px / 1 var(--tx-font-mono);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--tx-muted);
  padding-top: 3px;
}
.tx-alerts-empty {
  padding: 28px 16px;
  text-align: center;
  color: var(--tx-faint);
  font: var(--tx-fs-sm) var(--tx-font-sans);
}

/* ── ribbon host (edit strip + formatting band) ────────────────────── */
.tx-ribbon-host {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  background: var(--tx-header);
  border-bottom: 1px solid var(--tx-hairline);
}
.tx-ribbon-host[hidden] { display: none !important; }

.tx-edit-strip {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 4px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--tx-hairline) 80%, transparent);
  font-size: 12px;
}
.tx-edit-strip[hidden] { display: none !important; }
.tx-es-seg {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.tx-es-seg + .tx-es-seg {
  margin-left: 12px;
  padding-left: 12px;
  border-left: 1px solid color-mix(in srgb, var(--tx-hairline) 80%, transparent);
}
.tx-es-label {
  font: 600 9px / 1 var(--tx-font-mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--tx-faint);
  margin-right: 4px;
  user-select: none;
}
.tx-es-stat {
  font: 500 11px / 1 var(--tx-font-mono);
  color: var(--tx-faint);
  margin-left: 4px;
  white-space: nowrap;
}

.tx-ribbon {
  display: flex;
  align-items: stretch;
  gap: 0;
  min-height: 56px;
  padding: 4px 6px 2px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
  font-size: 12px;
}
.tx-ribbon[hidden] { display: none !important; }

.tx-rb-grp {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  padding: 5px 8px 3px;
  border-right: 1px solid var(--tx-hairline);
  flex-shrink: 0;
}
.tx-rb-grp:last-child { border-right: none; }
.tx-rb-deck {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: stretch;
  flex: 1;
  justify-content: center;
}
.tx-rb-mini {
  display: flex;
  align-items: center;
  gap: 2px;
}
.tx-rb-grp-name {
  font: 600 9px / 1 var(--tx-font-mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--tx-faint);
  margin-top: 2px;
  user-select: none;
}

.tx-rb-btn {
  appearance: none;
  width: 26px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--tx-radius);
  background: transparent;
  color: var(--tx-muted);
  cursor: pointer;
  position: relative;
  transition: background 80ms ease, color 80ms ease;
}
.tx-rb-btn:hover {
  background: color-mix(in srgb, var(--tx-fg) 7%, transparent);
  color: var(--tx-fg);
}
.tx-rb-btn:focus-visible { outline: 1px solid var(--tx-accent); outline-offset: 0; }
.tx-rb-btn.is-on,
.tx-rb-btn[aria-pressed="true"] {
  background: color-mix(in srgb, var(--tx-accent) 18%, transparent);
  color: var(--tx-accent);
}
.tx-rb-btn:disabled { opacity: 0.35; cursor: default; }

.tx-rb-pill {
  appearance: none;
  height: 24px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--tx-hairline);
  border-radius: var(--tx-radius);
  background: var(--tx-base);
  color: var(--tx-fg);
  font: 500 var(--tx-fs-xs) var(--tx-font-sans);
  cursor: pointer;
  white-space: nowrap;
}
.tx-rb-pill:hover { border-color: var(--tx-structural); }
.tx-rb-input {
  height: 24px;
  width: 64px;
  padding: 0 6px;
  border: 1px solid var(--tx-hairline);
  border-radius: var(--tx-radius);
  background: var(--tx-base);
  color: var(--tx-fg);
  font: var(--tx-fs-xs) var(--tx-font-mono);
}
.tx-rb-input:focus {
  outline: none;
  border-color: var(--tx-accent);
}
.tx-rb-swatch { position: relative; }
.tx-rb-swatchbar {
  position: absolute;
  left: 4px;
  right: 4px;
  bottom: 2px;
  height: 3px;
  border-radius: 1px;
  pointer-events: none;
}
.tx-rb-colorinput {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}
.tx-rb-targettoggle {
  appearance: none;
  height: 24px;
  padding: 0 7px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--tx-hairline);
  border-radius: var(--tx-radius);
  background: var(--tx-base);
  color: var(--tx-muted);
  font: 500 var(--tx-fs-xs) var(--tx-font-sans);
  cursor: pointer;
}
.tx-rb-targettoggle:hover { color: var(--tx-fg); border-color: var(--tx-structural); }
.tx-rb-targettoggle.is-header {
  border-color: color-mix(in srgb, var(--tx-accent) 40%, var(--tx-hairline));
  color: var(--tx-accent);
}

.tx-rb-extras {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  margin-left: auto;
  flex-shrink: 0;
}

.tx-rb-stepper {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 24px;
  padding: 0 4px;
  border: 1px solid var(--tx-hairline);
  border-radius: var(--tx-radius);
  background: var(--tx-base);
}
.tx-rb-size {
  font: 500 11px / 1 var(--tx-font-mono);
  color: var(--tx-muted);
  min-width: 28px;
  text-align: center;
}
.tx-rb-step-stack { display: flex; flex-direction: column; gap: 0; }
.tx-rb-step {
  appearance: none;
  width: 14px;
  height: 10px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--tx-muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.tx-rb-step:hover { color: var(--tx-fg); }
.tx-rb-ab {
  font: 700 11px / 1 var(--tx-font-sans) !important;
  letter-spacing: 0.04em;
}
.tx-rb-bpreview {
  width: 22px;
  height: 22px;
  border-radius: var(--tx-radius);
  background: var(--tx-base);
  border: 1px solid var(--tx-hairline);
  flex-shrink: 0;
}
.tx-rb-danger {
  color: var(--tx-down) !important;
  border-color: color-mix(in srgb, var(--tx-down) 40%, var(--tx-hairline)) !important;
}
.tx-rb-danger-btn { color: var(--tx-down); }
.tx-rb-danger-btn:hover {
  background: color-mix(in srgb, var(--tx-down) 16%, transparent);
  color: var(--tx-down);
}
.tx-rb-toggle.is-on,
.tx-rb-btn.is-on {
  background: color-mix(in srgb, var(--tx-accent) 18%, transparent);
  color: var(--tx-accent);
}

/* layouts chip (title bar) */
.tx-layouts {
  appearance: none;
  height: var(--tx-control-h);
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--tx-hairline);
  border-radius: var(--tx-radius);
  background: var(--tx-base);
  color: var(--tx-muted);
  font: 500 var(--tx-fs-sm) var(--tx-font-sans);
  cursor: pointer;
  max-width: 180px;
}
.tx-layouts:hover { border-color: var(--tx-structural); color: var(--tx-fg); }
.tx-layouts-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}

/* ── icon picker (ribbon Icons) ────────────────────────────────────── */
.tx-ip-open {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 7px 0 3px;
  border: 1px solid var(--tx-hairline);
  border-radius: var(--tx-radius);
  background: transparent;
  color: var(--tx-fg);
  font: 600 var(--tx-fs-xs) var(--tx-font-sans);
  cursor: pointer;
}
.tx-ip-open:hover:not(:disabled) { border-color: var(--tx-accent); }
.tx-ip-open:focus-visible { outline: 1px solid var(--tx-accent); outline-offset: 1px; }
.tx-ip-open > svg:last-child { color: var(--tx-faint); flex: 0 0 auto; }
.tx-ip-well {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--tx-radius);
  font-size: 12px;
  line-height: 1;
  color: var(--tx-muted);
  background: color-mix(in srgb, var(--tx-fg) 8%, transparent);
}
.tx-ip-well.has-icon {
  color: var(--tx-accent);
  background: color-mix(in srgb, var(--tx-accent) 14%, transparent);
}
.tx-ip-open.is-open {
  border-color: var(--tx-accent);
  background: color-mix(in srgb, var(--tx-accent) 12%, transparent);
}
.tx-ip-open:disabled { opacity: 0.38; cursor: default; }
.tx-ip-panel {
  position: fixed;
  z-index: 10000;
  width: 340px;
  max-height: 428px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--tx-overlay);
  border: 1px solid var(--tx-hairline);
  border-radius: var(--tx-radius);
  box-shadow: 0 16px 40px rgba(0,0,0,0.5);
  padding: 10px;
  color: var(--tx-fg);
  font: var(--tx-fs-sm) / 1.35 var(--tx-font-sans);
}
.tx-ip-panel[hidden] { display: none !important; }
.tx-ip-searchwrap {
  position: relative;
  display: flex;
  align-items: center;
  margin-bottom: 8px;
  color: var(--tx-muted);
}
.tx-ip-searchwrap > svg { position: absolute; left: 9px; pointer-events: none; }
.tx-ip-search {
  width: 100%;
  box-sizing: border-box;
  height: 30px;
  padding: 0 10px 0 30px;
  border: 1px solid var(--tx-hairline);
  border-radius: var(--tx-radius);
  background: var(--tx-base);
  color: var(--tx-fg);
  font: inherit;
  font-size: 12.5px;
}
.tx-ip-search:focus {
  outline: none;
  border-color: var(--tx-accent);
}
.tx-ip-scroll {
  overflow-y: auto;
  flex: 1 1 auto;
  scrollbar-width: thin;
}
.tx-ip-cat {
  font: 600 9px / 1 var(--tx-font-mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--tx-faint);
  margin: 10px 0 4px;
  padding: 0 2px;
}
.tx-ip-section:first-child .tx-ip-cat { margin-top: 0; }
.tx-ip-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 2px;
}
.tx-ip-tile {
  appearance: none;
  width: 100%;
  aspect-ratio: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--tx-radius);
  background: transparent;
  color: var(--tx-muted);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0;
}
.tx-ip-tile:hover {
  background: color-mix(in srgb, var(--tx-fg) 8%, transparent);
  color: var(--tx-fg);
}
.tx-ip-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 34px 0 30px;
  color: var(--tx-faint);
}
.tx-ip-empty[hidden] { display: none; }
.tx-ip-empty-msg { font-size: 12px; }

/* ── drawer ────────────────────────────────────────────────────────── */
.tx-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 300px;
  background: var(--tx-overlay);
  border-left: 1px solid var(--tx-hairline);
  transform: translateX(100%);
  z-index: 30;
  display: flex;
  flex-direction: column;
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.25);
}
.tx-drawer.is-open { transform: translateX(0); }
.tx-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--tx-hairline);
}
.tx-drawer-title {
  font: 650 13px / 1 var(--tx-font-sans);
  letter-spacing: -0.01em;
}
.tx-drawer-body {
  flex: 1;
  overflow: auto;
  padding: 12px 14px;
}
.tx-drawer-section { margin-bottom: 18px; }
.tx-drawer-section-title {
  font: 600 9px / 1 var(--tx-font-mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--tx-faint);
  margin-bottom: 8px;
}
.tx-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}
.tx-field label {
  font: 500 var(--tx-fs-xs) var(--tx-font-sans);
  color: var(--tx-muted);
}
.tx-field select,
.tx-field input[type="text"],
.tx-field input[type="number"] {
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--tx-hairline);
  border-radius: var(--tx-radius);
  background: var(--tx-base);
  color: var(--tx-fg);
  font: var(--tx-fs-sm) var(--tx-font-sans);
}
.tx-field select:focus,
.tx-field input:focus {
  outline: none;
  border-color: var(--tx-accent);
}
.tx-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font: var(--tx-fs-sm) var(--tx-font-sans);
  color: var(--tx-fg);
  cursor: pointer;
  margin-bottom: 8px;
}
.tx-check input { accent-color: var(--tx-accent); }

/* ── modal pickers ─────────────────────────────────────────────────── */
.tx-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 10001;
  display: flex;
  align-items: center;
  justify-content: center;
}
.tx-modal {
  width: min(440px, calc(100vw - 32px));
  max-height: min(80vh, 560px);
  overflow: auto;
  background: var(--tx-overlay);
  border: 1px solid var(--tx-hairline);
  border-radius: var(--tx-radius);
  padding: 16px;
  color: var(--tx-fg);
  font: var(--tx-fs) / 1.35 var(--tx-font-sans);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
}
.tx-modal-title {
  font: 650 14px / 1.2 var(--tx-font-sans);
  letter-spacing: -0.02em;
  margin-bottom: 12px;
}
.tx-modal-preview {
  padding: 12px;
  margin-bottom: 12px;
  background: var(--tx-base);
  border: 1px solid var(--tx-hairline);
  border-radius: var(--tx-radius);
  font: var(--tx-fs-sm) / 1.4 var(--tx-font-mono);
  color: var(--tx-fg);
}
.tx-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
.tx-btn {
  appearance: none;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--tx-hairline);
  border-radius: var(--tx-radius);
  background: var(--tx-base);
  color: var(--tx-fg);
  font: 500 var(--tx-fs-sm) var(--tx-font-sans);
  cursor: pointer;
}
.tx-btn:hover { border-color: var(--tx-structural); }
.tx-btn-primary {
  background: var(--tx-accent);
  border-color: var(--tx-accent);
  color: #0a0a0a;
}
.tx-btn-primary:hover { filter: brightness(1.08); }

@media (prefers-reduced-motion: reduce) {
  .tx-search-input,
  .tx-iconbtn,
  .tx-rb-btn,
  .tx-save { transition: none !important; }
}
`;
