/**
 * Format picker — dropdown menu (not modal). Plain DOM; state re-derived from
 * host closures on every open/re-render. Selection applies + closes; Clear and
 * Custom quick-inserts keep the panel open.
 */
import { resolveFormat } from '@tabular/format';
import type { ResolvedTheme } from '@tabular/core';
import { ICON, menu, svg } from './ui';
import { injectExtStyles } from './styles';
import {
  CATEGORY_LABELS,
  CURRENCY_QUICK_INSERT,
  EXCEL_EXAMPLES,
  applyCurrencySymbol,
  categoriesForDataType,
  codeText,
  defaultSampleValue,
  filterPresets,
  findPresetByFormat,
  presetsForCategory,
  presetsForDataType,
  type FormatDataType,
  type FormatPreset,
} from './formatPresets';

export interface FormatPickerHost {
  targetCols(): string[];
  currentFormat(): string | undefined;
  applyFormat(format: string): void;
  clearFormat(): void;
  dataType(): FormatDataType;
}

const CUSTOM_TAB = '__custom__';
const STYLE_ID = 'tx-fmt-styles';

/** Resolve + run `format` against `sample`; `·` when empty / failure. */
export function previewFormat(format: string, sample: unknown): string {
  try {
    const compiled = resolveFormat(format);
    const text = compiled.format(sample);
    return text === '' ? '·' : text;
  } catch {
    return '·';
  }
}

export function formatPickerMenu(
  anchor: HTMLElement,
  host: FormatPickerHost,
  theme: ResolvedTheme,
): { toggle(): void; destroy(): void } {
  injectExtStyles();
  injectFormatPickerStyles();
  const m = menu(anchor, theme, (close) => buildPanel(host, close), { className: 'tx-fmt' });
  return { toggle: m.toggle, destroy: m.destroy };
}

function buildPanel(host: FormatPickerHost, close: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tx-fmt-panel';
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  if (host.targetCols().length === 0) {
    el.innerHTML = `<div class="tx-fmt-empty">Select a cell or column first.</div>`;
    return el;
  }

  const dataType = host.dataType();
  const sample = defaultSampleValue(dataType);
  const categories = categoriesForDataType(dataType);
  let query = '';
  const current = () => host.currentFormat()?.trim();
  const activePreset = () => findPresetByFormat(current());
  let tab: string =
    activePreset()?.category ?? (current() !== undefined ? CUSTOM_TAB : categories[0] ?? CUSTOM_TAB);

  el.innerHTML =
    `<div class="tx-fmt-current">` +
    `<span class="tx-fmt-caps">CURRENT</span>` +
    `<span class="tx-fmt-current-chip"></span>` +
    `<button type="button" class="tx-fmt-clear" title="Clear format">${svg(ICON.close, 14)}</button>` +
    `</div>` +
    `<div class="tx-fmt-search">${svg(ICON.search, 14)}<input type="search" placeholder="Search formats…" aria-label="Search formats" /></div>` +
    `<div class="tx-fmt-main"></div>`;

  const chipEl = el.querySelector<HTMLElement>('.tx-fmt-current-chip')!;
  const clearBtn = el.querySelector<HTMLButtonElement>('.tx-fmt-clear')!;
  const mainEl = el.querySelector<HTMLElement>('.tx-fmt-main')!;
  const searchInput = el.querySelector<HTMLInputElement>('.tx-fmt-search input')!;

  const renderCurrent = () => {
    const cur = current();
    chipEl.textContent =
      cur === undefined ? '—' : previewFormat(cur, activePreset()?.sample ?? sample);
    chipEl.title = cur === undefined ? 'No format applied' : cur;
    chipEl.classList.toggle('has-format', cur !== undefined);
    clearBtn.disabled = cur === undefined;
  };

  const presetRow = (p: FormatPreset): HTMLElement => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'tx-fmt-row' + (p.format === current() ? ' is-active' : '');
    row.dataset.presetId = p.id;
    const preview = previewFormat(p.format, p.sample ?? sample);
    row.innerHTML =
      `<span class="tx-fmt-row-main"><span class="tx-fmt-row-label"></span><span class="tx-fmt-row-code"></span></span>` +
      `<span class="tx-fmt-row-preview"></span>`;
    row.querySelector('.tx-fmt-row-label')!.textContent = p.label;
    row.querySelector('.tx-fmt-row-code')!.textContent = codeText(p.format);
    row.querySelector('.tx-fmt-row-preview')!.textContent = preview;
    row.title = `${p.label} · ${preview}`;
    row.addEventListener('click', () => {
      host.applyFormat(p.format);
      close();
    });
    return row;
  };

  const renderMain = () => {
    mainEl.replaceChildren();
    if (query.trim()) {
      const results = filterPresets(presetsForDataType(dataType), query);
      const list = document.createElement('div');
      list.className = 'tx-fmt-list';
      if (results.length === 0) {
        list.innerHTML = `<div class="tx-fmt-empty"></div>`;
        list.querySelector('.tx-fmt-empty')!.textContent =
          `No formats match "${query.trim()}". Try the Custom tab.`;
      } else {
        list.append(...results.map(presetRow));
      }
      mainEl.appendChild(list);
      return;
    }

    const tabs = document.createElement('div');
    tabs.className = 'tx-fmt-tabs';
    const tabBtn = (cat: string, label: string, count: number | null) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tx-fmt-tab' + (tab === cat ? ' is-active' : '');
      b.dataset.cat = cat;
      b.innerHTML =
        `<span></span>` +
        (count === null ? svg(ICON.hash, 13) : `<span class="tx-fmt-count">${count}</span>`);
      b.querySelector('span')!.textContent = label;
      b.addEventListener('click', () => {
        tab = cat;
        renderMain();
      });
      tabs.appendChild(b);
    };
    for (const c of categories) tabBtn(c, CATEGORY_LABELS[c], presetsForCategory(c).length);
    tabBtn(CUSTOM_TAB, 'Custom', null);

    const body = document.createElement('div');
    body.className = 'tx-fmt-body';
    if (tab === CUSTOM_TAB) {
      body.appendChild(
        buildCustomTab(host, dataType, { current, renderCurrent, renderMain, close }),
      );
    } else {
      const list = document.createElement('div');
      list.className = 'tx-fmt-list';
      list.append(...presetsForCategory(tab as FormatPreset['category']).map(presetRow));
      body.appendChild(list);
    }
    mainEl.append(tabs, body);
  };

  clearBtn.addEventListener('click', () => {
    host.clearFormat();
    renderCurrent();
    // Keep Custom draft intact when clearing.
    if (tab !== CUSTOM_TAB) renderMain();
  });
  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    renderMain();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      close();
      return;
    }
    e.stopPropagation();
  });

  renderCurrent();
  renderMain();
  return el;
}

function buildCustomTab(
  host: FormatPickerHost,
  dataType: FormatDataType,
  ctx: {
    current(): string | undefined;
    renderCurrent(): void;
    renderMain(): void;
    close(): void;
  },
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'tx-fmt-custom';
  wrap.innerHTML =
    `<div class="tx-fmt-caps">CUSTOM EXCEL FORMAT</div>` +
    `<div class="tx-fmt-symbols"><span class="tx-fmt-caps">SYMBOL</span></div>` +
    `<div class="tx-fmt-custom-input">` +
    `${svg(ICON.hash, 14)}<input type="text" spellcheck="false" aria-label="Custom format" />` +
    `<button type="button" class="tx-fmt-custom-apply" title="Apply format">${svg(ICON.check, 14)}</button>` +
    `<button type="button" class="tx-fmt-custom-clear" title="Clear format">${svg(ICON.close, 14)}</button>` +
    `</div>` +
    `<div class="tx-fmt-ref"></div>`;

  const input = wrap.querySelector<HTMLInputElement>('.tx-fmt-custom-input input')!;
  const applyBtn = wrap.querySelector<HTMLButtonElement>('.tx-fmt-custom-apply')!;
  const clearBtn = wrap.querySelector<HTMLButtonElement>('.tx-fmt-custom-clear')!;
  input.placeholder = dataType === 'date' ? 'yyyy-mm-dd' : '#,##0.00';

  const cur = ctx.current();
  if (cur !== undefined && !findPresetByFormat(cur)) input.value = cur;

  const validate = (): boolean => {
    const draft = input.value.trim();
    if (!draft) {
      input.classList.remove('is-error');
      input.title = '';
      applyBtn.disabled = true;
      return false;
    }
    // @tabular/format never throws on bad codes — treat non-empty as applyable.
    try {
      resolveFormat(draft);
      input.classList.remove('is-error');
      input.title = '';
      applyBtn.disabled = false;
      return true;
    } catch (err) {
      input.classList.add('is-error');
      input.title = err instanceof Error ? err.message : 'Invalid format';
      applyBtn.disabled = true;
      return false;
    }
  };
  validate();
  input.addEventListener('input', validate);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && validate()) {
      host.applyFormat(input.value.trim());
      ctx.close();
    }
    if (e.key === 'Escape') ctx.close();
  });
  applyBtn.addEventListener('click', () => {
    if (validate()) {
      host.applyFormat(input.value.trim());
      ctx.close();
    }
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    validate();
    host.clearFormat();
    ctx.renderCurrent();
  });

  const symbols = wrap.querySelector<HTMLElement>('.tx-fmt-symbols')!;
  for (const c of CURRENCY_QUICK_INSERT) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tx-fmt-symbol';
    b.dataset.symbol = c.symbol;
    b.textContent = c.label;
    b.setAttribute('aria-label', `Insert ${c.label} currency symbol`);
    b.addEventListener('click', () => {
      const next = applyCurrencySymbol(input.value, c.symbol);
      input.value = next;
      if (validate()) {
        host.applyFormat(next);
        ctx.renderCurrent();
      }
    });
    symbols.appendChild(b);
  }

  const ref = wrap.querySelector<HTMLElement>('.tx-fmt-ref')!;
  for (const section of EXCEL_EXAMPLES) {
    const title = document.createElement('div');
    title.className = 'tx-fmt-ref-title tx-fmt-caps';
    title.textContent = section.title;
    ref.appendChild(title);
    for (const row of section.rows) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tx-fmt-ref-row';
      b.dataset.format = row.format;
      b.innerHTML =
        `<span class="tx-fmt-ref-label"></span>` +
        `<span class="tx-fmt-ref-code"></span>` +
        `<span class="tx-fmt-ref-sample"></span>`;
      b.querySelector('.tx-fmt-ref-label')!.textContent = row.label;
      b.querySelector('.tx-fmt-ref-code')!.textContent = row.format;
      b.querySelector('.tx-fmt-ref-sample')!.textContent = row.sample;
      b.addEventListener('click', () => {
        try {
          void navigator.clipboard?.writeText(row.format);
        } catch {
          /* best-effort */
        }
        host.applyFormat(row.format);
        ctx.close();
      });
      ref.appendChild(b);
    }
  }
  return wrap;
}

export function injectFormatPickerStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = FMT_CSS;
  document.head.appendChild(style);
}

const FMT_CSS = `
.tx-menu.tx-fmt {
  width: 440px;
  max-width: min(440px, calc(100vw - 16px));
  max-height: min(70vh, 520px);
  padding: 0;
  overflow: hidden;
}
.tx-fmt-panel {
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 0;
  max-height: min(70vh, 520px);
  overflow: hidden;
}
.tx-fmt-caps {
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--tx-faint);
  font-family: var(--tx-font-mono);
}
.tx-fmt-current {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
}
.tx-fmt-current-chip {
  flex: 1 1 auto;
  min-width: 0;
  height: 26px;
  display: inline-flex;
  align-items: center;
  padding: 0 8px;
  border: 1px dashed var(--tx-hairline);
  border-radius: 2px;
  font-family: var(--tx-font-mono);
  font-size: var(--tx-fs-sm);
  color: var(--tx-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tx-fmt-current-chip.has-format {
  color: var(--tx-fg);
  border-color: var(--tx-accent);
  border-style: solid;
}
.tx-fmt-clear {
  appearance: none;
  width: 26px;
  height: 26px;
  border: 1px solid var(--tx-hairline);
  border-radius: 2px;
  background: transparent;
  color: var(--tx-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex: 0 0 auto;
}
.tx-fmt-clear:hover:not(:disabled) {
  color: var(--tx-down);
  border-color: var(--tx-down);
}
.tx-fmt-clear:disabled { opacity: 0.4; cursor: default; }
.tx-fmt-search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--tx-hairline);
  border-radius: 2px;
  margin-bottom: 8px;
  color: var(--tx-muted);
  background: var(--tx-sunken);
}
.tx-fmt-search:focus-within { border-color: var(--tx-accent); }
.tx-fmt-search input {
  flex: 1 1 auto;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  color: var(--tx-fg);
  font: inherit;
  font-size: var(--tx-fs-sm);
}
.tx-fmt-main {
  display: flex;
  gap: 10px;
  flex: 1 1 auto;
  min-height: 200px;
  overflow: hidden;
}
.tx-fmt-tabs {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 128px;
  flex: 0 0 auto;
  overflow-y: auto;
}
.tx-fmt-tab {
  appearance: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 6px 8px;
  border: none;
  border-radius: 2px;
  background: transparent;
  color: var(--tx-muted);
  font: inherit;
  font-size: var(--tx-fs-sm);
  text-align: left;
  cursor: pointer;
}
.tx-fmt-tab:hover { background: color-mix(in srgb, var(--tx-fg) 6%, transparent); }
.tx-fmt-tab.is-active {
  color: var(--tx-accent);
  background: color-mix(in srgb, var(--tx-accent) 12%, transparent);
  box-shadow: inset 2px 0 0 var(--tx-accent);
}
.tx-fmt-count {
  font-family: var(--tx-font-mono);
  font-size: 10px;
  opacity: 0.75;
}
.tx-fmt-body {
  flex: 1 1 auto;
  min-width: 0;
  max-height: 320px;
  overflow-y: auto;
}
.tx-fmt-list { display: flex; flex-direction: column; gap: 1px; }
.tx-fmt-row {
  appearance: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 2px;
  background: transparent;
  color: var(--tx-fg);
  font: inherit;
  text-align: left;
  cursor: pointer;
  width: 100%;
}
.tx-fmt-row:hover { background: color-mix(in srgb, var(--tx-fg) 6%, transparent); }
.tx-fmt-row.is-active {
  background: color-mix(in srgb, var(--tx-accent) 12%, transparent);
  border-color: var(--tx-accent);
}
.tx-fmt-row-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.tx-fmt-row-label { font-weight: 600; font-size: var(--tx-fs-sm); }
.tx-fmt-row-code {
  font-family: var(--tx-font-mono);
  font-size: 11px;
  color: var(--tx-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}
.tx-fmt-row-preview {
  font-family: var(--tx-font-mono);
  font-size: var(--tx-fs-sm);
  color: var(--tx-fg);
  white-space: nowrap;
  flex: 0 0 auto;
}
.tx-fmt-empty {
  padding: 16px 8px;
  font-size: var(--tx-fs-sm);
  color: var(--tx-muted);
}
.tx-fmt-custom { display: flex; flex-direction: column; gap: 8px; }
.tx-fmt-symbols { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.tx-fmt-symbol {
  appearance: none;
  min-width: 30px;
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--tx-hairline);
  border-radius: 2px;
  background: transparent;
  color: var(--tx-fg);
  font: inherit;
  font-size: var(--tx-fs-sm);
  cursor: pointer;
}
.tx-fmt-symbol:hover { border-color: var(--tx-accent); color: var(--tx-accent); }
.tx-fmt-custom-input {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 8px;
  border: 1px solid var(--tx-hairline);
  border-radius: 2px;
  color: var(--tx-muted);
  background: var(--tx-sunken);
}
.tx-fmt-custom-input:focus-within { border-color: var(--tx-accent); }
.tx-fmt-custom-input input {
  flex: 1 1 auto;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  color: var(--tx-fg);
  font-family: var(--tx-font-mono);
  font-size: var(--tx-fs-sm);
}
.tx-fmt-custom-input input.is-error { color: var(--tx-down); }
.tx-fmt-custom-apply,
.tx-fmt-custom-clear {
  appearance: none;
  width: 26px;
  height: 26px;
  border: 1px solid var(--tx-hairline);
  border-radius: 2px;
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex: 0 0 auto;
}
.tx-fmt-custom-apply { color: var(--tx-accent); }
.tx-fmt-custom-apply:disabled { opacity: 0.4; cursor: default; }
.tx-fmt-custom-clear { color: var(--tx-down); }
.tx-fmt-ref {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border-top: 1px solid var(--tx-hairline);
  padding-top: 8px;
}
.tx-fmt-ref-title { padding: 6px 2px 2px; }
.tx-fmt-ref-row {
  appearance: none;
  display: grid;
  grid-template-columns: 110px 1fr auto;
  gap: 6px;
  align-items: center;
  padding: 4px 6px;
  border: 1px solid transparent;
  border-radius: 2px;
  background: transparent;
  color: var(--tx-fg);
  font: inherit;
  font-size: var(--tx-fs-sm);
  text-align: left;
  cursor: pointer;
  width: 100%;
}
.tx-fmt-ref-row:hover { background: color-mix(in srgb, var(--tx-fg) 6%, transparent); }
.tx-fmt-ref-code,
.tx-fmt-ref-sample {
  font-family: var(--tx-font-mono);
  font-size: 11px;
}
.tx-fmt-ref-code {
  color: var(--tx-accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tx-fmt-ref-sample {
  color: var(--tx-muted);
  white-space: nowrap;
}
`;
