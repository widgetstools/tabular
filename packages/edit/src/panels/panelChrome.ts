/**
 * Shared DOM chrome for edit tool panels — mirrors core tool-panel styling
 * via theme tokens from `api.getTheme()`.
 */
import type { ResolvedTheme, Tabular } from '@tabular/core';
import { parseMagnitude } from '../nudge';

export function themeOf<TData>(api: Tabular<TData>): ResolvedTheme {
  return api.getTheme();
}

export function panelRoot(t: ResolvedTheme): HTMLElement {
  const root = document.createElement('div');
  Object.assign(root.style, {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    font: `${t.fontSize}px ${t.fontSans}`,
    color: t.textPrimary,
  } satisfies Partial<CSSStyleDeclaration>);
  return root;
}

export function label(t: ResolvedTheme, text: string): HTMLElement {
  const el = document.createElement('label');
  Object.assign(el.style, {
    display: 'block',
    fontSize: `${t.fontSize - 1}px`,
    fontWeight: '600',
    color: t.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    marginBottom: '2px',
  } satisfies Partial<CSSStyleDeclaration>);
  el.textContent = text;
  return el;
}

export function fieldWrap(): HTMLElement {
  const el = document.createElement('div');
  el.style.display = 'flex';
  el.style.flexDirection = 'column';
  el.style.gap = '2px';
  return el;
}

export function inputStyle(t: ResolvedTheme): Partial<CSSStyleDeclaration> {
  return {
    width: '100%',
    boxSizing: 'border-box',
    border: `1px solid ${t.hairline}`,
    background: t.base,
    color: t.textPrimary,
    borderRadius: '2px',
    padding: '4px 6px',
    font: `${t.fontSize}px ${t.fontSans}`,
  };
}

export function btnStyle(t: ResolvedTheme, primary = false): Partial<CSSStyleDeclaration> {
  return {
    border: `1px solid ${primary ? t.accent : t.hairline}`,
    background: primary ? t.accent : t.base,
    color: primary ? t.base : t.textSecondary,
    borderRadius: '2px',
    padding: '4px 10px',
    fontSize: `${t.fontSize - 1}px`,
    cursor: 'pointer',
    font: `${t.fontSize - 1}px ${t.fontSans}`,
  };
}

export function buttonRow(): HTMLElement {
  const row = document.createElement('div');
  Object.assign(row.style, {
    display: 'flex',
    gap: '6px',
    flexWrap: 'wrap',
  } satisfies Partial<CSSStyleDeclaration>);
  return row;
}

export function previewList(t: ResolvedTheme): HTMLElement {
  const el = document.createElement('div');
  Object.assign(el.style, {
    maxHeight: '220px',
    overflow: 'auto',
    border: `1px solid ${t.hairline}`,
    borderRadius: '2px',
    background: t.overlay,
    font: `${t.fontSize - 1}px ${t.fontMono}`,
    padding: '4px 6px',
    whiteSpace: 'pre',
  } satisfies Partial<CSSStyleDeclaration>);
  return el;
}

export function statusLine(t: ResolvedTheme): HTMLElement {
  const el = document.createElement('div');
  Object.assign(el.style, {
    fontSize: `${t.fontSize - 1}px`,
    color: t.textSecondary,
    minHeight: '1.2em',
  } satisfies Partial<CSSStyleDeclaration>);
  return el;
}

/** Visible (non-hidden) column ids in column-state order. */
export function displayedColIds<TData>(api: Tabular<TData>): string[] {
  return api
    .getColumnState()
    .filter((c) => !c.hide)
    .map((c) => c.colId);
}

/** Leaf rows currently in the displayed (filtered/sorted) set. */
export function displayedLeafRows<TData>(api: Tabular<TData>): TData[] {
  const out: TData[] = [];
  const n = api.getDisplayedRowCount();
  for (let i = 0; i < n; i++) {
    const row = api.getDisplayedRowAtIndex(i);
    if (row != null) out.push(row);
  }
  return out;
}

/**
 * Best-effort row id: prefer `id` on the data object (showcase / typical
 * getRowId), else a stable index key. Gap: no public `api.getRowId(data)`.
 */
export function rowIdOf(row: unknown, index: number): string {
  if (row && typeof row === 'object' && 'id' in row) {
    const id = (row as { id: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  }
  return `__row_${index}`;
}

export function parseOperand(raw: string): number {
  return parseMagnitude(raw);
}

export function fmtPreview(v: unknown): string {
  if (typeof v === 'number') {
    return Number.isFinite(v)
      ? v.toLocaleString(undefined, { maximumFractionDigits: 6 })
      : String(v);
  }
  if (v == null) return '∅';
  return String(v);
}
