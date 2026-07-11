/**
 * Formatting / editing ribbon — matches cgrid-ext-demo structure:
 *   edit strip (History · Smart · Bulk)
 *   Target · Font · Alignment · Borders · Number · Icons · Column · Templates
 */
import type { ExtContext } from './context';
import { injectExtStyles } from './styles';
import { ICON, menu, svg } from './ui';
import { formatPickerMenu } from './formatPickerMenu';
import { columnPanelMenu } from './columnPanel';
import { mountEditStrip } from './editStrip';
import { createIconPicker, type IconSelection } from './iconPicker';
import { openColorPicker } from './colorPicker';
import {
  adjustDecimals,
  applyColumnAlign,
  applyColumnFormat,
  applyColumnHeaderStyle,
  applyColumnIcon,
  applyColumnStyle,
  clearColumnFormatting,
  currencyFormat,
  decimalsOf,
  mergeBorder,
  numberFormat,
  percentFormat,
  readColumnChrome,
  resolveTargetColIds,
  mapLeafCols,
  leafColId,
  walkLeafCols,
  type Align,
  type BorderSide,
} from './columnFormat';
import type { AnyColDef, CellIconPlace, CellIconSpec, CellStyle, ColDef } from '@tabular/core';
import type { FormatDataType } from './formatPresets';

function h(cls: string, html?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  if (html) d.innerHTML = html;
  return d;
}
function mini(...children: HTMLElement[]): HTMLDivElement {
  const r = h('tx-rb-mini');
  r.append(...children);
  return r;
}
function grp(name: string, ...rows: HTMLElement[]): HTMLDivElement {
  const g = h('tx-rb-grp');
  const deck = h('tx-rb-deck');
  deck.append(...rows);
  g.append(deck, h('tx-rb-grp-name', name));
  return g;
}
function iconBtn(icon: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tx-rb-btn';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = svg(icon, 14);
  return b;
}
function toggleBtn(icon: string, title: string): HTMLButtonElement {
  const b = iconBtn(icon, title);
  b.classList.add('tx-rb-toggle');
  return b;
}
function dangerIcon(icon: string, title: string): HTMLButtonElement {
  const b = iconBtn(icon, title);
  b.classList.add('tx-rb-danger-btn');
  return b;
}
function pill(text: string, caret = true): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tx-rb-pill';
  b.innerHTML = `<span>${text}</span>` + (caret ? svg(ICON.chevronDown, 11) : '');
  return b;
}
function colorSwatch(icon: string, title: string, defaultColor: string) {
  let value = defaultColor;
  const changeListeners = new Set<() => void>();
  const button = iconBtn(icon, title);
  button.classList.add('tx-rb-swatch');
  const bar = document.createElement('span');
  bar.className = 'tx-rb-swatchbar';
  bar.style.background = value;
  button.append(bar);

  const input = {
    get value() {
      return value;
    },
    set value(v: string) {
      value = v;
      bar.style.background = v;
    },
    addEventListener(type: string, fn: () => void) {
      if (type === 'change' || type === 'input') changeListeners.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      if (type === 'change' || type === 'input') changeListeners.delete(fn);
    },
  };

  const setBar = (css: string) => {
    if (!css) return;
    value = css;
    bar.style.background = css;
  };

  const fire = () => {
    for (const fn of changeListeners) fn();
  };

  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openColorPicker({
      color: value,
      clientX: e.clientX,
      clientY: e.clientY,
      anchor: button,
      onInput: (css) => {
        value = css;
        bar.style.background = css;
        fire();
      },
      onChange: (css) => {
        value = css;
        bar.style.background = css;
        fire();
      },
    });
  });

  return { button, input, setBar };
}
function decimalIcon(kind: 'fewer' | 'more'): string {
  const digit = (x: number, y: number, s: string) =>
    `<text x="${x}" y="${y}" fill="currentColor" font-size="10" font-weight="700">${s}</text>`;
  const arrow = (d: string) =>
    `<path d="${d}" fill="none" stroke="var(--tx-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  const rows =
    kind === 'fewer'
      ? arrow('M9.5 4H1.5M4.5 1l-3 3 3 3') + digit(11.5, 7.5, '0') + digit(0.5, 17.5, '.00')
      : digit(0.5, 7.5, '.00') + arrow('M1.5 14h8M6.5 11l3 3-3 3') + digit(11.5, 17.5, '0');
  return `<svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">${rows}</svg>`;
}
function decimalBtn(kind: 'fewer' | 'more', title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tx-rb-btn';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = decimalIcon(kind);
  return b;
}

const BORDER_EDGE: Record<BorderSide, string> = {
  all: 'M5 5h14v14H5z',
  top: 'M5 5h14',
  bottom: 'M5 19h14',
  left: 'M5 5v14',
  right: 'M19 5v14',
};
function borderSideBtn(side: BorderSide): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tx-rb-btn tx-rb-toggle';
  b.dataset.side = side;
  b.title = side === 'all' ? 'All borders' : `${side[0]!.toUpperCase()}${side.slice(1)} border`;
  b.innerHTML =
    `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true">` +
    `<path d="M5 5h14v14H5z" stroke-width="1" opacity="0.35"/>` +
    `<path d="${BORDER_EDGE[side]}" stroke-width="2.6"/></svg>`;
  return b;
}

function stateToggle(opts: {
  a: { icon: string; label: string };
  b: { icon: string; label: string };
  title: (isA: boolean) => string;
}): { el: HTMLButtonElement; paint: (isA: boolean) => void } {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'tx-rb-targettoggle';
  const paint = (isA: boolean) => {
    const s = isA ? opts.a : opts.b;
    el.innerHTML = `${svg(s.icon, 13)}<span>${s.label}</span>${svg(ICON.swap, 10)}`;
    const title = opts.title(isA);
    el.title = title;
    el.setAttribute('aria-label', title);
    el.setAttribute('aria-pressed', String(!isA));
    el.classList.toggle('is-header', !isA);
  };
  return { el, paint };
}

const PLACE_LABELS: Array<[CellIconPlace, string]> = [
  ['prefix', 'Prefix'],
  ['suffix', 'Suffix'],
  ['tl', 'Top-left'],
  ['tr', 'Top-right'],
  ['bl', 'Bottom-left'],
  ['br', 'Bottom-right'],
];

const POPOUT_ICON = 'M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6';
const TEMPLATES_ICON = 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8';
const TRASH_ICON = 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2';

function templatesStorageKey(ctx: ExtContext<any>): string {
  return `tabular-ext:templates:${(ctx.api as { gridId?: string }).gridId ?? 'default'}`;
}

export interface RibbonHandle {
  destroy: () => void;
  setVisible: (v: boolean) => void;
  isVisible: () => boolean;
  setEditVisible: (v: boolean) => void;
  isEditVisible: () => boolean;
  setFormatVisible: (v: boolean) => void;
  isFormatVisible: () => boolean;
  refresh: () => void;
}

export function mountRibbon(host: HTMLElement, ctx: ExtContext<any>): RibbonHandle {
  injectExtStyles();
  host.className = 'tx-ribbon-host';
  host.replaceChildren();
  host.hidden = false;

  const editEl = document.createElement('div');
  editEl.dataset.toolbar = 'editing';
  const band = h('tx-ribbon');
  band.dataset.toolbar = 'formatting';
  host.append(editEl, band);

  const editApi = mountEditStrip(editEl, ctx);

  let scope: 'selected' | 'all' = 'selected';
  let styleTarget: 'cell' | 'header' = 'cell';
  let borderSide: BorderSide = 'all';
  let borderStyle = 'solid';
  let borderWidth = 1;
  let iconPlace: CellIconPlace = 'prefix';
  const cleanups: Array<() => void> = [];

  const targetCols = () => resolveTargetColIds(ctx.api, scope);
  const afterApply = () => {
    ctx.markDirty(true);
    refresh();
  };
  const requireCols = (): string[] | null => {
    const cols = targetCols();
    if (!cols.length) return null;
    return cols;
  };
  const applyFormat = (format: string | null) => {
    const cols = requireCols();
    if (!cols) return;
    if (applyColumnFormat(ctx.api, cols, format)) afterApply();
  };
  const activeStyle = (chrome: ReturnType<typeof readColumnChrome>): CellStyle =>
    styleTarget === 'header' ? chrome.headerStyle : chrome.style;

  const applyStylePatch = (patch: CellStyle, opts?: { clearKeys?: Array<keyof CellStyle> }) => {
    const cols = requireCols();
    if (!cols) return;
    const ok =
      styleTarget === 'header'
        ? applyColumnHeaderStyle(ctx.api, cols, patch, opts)
        : applyColumnStyle(ctx.api, cols, patch, opts);
    if (ok) afterApply();
  };
  const applyAlign = (align: Align) => {
    const cols = requireCols();
    if (!cols) return;
    if (applyColumnAlign(ctx.api, cols, align)) afterApply();
  };
  const patchFlag = (key: keyof ColDef, value: unknown) => {
    const cols = requireCols();
    if (!cols) return;
    const defs = ctx.api.getGridOption('columnDefs') as AnyColDef[] | undefined;
    if (!defs) return;
    const set = new Set(cols);
    ctx.api.setColumnDefs(
      mapLeafCols(defs, set, (col) => ({ ...col, [key]: value })),
    );
    afterApply();
  };

  // Target
  const targetT = stateToggle({
    a: { icon: ICON.grid, label: 'Cells' },
    b: { icon: ICON.rows, label: 'Header' },
    title: (isCell) =>
      `Styling target: ${isCell ? 'Cells' : 'Header'} — click to switch`,
  });
  const scopeT = stateToggle({
    a: { icon: ICON.range, label: 'Selected' },
    b: { icon: ICON.columns, label: 'All' },
    title: (isSel) =>
      `Scope: ${isSel ? 'selected column(s)' : 'ALL columns'} — click to switch`,
  });
  targetT.paint(true);
  scopeT.paint(true);
  targetT.el.addEventListener('click', () => {
    styleTarget = styleTarget === 'cell' ? 'header' : 'cell';
    targetT.paint(styleTarget === 'cell');
    refresh();
  });
  scopeT.el.addEventListener('click', () => {
    scope = scope === 'selected' ? 'all' : 'selected';
    scopeT.paint(scope === 'selected');
    refresh();
  });
  const selPill = pill('Select a cell', false);
  selPill.disabled = true;

  // Font
  const bold = toggleBtn(ICON.bold, 'Bold');
  const italic = toggleBtn(ICON.italic, 'Italic');
  const underline = toggleBtn(ICON.underline, 'Underline');
  const strike = toggleBtn(
    'M16 4H9a3 3 0 0 0-2.83 4M14 12a4 4 0 0 1 0 8H6M4 12h16',
    'Strikethrough',
  );
  const sizeVal = document.createElement('span');
  sizeVal.className = 'tx-rb-size';
  sizeVal.textContent = '12px';
  const sizeUp = document.createElement('button');
  sizeUp.type = 'button';
  sizeUp.className = 'tx-rb-step';
  sizeUp.title = 'Larger font';
  sizeUp.innerHTML = svg(ICON.chevronUp, 11);
  const sizeDn = document.createElement('button');
  sizeDn.type = 'button';
  sizeDn.className = 'tx-rb-step';
  sizeDn.title = 'Smaller font';
  sizeDn.innerHTML = svg(ICON.chevronDown, 11);
  const sizeWrap = h('tx-rb-stepper');
  const sizeStack = h('tx-rb-step-stack');
  sizeStack.append(sizeUp, sizeDn);
  sizeWrap.append(sizeVal, sizeStack);

  const textColor = colorSwatch(ICON.paintText, 'Text colour', '#81A1C1');
  const fillColor = colorSwatch(ICON.fill, 'Fill colour', '#2A2A2A');
  const headerCase = document.createElement('button');
  headerCase.type = 'button';
  headerCase.className = 'tx-rb-btn tx-rb-toggle tx-rb-ab';
  headerCase.textContent = 'AB';
  headerCase.title = 'Toggle header captions uppercase';

  // Align
  const alignL = toggleBtn(ICON.alignLeft, 'Align left');
  const alignC = toggleBtn(ICON.alignCenter, 'Align center');
  const alignR = toggleBtn(ICON.alignRight, 'Align right');

  // Borders
  const borderSideBtns: Record<BorderSide, HTMLButtonElement> = {
    all: borderSideBtn('all'),
    top: borderSideBtn('top'),
    bottom: borderSideBtn('bottom'),
    left: borderSideBtn('left'),
    right: borderSideBtn('right'),
  };
  const borderPreview = h('tx-rb-bpreview');
  borderPreview.title = 'Current borders';
  const borderColor = colorSwatch('M4 4h16v16H4zM12 12h.01', 'Border colour', '#81A1C1');
  const borderStylePill = pill('Solid');
  const borderWidthPill = pill('1 px');
  const borderClear = iconBtn(ICON.close, 'Clear border');

  // Number
  const fmtCode = pill('# Format');
  const fmtDollar = iconBtn(ICON.dollar, 'Currency format');
  const fmtPercent = iconBtn(ICON.percent, 'Percent format');
  const fmtThousands = iconBtn(ICON.hash, 'Thousands format');
  const decDown = decimalBtn('fewer', 'Fewer decimals');
  const decUp = decimalBtn('more', 'More decimals');

  // Icons
  const iconPicker = createIconPicker({
    onSelect: (sel) => applyIcon(sel),
    getTheme: () => ctx.getTheme(),
  });
  cleanups.push(() => iconPicker.destroy());
  const iconPlacePill = pill('Prefix');
  const iconColor = colorSwatch(ICON.paintText, 'Icon colour', '#81A1C1');
  const iconClear = iconBtn(ICON.close, 'Clear icon');

  // Column
  const colOpen = document.createElement('button');
  colOpen.type = 'button';
  colOpen.className = 'tx-rb-pill';
  colOpen.innerHTML = `${svg(ICON.settings, 13)}<span>Column</span>${svg(ICON.chevronDown, 11)}`;
  const aggPill = pill('Σ None');
  const colFF = toggleBtn(ICON.filter, 'Floating filter');
  const colGrp = toggleBtn(
    'M4 4h16v4H4zM4 10h10v4H4zM4 16h6v4H4z',
    'Groupable',
  );
  const colAggH = toggleBtn(ICON.rows, 'Show aggregation in header');

  // Templates
  const templatesBtn = iconBtn(TEMPLATES_ICON, 'Templates');
  const clear = pill('Clear', false);
  clear.classList.add('tx-rb-danger');
  clear.title = 'Clear styling + format on target columns';
  const eraser = iconBtn(ICON.close, 'Clear formatting');
  const deleteTpl = dangerIcon(TRASH_ICON, 'Delete template');

  // Popout
  const pop = iconBtn(POPOUT_ICON, 'Pop out');
  pop.addEventListener('click', () => ctx.bus.emit('popout', {}));

  band.append(
    grp('Target', mini(selPill), mini(targetT.el, scopeT.el)),
    grp(
      'Font',
      mini(bold, italic, underline, strike, sizeWrap),
      mini(textColor.button, fillColor.button, headerCase),
    ),
    grp('Alignment', mini(alignL, alignC, alignR)),
    grp(
      'Borders',
      mini(
        borderSideBtns.all,
        borderSideBtns.top,
        borderSideBtns.bottom,
        borderSideBtns.left,
        borderSideBtns.right,
        borderPreview,
      ),
      mini(borderColor.button, borderStylePill, borderWidthPill, borderClear),
    ),
    grp('Number', mini(fmtCode), mini(fmtDollar, fmtPercent, fmtThousands, decDown, decUp)),
    grp('Icons', mini(iconPicker.button, iconPlacePill), mini(iconColor.button, iconClear)),
    grp('Column', mini(colOpen, aggPill), mini(colFF, colGrp, colAggH)),
    grp('Templates', mini(templatesBtn), mini(clear, eraser, deleteTpl)),
  );

  const extras = h('tx-rb-extras');
  extras.dataset.slot = 'ribbon-extras';
  extras.appendChild(pop);
  band.appendChild(extras);

  // ── wire format ─────────────────────────────────────────────────────
  const dataType = (): FormatDataType => {
    const id = targetCols()[0];
    if (!id) return 'number';
    let t: FormatDataType = 'number';
    walkLeafCols(ctx.api.getGridOption('columnDefs') as AnyColDef[] | undefined, (c) => {
      if (leafColId(c) !== id) return;
      if (c.type === 'date') t = 'date';
      else if (c.type === 'text') t = 'text';
      else t = 'number';
    });
    return t;
  };

  const fmtPicker = formatPickerMenu(
    fmtCode,
    {
      targetCols,
      currentFormat: () => readColumnChrome(ctx.api, targetCols()).format,
      applyFormat: (f) => applyFormat(f),
      clearFormat: () => applyFormat(null),
      dataType,
    },
    ctx.getTheme(),
  );
  fmtCode.addEventListener('click', () => fmtPicker.toggle());
  cleanups.push(() => fmtPicker.destroy());

  fmtDollar.addEventListener('click', () => {
    const chrome = readColumnChrome(ctx.api, targetCols());
    applyFormat(currencyFormat(decimalsOf(chrome.format)));
  });
  fmtPercent.addEventListener('click', () => {
    const chrome = readColumnChrome(ctx.api, targetCols());
    applyFormat(percentFormat(decimalsOf(chrome.format) || 2));
  });
  fmtThousands.addEventListener('click', () => {
    const chrome = readColumnChrome(ctx.api, targetCols());
    applyFormat(numberFormat(decimalsOf(chrome.format)));
  });
  decDown.addEventListener('click', () => {
    const chrome = readColumnChrome(ctx.api, targetCols());
    applyFormat(adjustDecimals(chrome.format, -1));
  });
  decUp.addEventListener('click', () => {
    const chrome = readColumnChrome(ctx.api, targetCols());
    applyFormat(adjustDecimals(chrome.format, 1));
  });

  // ── wire style ──────────────────────────────────────────────────────
  textColor.input.addEventListener('change', () => applyStylePatch({ color: textColor.input.value }));
  fillColor.input.addEventListener('change', () =>
    applyStylePatch({ backgroundColor: fillColor.input.value }),
  );
  bold.addEventListener('click', () => {
    const chrome = readColumnChrome(ctx.api, targetCols());
    const s = activeStyle(chrome);
    const on = String(s.fontWeight) === 'bold' || Number(s.fontWeight) >= 600;
    applyStylePatch({ fontWeight: on ? 'normal' : 'bold' });
  });
  italic.addEventListener('click', () => {
    const chrome = readColumnChrome(ctx.api, targetCols());
    const s = activeStyle(chrome);
    applyStylePatch({ fontStyle: s.fontStyle === 'italic' ? 'normal' : 'italic' });
  });
  underline.addEventListener('click', () => {
    const chrome = readColumnChrome(ctx.api, targetCols());
    const s = activeStyle(chrome);
    const on = (s.textDecoration ?? '').includes('underline');
    applyStylePatch({ textDecoration: on ? 'none' : 'underline' });
  });
  strike.addEventListener('click', () => {
    const chrome = readColumnChrome(ctx.api, targetCols());
    const s = activeStyle(chrome);
    const on = (s.textDecoration ?? '').includes('line-through');
    applyStylePatch({ textDecoration: on ? 'none' : 'line-through' });
  });
  const bumpSize = (delta: number) => {
    const chrome = readColumnChrome(ctx.api, targetCols());
    const s = activeStyle(chrome);
    const cur = s.fontSize ?? ctx.getTheme().fontSize;
    applyStylePatch({ fontSize: Math.max(8, Math.min(24, cur + delta)) });
  };
  sizeUp.addEventListener('click', () => bumpSize(1));
  sizeDn.addEventListener('click', () => bumpSize(-1));

  alignL.addEventListener('click', () => applyAlign('left'));
  alignC.addEventListener('click', () => applyAlign('center'));
  alignR.addEventListener('click', () => applyAlign('right'));

  // Borders — merge sides into a map
  const borderCss = () => `${borderWidth}px ${borderStyle} ${borderColor.input.value}`;
  const applyBorder = () => {
    applyStylePatch({ border: { [borderSide]: borderCss() } as CellStyle['border'] });
  };
  const paintBorderPreview = (border: CellStyle['border'] | undefined) => {
    const p = borderPreview.style;
    p.border = '';
    p.borderTop = '';
    p.borderRight = '';
    p.borderBottom = '';
    p.borderLeft = '';
    p.boxShadow = '';
    const map: Partial<Record<BorderSide, string>> = {};
    if (typeof border === 'string') {
      const m = border.match(/^(all|top|bottom|left|right):(.+)$/i);
      if (m) map[m[1]!.toLowerCase() as BorderSide] = m[2]!.trim();
      else map.all = border;
    } else if (border) {
      Object.assign(map, border);
    }
    const css = (spec?: string) => {
      if (!spec) return '';
      const m = spec.match(/^(all|top|bottom|left|right):(.+)$/i);
      return m ? m[2]!.trim() : spec;
    };
    if (map.all) p.border = css(map.all);
    if (map.top) p.borderTop = css(map.top);
    if (map.bottom) p.borderBottom = css(map.bottom);
    if (map.left) p.borderLeft = css(map.left);
    if (map.right) p.borderRight = css(map.right);
  };
  for (const [side, btn] of Object.entries(borderSideBtns) as Array<[BorderSide, HTMLButtonElement]>) {
    btn.addEventListener('click', () => {
      borderSide = side;
      for (const [s, b] of Object.entries(borderSideBtns)) {
        b.classList.toggle('is-on', s === side);
      }
      applyBorder();
    });
  }
  borderSideBtns.all.classList.add('is-on');
  borderColor.input.addEventListener('change', applyBorder);
  borderClear.addEventListener('click', () => {
    const cols = requireCols();
    if (!cols) return;
    if (borderSide === 'all') {
      applyStylePatch({}, { clearKeys: ['border'] });
      return;
    }
    const chrome = readColumnChrome(ctx.api, cols);
    const existing = activeStyle(chrome).border;
    const map =
      typeof existing === 'object' && existing
        ? { ...existing }
        : mergeBorder(existing, 'all', typeof existing === 'string' ? existing : '');
    delete map[borderSide];
    if (!Object.keys(map).length) applyStylePatch({}, { clearKeys: ['border'] });
    else {
      // Replace whole border map: clear then set
      const defs = ctx.api.getGridOption('columnDefs') as AnyColDef[] | undefined;
      if (!defs) return;
      const set = new Set(cols);
      const key = styleTarget === 'header' ? 'headerStyle' : 'cellStyle';
      ctx.api.setColumnDefs(
        mapLeafCols(defs, set, (col) => {
          if (key === 'headerStyle') {
            const hs = { ...(col.headerStyle ?? {}), border: map };
            return { ...col, headerStyle: hs };
          }
          if (typeof col.cellStyle === 'function') {
            const prevFn = col.cellStyle;
            return {
              ...col,
              cellStyle: (params) => ({ ...(prevFn(params) ?? {}), border: map }),
            };
          }
          return { ...col, cellStyle: { ...(col.cellStyle ?? {}), border: map } };
        }),
      );
      afterApply();
    }
  });

  const styleMenu = menu(borderStylePill, ctx.getTheme(), (close) => {
    const list = h('tx-menu-list');
    for (const s of ['solid', 'dashed', 'dotted']) {
      const it = document.createElement('button');
      it.type = 'button';
      it.className = 'tx-menu-item' + (borderStyle === s ? ' is-active' : '');
      it.textContent = s[0]!.toUpperCase() + s.slice(1);
      it.addEventListener('click', () => {
        borderStyle = s;
        borderStylePill.querySelector('span')!.textContent = it.textContent!;
        applyBorder();
        close();
      });
      list.appendChild(it);
    }
    return list;
  });
  borderStylePill.addEventListener('click', () => styleMenu.toggle());
  cleanups.push(() => styleMenu.destroy());

  const widthMenu = menu(borderWidthPill, ctx.getTheme(), (close) => {
    const list = h('tx-menu-list');
    for (const w of [1, 2, 3, 4]) {
      const it = document.createElement('button');
      it.type = 'button';
      it.className = 'tx-menu-item' + (borderWidth === w ? ' is-active' : '');
      it.textContent = `${w} px`;
      it.addEventListener('click', () => {
        borderWidth = w;
        borderWidthPill.querySelector('span')!.textContent = `${w} px`;
        applyBorder();
        close();
      });
      list.appendChild(it);
    }
    return list;
  });
  borderWidthPill.addEventListener('click', () => widthMenu.toggle());
  cleanups.push(() => widthMenu.destroy());

  // AB — headerStyle.textTransform
  headerCase.addEventListener('click', () => {
    const cols = resolveTargetColIds(ctx.api, 'all');
    if (!cols.length) return;
    const first = readColumnChrome(ctx.api, cols);
    const on = first.headerStyle.textTransform === 'uppercase';
    applyColumnHeaderStyle(ctx.api, cols, { textTransform: on ? 'none' : 'uppercase' });
    afterApply();
  });

  // Icons
  function currentIcon(): CellIconSpec | null | undefined {
    const chrome = readColumnChrome(ctx.api, targetCols());
    return styleTarget === 'header' ? chrome.headerIcon : chrome.cellIcon;
  }
  function applyIcon(sel: IconSelection | null): void {
    const cols = requireCols();
    if (!cols) return;
    if (sel == null) {
      if (applyColumnIcon(ctx.api, cols, null, styleTarget)) afterApply();
      return;
    }
    const spec: CellIconSpec = {
      ...sel,
      place: iconPlace,
      ...(sel.name ? { color: iconColor.input.value } : {}),
    };
    if (applyColumnIcon(ctx.api, cols, spec, styleTarget)) afterApply();
  }
  iconPicker.onSelect = (sel) => applyIcon(sel);
  iconClear.addEventListener('click', () => applyIcon(null));
  iconColor.input.addEventListener('change', () => {
    const cur = currentIcon();
    if (cur?.name) applyIcon({ name: cur.name });
  });
  const placeMenu = menu(iconPlacePill, ctx.getTheme(), (close) => {
    const list = h('tx-menu-list');
    for (const [place, label] of PLACE_LABELS) {
      const it = document.createElement('button');
      it.type = 'button';
      it.className = 'tx-menu-item' + (iconPlace === place ? ' is-active' : '');
      it.textContent = label;
      it.addEventListener('click', () => {
        const prev = iconPlace;
        const moving = currentIcon();
        const sameSlot = moving && (moving.place ?? 'prefix') === prev;
        iconPlacePill.querySelector('span')!.textContent = label;
        if (sameSlot && prev !== place) {
          // Move: clear old slot, rewrite at new placement
          iconPlace = prev;
          applyIcon(null);
          iconPlace = place;
          applyIcon(moving!.name ? { name: moving!.name } : { emoji: moving!.emoji! });
        } else {
          iconPlace = place;
          refresh();
        }
        close();
      });
      list.appendChild(it);
    }
    return list;
  }, { align: 'left' });
  iconPlacePill.addEventListener('click', () => placeMenu.toggle());
  cleanups.push(() => placeMenu.destroy());

  // Templates stub
  const templatesMenu = menu(templatesBtn, ctx.getTheme(), (close) => {
    const list = h('tx-menu-list');
    const label = document.createElement('div');
    label.className = 'tx-menu-label';
    label.textContent = 'Templates';
    list.appendChild(label);
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'tx-menu-item';
    save.textContent = 'Save as template…';
    save.addEventListener('click', () => {
      const cols = targetCols();
      if (!cols.length) return;
      const name = window.prompt('Template name', cols[0] ?? 'template');
      if (!name) return;
      const chrome = readColumnChrome(ctx.api, cols);
      let store: Record<string, unknown> = {};
      try {
        store = JSON.parse(localStorage.getItem(templatesStorageKey(ctx)) ?? '{}') as Record<
          string,
          unknown
        >;
      } catch {
        store = {};
      }
      store[name] = {
        format: chrome.format,
        style: chrome.style,
        headerStyle: chrome.headerStyle,
        cellIcon: chrome.cellIcon,
        headerIcon: chrome.headerIcon,
        align: chrome.align,
        colIds: cols,
      };
      localStorage.setItem(templatesStorageKey(ctx), JSON.stringify(store));
      close();
    });
    list.appendChild(save);
    let store: Record<string, unknown> = {};
    try {
      store = JSON.parse(localStorage.getItem(templatesStorageKey(ctx)) ?? '{}') as Record<
        string,
        unknown
      >;
    } catch {
      store = {};
    }
    const names = Object.keys(store);
    if (names.length) {
      const sep = document.createElement('div');
      sep.className = 'tx-menu-sep';
      list.appendChild(sep);
      for (const n of names) {
        const it = document.createElement('button');
        it.type = 'button';
        it.className = 'tx-menu-item';
        it.textContent = n;
        it.addEventListener('click', () => {
          const cols = requireCols();
          if (!cols) return;
          const tpl = store[n] as {
            format?: string;
            style?: CellStyle;
            headerStyle?: CellStyle;
            cellIcon?: CellIconSpec | null;
            headerIcon?: CellIconSpec | null;
            align?: Align;
          };
          if (tpl.format != null) applyColumnFormat(ctx.api, cols, tpl.format);
          if (tpl.style) applyColumnStyle(ctx.api, cols, tpl.style);
          if (tpl.headerStyle) applyColumnHeaderStyle(ctx.api, cols, tpl.headerStyle);
          if (tpl.cellIcon !== undefined) applyColumnIcon(ctx.api, cols, tpl.cellIcon ?? null, 'cell');
          if (tpl.headerIcon !== undefined)
            applyColumnIcon(ctx.api, cols, tpl.headerIcon ?? null, 'header');
          if (tpl.align) applyColumnAlign(ctx.api, cols, tpl.align);
          afterApply();
          close();
        });
        list.appendChild(it);
      }
    }
    return list;
  });
  templatesBtn.addEventListener('click', () => templatesMenu.toggle());
  cleanups.push(() => templatesMenu.destroy());

  deleteTpl.addEventListener('click', () => {
    const name = window.prompt('Delete template name');
    if (!name) return;
    try {
      const store = JSON.parse(localStorage.getItem(templatesStorageKey(ctx)) ?? '{}') as Record<
        string,
        unknown
      >;
      delete store[name];
      localStorage.setItem(templatesStorageKey(ctx), JSON.stringify(store));
    } catch {
      /* ignore */
    }
  });

  clear.addEventListener('click', () => {
    const cols = requireCols();
    if (!cols) return;
    if (clearColumnFormatting(ctx.api, cols)) afterApply();
  });
  eraser.addEventListener('click', () => clear.click());

  // Column panel + quick flags
  const colPanel = columnPanelMenu(colOpen, {
    api: ctx.api,
    targetCols,
    onApplied: afterApply,
    getTheme: () => ctx.getTheme(),
  });
  colOpen.addEventListener('click', () => colPanel.toggle());
  cleanups.push(() => colPanel.destroy());

  colFF.addEventListener('click', () => {
    const first = targetCols()[0];
    if (!first) return;
    let cur = false;
    walkLeafCols(ctx.api.getGridOption('columnDefs') as AnyColDef[] | undefined, (c) => {
      if (leafColId(c) === first) cur = !!c.floatingFilter;
    });
    patchFlag('floatingFilter', !cur);
    if (!cur) ctx.api.setGridOption('floatingFilter', true);
  });
  colGrp.addEventListener('click', () => {
    const first = targetCols()[0];
    if (!first) return;
    let cur = false;
    walkLeafCols(ctx.api.getGridOption('columnDefs') as AnyColDef[] | undefined, (c) => {
      if (leafColId(c) === first) cur = !!c.enableRowGroup;
    });
    patchFlag('enableRowGroup', !cur);
  });
  colAggH.addEventListener('click', () => {
    const cur = ctx.api.getGridOption('suppressAggFuncInHeader') === true;
    ctx.api.setGridOption('suppressAggFuncInHeader', !cur);
    afterApply();
  });

  const aggMenu = menu(aggPill, ctx.getTheme(), (close) => {
    const list = h('tx-menu-list');
    for (const v of ['none', 'sum', 'avg', 'min', 'max', 'count', 'first', 'last']) {
      const it = document.createElement('button');
      it.type = 'button';
      it.className = 'tx-menu-item';
      it.textContent = v === 'none' ? 'None' : v;
      it.addEventListener('click', () => {
        if (v === 'none') patchFlag('aggFunc', undefined);
        else patchFlag('aggFunc', v);
        aggPill.querySelector('span')!.textContent = v === 'none' ? 'Σ None' : `Σ ${v}`;
        close();
      });
      list.appendChild(it);
    }
    return list;
  });
  aggPill.addEventListener('click', () => aggMenu.toggle());
  cleanups.push(() => aggMenu.destroy());

  const formatControls = [
    bold,
    italic,
    underline,
    strike,
    sizeUp,
    sizeDn,
    textColor.button,
    fillColor.button,
    alignL,
    alignC,
    alignR,
    ...Object.values(borderSideBtns),
    borderColor.button,
    borderStylePill,
    borderWidthPill,
    borderClear,
    fmtCode,
    fmtDollar,
    fmtPercent,
    fmtThousands,
    decDown,
    decUp,
    iconPicker.button,
    iconPlacePill,
    iconColor.button,
    iconClear,
    colOpen,
    aggPill,
    colFF,
    colGrp,
    colAggH,
    templatesBtn,
    clear,
    eraser,
    deleteTpl,
  ];

  function refresh(): void {
    editApi.refresh();
    const cols = targetCols();
    const has = cols.length > 0;
    for (const c of formatControls) c.disabled = !has;
    headerCase.disabled = styleTarget !== 'header';

    if (!has) {
      selPill.querySelector('span')!.textContent =
        scope === 'all' ? 'No columns' : 'Select a cell';
      iconPicker.setPreview(null);
      return;
    }
    selPill.querySelector('span')!.textContent =
      scope === 'all' ? `All (${cols.length})` : cols.length === 1 ? cols[0]! : `${cols.length} cols`;

    const chrome = readColumnChrome(ctx.api, cols);
    const style = activeStyle(chrome);
    const fmtLabel = chrome.format
      ? chrome.format.length > 14
        ? `${chrome.format.slice(0, 13)}…`
        : chrome.format
      : '# Format';
    fmtCode.querySelector('span')!.textContent = fmtLabel;

    const weightOn =
      String(style.fontWeight) === 'bold' || Number(style.fontWeight) >= 600;
    bold.classList.toggle('is-on', weightOn);
    italic.classList.toggle('is-on', style.fontStyle === 'italic');
    underline.classList.toggle('is-on', (style.textDecoration ?? '').includes('underline'));
    strike.classList.toggle('is-on', (style.textDecoration ?? '').includes('line-through'));
    sizeVal.textContent = `${style.fontSize ?? ctx.getTheme().fontSize}px`;
    if (style.color) textColor.setBar(style.color);
    const bg = style.backgroundColor ?? style.background;
    if (bg) fillColor.setBar(bg);

    headerCase.classList.toggle('is-on', chrome.headerStyle.textTransform === 'uppercase');

    alignL.classList.toggle('is-on', chrome.align === 'left');
    alignC.classList.toggle('is-on', chrome.align === 'center');
    alignR.classList.toggle('is-on', chrome.align === 'right');

    paintBorderPreview(style.border);
    for (const [s, b] of Object.entries(borderSideBtns)) {
      b.classList.toggle('is-on', s === borderSide);
    }

    const icon = styleTarget === 'header' ? chrome.headerIcon : chrome.cellIcon;
    iconPicker.setPreview(icon?.name || icon?.emoji ? { name: icon.name, emoji: icon.emoji } : null);
    if (icon?.place) {
      iconPlace = icon.place;
      const label = PLACE_LABELS.find(([p]) => p === iconPlace)?.[1] ?? 'Prefix';
      iconPlacePill.querySelector('span')!.textContent = label;
    }
    if (icon?.color) iconColor.setBar(icon.color);
    iconColor.button.disabled = !has || !!icon?.emoji;

    let ff = false;
    let grpOn = false;
    let agg: string | undefined;
    walkLeafCols(ctx.api.getGridOption('columnDefs') as AnyColDef[] | undefined, (c) => {
      if (leafColId(c) !== cols[0]) return;
      ff = !!c.floatingFilter;
      grpOn = !!c.enableRowGroup;
      agg = typeof c.aggFunc === 'string' ? c.aggFunc : undefined;
    });
    colFF.classList.toggle('is-on', ff);
    colGrp.classList.toggle('is-on', grpOn);
    colAggH.classList.toggle(
      'is-on',
      ctx.api.getGridOption('suppressAggFuncInHeader') !== true,
    );
    aggPill.querySelector('span')!.textContent = agg ? `Σ ${agg}` : 'Σ None';
  }

  cleanups.push(ctx.api.on('cellSelectionChanged', () => refresh()));
  cleanups.push(ctx.api.on('cellClicked', () => refresh()));
  cleanups.push(ctx.api.on('columnMoved', () => refresh()));
  cleanups.push(ctx.api.on('columnVisible', () => refresh()));

  refresh();

  return {
    destroy: () => {
      for (const fn of cleanups) fn();
      editApi.destroy();
      host.replaceChildren();
    },
    setVisible: (v) => {
      host.hidden = !v;
    },
    isVisible: () => !host.hidden,
    setEditVisible: (v) => {
      editEl.hidden = !v;
    },
    isEditVisible: () => !editEl.hidden,
    setFormatVisible: (v) => {
      band.hidden = !v;
    },
    isFormatVisible: () => !band.hidden,
    refresh,
  };
}

export function appendRibbonExtras(host: HTMLElement, nodes: HTMLElement[]): void {
  const extras =
    host.querySelector<HTMLElement>('[data-slot="ribbon-extras"]') ??
    host.querySelector<HTMLElement>('.tx-ribbon [data-slot="ribbon-extras"]');
  if (!extras) return;
  for (const n of nodes) extras.appendChild(n);
}
