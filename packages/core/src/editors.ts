/**
 * Built-in DOM cell editors (AG provided-editor parity):
 * `agTextCellEditor`, `agNumberCellEditor`, `agSelectCellEditor`,
 * `agCheckboxCellEditor`, `agDateCellEditor`, `agDateStringCellEditor`,
 * `agLargeTextCellEditor`. Registered globally under their AG names;
 * columns opt in via `colDef.cellEditor` + `cellEditorParams`.
 *
 * Editors are constructed only when an edit starts — zero cost otherwise.
 * All styling derives from theme tokens.
 */
import {
  globalRegistry,
  type CellEditorComp,
  type CellEditorFactory,
  type CellEditorParams,
} from './registry';
import type { ResolvedTheme } from './theme';

/** AG `ITextCellEditorParams` subset. */
export interface TextCellEditorParams {
  maxLength?: number;
  /** Seed the input with the formatted value (reference-data style columns). */
  useFormatter?: boolean;
}

/** AG `INumberCellEditorParams` subset. */
export interface NumberCellEditorParams {
  min?: number;
  max?: number;
  /** Digits allowed after the decimal point. */
  precision?: number;
  step?: number;
  /** Show the native stepper buttons. Default false (AG parity). */
  showStepperButtons?: boolean;
}

/** AG `ISelectCellEditorParams`. */
export interface SelectCellEditorParams {
  values: unknown[];
}

/** AG `IDateCellEditorParams` / `IDateStringCellEditorParams` subset. */
export interface DateCellEditorParams {
  min?: string | Date;
  max?: string | Date;
  step?: number;
}

/** AG `ILargeTextEditorParams` subset. */
export interface LargeTextCellEditorParams {
  /** Max characters. Default 200 (AG parity). */
  maxLength?: number;
  /** Character rows. Default 10 (AG parity). */
  rows?: number;
  /** Character columns. Default 60 (AG parity). */
  cols?: number;
}

function inputChrome(el: HTMLElement, t: ResolvedTheme, mono: boolean): void {
  Object.assign(el.style, {
    boxSizing: 'border-box',
    background: t.overlay,
    color: t.textPrimary,
    border: `2px solid ${t.accent}`,
    borderRadius: '0',
    outline: 'none',
    margin: '0',
    padding: `0 ${Math.max(0, t.paddingX - 2)}px`,
    font: `500 ${t.fontSize}px ${mono ? t.fontMono : t.fontSans}`,
  } satisfies Partial<CSSStyleDeclaration>);
}

/** Printable single character that should seed type-to-replace editing. */
function printableKey(eventKey: string | null): string | null {
  return eventKey && eventKey.length === 1 ? eventKey : null;
}

function toDateInputValue(v: unknown): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  if (typeof v === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
    if (m) return m[1];
  }
  return '';
}

function dateBound(v: string | Date | undefined): string {
  return v === undefined ? '' : toDateInputValue(v);
}

/**
 * Magnitude suffix parsing for the number editor (`1.5k`, `2M`, `1B`).
 * Local copy — satellites import core, not the reverse (`@tabular/edit`).
 */
const MAGNITUDE_SUFFIX: Record<string, number> = {
  k: 1e3,
  K: 1e3,
  m: 1e6,
  M: 1e6,
  b: 1e9,
  B: 1e9,
  t: 1e12,
  T: 1e12,
};

/** Parse a numeric string with optional k/M/B/T suffix. Returns NaN on failure. */
function parseMagnitude(input: string): number {
  const s = input.trim().replace(/,/g, '');
  if (!s) return NaN;
  const m = s.match(/^([+-]?\d*\.?\d+)\s*([kKmMbBtT])?$/);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return NaN;
  const suf = m[2];
  return suf ? base * (MAGNITUDE_SUFFIX[suf] ?? 1) : base;
}

export function textCellEditor<TData>(params: CellEditorParams<TData>): CellEditorComp {
  const p = (params.cellEditorParams ?? {}) as TextCellEditorParams;
  const input = document.createElement('input');
  input.type = 'text';
  if (p.maxLength !== undefined) input.maxLength = p.maxLength;
  inputChrome(input, params.theme, false);
  const seed = printableKey(params.eventKey);
  input.value =
    seed ??
    (p.useFormatter === true
      ? params.formatValue(params.value)
      : params.value == null
        ? ''
        : String(params.value));
  return {
    getGui: () => input,
    getValue: () => params.parseValue(input.value),
    afterGuiAttached: () => {
      input.focus();
      if (seed) input.setSelectionRange(input.value.length, input.value.length);
      else input.select();
    },
  };
}

export function numberCellEditor<TData>(params: CellEditorParams<TData>): CellEditorComp {
  const p = (params.cellEditorParams ?? {}) as NumberCellEditorParams;
  // Text input so magnitude suffixes (`1.5k`, `2M`) can be typed; native
  // `type=number` rejects non-numeric characters.
  const input = document.createElement('input');
  input.type = p.showStepperButtons === true ? 'number' : 'text';
  input.inputMode = 'decimal';
  if (p.min !== undefined) input.min = String(p.min);
  if (p.max !== undefined) input.max = String(p.max);
  if (p.step !== undefined) input.step = String(p.step);
  inputChrome(input, params.theme, true);
  input.style.textAlign = 'right';
  if (p.showStepperButtons !== true) {
    input.style.appearance = 'textfield';
  }
  const seed = printableKey(params.eventKey);
  input.value =
    seed && /[\d.kKmMbBtT+-]/.test(seed)
      ? seed
      : typeof params.value === 'number'
        ? String(params.value)
        : '';
  const parse = (): number | null => {
    if (input.value.trim() === '') return null;
    let n = parseMagnitude(input.value);
    if (!Number.isFinite(n)) return null;
    if (p.precision !== undefined) n = Number(n.toFixed(p.precision));
    return n;
  };
  return {
    getGui: () => input,
    getValue: parse,
    // Out-of-range input cancels the edit rather than clamping (AG behaviour).
    isCancelAfterEnd: () => {
      const n = parse();
      if (n === null) return input.value.trim() !== '';
      if (p.min !== undefined && n < p.min) return true;
      if (p.max !== undefined && n > p.max) return true;
      return false;
    },
    afterGuiAttached: () => {
      input.focus();
      if (seed) input.setSelectionRange?.(input.value.length, input.value.length);
      else input.select();
    },
  };
}

export function selectCellEditor<TData>(params: CellEditorParams<TData>): CellEditorComp {
  const p = (params.cellEditorParams ?? { values: [] }) as SelectCellEditorParams;
  const select = document.createElement('select');
  inputChrome(select, params.theme, false);
  select.style.padding = `0 ${Math.max(0, params.theme.paddingX - 4)}px`;
  const values = p.values ?? [];
  for (let i = 0; i < values.length; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = params.formatValue(values[i]) || String(values[i] ?? '');
    if (values[i] === params.value) opt.selected = true;
    select.appendChild(opt);
  }
  return {
    getGui: () => select,
    getValue: () => values[Number(select.value)] ?? params.value,
    afterGuiAttached: () => select.focus(),
  };
}

export function checkboxCellEditor<TData>(params: CellEditorParams<TData>): CellEditorComp {
  const t = params.theme;
  const wrap = document.createElement('div');
  Object.assign(wrap.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    background: t.overlay,
    border: `2px solid ${t.accent}`,
  } satisfies Partial<CSSStyleDeclaration>);
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = params.value === true;
  input.style.accentColor = t.accent;
  wrap.appendChild(input);
  return {
    getGui: () => wrap,
    getValue: () => input.checked,
    afterGuiAttached: () => input.focus(),
  };
}

function makeDateEditor<TData>(
  params: CellEditorParams<TData>,
  asString: boolean,
): CellEditorComp {
  const p = (params.cellEditorParams ?? {}) as DateCellEditorParams;
  const input = document.createElement('input');
  input.type = 'date';
  const min = dateBound(p.min);
  const max = dateBound(p.max);
  if (min) input.min = min;
  if (max) input.max = max;
  if (p.step !== undefined) input.step = String(p.step);
  inputChrome(input, params.theme, true);
  input.value = toDateInputValue(params.value);
  return {
    getGui: () => input,
    getValue: () => {
      if (!input.value) return null;
      if (asString) return input.value;
      const d = new Date(`${input.value}T00:00:00`);
      return Number.isNaN(d.getTime()) ? null : d;
    },
    afterGuiAttached: () => input.focus(),
  };
}

export function dateCellEditor<TData>(params: CellEditorParams<TData>): CellEditorComp {
  return makeDateEditor(params, false);
}

export function dateStringCellEditor<TData>(params: CellEditorParams<TData>): CellEditorComp {
  return makeDateEditor(params, true);
}

export function largeTextCellEditor<TData>(params: CellEditorParams<TData>): CellEditorComp {
  const p = (params.cellEditorParams ?? {}) as LargeTextCellEditorParams;
  const t = params.theme;
  const ta = document.createElement('textarea');
  ta.maxLength = p.maxLength ?? 200;
  ta.rows = p.rows ?? 10;
  ta.cols = p.cols ?? 60;
  Object.assign(ta.style, {
    boxSizing: 'border-box',
    background: t.overlay,
    color: t.textPrimary,
    border: `2px solid ${t.accent}`,
    borderRadius: '0',
    outline: 'none',
    margin: '0',
    padding: '6px 8px',
    font: `500 ${t.fontSize}px ${t.fontSans}`,
    resize: 'none',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
  } satisfies Partial<CSSStyleDeclaration>);
  ta.value = params.value == null ? '' : String(params.value);
  return {
    getGui: () => ta,
    getValue: () => params.parseValue(ta.value),
    isPopup: () => true,
    getPopupPosition: () => 'under',
    afterGuiAttached: () => {
      ta.focus();
      ta.select();
    },
  };
}

/** Register the built-in editors under their AG names (module load, once). */
export function registerBuiltinEditors(): void {
  globalRegistry.setCellEditor('agTextCellEditor', textCellEditor as CellEditorFactory);
  globalRegistry.setCellEditor('agNumberCellEditor', numberCellEditor as CellEditorFactory);
  globalRegistry.setCellEditor('agSelectCellEditor', selectCellEditor as CellEditorFactory);
  globalRegistry.setCellEditor('agCheckboxCellEditor', checkboxCellEditor as CellEditorFactory);
  globalRegistry.setCellEditor('agDateCellEditor', dateCellEditor as CellEditorFactory);
  globalRegistry.setCellEditor('agDateStringCellEditor', dateStringCellEditor as CellEditorFactory);
  globalRegistry.setCellEditor('agLargeTextCellEditor', largeTextCellEditor as CellEditorFactory);
}

registerBuiltinEditors();
