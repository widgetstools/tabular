import { useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { AgGridReact as AgGridReactType } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { makeBonds, type Bond } from '../data';
import { gridTheme } from '../theme';

export function InteractionPage() {
  const rowData = useMemo(() => makeBonds(200), []);
  const columnDefs = useMemo<ColDef<Bond>[]>(
    () => [
      { field: 'cusip', headerName: 'CUSIP', pinned: 'left', width: 110 },
      { field: 'issuer', headerName: 'Issuer', width: 140, tooltipField: 'issuer' },
      { field: 'sector', headerName: 'Sector', width: 100, headerTooltip: 'GICS sector classification' },
      { field: 'rating', headerName: 'Rating', width: 78 },
      {
        field: 'price',
        headerName: 'Price',
        type: 'numericColumn',
        width: 92,
        editable: true,
        valueFormatter: (p) =>
          typeof p.value === 'number'
            ? p.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : '',
      },
      {
        field: 'notional',
        headerName: 'Notional',
        type: 'numericColumn',
        width: 116,
        valueFormatter: (p) => (typeof p.value === 'number' ? Math.round(p.value).toLocaleString() : ''),
      },
    ],
    [],
  );
  const gridRef = useRef<AgGridReactType<Bond>>(null);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Interaction &amp; navigation</h2>
        <p>AG Grid reference — keyboard navigation, focus, and tooltips.</p>
      </div>
      <div className="controls">
        <button
          type="button"
          onClick={() => {
            const api = gridRef.current?.api;
            if (!api) return;
            api.setFocusedCell(0, 'cusip');
            api.ensureIndexVisible(0, 'top');
          }}
        >
          Focus CUSIP
        </button>
        <button
          type="button"
          onClick={() => {
            const api = gridRef.current?.api;
            api?.setFocusedCell(150, 'cusip');
            api?.ensureIndexVisible(150, 'middle');
          }}
        >
          Scroll to row 151
        </button>
        <button
          type="button"
          onClick={() => {
            const api = gridRef.current?.api;
            api?.setFocusedCell(0, 'notional');
            api?.ensureColumnVisible('notional', 'middle');
          }}
        >
          Scroll to Notional col
        </button>
      </div>
      <div className="grid-wrap">
        <AgGridReact<Bond>
          ref={gridRef}
          theme={gridTheme}
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
          cellSelection
          tooltipShowDelay={600}
        />
      </div>
    </main>
  );
}
