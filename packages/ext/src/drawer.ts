/**
 * Non-modal right settings drawer overlaid on the grid.
 */
import type { ExtContext, SettingsModuleFactory } from './context';
import { injectExtStyles } from './styles';
import { ICON, iconButton } from './ui';

export function mountDrawer(
  host: HTMLElement,
  ctx: ExtContext<any>,
  modules: Array<{ id: string; title: string; factory: SettingsModuleFactory }>,
): { setOpen: (open: boolean) => void; destroy: () => void } {
  injectExtStyles();
  const instances: Array<{ destroy?: () => void }> = [];
  let open = false;

  host.className = 'tx-drawer';
  host.replaceChildren();

  const header = document.createElement('div');
  header.className = 'tx-drawer-head';
  const title = document.createElement('div');
  title.className = 'tx-drawer-title';
  title.textContent = 'Settings';
  const close = iconButton(ICON.close, 'Close settings');
  close.addEventListener('click', () => setOpen(false));
  header.append(title, close);
  host.appendChild(header);

  const body = document.createElement('div');
  body.className = 'tx-drawer-body';
  host.appendChild(body);

  for (const mod of modules) {
    const section = document.createElement('div');
    section.className = 'tx-drawer-section';
    const st = document.createElement('div');
    st.className = 'tx-drawer-section-title';
    st.textContent = mod.title;
    section.appendChild(st);
    const content = document.createElement('div');
    section.appendChild(content);
    body.appendChild(section);
    try {
      const inst = mod.factory(ctx, content);
      if (inst) instances.push(inst);
    } catch (e) {
      content.textContent = `Module error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  function setOpen(next: boolean): void {
    open = next;
    host.classList.toggle('is-open', open);
    ctx.bus.emit('drawer', { open });
  }

  return {
    setOpen,
    destroy: () => {
      for (const i of instances) i.destroy?.();
      host.replaceChildren();
    },
  };
}

/** Built-in Grid Options settings module. */
export function gridOptionsSettingsModule(
  ctx: ExtContext<any>,
  body: HTMLElement,
): { destroy?: () => void } {
  const mkCheck = (label: string, get: () => boolean, set: (v: boolean) => void) => {
    const row = document.createElement('label');
    row.className = 'tx-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = get();
    input.onchange = () => {
      set(input.checked);
      ctx.markDirty(true);
    };
    row.append(input, document.createTextNode(label));
    body.appendChild(row);
  };

  mkCheck(
    'Enable cell flash',
    () => ctx.api.getGridOption('enableCellFlash') !== false,
    (v) => ctx.api.setGridOption('enableCellFlash', v),
  );
  mkCheck(
    'Pagination',
    () => !!ctx.api.getGridOption('pagination'),
    (v) => ctx.api.setGridOption('pagination', v),
  );

  const field = document.createElement('div');
  field.className = 'tx-field';
  const densLabel = document.createElement('label');
  densLabel.textContent = 'Density';
  const dens = document.createElement('select');
  for (const d of ['compact', 'dense', 'comfortable'] as const) {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d;
    dens.appendChild(opt);
  }
  dens.value = String(ctx.api.getGridOption('density') ?? 'compact');
  dens.onchange = () => {
    ctx.api.setGridOption('density', dens.value as 'compact' | 'dense' | 'comfortable');
    ctx.markDirty(true);
  };
  field.append(densLabel, dens);
  body.appendChild(field);

  return {};
}
