import { useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { AgGridReact as AgGridReactType } from 'ag-grid-react';
import type { ColDef, RowClassRules } from 'ag-grid-community';
import { makeBonds, type Bond } from '../data';
import { gridTheme } from '../theme';

const IG = new Set(['AAA', 'AA+', 'AA', 'AA-', 'A+', 'A', 'A-', 'BBB+', 'BBB', 'BBB-']);
const HY = new Set(['BB+', 'BB', 'BB-', 'B+', 'B', 'B-']);

export function RenderingPage() {
  const rowData = useMemo(() => makeBonds(120), []);
  const columnDefs = useMemo<ColDef<Bond>[]>(
    () => [
      { field: 'cusip', headerName: 'CUSIP', pinned: 'left', width: 110 },
      { field: 'issuer', headerName: 'Issuer', width: 150 },
      {
        field: 'rating',
        headerName: 'Rating',
        width: 78,
        cellClassRules: {
          'rating-ig': (p) => IG.has(String(p.value)),
          'rating-hy': (p) => HY.has(String(p.value)),
          'rating-dist': (p) => !IG.has(String(p.value)) && !HY.has(String(p.value)),
        },
      },
      {
        field: 'spread',
        headerName: 'Spread',
        type: 'numericColumn',
        width: 88,
        valueFormatter: (p) => (typeof p.value === 'number' ? `${Math.round(p.value)} bp` : ''),
        cellClassRules: {
          'spread-hot': (p) => typeof p.value === 'number' && p.value >= 400,
          'spread-warm': (p) => typeof p.value === 'number' && p.value >= 250 && p.value < 400,
        },
      },
      {
        field: 'price',
        headerName: 'Price',
        type: 'numericColumn',
        width: 92,
        enableCellChangeFlash: true,
        valueFormatter: (p) => (typeof p.value === 'number' ? p.value.toFixed(2) : ''),
      },
      {
        field: 'pnl',
        headerName: 'PnL',
        type: 'numericColumn',
        width: 108,
        valueFormatter: (p) => {
          const v = p.value as number;
          return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v)).toLocaleString()}`;
        },
        cellStyle: (p) => {
          const v = p.value as number;
          return v > 0 ? { color: '#3ecf8e' } : v < 0 ? { color: '#f85149' } : undefined;
        },
      },
      {
        field: 'notional',
        headerName: 'Notional',
        type: 'numericColumn',
        width: 116,
        valueFormatter: (p) => (typeof p.value === 'number' ? Math.round(p.value).toLocaleString() : ''),
      },
    ] as ColDef<Bond>[],
    [],
  );
  const rowClassRules = useMemo<RowClassRules<Bond>>(
    () => ({
      'row-pnl-risk': (p) => typeof p.data?.pnl === 'number' && Math.abs(p.data.pnl) >= 500_000,
    }),
    [],
  );
  const gridRef = useRef<AgGridReactType<Bond>>(null);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Rendering features</h2>
        <p>AG Grid reference — cell styles, class rules, value formatters, and flash.</p>
      </div>
      <div className="controls">
        <button
          type="button"
          onClick={() => {
            const api = gridRef.current?.api;
            const row = rowData[0];
            if (!api || !row) return;
            api.applyTransaction({
              update: [{ ...row, price: row.price + (Math.random() > 0.5 ? 0.05 : -0.05) }],
            });
          }}
        >
          Tick row 1 price
        </button>
        <button
          type="button"
          onClick={() => {
            const api = gridRef.current?.api;
            if (!api) return;
            const nodes = [api.getDisplayedRowAtIndex(0), api.getDisplayedRowAtIndex(1)].filter(Boolean);
            api.flashCells({ rowNodes: nodes as never[], columns: ['price', 'pnl'] });
          }}
        >
          Flash rows 1–2
        </button>
      </div>
      <div className="grid-wrap agref-rendering">
        <AgGridReact<Bond>
          ref={gridRef}
          theme={gridTheme}
          rowData={rowData}
          columnDefs={columnDefs}
          getRowId={(p) => p.data.id}
          rowClassRules={rowClassRules}
          cellFlashDuration={500}
          cellFadeDuration={1000}
        />
      </div>
      <style>{`
        .agref-rendering .rating-ig { background-color: rgba(42, 120, 80, 0.28); }
        .agref-rendering .rating-hy { background-color: rgba(160, 90, 30, 0.3); }
        .agref-rendering .rating-dist { background-color: rgba(140, 40, 40, 0.32); }
        .agref-rendering .spread-hot { background-color: rgba(220, 60, 60, 0.24); font-weight: 600; }
        .agref-rendering .spread-warm { background-color: rgba(220, 140, 40, 0.18); }
        .agref-rendering .row-pnl-risk { background-color: rgba(120, 40, 120, 0.14); }
      `}</style>
    </main>
  );
}
