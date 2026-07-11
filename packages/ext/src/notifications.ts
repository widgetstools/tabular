/**
 * Alerts popover — severity-coded feed instead of window.alert.
 */
import type { ExtContext } from './context';
import type { AlertEvent } from '@tabular/rules';
import { menu } from './ui';

function sevClass(sev: string | undefined): string {
  if (sev === 'error' || sev === 'critical') return 'error';
  if (sev === 'warn' || sev === 'warning') return 'warn';
  return 'info';
}

export function openAlertsMenu(ctx: ExtContext<any>, anchor: HTMLButtonElement): () => void {
  const t = ctx.getTheme();
  const m = menu(
    anchor,
    t,
    (close) => {
      const root = document.createElement('div');
      root.className = 'tx-alerts';

      const head = document.createElement('div');
      head.className = 'tx-alerts-head';
      const title = document.createElement('div');
      title.className = 'tx-alerts-title';
      title.textContent = 'Alerts';
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'tx-alerts-clear';
      clear.textContent = 'Clear';
      clear.addEventListener('click', () => {
        ctx.clearAlerts();
        close();
      });
      head.append(title, clear);
      root.appendChild(head);

      const body = document.createElement('div');
      body.className = 'tx-alerts-body';
      const alerts = [...ctx.getAlerts()].reverse();
      if (!alerts.length) {
        const empty = document.createElement('div');
        empty.className = 'tx-alerts-empty';
        empty.textContent = 'Quiet for now — rule alerts will appear here.';
        body.appendChild(empty);
      } else {
        for (const a of alerts.slice(0, 40)) body.appendChild(row(a));
      }
      root.appendChild(body);
      return root;
    },
    { align: 'right', className: 'tx-alerts-menu' },
  );
  m.toggle();
  return () => m.destroy();
}

function row(a: AlertEvent): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tx-alert-row';
  const dot = document.createElement('div');
  dot.className = `tx-alert-dot ${sevClass(a.severity)}`;
  const mid = document.createElement('div');
  const msg = document.createElement('div');
  msg.className = 'tx-alert-msg';
  msg.textContent = a.message;
  const meta = document.createElement('div');
  meta.className = 'tx-alert-meta';
  const when = new Date(a.at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  meta.textContent = `${a.rowId} · ${when}`;
  mid.append(msg, meta);
  const sev = document.createElement('div');
  sev.className = 'tx-alert-sev';
  sev.textContent = a.severity ?? 'info';
  el.append(dot, mid, sev);
  return el;
}
