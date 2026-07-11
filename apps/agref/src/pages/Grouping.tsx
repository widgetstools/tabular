import { useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, IAggFuncParams } from 'ag-grid-community';
import { gridTheme } from '../theme';
import { makeBonds, type Bond } from '../data';

const fmtInt = (p: { value: unknown }) =>
  typeof p.value === 'number' ? Math.round(p.value).toLocaleString() : '';
const fmt2 = (p: { value: unknown }) =>
  typeof p.value === 'number'
    ? p.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '';

/** Notional-weighted average over the group's leaf rows. */
function weightedAverage(params: IAggFuncParams<Bond>) {
  const field = params.colDef.field as keyof Bond;
  let num = 0;
  let den = 0;
  for (const leaf of params.rowNode.allLeafChildren ?? []) {
    const d = leaf.data;
    if (!d) continue;
    const v = d[field] as number;
    const w = d.notional;
    if (typeof v === 'number' && typeof w === 'number') {
      num += v * w;
      den += w;
    }
  }
  return den ? num / den : null;
}

export function GroupingPage() {
  const rowData = useMemo(() => makeBonds(2_000), []);
  const columnDefs = useMemo<ColDef<Bond>[]>(
    () => [
      { field: 'desk', headerName: 'Desk', rowGroup: true, enableRowGroup: true, hide: true },
      { field: 'sector', headerName: 'Sector', rowGroup: true, enableRowGroup: true, hide: true },
      { field: 'cusip', headerName: 'CUSIP', width: 110 },
      { field: 'issuer', headerName: 'Issuer', width: 150, enableRowGroup: true },
      { field: 'rating', headerName: 'Rating', width: 78, enableRowGroup: true },
      {
        field: 'spread',
        headerName: 'Spread',
        type: 'rightAligned',
        width: 90,
        aggFunc: 'weightedAverage',
        valueFormatter: fmt2,
      },
      {
        field: 'yld',
        headerName: 'Yield',
        type: 'rightAligned',
        width: 84,
        aggFunc: 'weightedAverage',
        valueFormatter: fmt2,
      },
      {
        field: 'notional',
        headerName: 'Notional',
        type: 'rightAligned',
        width: 116,
        aggFunc: 'sum',
        valueFormatter: fmtInt,
      },
      { field: 'pnl', headerName: 'PnL', type: 'rightAligned', width: 100, aggFunc: 'sum', valueFormatter: fmtInt },
      { field: 'dv01', headerName: 'DV01', type: 'rightAligned', width: 96, aggFunc: 'sum', valueFormatter: fmt2 },
    ],
    [],
  );
  const aggFuncs = useMemo(() => ({ weightedAverage }), []);
  const apiRef = useRef<import('ag-grid-community').GridApi<Bond> | null>(null);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Row grouping &amp; aggregation</h2>
        <p>
          Group by desk → sector with the row group panel (drag headers into it). Aggregations: sum
          on notional / PnL / DV01, weighted-average spread and yield by notional.
        </p>
      </div>
      <div className="controls">
        <button type="button" onClick={() => apiRef.current?.expandAll()}>
          Expand all
        </button>
        <button type="button" onClick={() => apiRef.current?.collapseAll()}>
          Collapse all
        </button>
      </div>
      <div className="grid-wrap">
        <AgGridReact<Bond>
          theme={gridTheme}
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
          aggFuncs={aggFuncs}
          groupDefaultExpanded={1}
          groupTotalRow="bottom"
          grandTotalRow="bottom"
          rowGroupPanelShow="always"
          suppressAggFuncInHeader

          autoGroupColumnDef={{ headerName: 'Group', pinned: 'left', width: 220 }}
          onGridReady={(e) => {
            apiRef.current = e.api;
          }}
        />
      </div>
    </main>
  );
}
