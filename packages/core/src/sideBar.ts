/**
 * AG-shaped side bar (v36): button strip, resizable tool panels, Columns + Filters.
 */
import type { ColumnModel, InternalColumn } from './columnModel';
import type { Tabular } from './grid';
import type { ResolvedTheme } from './theme';
import { withAlpha } from './theme';
import type { GridOptions, SideBarDef, ToolPanelDef } from './types';
import {
  createColumnToolPanelApi,
  renderColumnsToolPanel,
  type ColumnToolPanelApi,
  type ColumnToolPanelRuntime,
} from './toolPanels/columnsToolPanel';
import {
  createFiltersToolPanelApi,
  renderFiltersToolPanel,
  type FiltersToolPanelApi,
} from './toolPanels/filtersToolPanel';
import {
  DEFAULT_TOOL_PANEL_WIDTH,
  panelIconMarkup,
  SIDE_BAR_BUTTON_WIDTH,
} from './toolPanels/shared';
import type { ToolPanelComp } from './registry';

export interface SideBarHost<TData> {
  root: HTMLElement;
  theme: ResolvedTheme;
  api: Tabular<TData>;
  cols: ColumnModel<TData>;
  options: GridOptions<TData>;
  headerLabel: (col: InternalColumn<TData>) => string;
  getDistinctValues: (colId: string) => string[];
  emit: (name: 'toolPanelVisibleChanged', payload: {
    visible: boolean;
    source: 'sideBarButtonClicked' | 'sideBarInitializing' | 'api';
    key: string;
    switchingToolPanel: boolean;
  }) => void;
  emitSizeChanged: (width: number, started: boolean, ended: boolean) => void;
  requestLayout: () => void;
  refreshPanels: () => void;
}

export function resolveSideBarDef(sideBar: GridOptions<unknown>['sideBar']): SideBarDef | null {
  if (!sideBar) return null;
  if (sideBar === true) {
    return {
      toolPanels: [
        {
          id: 'columns',
          labelDefault: 'Columns',
          labelKey: 'columns',
          iconKey: 'columns',
          toolPanel: 'agColumnsToolPanel',
        },
        {
          id: 'filters',
          labelDefault: 'Filters',
          labelKey: 'filters',
          iconKey: 'filter',
          toolPanel: 'agFiltersToolPanel',
        },
      ],
      defaultToolPanel: 'columns',
    };
  }
  if (typeof sideBar === 'string') {
    const id = sideBar === 'filters-new' ? 'filters' : sideBar;
    return {
      toolPanels: [
        {
          id,
          labelDefault: id === 'columns' ? 'Columns' : 'Filters',
          labelKey: id,
          iconKey: id === 'columns' ? 'columns' : 'filter',
          toolPanel: id === 'columns' ? 'agColumnsToolPanel' : 'agFiltersToolPanel',
        },
      ],
      defaultToolPanel: id,
    };
  }
  if (Array.isArray(sideBar)) {
    return {
      toolPanels: sideBar.map((raw) => {
        const id = raw === 'filters-new' ? 'filters' : raw;
        return {
          id,
          labelDefault: id === 'columns' ? 'Columns' : 'Filters',
          labelKey: id,
          iconKey: id === 'columns' ? 'columns' : 'filter',
          toolPanel: id === 'columns' ? 'agColumnsToolPanel' : 'agFiltersToolPanel',
        };
      }),
    };
  }
  return sideBar;
}

function normalizeToolPanels(def: SideBarDef): ToolPanelDef[] {
  return (def.toolPanels ?? []).map((p) => {
    if (typeof p === 'string') {
      const id = p === 'filters-new' ? 'filters' : p;
      return {
        id,
        labelDefault: id,
        labelKey: id,
        iconKey: id,
        toolPanel: id,
      };
    }
    return p;
  });
}

function isColumnsPanel(p: ToolPanelDef): boolean {
  return p.toolPanel === 'agColumnsToolPanel' || p.id === 'columns';
}

function isFiltersPanel(p: ToolPanelDef): boolean {
  return (
    p.toolPanel === 'agFiltersToolPanel' ||
    p.toolPanel === 'agNewFiltersToolPanel' ||
    p.id === 'filters' ||
    p.id === 'filters-new'
  );
}

export class SideBarController<TData> {
  private def: SideBarDef;
  private readonly panels: ToolPanelDef[];
  private readonly el: HTMLDivElement;
  private readonly buttonsEl: HTMLDivElement;
  private readonly contentEl: HTMLDivElement;
  private readonly resizeEl: HTMLDivElement;
  private readonly panelBody: HTMLDivElement;
  private visible: boolean;
  private openedId: string | null;
  private panelWidths = new Map<string, number>();
  private readonly filterState = {
    expandedCols: new Set<string>(),
    expandedGroups: new Set<string>(),
    search: '',
  };
  private columnApi: ColumnToolPanelApi;
  private filtersApi: FiltersToolPanelApi;
  private readonly columnRuntime: ColumnToolPanelRuntime = {
    pivotModeVisible: true,
    rowGroupsVisible: true,
    valuesVisible: true,
    pivotVisible: true,
  };
  private resizing = false;
  /** Mounted custom (registered) tool panel component, if the open panel is one. */
  private customPanel: ToolPanelComp | null = null;
  private customPanelId: string | null = null;

  constructor(
    private readonly host: SideBarHost<TData>,
    initial: SideBarDef,
  ) {
    this.def = { ...initial };
    this.panels = normalizeToolPanels(this.def);
    for (const p of this.panels) {
      this.panelWidths.set(p.id, p.width ?? DEFAULT_TOOL_PANEL_WIDTH);
    }
    this.visible = !this.def.hiddenByDefault;
    this.openedId =
      this.visible && !this.def.hiddenByDefault ? this.def.defaultToolPanel ?? null : null;

    const t = host.theme;
    this.el = document.createElement('div');
    this.el.className = 'tabular-side-bar';
    Object.assign(this.el.style, {
      position: 'absolute',
      top: '0',
      bottom: '0',
      display: 'flex',
      flexDirection: this.def.position === 'left' ? 'row-reverse' : 'row',
      zIndex: '13',
      pointerEvents: 'auto',
      font: `${t.fontSize}px ${t.fontSans}`,
      color: t.textSecondary,
    } satisfies Partial<CSSStyleDeclaration>);

    this.contentEl = document.createElement('div');
    Object.assign(this.contentEl.style, {
      display: 'flex',
      flexDirection: 'row',
      overflow: 'hidden',
      background: t.raised,
      borderLeft: this.def.position === 'left' ? 'none' : `1px solid ${t.structural}`,
      borderRight: this.def.position === 'left' ? `1px solid ${t.structural}` : 'none',
      boxSizing: 'border-box',
    } satisfies Partial<CSSStyleDeclaration>);

    this.resizeEl = document.createElement('div');
    Object.assign(this.resizeEl.style, {
      width: '5px',
      cursor: 'col-resize',
      flex: 'none',
      background: 'transparent',
    } satisfies Partial<CSSStyleDeclaration>);
    this.resizeEl.onmousedown = (e) => this.startResize(e);

    this.panelBody = document.createElement('div');
    Object.assign(this.panelBody.style, {
      flex: '1',
      display: 'flex',
      flexDirection: 'column',
      minWidth: '0',
      overflow: 'hidden',
    } satisfies Partial<CSSStyleDeclaration>);

    this.contentEl.appendChild(this.resizeEl);
    this.contentEl.appendChild(this.panelBody);

    this.buttonsEl = document.createElement('div');
    this.buttonsEl.className = 'tabular-side-bar-buttons';
    Object.assign(this.buttonsEl.style, {
      width: `${SIDE_BAR_BUTTON_WIDTH}px`,
      display: this.def.hideButtons ? 'none' : 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '2px',
      padding: '8px 0',
      boxSizing: 'border-box',
      background: t.headerBg,
      borderLeft: this.def.position === 'left' ? 'none' : `1px solid ${t.structural}`,
      borderRight: this.def.position === 'left' ? `1px solid ${t.structural}` : 'none',
    } satisfies Partial<CSSStyleDeclaration>);

    this.el.appendChild(this.contentEl);
    this.el.appendChild(this.buttonsEl);
    host.root.appendChild(this.el);

    const panelHost = {
      theme: host.theme,
      api: host.api,
      cols: host.cols,
      options: host.options,
      headerLabel: host.headerLabel,
      refreshPanels: host.refreshPanels,
      rerender: () => this.renderPanel(),
      getDistinctValues: host.getDistinctValues,
    };
    this.columnApi = createColumnToolPanelApi(panelHost, this.columnRuntime);
    this.filtersApi = createFiltersToolPanelApi(panelHost, this.filterState);

    this.renderButtons();
    this.renderPanel();
    if (this.openedId) {
      this.host.emit('toolPanelVisibleChanged', {
        visible: true,
        source: 'sideBarInitializing',
        key: this.openedId,
        switchingToolPanel: false,
      });
    }
  }

  destroy(): void {
    this.customPanel?.destroy?.();
    this.customPanel = null;
    this.el.remove();
  }

  getDef(): SideBarDef {
    return { ...this.def, toolPanels: [...this.panels] };
  }

  isSideBarVisible(): boolean {
    return this.visible;
  }

  setDef(def: SideBarDef): void {
    this.def = { ...def };
    this.renderButtons();
    this.renderPanel();
    this.host.requestLayout();
  }

  inset(): { left: number; right: number } {
    if (!this.visible) return { left: 0, right: 0 };
    const buttons = this.def.hideButtons ? 0 : SIDE_BAR_BUTTON_WIDTH;
    const panelW = this.openedId ? this.panelWidth() : 0;
    const total = buttons + panelW;
    return this.def.position === 'left' ? { left: total, right: 0 } : { left: 0, right: total };
  }

  layout(height: number): void {
    const side = this.def.position === 'left' ? 'left' : 'right';
    this.el.style[side] = '0';
    this.el.style.height = `${height}px`;
    this.el.style.display = this.visible ? 'flex' : 'none';
    const panelW = this.openedId ? this.panelWidth() : 0;
    this.contentEl.style.width = panelW > 0 ? `${panelW}px` : '0';
    this.contentEl.style.display = panelW > 0 ? 'flex' : 'none';
    if (this.def.position === 'left') {
      this.resizeEl.style.order = '2';
    } else {
      this.resizeEl.style.order = '0';
    }
  }

  refresh(): void {
    this.renderPanel();
  }

  refreshToolPanel(): void {
    this.renderPanel();
  }

  getToolPanelInstance(id: string): ColumnToolPanelApi | FiltersToolPanelApi | undefined {
    const panel = this.panels.find((p) => p.id === id);
    if (!panel) return undefined;
    if (isColumnsPanel(panel)) return this.columnApi;
    if (isFiltersPanel(panel)) return this.filtersApi;
    return undefined;
  }

  setVisible(show: boolean): void {
    if (this.visible === show) return;
    this.visible = show;
    if (!show) this.openedId = null;
    this.renderButtons();
    this.renderPanel();
    this.host.requestLayout();
  }

  setPosition(position: 'left' | 'right'): void {
    this.def.position = position;
    this.el.style.flexDirection = position === 'left' ? 'row-reverse' : 'row';
    this.host.requestLayout();
  }

  openToolPanel(key: string, source: 'sideBarButtonClicked' | 'api' = 'api'): void {
    this.visible = true;
    const switching = this.openedId != null && this.openedId !== key;
    if (this.openedId === key) return;
    const prev = this.openedId;
    this.openedId = key;
    this.renderButtons();
    this.renderPanel();
    this.host.requestLayout();
    if (prev) {
      this.host.emit('toolPanelVisibleChanged', {
        visible: false,
        source,
        key: prev,
        switchingToolPanel: true,
      });
    }
    this.host.emit('toolPanelVisibleChanged', {
      visible: true,
      source,
      key,
      switchingToolPanel: switching,
    });
  }

  closeToolPanel(source: 'sideBarButtonClicked' | 'api' = 'api'): void {
    if (!this.openedId) return;
    const key = this.openedId;
    this.openedId = null;
    this.renderButtons();
    this.renderPanel();
    this.host.requestLayout();
    this.host.emit('toolPanelVisibleChanged', {
      visible: false,
      source,
      key,
      switchingToolPanel: false,
    });
  }

  getOpenedToolPanel(): string | null {
    return this.openedId;
  }

  isToolPanelShowing(): boolean {
    return this.openedId != null;
  }

  private panelWidth(): number {
    if (!this.openedId) return 0;
    const panel = this.panels.find((p) => p.id === this.openedId);
    const w = this.panelWidths.get(this.openedId) ?? panel?.width ?? DEFAULT_TOOL_PANEL_WIDTH;
    const min = panel?.minWidth ?? 100;
    const max = panel?.maxWidth ?? 480;
    return Math.max(min, Math.min(max, w));
  }

  private startResize(e: MouseEvent): void {
    if (!this.openedId) return;
    e.preventDefault();
    const id = this.openedId;
    const panel = this.panels.find((p) => p.id === id);
    const min = panel?.minWidth ?? 100;
    const max = panel?.maxWidth ?? 480;
    const startX = e.clientX;
    const startW = this.panelWidth();
    const leftSide = this.def.position === 'left';
    const move = (ev: MouseEvent): void => {
      const dx = leftSide ? ev.clientX - startX : startX - ev.clientX;
      const next = Math.max(min, Math.min(max, startW + dx));
      this.panelWidths.set(id, next);
      this.host.requestLayout();
      if (!this.resizing) {
        this.resizing = true;
        this.host.emitSizeChanged(next, true, false);
      } else {
        this.host.emitSizeChanged(next, false, false);
      }
    };
    const up = (): void => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      const w = this.panelWidth();
      if (this.resizing) {
        this.resizing = false;
        this.host.emitSizeChanged(w, false, true);
      }
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.body.style.cursor = 'col-resize';
  }

  private renderButtons(): void {
    this.buttonsEl.replaceChildren();
    const t = this.host.theme;
    for (const panel of this.panels) {
      // AG renders vertical text tabs (icon above rotated label) in the strip.
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.title = panel.labelDefault;
      btn.setAttribute('aria-label', panel.labelDefault);
      btn.setAttribute('aria-pressed', String(this.openedId === panel.id));
      const active = this.openedId === panel.id;
      Object.assign(btn.style, {
        width: `${SIDE_BAR_BUTTON_WIDTH}px`,
        border: 'none',
        borderRadius: '0',
        background: active ? withAlpha(t.accent, 0.14) : 'transparent',
        color: active ? t.textPrimary : t.textSecondary,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '6px',
        padding: '10px 0',
        font: `${t.fontSize}px ${t.fontSans}`,
        borderLeft: active ? `2px solid ${t.accent}` : '2px solid transparent',
        boxSizing: 'border-box',
      } satisfies Partial<CSSStyleDeclaration>);

      const icon = document.createElement('span');
      icon.innerHTML = panelIconMarkup(panel.iconKey, panel.labelDefault);
      Object.assign(icon.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
      } satisfies Partial<CSSStyleDeclaration>);
      btn.appendChild(icon);

      const label = document.createElement('span');
      label.textContent = panel.labelDefault;
      Object.assign(label.style, {
        writingMode: 'vertical-lr',
        letterSpacing: '0.2px',
        lineHeight: '1',
        userSelect: 'none',
      } satisfies Partial<CSSStyleDeclaration>);
      btn.appendChild(label);

      btn.onclick = () => {
        if (this.openedId === panel.id) this.closeToolPanel('sideBarButtonClicked');
        else this.openToolPanel(panel.id, 'sideBarButtonClicked');
      };
      this.buttonsEl.appendChild(btn);
    }
  }

  private renderPanel(): void {
    const panel = this.panels.find((p) => p.id === this.openedId);
    // A mounted custom panel owns its DOM — delegate refreshes to its hook.
    if (panel && this.customPanel && this.customPanelId === panel.id) {
      this.customPanel.refresh?.();
      return;
    }
    this.customPanel?.destroy?.();
    this.customPanel = null;
    this.customPanelId = null;
    this.panelBody.replaceChildren();
    if (!panel) return;
    // AG tool panels have no title header; content starts at the top.
    const body = document.createElement('div');
    Object.assign(body.style, {
      flex: '1',
      overflow: 'auto',
      padding: '8px 10px',
    } satisfies Partial<CSSStyleDeclaration>);

    const panelHost = {
      theme: this.host.theme,
      api: this.host.api,
      cols: this.host.cols,
      options: this.host.options,
      headerLabel: this.host.headerLabel,
      refreshPanels: this.host.refreshPanels,
      rerender: () => this.renderPanel(),
      getDistinctValues: this.host.getDistinctValues,
    };

    if (isColumnsPanel(panel)) {
      renderColumnsToolPanel(
        panelHost,
        body,
        panel.toolPanelParams as import('./types').ColumnsToolPanelParams,
        this.columnRuntime,
      );
    } else if (isFiltersPanel(panel)) {
      renderFiltersToolPanel(
        panelHost,
        body,
        panel.toolPanelParams as import('./types').FiltersToolPanelParams,
        this.filterState,
      );
    } else {
      const factory = this.host.api.resolveToolPanelFactory(panel.toolPanel ?? panel.id);
      if (factory) {
        const comp = factory({
          api: this.host.api,
          container: body,
          toolPanelParams: panel.toolPanelParams,
        });
        this.customPanel = comp ?? null;
        this.customPanelId = panel.id;
      } else {
        body.textContent = `Unknown tool panel: ${panel.toolPanel ?? panel.id}`;
      }
    }
    this.panelBody.appendChild(body);
  }
}
