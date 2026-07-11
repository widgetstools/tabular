import { useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, ColGroupDef } from 'ag-grid-community';
import { gridTheme } from '../theme';
import { makeBonds, type Bond } from '../data';

const fmtInt = (p: { value: unknown }) =>
  typeof p.value === 'number' ? Math.round(p.value).toLocaleString() : '';
const fmt2 = (p: { value: unknown }) =>
  typeof p.value === 'number'
    ? p.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '';

export function ColumnGroupsPage() {
  const rowData = useMemo(() => makeBonds(400), []);
  const columnDefs = useMemo<(ColDef<Bond> | ColGroupDef<Bond>)[]>(
    () => [
      { field: 'cusip', headerName: 'CUSIP', pinned: 'left', width: 110 },
      {
        headerName: 'Instrument',
        children: [
          { field: 'issuer', headerName: 'Issuer', width: 160 },
          { field: 'sector', headerName: 'Sector', width: 110 },
          { field: 'rating', headerName: 'Rating', width: 78 },
        ],
      },
      {
        headerName: 'Terms',
        children: [
          { field: 'coupon', headerName: 'Coupon', type: 'rightAligned', width: 84, valueFormatter: fmt2 },
          { field: 'maturity', headerName: 'Maturity', width: 104 },
        ],
      },
      {
        headerName: 'Market',
        children: [
          {
            headerName: 'Levels',
            children: [
              { field: 'price', headerName: 'Price', type: 'rightAligned', width: 92, valueFormatter: fmt2 },
              { field: 'yld', headerName: 'Yield', type: 'rightAligned', width: 84, valueFormatter: fmt2 },
              { field: 'spread', headerName: 'Spread', type: 'rightAligned', width: 84, valueFormatter: fmtInt },
            ],
          },
          { field: 'dv01', headerName: 'DV01', type: 'rightAligned', width: 96, columnGroupShow: 'open', valueFormatter: fmt2 },
          { field: 'notional', headerName: 'Notional', type: 'rightAligned', width: 116, valueFormatter: fmtInt },
        ],
      },
      {
        headerName: 'Desk',
        children: [
          { field: 'desk', headerName: 'Desk', width: 100 },
          { field: 'trader', headerName: 'Trader', width: 90, columnGroupShow: 'open' },
        ],
      },
    ],
    [],
  );

  return (
    <main className="page">
      <div className="page-head">
        <h2>Column groups</h2>
        <p>Nested column group headers; groups with columnGroupShow children are expandable.</p>
      </div>
      <div className="grid-wrap">
        <AgGridReact<Bond>
          theme={gridTheme}
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
        />
      </div>
    </main>
  );
}
