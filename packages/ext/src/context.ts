/**
 * Shared ext context — grid api, event bus, modal host, profiles.
 */
import type { Tabular, ResolvedTheme } from '@tabular/core';
import type { AlertEvent } from '@tabular/rules';

export type ExtEventMap = {
  alert: AlertEvent;
  dirty: { dirty: boolean };
  drawer: { open: boolean };
  layout: { activeLayoutId: string | null };
  popout: Record<string, never>;
};

type Handler<K extends keyof ExtEventMap> = (e: ExtEventMap[K]) => void;

export class ExtEventBus {
  private listeners = new Map<string, Set<(e: unknown) => void>>();

  on<K extends keyof ExtEventMap>(event: K, handler: Handler<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as (e: unknown) => void);
    return () => set!.delete(handler as (e: unknown) => void);
  }

  emit<K extends keyof ExtEventMap>(event: K, payload: ExtEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const h of [...set]) h(payload);
  }
}

export interface ExtContext<TData = unknown> {
  api: Tabular<TData>;
  bus: ExtEventBus;
  getTheme: () => ResolvedTheme;
  /** Open/close the settings drawer. */
  setDrawerOpen: (open: boolean) => void;
  isDrawerOpen: () => boolean;
  /** Alert history ring (newest last). */
  getAlerts: () => readonly AlertEvent[];
  clearAlerts: () => void;
  /** Dirty flag for save affordances. */
  isDirty: () => boolean;
  markDirty: (dirty?: boolean) => void;
  /** Re-sync chrome CSS vars after theme changes. */
  refreshChrome: () => void;
}

export type ToolbarItemFactory = (ctx: ExtContext<any>) => HTMLElement;
export type SettingsModuleFactory = (
  ctx: ExtContext<any>,
  body: HTMLElement,
) => { destroy?: () => void };

export interface ExtensionRegistry {
  registerToolbarItem(id: string, factory: ToolbarItemFactory): void;
  registerSettingsModule(id: string, title: string, factory: SettingsModuleFactory): void;
  toolbarItems(): Array<{ id: string; factory: ToolbarItemFactory }>;
  settingsModules(): Array<{ id: string; title: string; factory: SettingsModuleFactory }>;
}

export function createExtensionRegistry(): ExtensionRegistry {
  const toolbar: Array<{ id: string; factory: ToolbarItemFactory }> = [];
  const settings: Array<{ id: string; title: string; factory: SettingsModuleFactory }> = [];
  return {
    registerToolbarItem(id, factory) {
      const i = toolbar.findIndex((t) => t.id === id);
      if (i >= 0) toolbar[i] = { id, factory };
      else toolbar.push({ id, factory });
    },
    registerSettingsModule(id, title, factory) {
      const i = settings.findIndex((s) => s.id === id);
      if (i >= 0) settings[i] = { id, title, factory };
      else settings.push({ id, title, factory });
    },
    toolbarItems: () => [...toolbar],
    settingsModules: () => [...settings],
  };
}
