/**
 * Title bar — brand, expandable search, alerts, layouts, dirty save, date, settings, overflow.
 */
import type { ExtContext } from './context';
import { injectExtStyles } from './styles';
import { ICON, iconButton, menu, svg } from './ui';
import { openLayoutsMenu } from './layoutsMenu';
import { openAlertsMenu } from './notifications';

export interface TitleBarOptions {
  brand?: string;
  showSearch?: boolean;
  showNotifications?: boolean;
  showLayouts?: boolean;
  showSave?: boolean;
  showSettings?: boolean;
  showDate?: boolean;
  showOverflow?: boolean;
  /** Collapse ribbon control. */
  onToggleRibbon?: () => void;
  ribbonVisible?: () => boolean;
  /** Optional Formatting / Editing strip toggles (overflow menu). */
  onToggleFormat?: () => void;
  formatVisible?: () => boolean;
  onToggleEdit?: () => void;
  editVisible?: () => boolean;
}

export function mountTitleBar(
  host: HTMLElement,
  ctx: ExtContext<any>,
  opts: TitleBarOptions = {},
): { destroy: () => void; setAlertCount: (n: number) => void; refresh: () => void } {
  injectExtStyles();
  const cleanups: Array<() => void> = [];
  let alertCount = 0;

  host.className = 'tx-titlebar';
  host.replaceChildren();

  // Brand
  const brand = document.createElement('div');
  brand.className = 'tx-brand';
  const mark = document.createElement('div');
  mark.className = 'tx-brand-mark';
  mark.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span');
  name.className = 'tx-brand-name';
  name.textContent = opts.brand ?? 'tabular';
  brand.append(mark, name);
  if (opts.onToggleRibbon) {
    const collapse = iconButton(ICON.chevronUp, 'Toggle ribbon', 'tx-iconbtn tx-brand-collapse');
    const syncCollapse = () => {
      const vis = opts.ribbonVisible?.() ?? true;
      collapse.innerHTML = svg(vis ? ICON.chevronUp : ICON.chevronDown);
      collapse.setAttribute('aria-pressed', String(vis));
    };
    syncCollapse();
    collapse.addEventListener('click', () => {
      opts.onToggleRibbon?.();
      syncCollapse();
    });
    brand.appendChild(collapse);
    cleanups.push(() => collapse.replaceChildren());
  }
  host.appendChild(brand);

  const left = document.createElement('div');
  left.className = 'tx-tb-cluster';
  host.appendChild(left);

  // Search
  if (opts.showSearch !== false) {
    const wrap = document.createElement('div');
    wrap.className = 'tx-search';
    const toggle = iconButton(ICON.search, 'Search');
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'tx-search-input';
    input.placeholder = 'Filter rows…';
    input.setAttribute('aria-label', 'Quick filter');
    const open = () => {
      wrap.classList.add('is-open');
      input.focus();
    };
    const closeIfEmpty = () => {
      if (!input.value) wrap.classList.remove('is-open');
    };
    toggle.addEventListener('click', () => {
      if (wrap.classList.contains('is-open')) {
        if (input.value) {
          input.value = '';
          ctx.api.setQuickFilter('');
        }
        wrap.classList.remove('is-open');
      } else open();
    });
    input.addEventListener('input', () => ctx.api.setQuickFilter(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        input.value = '';
        ctx.api.setQuickFilter('');
        wrap.classList.remove('is-open');
        toggle.focus();
      }
    });
    input.addEventListener('blur', closeIfEmpty);
    wrap.append(toggle, input);
    left.appendChild(wrap);
  }

  const spacer = document.createElement('div');
  spacer.className = 'tx-tb-spacer';
  host.appendChild(spacer);

  const right = document.createElement('div');
  right.className = 'tx-tb-cluster';
  host.appendChild(right);

  let badge: HTMLSpanElement | null = null;
  if (opts.showNotifications !== false) {
    const bell = iconButton(ICON.bell, 'Alerts');
    badge = document.createElement('span');
    badge.className = 'tx-badge';
    badge.hidden = true;
    bell.appendChild(badge);
    bell.addEventListener('click', () => openAlertsMenu(ctx, bell));
    right.appendChild(bell);
  }

  let layoutsBtn: HTMLButtonElement | null = null;
  let layoutsNameEl: HTMLSpanElement | null = null;
  const paintLayoutsName = () => {
    if (!layoutsBtn || !layoutsNameEl) return;
    const activeId = ctx.api.getActiveLayoutId();
    const layouts = ctx.api.getLayouts();
    const active = activeId ? layouts.find((l) => l.id === activeId) : undefined;
    const label = active?.name ?? 'Layouts';
    layoutsNameEl.textContent = label;
    layoutsBtn.title = active ? `Layout: ${label}` : 'Layouts';
  };
  if (opts.showLayouts !== false) {
    layoutsBtn = document.createElement('button');
    layoutsBtn.type = 'button';
    layoutsBtn.className = 'tx-layouts';
    layoutsBtn.setAttribute('aria-haspopup', 'menu');
    layoutsBtn.innerHTML =
      `${svg(ICON.layouts, 13)}<span class="tx-layouts-name">Layouts</span>${svg(ICON.chevronDown, 11)}`;
    layoutsNameEl = layoutsBtn.querySelector('.tx-layouts-name');
    paintLayoutsName();
    layoutsBtn.addEventListener('click', () => {
      openLayoutsMenu(ctx, layoutsBtn!);
      // Re-paint after menu closes (apply/save may change active)
      queueMicrotask(paintLayoutsName);
    });
    cleanups.push(ctx.bus.on('layout', paintLayoutsName));
    cleanups.push(ctx.bus.on('dirty', paintLayoutsName));
    right.appendChild(layoutsBtn);
  }

  let saveBtn: HTMLButtonElement | null = null;
  if (opts.showSave !== false) {
    saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'tx-save';
    saveBtn.innerHTML = `<span class="tx-save-dot"></span><span class="tx-save-label">Save</span>`;
    const sync = () => {
      saveBtn!.classList.toggle('is-dirty', ctx.isDirty());
      const activeId = ctx.api.getActiveLayoutId();
      const layouts = ctx.api.getLayouts();
      const active = activeId ? layouts.find((l) => l.id === activeId) : undefined;
      saveBtn!.title = ctx.isDirty()
        ? active
          ? `Update layout '${active.name}' (unsaved changes)`
          : 'Unsaved layout changes'
        : 'Save layout';
    };
    sync();
    cleanups.push(ctx.bus.on('dirty', sync));
    cleanups.push(ctx.bus.on('layout', sync));
    saveBtn.addEventListener('click', () => {
      const activeId = ctx.api.getActiveLayoutId();
      if (activeId) {
        const layouts = ctx.api.getLayouts();
        const cur = layouts.find((l) => l.id === activeId);
        ctx.api.saveLayout(cur?.name ?? 'Default', activeId);
      } else {
        const layoutName = window.prompt('Layout name', 'Default');
        if (!layoutName) return;
        ctx.api.saveLayout(layoutName);
      }
      ctx.markDirty(false);
      ctx.bus.emit('layout', { activeLayoutId: ctx.api.getActiveLayoutId() });
      paintLayoutsName();
    });
    right.appendChild(saveBtn);
  }

  if (opts.showDate !== false) {
    const pill = document.createElement('div');
    pill.className = 'tx-date';
    const today = new Date();
    const label = today.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    pill.innerHTML = `${svg(ICON.calendar, 12)}<span>${label}</span>`;
    right.appendChild(pill);
  }

  if (opts.showSettings !== false) {
    const settings = iconButton(ICON.settings, 'Settings');
    settings.classList.add('tx-settings-launcher');
    settings.addEventListener('click', () => ctx.setDrawerOpen(!ctx.isDrawerOpen()));
    cleanups.push(
      ctx.bus.on('drawer', ({ open }) => {
        settings.setAttribute('aria-pressed', String(open));
        settings.classList.toggle('is-active', open);
      }),
    );
    right.appendChild(settings);
  }

  if (opts.showOverflow !== false) {
    const more = iconButton(ICON.more, 'More');
    const m = menu(more, ctx.getTheme(), (close) => {
      const list = document.createElement('div');
      list.className = 'tx-menu-list';
      const entry = (icon: string, text: string, onClick: () => void) => {
        const it = document.createElement('button');
        it.type = 'button';
        it.className = 'tx-menu-item';
        it.innerHTML = `${svg(icon, 14)}<span>${text}</span>`;
        it.addEventListener('click', () => {
          onClick();
          close();
        });
        list.appendChild(it);
      };
      const toggleEntry = (
        icon: string,
        text: string,
        isOn: () => boolean,
        onToggle: () => void,
      ) => {
        const it = document.createElement('button');
        it.type = 'button';
        const paint = () => {
          const on = isOn();
          it.className = 'tx-menu-item' + (on ? ' is-active' : '');
          it.innerHTML = `${svg(icon, 14)}<span>${text}</span><span class="tx-menu-check">${on ? svg(ICON.check, 13) : ''}</span>`;
        };
        paint();
        it.addEventListener('click', () => {
          onToggle();
          paint();
        });
        list.appendChild(it);
      };
      entry(ICON.columns, 'Columns…', () => {
        try {
          ctx.api.openToolPanel('columns');
        } catch {
          /* ignore */
        }
      });
      entry(ICON.filter, 'Filters…', () => {
        try {
          ctx.api.openToolPanel('filters');
        } catch {
          /* ignore */
        }
      });
      entry(ICON.edit, 'Smart edit…', () => {
        try {
          ctx.api.openToolPanel('smartEdit');
        } catch {
          /* ignore */
        }
      });
      if (opts.onToggleFormat || opts.onToggleEdit) {
        const sep0 = document.createElement('div');
        sep0.className = 'tx-menu-sep';
        list.appendChild(sep0);
        if (opts.onToggleFormat) {
          toggleEntry(
            ICON.brush,
            'Formatting toolbar',
            () => opts.formatVisible?.() ?? true,
            () => opts.onToggleFormat?.(),
          );
        }
        if (opts.onToggleEdit) {
          toggleEntry(
            ICON.pencil,
            'Editing toolbar',
            () => opts.editVisible?.() ?? true,
            () => opts.onToggleEdit?.(),
          );
        }
      }
      const sep = document.createElement('div');
      sep.className = 'tx-menu-sep';
      list.appendChild(sep);
      const themeIt = document.createElement('button');
      themeIt.type = 'button';
      const dark = ctx.getTheme().name === 'dark';
      themeIt.className = 'tx-menu-item' + (dark ? ' is-active' : '');
      themeIt.innerHTML = `${svg(ICON.moon, 14)}<span>Dark theme</span><span class="tx-menu-check">${dark ? svg(ICON.check, 13) : ''}</span>`;
      themeIt.addEventListener('click', () => {
        ctx.api.setTheme(ctx.getTheme().name === 'dark' ? 'light' : 'dark');
        ctx.refreshChrome();
        close();
      });
      list.appendChild(themeIt);
      return list;
    }, { align: 'right' });
    more.addEventListener('click', () => m.toggle());
    cleanups.push(() => m.destroy());
    right.appendChild(more);
  }

  return {
    destroy: () => {
      for (const fn of cleanups) fn();
      host.replaceChildren();
    },
    setAlertCount: (n: number) => {
      alertCount = n;
      if (!badge) return;
      if (n <= 0) {
        badge.hidden = true;
        badge.textContent = '';
        return;
      }
      badge.hidden = false;
      badge.textContent = n > 99 ? '99+' : String(n);
    },
    refresh: () => {
      if (saveBtn) saveBtn.classList.toggle('is-dirty', ctx.isDirty());
      paintLayoutsName();
      if (badge) {
        badge.hidden = alertCount <= 0;
        if (alertCount > 0) badge.textContent = alertCount > 99 ? '99+' : String(alertCount);
      }
    },
  };
}
