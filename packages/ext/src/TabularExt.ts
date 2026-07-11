/**
 * TabularExt — batteries-included shell around a Tabular grid.
 * The grid never imports this package; ext wraps from the outside.
 */
import type { GridOptions, Tabular } from '@tabular/core';
import { createExtensionRegistry, ExtEventBus, type ExtContext } from './context';
import { mountDrawer, gridOptionsSettingsModule } from './drawer';
import { mountTitleBar, type TitleBarOptions } from './titleBar';
import { mountRibbon, appendRibbonExtras } from './ribbon';
import { LocalStorageProfileStore, ProfilesController } from './profiles';
import type { AlertEvent } from '@tabular/rules';
import { registerEditToolPanels } from '@tabular/edit';
import { registerToolPanel } from '@tabular/core';
import { applyThemeVars, injectExtStyles } from './styles';

export interface TabularExtOptions<TData = unknown> {
  /** Host element that will contain title bar + grid mount + drawer. */
  container: HTMLElement;
  /** Grid factory — called with the inner mount node. */
  createGrid: (mount: HTMLElement) => Tabular<TData>;
  brand?: string;
  titleBar?: TitleBarOptions | false;
  ribbon?: boolean;
  drawer?: boolean;
  /** Register smart-edit / bulk-update tool panels globally. Default true. */
  registerEditPanels?: boolean;
  gridId?: string;
  /** Populate toolbar / settings modules before the shell mounts chrome. */
  configureRegistry?: (registry: import('./context').ExtensionRegistry) => void;
}

export class TabularExt<TData = unknown> {
  readonly api: Tabular<TData>;
  readonly bus = new ExtEventBus();
  readonly registry = createExtensionRegistry();
  private readonly root: HTMLElement;
  private readonly gridMount: HTMLElement;
  private readonly titleEl: HTMLElement | null = null;
  private readonly ribbonEl: HTMLElement | null = null;
  private readonly drawerEl: HTMLElement;
  private readonly shell: HTMLElement;
  private titleBarApi: ReturnType<typeof mountTitleBar> | null = null;
  private ribbonApi: ReturnType<typeof mountRibbon> | null = null;
  private drawerApi: ReturnType<typeof mountDrawer> | null = null;
  private drawerOpen = false;
  private dirty = false;
  private readonly alerts: AlertEvent[] = [];
  private readonly cleanups: Array<() => void> = [];
  private readonly profiles: ProfilesController;

  constructor(opts: TabularExtOptions<TData>) {
    injectExtStyles();

    if (opts.registerEditPanels !== false) {
      try {
        registerEditToolPanels(registerToolPanel);
      } catch {
        // already registered
      }
    }

    this.root = opts.container;
    this.root.classList.add('tx-root');
    this.root.replaceChildren();

    if (opts.titleBar !== false) {
      this.titleEl = document.createElement('div');
      this.root.appendChild(this.titleEl);
    }

    if (opts.ribbon) {
      this.ribbonEl = document.createElement('div');
      this.root.appendChild(this.ribbonEl);
    }

    this.shell = document.createElement('div');
    this.shell.className = 'tx-body';
    this.root.appendChild(this.shell);

    this.gridMount = document.createElement('div');
    this.gridMount.className = 'tx-grid-mount';
    this.shell.appendChild(this.gridMount);

    this.drawerEl = document.createElement('div');
    this.shell.appendChild(this.drawerEl);

    this.api = opts.createGrid(this.gridMount);
    this.syncTheme();

    this.profiles = new ProfilesController(
      new LocalStorageProfileStore(opts.gridId ?? 'tabular-ext'),
      () => ({
        gridState: this.api.getState(),
        extState: { drawerOpen: this.drawerOpen },
      }),
    );

    this.registry.registerSettingsModule('gridOptions', 'Grid options', gridOptionsSettingsModule);
    opts.configureRegistry?.(this.registry);

    const ctx = this.makeContext();

    if (this.ribbonEl) {
      this.ribbonApi = mountRibbon(this.ribbonEl, ctx);
      const extras: HTMLElement[] = [];
      for (const item of this.registry.toolbarItems()) {
        try {
          extras.push(item.factory(ctx));
        } catch {
          // ignore bad toolbar items
        }
      }
      appendRibbonExtras(this.ribbonEl, extras);
    }

    if (this.titleEl) {
      this.titleBarApi = mountTitleBar(this.titleEl, ctx, {
        brand: opts.brand,
        onToggleRibbon: this.ribbonApi
          ? () => this.ribbonApi!.setVisible(!this.ribbonApi!.isVisible())
          : undefined,
        ribbonVisible: this.ribbonApi ? () => this.ribbonApi!.isVisible() : undefined,
        onToggleFormat: this.ribbonApi
          ? () => this.ribbonApi!.setFormatVisible(!this.ribbonApi!.isFormatVisible())
          : undefined,
        formatVisible: this.ribbonApi ? () => this.ribbonApi!.isFormatVisible() : undefined,
        onToggleEdit: this.ribbonApi
          ? () => this.ribbonApi!.setEditVisible(!this.ribbonApi!.isEditVisible())
          : undefined,
        editVisible: this.ribbonApi ? () => this.ribbonApi!.isEditVisible() : undefined,
        ...(typeof opts.titleBar === 'object' ? opts.titleBar : {}),
      });
    }

    if (opts.drawer !== false) {
      this.drawerApi = mountDrawer(this.drawerEl, ctx, this.registry.settingsModules());
    }

    this.cleanups.push(
      this.api.on('alert', (e) => {
        this.alerts.push(e as AlertEvent);
        if (this.alerts.length > 100) this.alerts.splice(0, this.alerts.length - 100);
        this.titleBarApi?.setAlertCount(this.alerts.length);
        this.bus.emit('alert', e as AlertEvent);
      }),
    );

    for (const ev of ['filterChanged', 'sortChanged', 'columnMoved', 'columnVisible', 'columnPinned'] as const) {
      this.cleanups.push(this.api.on(ev as 'filterChanged', () => this.markDirty(true)));
    }
  }

  private syncTheme(): void {
    applyThemeVars(this.root, this.api.getTheme());
  }

  private makeContext(): ExtContext<TData> {
    return {
      api: this.api,
      bus: this.bus,
      getTheme: () => this.api.getTheme(),
      setDrawerOpen: (open) => {
        this.drawerOpen = open;
        this.drawerApi?.setOpen(open);
      },
      isDrawerOpen: () => this.drawerOpen,
      getAlerts: () => this.alerts,
      clearAlerts: () => {
        this.alerts.length = 0;
        this.titleBarApi?.setAlertCount(0);
      },
      isDirty: () => this.dirty,
      markDirty: (d = true) => this.markDirty(d),
      refreshChrome: () => this.refreshChrome(),
    };
  }

  /** Re-apply chrome tokens after setTheme (call from overflow menu consumers). */
  refreshChrome(): void {
    this.syncTheme();
    this.titleBarApi?.refresh();
  }

  markDirty(dirty = true): void {
    this.dirty = dirty;
    this.profiles.markDirty(dirty);
    this.bus.emit('dirty', { dirty });
  }

  getProfiles(): ProfilesController {
    return this.profiles;
  }

  destroy(): void {
    for (const fn of this.cleanups) fn();
    this.titleBarApi?.destroy();
    this.ribbonApi?.destroy();
    this.drawerApi?.destroy();
    this.api.destroy();
    this.root.classList.remove('tx-root');
    this.root.replaceChildren();
  }
}

/** Convenience: mount TabularExt with GridOptions via a provided constructor. */
export function createTabularExt<TData>(
  container: HTMLElement,
  Grid: new (el: HTMLElement, opts: GridOptions<TData>) => Tabular<TData>,
  gridOptions: GridOptions<TData>,
  extOptions?: Omit<TabularExtOptions<TData>, 'container' | 'createGrid'>,
): TabularExt<TData> {
  return new TabularExt({
    container,
    createGrid: (mount) => new Grid(mount, gridOptions),
    ...extOptions,
  });
}
