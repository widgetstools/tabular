/**
 * Ribbon-style icon picker — trigger well + anchored dropdown over
 * `listIconNames()` / `iconSvg` from @tabular/core, plus a small emoji set.
 */
import { iconSvg, listIconNames, type ResolvedTheme } from '@tabular/core';
import { applyThemeVars } from './styles';
import { themePopup } from './ui';

export interface IconSelection {
  name?: string;
  emoji?: string;
}

export interface IconPickerHandle {
  button: HTMLButtonElement;
  setPreview(sel: IconSelection | null): void;
  destroy(): void;
  onSelect: (sel: IconSelection) => void;
}

const EMOJIS = [
  '▲', '▼', '●', '◆', '★', '✓', '✗', '↑', '↓', '→', '←', '⚠', '💰', '📈', '📉',
  '🔥', '💡', '📌', '⚡', '🔔', '✅', '❌', '⭐', '🎯', '📊',
];

const PLACEHOLDER_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="2.6 2.8" aria-hidden="true">' +
  '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M12 8.5v7M8.5 12h7" stroke-dasharray="0"/></svg>';

const SEARCH_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';

const CARET_SVG =
  '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

const STYLE_ID = 'tabular-ext-icon-picker';

function injectIconPickerStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = ICON_PICKER_CSS;
  document.head.appendChild(style);
}

const ICON_PICKER_CSS = `
.tx-ip-open {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 7px 0 3px;
  border: 1px solid var(--tx-hairline);
  border-radius: 2px;
  background: transparent;
  color: var(--tx-fg);
  font: 600 var(--tx-fs-xs) var(--tx-font-sans);
  cursor: pointer;
  transition: border-color 110ms ease, background 110ms ease;
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
  border-radius: 2px;
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
.tx-ip-open:disabled:hover { background: transparent; color: var(--tx-muted); }

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
  border-radius: 2px;
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
  border-radius: 2px;
  background: var(--tx-base);
  color: var(--tx-fg);
  font: inherit;
  font-size: 12.5px;
}
.tx-ip-search::placeholder { color: var(--tx-faint); }
.tx-ip-search:focus {
  outline: none;
  border-color: var(--tx-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tx-accent) 20%, transparent);
}
.tx-ip-search::-webkit-search-cancel-button { appearance: none; }

.tx-ip-scroll {
  overflow-y: auto;
  flex: 1 1 auto;
  margin: 0 -4px;
  padding: 0 4px;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--tx-faint) 55%, transparent) transparent;
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
  border-radius: 2px;
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
  transform: scale(1.1);
}
.tx-ip-tile:focus-visible { outline: 1px solid var(--tx-accent); outline-offset: -1px; }
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
`;

export function createIconPicker(opts: {
  onSelect: (sel: IconSelection) => void;
  getTheme: () => ResolvedTheme;
}): IconPickerHandle {
  injectIconPickerStyles();

  let onSelect = opts.onSelect;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tx-ip-open';
  button.title = 'Pick icon or emoji';
  button.setAttribute('aria-label', 'Pick icon or emoji');
  button.innerHTML =
    `<span class="tx-ip-well">${PLACEHOLDER_SVG}</span>` +
    `<span class="tx-ip-openlabel">Add icon</span>` +
    CARET_SVG;
  const previewWell = button.querySelector<HTMLElement>('.tx-ip-well')!;
  const previewLabel = button.querySelector<HTMLElement>('.tx-ip-openlabel')!;

  const panel = document.createElement('div');
  panel.className = 'tx-ip-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Icons and emojis');
  panel.hidden = true;

  let built = false;
  const build = (): void => {
    built = true;

    const searchWrap = document.createElement('div');
    searchWrap.className = 'tx-ip-searchwrap';
    searchWrap.innerHTML = SEARCH_SVG;
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Search icons & emojis…';
    search.className = 'tx-ip-search';
    search.setAttribute('aria-label', 'Search icons and emojis');
    searchWrap.append(search);

    const scroller = document.createElement('div');
    scroller.className = 'tx-ip-scroll';

    const empty = document.createElement('div');
    empty.className = 'tx-ip-empty';
    empty.innerHTML = SEARCH_SVG;
    const emptyMsg = document.createElement('div');
    emptyMsg.className = 'tx-ip-empty-msg';
    emptyMsg.textContent = 'No icons match';
    empty.append(emptyMsg);
    empty.hidden = true;

    interface Section {
      root: HTMLElement;
      grid: HTMLElement;
      tiles: Array<{ el: HTMLButtonElement; key: string }>;
    }
    const sections: Section[] = [];

    const addSection = (
      title: string,
      entries: ReadonlyArray<{
        key: string;
        label: string;
        sel: IconSelection;
        html?: string;
        text?: string;
        glyph?: string;
      }>,
    ): void => {
      const root = document.createElement('div');
      root.className = 'tx-ip-section';
      const label = document.createElement('div');
      label.className = 'tx-ip-cat';
      label.textContent = title;
      const grid = document.createElement('div');
      grid.className = 'tx-ip-grid';
      const tiles: Section['tiles'] = [];
      for (const e of entries) {
        const t = document.createElement('button');
        t.type = 'button';
        t.className = 'tx-ip-tile';
        t.title = e.label;
        t.setAttribute('aria-label', e.label);
        if (e.sel.name) t.dataset.icon = e.sel.name;
        if (e.glyph) t.dataset.emoji = e.glyph;
        if (e.html) t.innerHTML = e.html;
        else t.textContent = e.text!;
        t.addEventListener('click', () => {
          onSelect(e.sel);
          close();
        });
        grid.append(t);
        tiles.push({ el: t, key: e.key.toLowerCase() });
      }
      root.append(label, grid);
      scroller.append(root);
      sections.push({ root, grid, tiles });
    };

    addSection(
      'Icons',
      listIconNames().map((name) => ({
        key: name,
        label: name,
        sel: { name },
        html: iconSvg(name, 16),
      })),
    );
    addSection(
      'Emoji',
      EMOJIS.map((emoji) => ({
        key: emoji,
        label: emoji,
        sel: { emoji },
        text: emoji,
        glyph: emoji,
      })),
    );

    let lastQuery: string | null = null;
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      if (q === lastQuery) return;
      lastQuery = q;
      let any = false;
      for (const s of sections) {
        const frag = document.createDocumentFragment();
        let visible = 0;
        for (const t of s.tiles) {
          const hit =
            q === '' || t.key.includes(q) || (t.el.dataset.emoji?.includes(q) ?? false);
          if (hit) {
            frag.append(t.el);
            visible++;
          }
        }
        s.grid.replaceChildren(frag);
        s.root.hidden = visible === 0;
        if (visible > 0) any = true;
      }
      emptyMsg.textContent =
        q === '' ? 'No icons match' : `Nothing matches “${search.value.trim()}”`;
      empty.hidden = any;
    });

    panel.append(searchWrap, scroller, empty);
  };

  const onDocClick = (e: MouseEvent): void => {
    if (panel.hidden) return;
    const t = e.target as Node;
    if (!panel.contains(t) && !button.contains(t)) close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };

  const open = (): void => {
    if (!built) build();
    const theme = opts.getTheme();
    applyThemeVars(panel, theme);
    themePopup(button, panel, theme);
    if (!panel.isConnected) document.body.appendChild(panel);
    const r = button.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 348))}px`;
    panel.style.top = `${r.bottom + 6}px`;
    panel.hidden = false;
    button.classList.add('is-open');
    panel.querySelector<HTMLInputElement>('.tx-ip-search')?.focus();
  };
  const close = (): void => {
    panel.hidden = true;
    button.classList.remove('is-open');
  };
  button.addEventListener('click', () => (panel.hidden ? open() : close()));
  document.addEventListener('mousedown', onDocClick);
  document.addEventListener('keydown', onKey);

  const setPreview = (sel: IconSelection | null): void => {
    if (sel?.emoji) {
      previewWell.textContent = sel.emoji;
      previewWell.classList.add('has-icon');
      previewLabel.textContent = 'Icon';
      return;
    }
    if (sel?.name) {
      const svg = iconSvg(sel.name, 15);
      if (svg) {
        previewWell.innerHTML = svg;
        previewWell.classList.add('has-icon');
        previewLabel.textContent = 'Icon';
        return;
      }
    }
    previewWell.innerHTML = PLACEHOLDER_SVG;
    previewWell.classList.remove('has-icon');
    previewLabel.textContent = 'Add icon';
  };

  const handle: IconPickerHandle = {
    button,
    setPreview,
    destroy() {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
      panel.remove();
    },
    get onSelect() {
      return onSelect;
    },
    set onSelect(fn) {
      onSelect = fn;
    },
  };
  return handle;
}
