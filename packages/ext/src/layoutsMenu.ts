/**
 * Layouts menu — save / apply / rename / duplicate / delete / import / export.
 */
import type { ExtContext } from './context';
import { ICON, menu, svg } from './ui';

export function openLayoutsMenu(ctx: ExtContext<any>, anchor: HTMLButtonElement): () => void {
  const t = ctx.getTheme();
  const m = menu(anchor, t, (close) => {
    const list = document.createElement('div');
    list.className = 'tx-menu-list';

    const label = document.createElement('div');
    label.className = 'tx-menu-label';
    label.textContent = 'Layouts';
    list.appendChild(label);

    const item = (icon: string, text: string, onClick: () => void, opts?: { danger?: boolean; active?: boolean }) => {
      const it = document.createElement('button');
      it.type = 'button';
      it.className =
        'tx-menu-item' + (opts?.danger ? ' is-danger' : '') + (opts?.active ? ' is-active' : '');
      it.innerHTML = `${svg(icon, 14)}<span>${text}</span>`;
      it.addEventListener('click', () => {
        onClick();
        close();
      });
      list.appendChild(it);
    };

    const layouts = ctx.api.getLayouts();
    const active = ctx.api.getActiveLayoutId();
    if (!layouts.length) {
      const empty = document.createElement('div');
      empty.className = 'tx-menu-item';
      empty.style.cursor = 'default';
      empty.style.color = 'var(--tx-faint)';
      empty.textContent = 'No saved layouts yet';
      list.appendChild(empty);
    } else {
      for (const l of layouts) {
        item(l.id === active ? ICON.check : ICON.layouts, l.name, () => {
          ctx.api.applyLayout(l.id);
          ctx.markDirty(false);
          ctx.bus.emit('layout', { activeLayoutId: ctx.api.getActiveLayoutId() });
        }, { active: l.id === active });
      }
    }

    const sep = () => {
      const s = document.createElement('div');
      s.className = 'tx-menu-sep';
      list.appendChild(s);
    };
    sep();

    item(ICON.save, 'Save current as…', () => {
      const name = window.prompt('Layout name');
      if (name) {
        ctx.api.saveLayout(name);
        ctx.markDirty(false);
        ctx.bus.emit('layout', { activeLayoutId: ctx.api.getActiveLayoutId() });
      }
    });

    if (active) {
      item(ICON.pencil, 'Rename active…', () => {
        const cur = layouts.find((l) => l.id === active);
        const name = window.prompt('New name', cur?.name ?? '');
        if (name) ctx.api.renameLayout(active, name);
      });
      item(ICON.layouts, 'Duplicate active', () => {
        ctx.api.duplicateLayout(active);
      });
      item(
        ICON.close,
        'Delete active',
        () => {
          if (window.confirm('Delete this layout?')) ctx.api.deleteLayout(active);
        },
        { danger: true },
      );
    }

    sep();
    item(ICON.grid, 'Export layouts JSON', () => {
      const blob = new Blob([JSON.stringify(ctx.api.getLayouts(), null, 2)], {
        type: 'application/json',
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'tabular-layouts.json';
      a.click();
      URL.revokeObjectURL(a.href);
    });
    item(ICON.rows, 'Import layouts JSON…', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const data = JSON.parse(await file.text());
          if (Array.isArray(data)) ctx.api.setLayouts(data);
        } catch {
          window.alert('Invalid layouts file');
        }
      };
      input.click();
    });

    return list;
  }, { align: 'right' });

  m.toggle();
  return () => m.destroy();
}
