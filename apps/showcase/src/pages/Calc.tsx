import { useMemo } from 'react';
import type { ColDef } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';

const mainMode =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('main') === '1';

const compareMode =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('compare') === '1';

function spreadGetter(row: Bond): number {
  return row.spread;
}

export function CalcPage() {
  const rowData = useMemo(() => makeBonds(500), []);
  const columnDefs = useMemo<ColDef<Bond>[]>(
    () => [
      { field: 'desk', headerName: 'Desk', width: 100, rowGroup: true, rowGroupIndex: 0 },
      { field: 'issuer', headerName: 'Issuer', width: 150 },
      { field: 'spread', headerName: 'Spread (field)', type: 'number', width: 100 },
      {
        colId: 'spreadCalc',
        headerName: 'Spread (calc)',
        type: 'number',
        width: 110,
        calc: '[spread]',
      },
      {
        colId: 'deskNotional',
        headerName: 'Desk notional Σ',
        type: 'number',
        width: 130,
        calc: "SUM([notional], 'group')",
      },
      {
        colId: 'spreadBps',
        headerName: 'Spread bps',
        type: 'number',
        width: 100,
        calc: 'ROUND([spread] * 100)',
      },
      {
        colId: 'spreadGetter',
        headerName: 'Spread (getter)',
        type: 'number',
        width: 120,
        valueGetter: (p) => spreadGetter(p.data as Bond),
      },
      {
        colId: 'pnlPrev',
        headerName: 'PnL prev',
        type: 'number',
        width: 100,
        calc: 'PREV([pnl])',
      },
      {
        colId: 'pnlFlag',
        headerName: 'PnL flag',
        width: 90,
        calc: 'IF([pnl] < 0, "loss", "gain")',
      },
    ],
    [],
  );

  return (
    <main className="page">
      <div className="page-head">
        <h2>Calculated columns</h2>
        <p>
          <code>ColDef.calc</code> with field refs, aggregate scopes, and <code>PREV([field])</code>.
          Group by Desk to see <code>SUM([notional], &apos;group&apos;)</code>. Edit PnL cells then
          update again to observe PREV. Worker pipeline is the default (getter columns are skipped
          for filter/sort maps). Append <code>?main=1</code> to force the UI thread, or{' '}
          <code>?compare=1</code> for differential checks.
        </p>
      </div>
      <div className="grid-wrap">
        <TabularGrid<Bond>
          columnDefs={columnDefs}
          rowData={rowData}
          rowDataMode={mainMode ? 'main' : undefined}
          workerCompareMode={compareMode && !mainMode}
          defaultColDef={{ sortable: true, filter: true, resizable: true, editable: true }}
          sideBar
        />
      </div>
    </main>
  );
}
