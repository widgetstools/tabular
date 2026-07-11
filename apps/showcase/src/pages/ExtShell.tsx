import { useEffect, useRef } from 'react';
import { Tabular, registerToolPanel } from '@tabular/core';
import {
  TabularExt,
  openFormatPicker,
  applyColumnFormat,
  resolveTargetColIds,
  readColumnChrome,
  ICON,
  svg,
} from '@tabular/ext';
import { registerEditToolPanels } from '@tabular/edit';
import { makeBonds, makeRng, tick, type Bond } from '../data';
import { bondColumns } from '../columns';

registerEditToolPanels(registerToolPanel);

/**
 * Phase 7 — instrument-console ext shell over a live blotter.
 */
export function ExtShellPage() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const rows = makeBonds(2500);
    const ext = new TabularExt<Bond>({
      container: host,
      brand: 'tabular',
      ribbon: true,
      gridId: 'showcase-ext',
      registerEditPanels: false,
      configureRegistry: (reg) => {
        reg.registerToolbarItem('format', (ctx) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'tx-rb-pill';
          b.title = 'Custom format code for selected columns';
          b.innerHTML = `${svg(ICON.hash, 12)}<span>Custom…</span>`;
          b.onclick = () => {
            const cols = resolveTargetColIds(ctx.api, 'selected');
            const targets = cols.length ? cols : resolveTargetColIds(ctx.api, 'all');
            const chrome = readColumnChrome(ctx.api, targets);
            openFormatPicker(ctx.getTheme(), chrome.format ?? 'currency', (r) => {
              if (applyColumnFormat(ctx.api, targets, r.code)) ctx.markDirty(true);
            });
          };
          return b;
        });
      },
      createGrid: (mount) =>
        new Tabular(mount, {
          columnDefs: bondColumns(),
          rowData: rows,
          getRowId: (p) => p.data.id,
          theme: 'dark',
          density: 'compact',
          enableCellFlash: true,
          cellSelection: true,
          undoRedoCellEditing: true,
          floatingFilter: true,
          rowGroupPanelShow: 'always',
          defaultColDef: {
            floatingFilter: true,
            filter: true,
            enableRowGroup: true,
            resizable: true,
            sortable: true,
          },
          sideBar: {
            toolPanels: [
              { id: 'columns', labelDefault: 'Columns', iconKey: 'columns' },
              { id: 'filters', labelDefault: 'Filters', iconKey: 'filter' },
            ],
          },
          rules: {
            style: [
              {
                id: 'pnl-drop',
                condition: '[pnl.new] < [pnl.old]',
                style: { backgroundColor: 'rgba(227, 70, 113, 0.2)' },
                field: 'pnl',
                flash: 'pulse',
                activeDurationMs: 600,
              },
            ],
            alerts: [
              {
                id: 'big-drop',
                condition: '[pnl.new] < [pnl.old] - 5000',
                message: 'Large PnL drop',
                severity: 'warn',
                trigger: 'relativeChange',
                field: 'pnl',
              },
            ],
            alertRateLimit: { tokens: 8, perMs: 1000 },
          },
        }),
    });

    const rnd = makeRng(7);
    const iv = setInterval(() => {
      const batch = tick(rows, 60, rnd);
      for (const u of batch) {
        const idx = Number(u.id.slice(1));
        rows[idx] = u;
      }
      ext.api.applyTransactionAsync({ update: batch });
    }, 80);

    return () => {
      clearInterval(iv);
      ext.destroy();
    };
  }, []);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Ext shell</h2>
        <p>
          Edit strip + full formatting band (Target · Font · Borders · Number · Icons ·
          Column · Templates) aligned with the cgrid ext demo. Select a cell, then format.
        </p>
      </div>
      <div className="grid-wrap" style={{ height: 'calc(100% - 80px)' }}>
        <div ref={hostRef} style={{ height: '100%', width: '100%' }} />
      </div>
    </main>
  );
}
