import type { InternalColumn } from '../columnModel';
import type { ProvidedColumnGroup } from '../columnGroups';
import { isColGroup } from '../columnGroups';
import type { AnyColDef } from '../types';
import type { ResolvedTheme } from '../theme';
import { withAlpha } from '../theme';
import { iconSvg } from '../icons';

export const SIDE_BAR_BUTTON_WIDTH = 42;
export const DEFAULT_TOOL_PANEL_WIDTH = 250;

export function panelIconMarkup(iconKey: string | undefined, label: string): string {
  if (iconKey === 'columns') {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1"/></svg>`;
  }
  if (iconKey === 'filter' || iconKey === 'filters-new') {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></svg>`;
  }
  return `<span style="font-size:11px;font-weight:600">${label.slice(0, 2)}</span>`;
}

export function chipBtnStyle(t: ResolvedTheme): Partial<CSSStyleDeclaration> {
  return {
    border: `1px solid ${t.hairline}`,
    background: t.base,
    color: t.textSecondary,
    borderRadius: '2px',
    padding: '2px 8px',
    fontSize: `${t.fontSize - 1}px`,
    cursor: 'pointer',
  };
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

export function sectionTitle(t: ResolvedTheme, text: string): HTMLElement {
  const el = document.createElement('div');
  Object.assign(el.style, {
    marginTop: '10px',
    marginBottom: '4px',
    fontSize: `${t.fontSize - 1}px`,
    fontWeight: '600',
    color: t.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  } satisfies Partial<CSSStyleDeclaration>);
  el.textContent = text;
  return el;
}

export function linkBtn(t: ResolvedTheme, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  Object.assign(b.style, {
    border: 'none',
    background: 'transparent',
    color: t.accent,
    cursor: 'pointer',
    padding: '0 4px 0 0',
    font: `${t.fontSize - 1}px ${t.fontSans}`,
  } satisfies Partial<CSSStyleDeclaration>);
  b.onclick = onClick;
  return b;
}

export interface ToolPanelColumnHost<TData> {
  theme: ResolvedTheme;
  headerLabel: (col: InternalColumn<TData>) => string;
}

export function columnEligibleForToolPanel<TData>(col: InternalColumn<TData>): boolean {
  return (
    !col.pivotResult &&
    col.colId !== 'ag-Grid-AutoColumn' &&
    col.colId !== 'ag-Grid-SelectionColumn' &&
    !col.def.suppressColumnsToolPanel
  );
}

export function filterEligibleForToolPanel<TData>(col: InternalColumn<TData>): boolean {
  return !col.pivotResult && !col.def.suppressFiltersToolPanel;
}

export function walkProvidedTree<TData>(
  roots: ProvidedColumnGroup<TData>[],
  visit: (node: ProvidedColumnGroup<TData> | InternalColumn<TData>, depth: number) => void,
  depth = 0,
): void {
  for (const root of roots) {
    const walk = (node: ProvidedColumnGroup<TData> | InternalColumn<TData>, d: number): void => {
      visit(node, d);
      if (!('colId' in node)) {
        for (const ch of node.children) walk(ch, d + 1);
      }
    };
    for (const ch of root.children) walk(ch, depth);
  }
}

export function collectGroupIds<TData>(roots: ProvidedColumnGroup<TData>[]): string[] {
  const ids: string[] = [];
  walkProvidedTree(roots, (node) => {
    if (!('colId' in node) && node.expandable) ids.push(node.groupId);
  });
  return ids;
}

/** All real (non-padding) group ids, regardless of header expandability. */
export function collectRealGroupIds<TData>(roots: ProvidedColumnGroup<TData>[]): string[] {
  const out: string[] = [];
  const walk = (g: ProvidedColumnGroup<TData>): void => {
    if (!g.padding) out.push(g.groupId);
    for (const ch of g.children) if (!('colId' in ch)) walk(ch);
  };
  for (const r of roots) walk(r);
  return out;
}

export function collectLeafColumnsFromDefs<TData>(defs: AnyColDef<TData>[]): string[] {
  const out: string[] = [];
  const walk = (items: AnyColDef<TData>[]): void => {
    for (const d of items) {
      if (isColGroup(d)) walk(d.children);
      else if (d.colId) out.push(d.colId);
      else if (d.field) out.push(d.field);
    }
  };
  walk(defs);
  return out;
}

export function makeDragGhost(t: ResolvedTheme, label: string): HTMLDivElement {
  const ghost = document.createElement('div');
  ghost.textContent = label;
  Object.assign(ghost.style, {
    position: 'fixed',
    zIndex: '10000',
    padding: '3px 10px',
    borderRadius: '3px',
    border: `1px solid ${t.accent}`,
    background: t.overlay,
    color: t.textPrimary,
    font: `${t.fontSize}px ${t.fontSans}`,
    pointerEvents: 'none',
    boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(ghost);
  return ghost;
}

export function chipZone<TData>(
  host: ToolPanelColumnHost<TData>,
  colIds: string[],
  getCol: (id: string) => InternalColumn<TData> | undefined,
  onRemove: (id: string) => void,
  zone: 'rowGroup' | 'values' | 'pivot',
  onDrop?: (colId: string, z: typeof zone) => void,
): HTMLElement {
  const t = host.theme;
  const el = document.createElement('div');
  el.dataset.dropZone = zone;
  const empty = colIds.length === 0;
  Object.assign(el.style, {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    // AG shows a tall dashed target with a centered hint while empty.
    minHeight: empty ? '48px' : '32px',
    padding: '6px',
    alignItems: 'center',
    justifyContent: empty ? 'center' : 'flex-start',
    alignContent: 'center',
    border: `1px dashed ${t.hairline}`,
    borderRadius: '2px',
    marginBottom: '8px',
    transition: 'background 0.1s',
  } satisfies Partial<CSSStyleDeclaration>);

  const setHighlight = (on: boolean): void => {
    el.style.background = on ? withAlpha(t.accent, 0.12) : 'transparent';
    el.style.borderColor = on ? t.accent : t.hairline;
  };
  el.addEventListener('mouseenter', () => {
    if (document.body.dataset.tabularToolDrag) setHighlight(true);
  });
  el.addEventListener('mouseleave', () => setHighlight(false));

  if (empty) {
    const hint = document.createElement('span');
    // AG wording per zone.
    hint.textContent =
      zone === 'rowGroup'
        ? 'Drag here to set row groups'
        : zone === 'values'
          ? 'Drag here to aggregate'
          : 'Drag here to set column labels';
    Object.assign(hint.style, {
      color: t.textTertiary,
      fontSize: `${t.fontSize - 1}px`,
      pointerEvents: 'none',
      textAlign: 'center',
    } satisfies Partial<CSSStyleDeclaration>);
    el.appendChild(hint);
  }

  for (const id of colIds) {
    const col = getCol(id);
    if (!col) continue;
    const chip = document.createElement('span');
    Object.assign(chip.style, {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '2px 6px',
      background: withAlpha(t.accent, 0.18),
      color: t.textPrimary,
      borderRadius: '2px',
      fontSize: `${t.fontSize - 1}px`,
    } satisfies Partial<CSSStyleDeclaration>);
    chip.appendChild(document.createTextNode(host.headerLabel(col)));
    const x = document.createElement('button');
    x.type = 'button';
    x.innerHTML = iconSvg('x', 12);
    Object.assign(x.style, {
      border: 'none',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      padding: '0',
      display: 'flex',
    } satisfies Partial<CSSStyleDeclaration>);
    x.onclick = () => onRemove(id);
    chip.appendChild(x);
    el.appendChild(chip);
  }

  if (onDrop) {
    el.addEventListener('mouseup', (e) => {
      const dragId = document.body.dataset.tabularToolDrag;
      if (!dragId) return;
      const zone = resolveDropZone(e.clientX, e.clientY, el.closest('.tabular-side-bar') ?? el);
      if (zone === el.dataset.dropZone) onDrop(dragId, zone);
    });
  }
  return el;
}

export function colIdFromDef(def: { colId?: string; field?: string }): string | undefined {
  return def.colId ?? def.field;
}

export function columnEnablePivot<TData>(
  col: InternalColumn<TData>,
  defaultColDef?: { enablePivot?: boolean },
): boolean {
  if (col.def.enablePivot === true) return true;
  if (col.def.enablePivot === false) return false;
  return defaultColDef?.enablePivot === true;
}

export function columnEnableRowGroup<TData>(
  col: InternalColumn<TData>,
  defaultColDef?: { enableRowGroup?: boolean },
): boolean {
  if (col.def.enableRowGroup === true) return true;
  if (col.def.enableRowGroup === false) return false;
  return defaultColDef?.enableRowGroup === true;
}

export function columnEnableValue<TData>(
  col: InternalColumn<TData>,
  defaultColDef?: { enableValue?: boolean },
): boolean {
  if (col.def.enableValue === false) return false;
  if (col.def.enableValue === true || col.def.type === 'number' || col.def.aggFunc != null) return true;
  return defaultColDef?.enableValue === true;
}

export function resolveDropZone(
  clientX: number,
  clientY: number,
  root: HTMLElement,
): 'rowGroup' | 'values' | 'pivot' | null {
  const el = document.elementFromPoint(clientX, clientY)?.closest('[data-drop-zone]');
  if (!el || !root.contains(el)) return null;
  const zone = (el as HTMLElement).dataset.dropZone;
  if (zone === 'rowGroup' || zone === 'values' || zone === 'pivot') return zone;
  return null;
}

export function startColumnDrag(
  colId: string,
  label: string,
  t: ResolvedTheme,
  startEvent: MouseEvent,
  onEnd: (colId: string, clientX: number, clientY: number) => void,
): void {
  document.body.dataset.tabularToolDrag = colId;
  const ghost = makeDragGhost(t, label);
  let lastX = startEvent.clientX;
  let lastY = startEvent.clientY;
  ghost.style.left = `${lastX + 10}px`;
  ghost.style.top = `${lastY + 10}px`;
  const move = (e: MouseEvent): void => {
    lastX = e.clientX;
    lastY = e.clientY;
    ghost.style.left = `${e.clientX + 10}px`;
    ghost.style.top = `${e.clientY + 10}px`;
  };
  const up = (): void => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    delete document.body.dataset.tabularToolDrag;
    ghost.remove();
    document.body.style.cursor = '';
    onEnd(colId, lastX, lastY);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
  document.body.style.cursor = 'grabbing';
}
