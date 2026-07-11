/**
 * Ribbon column-config popover — FILTER / GROUPING / AGGREGATION / BEHAVIOR.
 * Patches ColDefs via setColumnDefs (no editColumn / templates). Pinning uses
 * setColumnsPinned when available. Every edit applies to all target colIds
 * immediately; the popover stays open for more edits.
 */
import type { AnyColDef, ColDef, ResolvedTheme, Tabular } from '@tabular/core';
import {
  leafColId,
  mapLeafCols,
  resolveTargetColIds,
  walkLeafCols,
} from './columnFormat';
import { ICON, menu, svg } from './ui';

export { resolveTargetColIds };

export type AggFuncChoice = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'first' | 'last';
export const AGG_FUNCS: readonly AggFuncChoice[] = [
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'first',
  'last',
];

export interface ColumnPanelHost {
  api: Tabular<any>;
  targetCols(): string[];
  onApplied(): void;
  getTheme(): ResolvedTheme;
}

type FlagKey =
  | 'floatingFilter'
  | 'filter'
  | 'enableRowGroup'
  | 'enablePivot'
  | 'sortable'
  | 'resizable'
  | 'editable'
  | 'hide'
  | 'aggFunc'
  | 'suppressAggFuncInHeader';

const FLAG_DEFAULTS: Partial<Record<FlagKey, unknown>> = {
  sortable: true,
  resizable: true,
  enableRowGroup: false,
  enablePivot: false,
  hide: false,
  editable: false,
  floatingFilter: false,
};

/** ColDef keys that exist on Tabular's ColDef (skip controls for missing ones). */
const COL_DEF_HAS: Record<string, boolean> = {
  floatingFilter: true,
  filter: true,
  enableRowGroup: true,
  enablePivot: true,
  sortable: true,
  resizable: true,
  editable: true,
  hide: true,
  aggFunc: true,
  // GridOptions only in Tabular — not a ColDef field
  suppressAggFuncInHeader: false,
};

function baseDefOf(api: Tabular<any>, colId: string): ColDef<any> | undefined {
  let hit: ColDef<any> | undefined;
  walkLeafCols(api.getGridOption('columnDefs') as AnyColDef<any>[] | undefined, (c) => {
    if (leafColId(c) === colId) hit = c;
  });
  return hit;
}

function defaultColValue(api: Tabular<any>, key: FlagKey): unknown {
  const d = api.getGridOption('defaultColDef') as ColDef<any> | undefined;
  if (!d) return undefined;
  return (d as Record<string, unknown>)[key];
}

/** ColDef → defaultColDef → per-key default (plus grid floatingFilter). */
function effectiveFlag(api: Tabular<any>, colId: string, key: FlagKey): unknown {
  const base = baseDefOf(api, colId) as Record<string, unknown> | undefined;
  if (base && base[key] !== undefined) {
    const v = base[key];
    // editable may be a callback — treat as on for the switch
    if (key === 'editable' && typeof v === 'function') return true;
    return v;
  }
  const chained = defaultColValue(api, key);
  if (chained !== undefined) {
    if (key === 'editable' && typeof chained === 'function') return true;
    return chained;
  }
  if (key === 'floatingFilter') {
    return api.getGridOption('floatingFilter') === true;
  }
  if (key === 'hide') {
    const st = api.getColumnState().find((s) => s.colId === colId);
    if (st?.hide !== undefined) return st.hide;
  }
  return FLAG_DEFAULTS[key];
}

function mixedValue(
  api: Tabular<any>,
  cols: string[],
  key: FlagKey,
): { value: unknown; mixed: boolean } {
  const values = cols.map((c) => effectiveFlag(api, c, key));
  const first = values[0];
  return values.every((v) => v === first) ? { value: first, mixed: false } : { value: undefined, mixed: true };
}

function patchCols(
  api: Tabular<any>,
  colIds: string[],
  patch: (col: ColDef<any>) => ColDef<any>,
): void {
  const defs = api.getGridOption('columnDefs') as AnyColDef<any>[] | undefined;
  if (!defs?.length) return;
  api.setColumnDefs(mapLeafCols(defs, new Set(colIds), patch));
}

export function columnPanelMenu(
  anchor: HTMLElement,
  host: ColumnPanelHost,
): { toggle(): void; destroy(): void } {
  injectColumnPanelStyles();
  let onKeyDoc: ((e: KeyboardEvent) => void) | null = null;
  const detachKey = (): void => {
    if (onKeyDoc) {
      document.removeEventListener('keydown', onKeyDoc);
      onKeyDoc = null;
    }
  };
  const m = menu(
    anchor,
    host.getTheme(),
    (close) => {
      const wrappedClose = (): void => {
        detachKey();
        close();
      };
      const panel = buildPanel(host, wrappedClose);
      onKeyDoc = (e) => {
        if (e.key === 'Escape') wrappedClose();
      };
      document.addEventListener('keydown', onKeyDoc);
      return panel;
    },
    { align: 'left', className: 'tx-colpanel' },
  );
  return {
    toggle: m.toggle,
    destroy: () => {
      detachKey();
      m.destroy();
    },
  };
}

function buildPanel(host: ColumnPanelHost, close: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tx-colpanel-body';
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  if (host.targetCols().length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tx-colpanel-empty';
    empty.innerHTML = `${svg(ICON.columns, 14)}<span>Select a cell or column first.</span>`;
    el.append(empty);
    return el;
  }
  renderSections(el, host);
  return el;
}

function switchRow(
  key: string,
  label: string,
  state: { value: unknown; mixed: boolean },
  onToggle: (next: boolean) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tx-colpanel-row';
  row.dataset.k = key;
  const lab = document.createElement('span');
  lab.className = 'tx-colpanel-label';
  lab.textContent = label;
  const sw = document.createElement('button');
  sw.type = 'button';
  sw.className = 'tx-colpanel-switch' + (state.mixed ? ' is-mixed' : '');
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', state.mixed ? 'mixed' : String(!!state.value));
  sw.innerHTML = '<span class="tx-colpanel-knob"></span>';
  sw.addEventListener('click', () => onToggle(state.mixed ? true : !state.value));
  row.append(lab, sw);
  return row;
}

function segRow(
  key: string,
  label: string,
  options: Array<{ v: string; text: string }>,
  active: string | undefined,
  onPick: (v: string) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tx-colpanel-row';
  row.dataset.k = key;
  const lab = document.createElement('span');
  lab.className = 'tx-colpanel-label';
  lab.textContent = label;
  const seg = document.createElement('span');
  seg.className = 'tx-colpanel-seg';
  for (const opt of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.v = opt.v;
    b.textContent = opt.text;
    b.classList.toggle('is-on', opt.v === active);
    b.addEventListener('click', () => onPick(opt.v));
    seg.append(b);
  }
  row.append(lab, seg);
  return row;
}

function sectionCaps(text: string): HTMLElement {
  const h = document.createElement('div');
  h.className = 'tx-colpanel-caps';
  h.textContent = text;
  return h;
}

function renderSections(el: HTMLElement, host: ColumnPanelHost): void {
  const { api } = host;
  const cols = host.targetCols();
  const rerender = () => {
    el.querySelectorAll('.tx-colpanel-caps, .tx-colpanel-row').forEach((n) => n.remove());
    renderSections(el, host);
  };

  /** Run a batched patch over all targets; error-tints the row on throw. */
  const applyPatch = (
    row: HTMLElement,
    patch: (col: ColDef<any>) => ColDef<any>,
  ): void => {
    row.classList.remove('is-error');
    row.removeAttribute('title');
    try {
      patchCols(api, cols, patch);
      host.onApplied();
      rerender();
    } catch (err) {
      row.classList.add('is-error');
      row.title = err instanceof Error ? err.message : String(err);
      host.onApplied();
    }
  };

  const flagSwitch = (key: FlagKey, label: string): HTMLElement | null => {
    if (!COL_DEF_HAS[key]) return null;
    const state = mixedValue(api, cols, key);
    const row = switchRow(key, label, state, (next) => {
      applyPatch(row, (col) => ({ ...col, [key]: next }));
    });
    return row;
  };

  // ── FILTER ──
  el.append(sectionCaps('FILTER'));
  {
    const row = flagSwitch('floatingFilter', 'Floating filter');
    if (row) el.append(row);
  }
  if (COL_DEF_HAS.filter) {
    const state = mixedValue(api, cols, 'filter');
    let active: string | undefined;
    if (!state.mixed) {
      if (state.value === true || state.value == null) active = 'true';
      else if (state.value === false) active = undefined;
      else active = String(state.value);
    }
    const row = segRow(
      'filter',
      'Filter type',
      [
        { v: 'true', text: 'Auto' },
        { v: 'text', text: 'Text' },
        { v: 'number', text: 'Num' },
        { v: 'date', text: 'Date' },
        { v: 'set', text: 'Set' },
      ],
      active,
      (v) => {
        applyPatch(row, (col) => ({
          ...col,
          filter: v === 'true' ? true : (v as 'text' | 'number' | 'set' | 'date'),
        }));
      },
    );
    el.append(row);
  }

  // ── GROUPING ──
  el.append(sectionCaps('GROUPING'));
  {
    const g = flagSwitch('enableRowGroup', 'Groupable');
    if (g) el.append(g);
    const p = flagSwitch('enablePivot', 'Pivotable');
    if (p) el.append(p);
  }

  // ── AGGREGATION ──
  el.append(sectionCaps('AGGREGATION'));
  if (COL_DEF_HAS.aggFunc) {
    const aggOf = (colId: string): string | undefined => {
      const v = effectiveFlag(api, colId, 'aggFunc');
      if (typeof v === 'string') return v;
      if (typeof v === 'function') return 'func';
      return undefined;
    };
    const aggs = cols.map(aggOf);
    const mixed = !aggs.every((a) => a === aggs[0]);
    const current = mixed ? '' : (aggs[0] ?? 'none');
    const row = document.createElement('div');
    row.className = 'tx-colpanel-row';
    row.dataset.k = 'aggFunc';
    const lab = document.createElement('span');
    lab.className = 'tx-colpanel-label';
    lab.textContent = 'Function';
    const sel = document.createElement('select');
    sel.className = 'tx-colpanel-select';
    for (const v of ['none', ...AGG_FUNCS]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v === 'none' ? 'None' : v;
      sel.append(o);
    }
    if (mixed) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '(mixed)';
      o.disabled = true;
      sel.prepend(o);
    }
    sel.value = current === 'func' ? '' : current;
    if (current === 'func' && !mixed) {
      const o = document.createElement('option');
      o.value = 'func';
      o.textContent = '(custom)';
      o.disabled = true;
      sel.append(o);
      sel.value = 'func';
    }
    sel.addEventListener('change', () => {
      const v = sel.value;
      applyPatch(row, (col) => {
        const next = { ...col };
        if (v === 'none') delete next.aggFunc;
        else next.aggFunc = v as AggFuncChoice;
        return next;
      });
    });
    row.append(lab, sel);
    el.append(row);

    // suppressAggFuncInHeader is GridOptions-only in Tabular — skip unless ColDef has it
    if (COL_DEF_HAS.suppressAggFuncInHeader) {
      const anyAgg = cols.some((c) => aggOf(c) !== undefined);
      const supState = mixedValue(api, cols, 'suppressAggFuncInHeader');
      const shown = {
        value: supState.mixed ? undefined : !(supState.value as boolean),
        mixed: supState.mixed,
      };
      const hdrRow = switchRow('aggHeader', 'Show in header', shown, (next) => {
        applyPatch(hdrRow, (col) => ({
          ...col,
          ...( { suppressAggFuncInHeader: !next } as Partial<ColDef<any>> ),
        }));
      });
      const hdrSwitch = hdrRow.querySelector<HTMLButtonElement>('.tx-colpanel-switch')!;
      hdrSwitch.disabled = !anyAgg;
      el.append(hdrRow);
    }
  }

  // ── BEHAVIOR ──
  el.append(sectionCaps('BEHAVIOR'));
  {
    const s = flagSwitch('sortable', 'Sortable');
    if (s) el.append(s);
    const r = flagSwitch('resizable', 'Resizable');
    if (r) el.append(r);
    const e = flagSwitch('editable', 'Editable');
    if (e) el.append(e);
  }

  // Pin — prefer setColumnsPinned, else applyColumnState
  {
    const hasSetPinned = typeof api.setColumnsPinned === 'function';
    const hasApplyState = typeof api.applyColumnState === 'function';
    if (hasSetPinned || hasApplyState) {
      const states = cols.map(
        (c) => api.getColumnState().find((s) => s.colId === c)?.pinned ?? null,
      );
      const mixed = !states.every((s) => s === states[0]);
      const active = mixed ? undefined : (states[0] ?? null) === null ? 'none' : String(states[0]);
      const row = segRow(
        'pinned',
        'Pinned',
        [
          { v: 'left', text: 'Left' },
          { v: 'none', text: '–' },
          { v: 'right', text: 'Right' },
        ],
        active,
        (v) => {
          row.classList.remove('is-error');
          row.removeAttribute('title');
          let errored = false;
          const pinned = v === 'none' ? null : (v as 'left' | 'right');
          try {
            if (hasSetPinned) api.setColumnsPinned(cols, pinned);
            else {
              api.applyColumnState(cols.map((colId) => ({ colId, pinned })));
            }
          } catch (err) {
            errored = true;
            row.classList.add('is-error');
            row.title = err instanceof Error ? err.message : String(err);
          }
          host.onApplied();
          if (!errored) rerender();
        },
      );
      el.append(row);
    }
  }

  {
    const h = flagSwitch('hide', 'Hidden');
    if (h) el.append(h);
  }
}

export function injectColumnPanelStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById('tx-colpanel-styles')) return;
  const style = document.createElement('style');
  style.id = 'tx-colpanel-styles';
  style.textContent = COL_CSS;
  document.head.appendChild(style);
}

const COL_CSS = `
.tx-menu.tx-colpanel {
  width: 300px;
  padding: 8px 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tx-colpanel-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tx-colpanel-caps {
  padding: 8px 2px 4px;
  font: 650 10px / 1 var(--tx-font-mono);
  letter-spacing: 0.08em;
  color: var(--tx-faint);
  text-transform: uppercase;
}
.tx-colpanel-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 5px 4px;
  border-radius: var(--tx-radius, 2px);
}
.tx-colpanel-row:hover {
  background: color-mix(in srgb, var(--tx-fg) 5%, transparent);
}
.tx-colpanel-label {
  font: var(--tx-fs-sm) / 1.3 var(--tx-font-sans);
  color: var(--tx-fg);
}
.tx-colpanel-switch {
  appearance: none;
  width: 30px;
  height: 17px;
  border-radius: 9px;
  position: relative;
  border: 1px solid var(--tx-hairline);
  background: var(--tx-sunken);
  cursor: pointer;
  flex: 0 0 auto;
  transition: background 120ms ease, border-color 120ms ease;
}
.tx-colpanel-switch[aria-checked="true"] {
  background: color-mix(in srgb, var(--tx-accent) 55%, transparent);
  border-color: var(--tx-accent);
}
.tx-colpanel-knob {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--tx-fg);
  transition: left 120ms ease;
}
.tx-colpanel-switch[aria-checked="true"] .tx-colpanel-knob { left: 14px; }
.tx-colpanel-switch.is-mixed { border-style: dashed; }
.tx-colpanel-switch.is-mixed .tx-colpanel-knob { left: 7.5px; opacity: 0.6; }
.tx-colpanel-switch:focus-visible {
  outline: 1px solid var(--tx-accent);
  outline-offset: 1px;
}
.tx-colpanel-switch:disabled {
  opacity: 0.4;
  cursor: default;
}
.tx-colpanel-seg { display: inline-flex; gap: 2px; flex-wrap: wrap; justify-content: flex-end; }
.tx-colpanel-seg > button {
  appearance: none;
  height: 22px;
  padding: 0 7px;
  border-radius: var(--tx-radius, 2px);
  border: 1px solid var(--tx-hairline);
  background: transparent;
  color: var(--tx-muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.tx-colpanel-seg > button.is-on {
  color: var(--tx-accent);
  border-color: var(--tx-accent);
  background: color-mix(in srgb, var(--tx-accent) 12%, transparent);
}
.tx-colpanel-row.is-error {
  box-shadow: inset 0 0 0 1px var(--tx-down);
}
.tx-colpanel-select {
  height: 24px;
  padding: 0 6px;
  border-radius: var(--tx-radius, 2px);
  border: 1px solid var(--tx-hairline);
  background: var(--tx-sunken);
  color: var(--tx-fg);
  font: var(--tx-fs-sm) var(--tx-font-sans);
}
.tx-colpanel-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 18px 10px;
  font: var(--tx-fs-sm) var(--tx-font-sans);
  color: var(--tx-faint);
}
`;
