import type { ColumnModel, InternalColumn } from '../columnModel';
import type { ProvidedColumnGroup } from '../columnGroups';
import type { Tabular } from '../grid';
import type { AnyColDef, ColumnsToolPanelParams, GridOptions } from '../types';
import { isColGroup } from '../columnGroups';
import { withAlpha } from '../theme';
import {
  chipZone,
  colIdFromDef,
  columnEligibleForToolPanel,
  columnEnablePivot,
  columnEnableRowGroup,
  columnEnableValue,
  collectRealGroupIds,
  inputStyle,
  resolveDropZone,
  startColumnDrag,
} from './shared';

export interface ColumnsToolPanelHost<TData> {
  theme: import('../theme').ResolvedTheme;
  api: Tabular<TData>;
  cols: ColumnModel<TData>;
  options: GridOptions<TData>;
  headerLabel: (col: InternalColumn<TData>) => string;
  refreshPanels: () => void;
  rerender: () => void;
}

export interface ColumnToolPanelApi {
  refresh: () => void;
  expandColumnGroups(groupIds?: string[]): void;
  collapseColumnGroups(groupIds?: string[]): void;
  setColumnLayout(_colDefs: AnyColDef<unknown>[]): void;
  syncLayoutWithGrid(): void;
  setPivotModeSectionVisible(visible: boolean): void;
  setRowGroupsSectionVisible(visible: boolean): void;
  setValuesSectionVisible(visible: boolean): void;
  setPivotSectionVisible(visible: boolean): void;
}

export interface ColumnToolPanelRuntime {
  pivotModeVisible: boolean;
  rowGroupsVisible: boolean;
  valuesVisible: boolean;
  pivotVisible: boolean;
  /** Tree filter text (AG columns panel search box). */
  search?: string;
  /** Panel-local collapsed tree groups (independent of header group state). */
  collapsedGroups?: Set<string>;
}

export function createColumnToolPanelApi<TData>(
  host: ColumnsToolPanelHost<TData>,
  runtime: ColumnToolPanelRuntime,
): ColumnToolPanelApi {
  return {
    refresh: () => host.rerender(),
    // AG semantics: these control the panel tree, not the header groups.
    expandColumnGroups: (groupIds) => {
      const set = (runtime.collapsedGroups ??= new Set<string>());
      if (!groupIds) set.clear();
      else for (const id of groupIds) set.delete(id);
      host.rerender();
    },
    collapseColumnGroups: (groupIds) => {
      const set = (runtime.collapsedGroups ??= new Set<string>());
      const ids = groupIds ?? collectRealGroupIds(host.cols.providedRoots);
      for (const id of ids) set.add(id);
      host.rerender();
    },
    setColumnLayout: () => {
      /* canvas grid: column layout is driven by columnDefs */
    },
    syncLayoutWithGrid: () => host.rerender(),
    setPivotModeSectionVisible: (visible) => {
      runtime.pivotModeVisible = visible;
      host.rerender();
    },
    setRowGroupsSectionVisible: (visible) => {
      runtime.rowGroupsVisible = visible;
      host.rerender();
    },
    setValuesSectionVisible: (visible) => {
      runtime.valuesVisible = visible;
      host.rerender();
    },
    setPivotSectionVisible: (visible) => {
      runtime.pivotVisible = visible;
      host.rerender();
    },
  };
}

export function renderColumnsToolPanel<TData>(
  host: ColumnsToolPanelHost<TData>,
  body: HTMLElement,
  params: ColumnsToolPanelParams | undefined,
  runtime: ColumnToolPanelRuntime,
): void {
  const t = host.theme;
  const api = host.api;
  // AG parity: the panel switches to pivot semantics when pivot MODE is on,
  // even before any pivot/value columns are chosen.
  const pivotOn = host.cols.pivotMode;

  // ── Pivot Mode toggle switch (AG panel header strip) ────────────────
  if (!params?.suppressPivotMode && runtime.pivotModeVisible) {
    const pivotRow = document.createElement('label');
    Object.assign(pivotRow.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      margin: '-2px -4px 6px',
      padding: '4px 4px 8px',
      borderBottom: `1px solid ${t.hairline}`,
      cursor: 'pointer',
      color: t.textPrimary,
      fontWeight: '500',
    } satisfies Partial<CSSStyleDeclaration>);
    const track = document.createElement('span');
    Object.assign(track.style, {
      position: 'relative',
      width: '28px',
      height: '16px',
      borderRadius: '8px',
      background: pivotOn ? t.accent : withAlpha(t.textSecondary, 0.35),
      transition: 'background 0.15s',
      flex: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    const knob = document.createElement('span');
    Object.assign(knob.style, {
      position: 'absolute',
      top: '2px',
      left: pivotOn ? '14px' : '2px',
      width: '12px',
      height: '12px',
      borderRadius: '50%',
      background: t.base,
      transition: 'left 0.15s',
    } satisfies Partial<CSSStyleDeclaration>);
    track.appendChild(knob);
    pivotRow.appendChild(track);
    pivotRow.appendChild(document.createTextNode('Pivot Mode'));
    pivotRow.onclick = (e) => {
      e.preventDefault();
      api.setPivotMode(!pivotOn);
      host.rerender();
    };
    body.appendChild(pivotRow);
  }

  // ── Header row: expand/collapse, select-all checkbox, search (AG) ───
  const headerRow = document.createElement('div');
  Object.assign(headerRow.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginBottom: '6px',
  } satisfies Partial<CSSStyleDeclaration>);

  // Real (non-padding) groups determine whether the tree needs a chevron gutter.
  const hasRealGroup = (g: ProvidedColumnGroup<TData>): boolean => {
    if (!g.padding) return true;
    return g.children.some((ch) => !('colId' in ch) && hasRealGroup(ch));
  };
  const hasGroups = host.cols.providedRoots.some(hasRealGroup);
  const collapsed = (runtime.collapsedGroups ??= new Set<string>());
  if (!params?.suppressColumnExpandAll && hasGroups) {
    // AG shows one expand/collapse-all chevron left of the select-all box.
    const anyExpanded = collectRealGroupIds(host.cols.providedRoots).some((id) => !collapsed.has(id));
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
        for (const id of collectRealGroupIds(host.cols.providedRoots)) collapsed.add(id);
      } else {
        collapsed.clear();
      }
      host.rerender();
    };
    headerRow.appendChild(toggle);
  }

  if (!params?.suppressColumnSelectAll && !pivotOn) {
    const eligible = host.cols.all.filter((c) => columnEligibleForToolPanel(c));
    const visibleCount = eligible.filter((c) => !c.hide && !c.groupHidden).length;
    const all = document.createElement('input');
    all.type = 'checkbox';
    all.title = '(Select All)';
    all.style.accentColor = t.accent;
    all.style.flex = 'none';
    all.checked = visibleCount === eligible.length && eligible.length > 0;
    all.indeterminate = visibleCount > 0 && visibleCount < eligible.length;
    all.onchange = () => {
      for (const c of eligible) api.setColumnVisible(c.colId, all.checked);
      host.rerender();
    };
    headerRow.appendChild(all);
  }

  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Search...';
  search.value = runtime.search ?? '';
  Object.assign(search.style, inputStyle(t));
  search.style.flex = '1';
  search.style.minWidth = '0';
  search.onkeydown = (e) => e.stopPropagation();
  search.oninput = () => {
    runtime.search = search.value;
    renderTree();
  };
  headerRow.appendChild(search);
  body.appendChild(headerRow);

  const tree = document.createElement('div');
  Object.assign(tree.style, { display: 'flex', flexDirection: 'column', gap: '1px', marginBottom: '8px' } satisfies Partial<CSSStyleDeclaration>);

  const matchesSearch = (label: string): boolean => {
    const q = (runtime.search ?? '').trim().toLowerCase();
    return !q || label.toLowerCase().includes(q);
  };

  const groupMatches = (group: ProvidedColumnGroup<TData>): boolean => {
    if (matchesSearch(group.headerName)) return true;
    for (const ch of group.children) {
      if ('colId' in ch) {
        if (columnEligibleForToolPanel(ch) && matchesSearch(panelLabel(ch))) return true;
      } else if (groupMatches(ch)) return true;
    }
    return false;
  };

  const renderColumnRow = (col: InternalColumn<TData>, depth: number): void => {
    if (!columnEligibleForToolPanel(col)) return;
    if (!matchesSearch(panelLabel(col))) return;
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: `3px 2px 3px ${depth * 14 + 2}px`,
      color: t.textPrimary,
    } satisfies Partial<CSSStyleDeclaration>);

    if (hasGroups) {
      // Align leaf checkboxes with group checkboxes (chevron gutter).
      const pad = document.createElement('span');
      pad.style.width = '12px';
      pad.style.flex = 'none';
      row.appendChild(pad);
    }

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.style.accentColor = t.accent;
    cb.style.flex = 'none';
    cb.checked = pivotOn ? isColumnActiveInPivot(host, col) : !col.hide && !col.groupHidden;
    cb.onchange = () => {
      if (pivotOn) togglePivotColumn(host, col, cb.checked);
      else api.setColumnVisible(col.colId, cb.checked);
      host.refreshPanels();
      host.rerender();
    };
    row.appendChild(cb);

    // AG order: checkbox, drag grip, label.
    const grip = document.createElement('span');
    grip.textContent = '⋮⋮';
    grip.title = 'Drag';
    Object.assign(grip.style, {
      cursor: 'grab',
      color: t.textTertiary,
      fontSize: '10px',
      userSelect: 'none',
      flex: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    grip.onmousedown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      startColumnDrag(col.colId, host.headerLabel(col), t, e, (id, clientX, clientY) => {
        const zone = resolveDropZone(clientX, clientY, body);
        if (zone) handleDrop(host, id, zone);
      });
    };
    row.appendChild(grip);

    const label = document.createElement('span');
    // AG parity: the tree shows the plain header name (no agg prefix).
    label.textContent = panelLabel(col);
    label.style.flex = '1';
    label.style.overflow = 'hidden';
    label.style.textOverflow = 'ellipsis';
    label.style.whiteSpace = 'nowrap';
    row.appendChild(label);
    tree.appendChild(row);
  };

  const collectLeafColumns = (group: ProvidedColumnGroup<TData>, out: InternalColumn<TData>[]): void => {
    for (const ch of group.children) {
      if ('colId' in ch) {
        if (columnEligibleForToolPanel(ch)) out.push(ch);
      } else collectLeafColumns(ch, out);
    }
  };

  const renderGroupRow = (group: ProvidedColumnGroup<TData>, depth: number): void => {
    // Padding groups are structural fillers from tree balancing — render
    // their children transparently at the same depth.
    if (group.padding) {
      for (const ch of group.children) {
        if ('colId' in ch) renderColumnRow(ch, depth);
        else renderGroupRow(ch, depth);
      }
      return;
    }
    if (!groupMatches(group)) return;
    const searching = (runtime.search ?? '').trim().length > 0;
    // Panel tree expand state is local to the tool panel (AG parity) — it does
    // not open/close the header column group.
    const treeExpanded = !collapsed.has(group.groupId);
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: `3px 2px 3px ${depth * 14 + 2}px`,
      color: t.textPrimary,
      cursor: 'pointer',
    } satisfies Partial<CSSStyleDeclaration>);
    const chev = document.createElement('span');
    chev.textContent = treeExpanded || searching ? '▾' : '▸';
    chev.style.width = '12px';
    chev.style.flex = 'none';
    row.appendChild(chev);

    // AG shows a tri-state checkbox on group rows toggling all descendants.
    const leaves: InternalColumn<TData>[] = [];
    collectLeafColumns(group, leaves);
    const isOn = (c: InternalColumn<TData>): boolean =>
      pivotOn ? isColumnActiveInPivot(host, c) : !c.hide && !c.groupHidden;
    const onCount = leaves.filter(isOn).length;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.style.accentColor = t.accent;
    cb.style.flex = 'none';
    cb.checked = leaves.length > 0 && onCount === leaves.length;
    cb.indeterminate = onCount > 0 && onCount < leaves.length;
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = () => {
      for (const c of leaves) {
        if (pivotOn) togglePivotColumn(host, c, cb.checked);
        else api.setColumnVisible(c.colId, cb.checked);
      }
      host.refreshPanels();
      host.rerender();
    };
    row.appendChild(cb);

    const label = document.createElement('span');
    label.textContent = group.headerName;
    label.style.flex = '1';
    row.appendChild(label);
    row.onclick = () => {
      if (collapsed.has(group.groupId)) collapsed.delete(group.groupId);
      else collapsed.add(group.groupId);
      renderTree();
    };
    tree.appendChild(row);
    if (treeExpanded || searching) {
      for (const ch of group.children) {
        if ('colId' in ch) renderColumnRow(ch, depth + 1);
        else renderGroupRow(ch, depth + 1);
      }
    }
  };

  const renderTree = (): void => {
    tree.replaceChildren();
    let groupIdx = 0;
    for (const def of host.cols.sourceColumnDefs()) {
      if (isColGroup(def)) {
        const group = host.cols.providedRoots[groupIdx++];
        if (group) renderGroupRow(group, 0);
      } else {
        const id = colIdFromDef(def);
        if (id) {
          const col = host.cols.getColumn(id);
          if (col) renderColumnRow(col, 0);
        }
      }
    }
    if (!tree.childElementCount && !(runtime.search ?? '').trim()) {
      for (const col of host.cols.all) renderColumnRow(col, 0);
    }
  };
  renderTree();
  body.appendChild(tree);

  const onDrop = (colId: string, zone: 'rowGroup' | 'values' | 'pivot'): void => {
    handleDrop(host, colId, zone);
  };

  // AG-style drop-zone headers: icon + label above each dashed zone.
  const zoneHeader = (glyph: string, label: string): HTMLElement => {
    const el = document.createElement('div');
    Object.assign(el.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '7px',
      marginTop: '10px',
      marginBottom: '6px',
      paddingTop: '8px',
      borderTop: `1px solid ${t.hairline}`,
      color: t.textSecondary,
      fontWeight: '500',
    } satisfies Partial<CSSStyleDeclaration>);
    const icon = document.createElement('span');
    icon.textContent = glyph;
    Object.assign(icon.style, { color: t.textTertiary, fontSize: `${t.fontSize}px`, flex: 'none' } satisfies Partial<CSSStyleDeclaration>);
    el.appendChild(icon);
    el.appendChild(document.createTextNode(label));
    return el;
  };

  if (!params?.suppressRowGroups && runtime.rowGroupsVisible) {
    body.appendChild(zoneHeader('☰', 'Row Groups'));
    body.appendChild(
      chipZone(
        host,
        host.cols.rowGroupColumns().map((c) => c.colId),
        (id) => host.cols.getColumn(id),
        (id) => {
          host.cols.removeRowGroupColumn(id);
          host.refreshPanels();
          host.rerender();
        },
        'rowGroup',
        onDrop,
      ),
    );
  }

  if (!params?.suppressValues && runtime.valuesVisible) {
    body.appendChild(zoneHeader('Σ', 'Values'));
    // AG parity: value chips read "sum(Notional)". Use the raw header name
    // plus the agg func — host.headerLabel already prefixes only when grouped.
    const valuesHost = {
      ...host,
      headerLabel: (c: InternalColumn<TData>) => {
        const base = c.def.headerName ?? c.def.field ?? c.colId;
        const agg = typeof c.def.aggFunc === 'string' ? c.def.aggFunc : 'func';
        return `${agg}(${base})`;
      },
    };
    body.appendChild(
      chipZone(
        valuesHost,
        host.cols.valueColumns().map((c) => c.colId),
        (id) => host.cols.getColumn(id),
        (id) => {
          host.cols.removeValueColumns([id]);
          host.refreshPanels();
          host.rerender();
        },
        'values',
        onDrop,
      ),
    );
  }

  // AG only shows the Column Labels zone while pivot mode is on.
  if (!params?.suppressPivots && runtime.pivotVisible && pivotOn) {
    body.appendChild(zoneHeader('⫴', 'Column Labels'));
    body.appendChild(
      chipZone(
        host,
        host.cols.pivotColumns().map((c) => c.colId),
        (id) => host.cols.getColumn(id),
        (id) => {
          host.cols.removePivotColumn(id);
          host.refreshPanels();
          host.rerender();
        },
        'pivot',
        onDrop,
      ),
    );
  }
}

function panelLabel<TData>(col: InternalColumn<TData>): string {
  const raw = col.def.headerName ?? col.def.field ?? col.colId;
  // Same camelCase humanization as grid headers ("callId" -> "Call Id").
  if (/^[a-z][a-zA-Z0-9]*$/.test(raw)) {
    return raw
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(' ')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
  return raw;
}

function isColumnActiveInPivot<TData>(host: ColumnsToolPanelHost<TData>, col: InternalColumn<TData>): boolean {
  const id = col.colId;
  if (host.cols.valueColumns().some((c) => c.colId === id)) return true;
  if (host.cols.pivotColumns().some((c) => c.colId === id)) return true;
  if (host.cols.rowGroupColumns().some((c) => c.colId === id)) return true;
  return false;
}

function togglePivotColumn<TData>(
  host: ColumnsToolPanelHost<TData>,
  col: InternalColumn<TData>,
  on: boolean,
): void {
  const def = col.def;
  if (on) {
    if (def.enableValue !== false && (def.enableValue === true || def.type === 'number' || def.aggFunc)) {
      host.api.addValueColumns([col.colId]);
    } else if (def.enablePivot) host.api.addPivotColumns([col.colId]);
    else if (def.enableRowGroup) host.api.addRowGroupColumns([col.colId]);
    else host.api.setColumnVisible(col.colId, true);
  } else {
    host.cols.removeValueColumns([col.colId]);
    host.cols.removePivotColumn(col.colId);
    host.cols.removeRowGroupColumn(col.colId);
  }
}

function handleDrop<TData>(
  host: ColumnsToolPanelHost<TData>,
  colId: string,
  zone: 'rowGroup' | 'values' | 'pivot',
): void {
  const col = host.cols.getColumn(colId);
  if (!col) return;
  const def = host.cols.defaultColumnDef();
  if (zone === 'rowGroup' && columnEnableRowGroup(col, def)) host.api.addRowGroupColumns([colId]);
  else if (zone === 'values' && columnEnableValue(col, def)) host.api.addValueColumns([colId]);
  else if (zone === 'pivot' && columnEnablePivot(col, def)) host.api.addPivotColumns([colId]);
  else return;
  host.refreshPanels();
  host.rerender();
}
