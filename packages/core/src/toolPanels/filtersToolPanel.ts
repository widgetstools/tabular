import type { ColumnModel, InternalColumn } from '../columnModel';
import type { ProvidedColumnGroup } from '../columnGroups';
import type { Tabular } from '../grid';
import { formatFilterDisplay, parseFloatingFilterInput, resolveFilterKind } from '../filters';
import { SET_FILTER_BLANKS } from '../filters';
import type { ColumnFilter, FiltersToolPanelParams, GridOptions } from '../types';
import { isColGroup } from '../columnGroups';
import { withAlpha } from '../theme';
import {
  chipBtnStyle,
  colIdFromDef,
  collectRealGroupIds,
  filterEligibleForToolPanel,
  inputStyle,
} from './shared';

export interface FiltersToolPanelHost<TData> {
  theme: import('../theme').ResolvedTheme;
  api: Tabular<TData>;
  cols: ColumnModel<TData>;
  options: GridOptions<TData>;
  headerLabel: (col: InternalColumn<TData>) => string;
  getDistinctValues: (colId: string) => string[];
  rerender: () => void;
}

export interface FiltersToolPanelApi {
  refresh: () => void;
  setFilterLayout(_colDefs: unknown[]): void;
  expandFilterGroups(groupIds?: string[]): void;
  collapseFilterGroups(groupIds?: string[]): void;
  expandFilters(colIds?: string[]): void;
  collapseFilters(colIds?: string[]): void;
  syncLayoutWithGrid(): void;
}

export interface FiltersToolPanelState {
  expandedCols: Set<string>;
  expandedGroups: Set<string>;
  search: string;
  /** Column groups start expanded (AG default); set after first seeding. */
  seededGroups?: boolean;
}

export function createFiltersToolPanelApi<TData>(
  host: FiltersToolPanelHost<TData>,
  state: { expandedCols: Set<string>; expandedGroups: Set<string> },
): FiltersToolPanelApi {
  return {
    refresh: () => host.rerender(),
    setFilterLayout: () => {
      /* canvas grid: filter layout follows columnDefs */
    },
    expandFilters: (colIds) => {
      const cols = colIds ?? filterColumns(host).map((c) => c.colId);
      for (const id of cols) state.expandedCols.add(id);
      host.rerender();
    },
    collapseFilters: (colIds) => {
      if (colIds) for (const id of colIds) state.expandedCols.delete(id);
      else state.expandedCols.clear();
      host.rerender();
    },
    expandFilterGroups: (groupIds) => {
      const ids = groupIds ?? collectRealGroupIds(host.cols.providedRoots);
      for (const id of ids) state.expandedGroups.add(id);
      host.rerender();
    },
    collapseFilterGroups: (groupIds) => {
      if (groupIds) for (const id of groupIds) state.expandedGroups.delete(id);
      else state.expandedGroups.clear();
      host.rerender();
    },
    syncLayoutWithGrid: () => host.rerender(),
  };
}

function filterColumns<TData>(host: FiltersToolPanelHost<TData>): InternalColumn<TData>[] {
  const def = host.options.defaultColDef;
  return host.cols.all.filter((c) => filterEligibleForToolPanel(c) && resolveFilterKind(c, def) !== false);
}

export function renderFiltersToolPanel<TData>(
  host: FiltersToolPanelHost<TData>,
  body: HTMLElement,
  params: FiltersToolPanelParams | undefined,
  state: FiltersToolPanelState,
): void {
  const t = host.theme;
  const api = host.api;
  const model = api.getFilterModel();
  const q = state.search.trim().toLowerCase();

  if (!state.seededGroups) {
    state.seededGroups = true;
    for (const id of collectRealGroupIds(host.cols.providedRoots)) state.expandedGroups.add(id);
  }

  // AG layout: a collapse/expand-all chevron sits left of the search box.
  const topRow = document.createElement('div');
  Object.assign(topRow.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginBottom: '8px',
  } satisfies Partial<CSSStyleDeclaration>);

  if (!params?.suppressExpandAll) {
    const anyExpanded = state.expandedCols.size > 0 || state.expandedGroups.size > 0;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.title = anyExpanded ? 'Collapse All' : 'Expand All';
    toggle.textContent = anyExpanded ? '▾' : '▸';
    Object.assign(toggle.style, {
      border: 'none',
      background: 'transparent',
      color: t.textSecondary,
      cursor: 'pointer',
      padding: '0 2px',
      font: `${t.fontSize}px ${t.fontSans}`,
      flex: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    toggle.onclick = () => {
      if (anyExpanded) {
        state.expandedCols.clear();
        state.expandedGroups.clear();
      } else {
        for (const c of filterColumns(host)) state.expandedCols.add(c.colId);
        for (const id of collectRealGroupIds(host.cols.providedRoots)) state.expandedGroups.add(id);
      }
      host.rerender();
    };
    topRow.appendChild(toggle);
  }

  if (!params?.suppressFilterSearch) {
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Search...';
    search.value = state.search;
    Object.assign(search.style, inputStyle(t));
    search.style.flex = '1';
    search.style.minWidth = '0';
    search.oninput = () => {
      state.search = search.value;
      host.rerender();
    };
    search.onkeydown = (e) => e.stopPropagation();
    topRow.appendChild(search);
  }
  if (topRow.childElementCount) body.appendChild(topRow);

  const matches = (col: InternalColumn<TData>): boolean =>
    !q || host.headerLabel(col).toLowerCase().includes(q);

  const renderFilter = (col: InternalColumn<TData>, depth = 0): void => {
    if (!matches(col)) return;
    const colId = col.colId;
    const active = !!model[colId];
    const expanded = state.expandedCols.has(colId);
    const kind = resolveFilterKind(col, host.options.defaultColDef);

    const head = document.createElement('button');
    head.type = 'button';
    Object.assign(head.style, {
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: `5px 2px 5px ${depth * 12 + 2}px`,
      border: 'none',
      background: expanded ? withAlpha(t.accent, 0.08) : 'transparent',
      color: t.textPrimary,
      cursor: 'pointer',
      textAlign: 'left',
      font: `${t.fontSize}px ${t.fontSans}`,
    } satisfies Partial<CSSStyleDeclaration>);
    // AG puts the expand chevron before the label.
    const chev = document.createElement('span');
    chev.textContent = expanded ? '▾' : '▸';
    chev.style.color = t.textTertiary;
    chev.style.width = '12px';
    chev.style.flex = 'none';
    head.appendChild(chev);
    const label = document.createElement('span');
    label.textContent = host.headerLabel(col);
    label.style.flex = '1';
    head.appendChild(label);
    if (active) {
      const icon = document.createElement('span');
      icon.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${t.accent}" stroke-width="2"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></svg>`;
      head.appendChild(icon);
    }
    head.onclick = () => {
      if (expanded) state.expandedCols.delete(colId);
      else state.expandedCols.add(colId);
      host.rerender();
    };
    body.appendChild(head);

    if (!expanded) return;

    const editor = document.createElement('div');
    Object.assign(editor.style, {
      padding: '4px 8px 12px',
      borderBottom: `1px solid ${t.hairline}`,
    } satisfies Partial<CSSStyleDeclaration>);

    if (kind === 'set') renderSetFilter(host, editor, col, model[colId]);
    else if (kind === 'text' || kind === 'number')
      renderTextNumberFilter(host, editor, col, kind, model[colId]);

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Reset';
    Object.assign(clear.style, { ...chipBtnStyle(t), marginTop: '6px' });
    clear.onclick = () => {
      api.setColumnFilter(colId, null);
      host.rerender();
    };
    editor.appendChild(clear);
    body.appendChild(editor);
  };

  const renderGroup = (group: ProvidedColumnGroup<TData>, depth: number): void => {
    // Padding groups from tree balancing render their children transparently.
    if (group.padding) {
      for (const ch of group.children) {
        if ('colId' in ch) renderFilter(ch, depth);
        else renderGroup(ch, depth);
      }
      return;
    }
    const hasFilter = group.children.some((ch) => {
      if ('colId' in ch) return filterEligibleForToolPanel(ch) && matches(ch);
      return subtreeHasMatch(host, ch, q);
    });
    if (!hasFilter && q) return;

    const expanded = state.expandedGroups.has(group.groupId);
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: `5px 2px 5px ${depth * 12}px`,
      color: t.textPrimary,
      cursor: 'pointer',
    } satisfies Partial<CSSStyleDeclaration>);
    const chev = document.createElement('span');
    chev.textContent = expanded ? '▾' : '▸';
    chev.style.color = t.textTertiary;
    chev.style.width = '12px';
    chev.style.flex = 'none';
    row.appendChild(chev);
    row.appendChild(document.createTextNode(group.headerName));
    row.onclick = () => {
      if (expanded) state.expandedGroups.delete(group.groupId);
      else state.expandedGroups.add(group.groupId);
      host.rerender();
    };
    body.appendChild(row);
    if (expanded) {
      for (const ch of group.children) {
        if ('colId' in ch) renderFilter(ch, depth + 1);
        else renderGroup(ch, depth + 1);
      }
    }
  };

  let groupIdx = 0;
  let any = false;
  for (const def of host.cols.sourceColumnDefs()) {
    if (isColGroup(def)) {
      const group = host.cols.providedRoots[groupIdx++];
      if (group) {
        renderGroup(group, 0);
        any = true;
      }
    } else {
      const id = colIdFromDef(def);
      if (id) {
        const col = host.cols.getColumn(id);
        if (col && matches(col) && filterEligibleForToolPanel(col)) {
          renderFilter(col);
          any = true;
        }
      }
    }
  }
  if (!any) {
    for (const col of filterColumns(host)) {
      renderFilter(col);
    }
  }
}

function subtreeHasMatch<TData>(
  host: FiltersToolPanelHost<TData>,
  group: ProvidedColumnGroup<TData>,
  q: string,
): boolean {
  for (const ch of group.children) {
    if ('colId' in ch) {
      if (filterEligibleForToolPanel(ch) && (!q || host.headerLabel(ch).toLowerCase().includes(q))) return true;
    } else if (subtreeHasMatch(host, ch, q)) return true;
  }
  return false;
}

function renderTextNumberFilter<TData>(
  host: FiltersToolPanelHost<TData>,
  editor: HTMLElement,
  col: InternalColumn<TData>,
  kind: 'text' | 'number',
  existing?: ColumnFilter,
): void {
  const t = host.theme;
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = kind === 'number' ? 'e.g. >100, 50-200' : 'Contains…';
  input.value = formatFilterDisplay(existing);
  Object.assign(input.style, inputStyle(t));
  input.onkeydown = (e) => e.stopPropagation();
  const apply = (): void => {
    const filter = parseFloatingFilterInput(input.value, kind);
    host.api.setColumnFilter(col.colId, filter);
  };
  input.onchange = apply;
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') apply();
  };
  editor.appendChild(input);
}

function renderSetFilter<TData>(
  host: FiltersToolPanelHost<TData>,
  editor: HTMLElement,
  col: InternalColumn<TData>,
  existing?: ColumnFilter,
): void {
  const t = host.theme;
  const values = host.getDistinctValues(col.colId);
  const selected =
    existing?.type === 'set' ? new Set(existing.values) : new Set(values);

  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Search values…';
  Object.assign(search.style, { ...inputStyle(t), marginBottom: '6px' });
  search.onkeydown = (e) => e.stopPropagation();
  editor.appendChild(search);

  const list = document.createElement('div');
  Object.assign(list.style, {
    maxHeight: '160px',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  } satisfies Partial<CSSStyleDeclaration>);

  const apply = (): void => {
    if (selected.size === values.length) host.api.setColumnFilter(col.colId, null);
    else {
      host.api.setColumnFilter(col.colId, {
        type: 'set',
        values: values.filter((v) => selected.has(v)),
      });
    }
  };

  const paint = (): void => {
    list.replaceChildren();
    const q = search.value.trim().toLowerCase();
    const mk = (label: string, checked: boolean, toggle: (on: boolean) => void): void => {
      if (q && !label.toLowerCase().includes(q)) return;
      const row = document.createElement('label');
      Object.assign(row.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '2px 0',
        cursor: 'pointer',
        fontSize: `${t.fontSize - 1}px`,
      } satisfies Partial<CSSStyleDeclaration>);
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      cb.style.accentColor = t.accent;
      cb.onchange = () => toggle(cb.checked);
      row.appendChild(cb);
      row.appendChild(document.createTextNode(label));
      list.appendChild(row);
    };
    mk('(Select All)', selected.size === values.length, (on) => {
      if (on) for (const v of values) selected.add(v);
      else selected.clear();
      apply();
      paint();
    });
    for (const v of values) {
      mk(v === SET_FILTER_BLANKS ? '(Blanks)' : v, selected.has(v), (on) => {
        if (on) selected.add(v);
        else selected.delete(v);
        apply();
        paint();
      });
    }
  };
  search.oninput = paint;
  paint();
  editor.appendChild(list);
}
