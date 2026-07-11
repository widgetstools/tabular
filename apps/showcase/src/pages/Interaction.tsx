import { useMemo, useRef } from 'react';
import type { Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';

export function InteractionPage() {
  const rowData = useMemo(() => makeBonds(200), []);
  const columnDefs = useMemo(
    () => [
      { field: 'cusip', headerName: 'CUSIP', pinned: 'left' as const, width: 110 },
      {
        field: 'issuer',
        headerName: 'Issuer',
        width: 140,
        tooltipField: 'issuer',
      },
      {
        field: 'sector',
        headerName: 'Sector',
        width: 100,
        headerTooltip: 'GICS sector classification',
      },
      { field: 'rating', headerName: 'Rating', width: 78, align: 'center' as const },
      {
        field: 'price',
        headerName: 'Price',
        type: 'number' as const,
        width: 92,
        editable: true,
        tooltipValueGetter: (p: { value: unknown }) =>
          p.value == null ? '' : `Last price: ${Number(p.value).toFixed(2)}`,
      },
      {
        field: 'notional',
        headerName: 'Notional',
        type: 'number' as const,
        width: 116,
        valueFormatter: (p: { value: unknown }) =>
          typeof p.value === 'number' ? Math.round(p.value).toLocaleString() : '',
      },
    ],
    [],
  );
  const apiRef = useRef<Tabular<Bond> | null>(null);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Interaction &amp; navigation</h2>
        <p>
          Keyboard: arrows, Page Up/Down, Home/End, Ctrl+arrows (jump), Tab / Shift-Tab, Enter /
          Shift+Enter, F2. Cell focus ring on the overlay layer. DOM tooltips with AG delays (
          <code>tooltipShowDelay</code>).
        </p>
      </div>
      <div className="controls">
        <button
          type="button"
          onClick={() => {
            const api = apiRef.current;
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
            apiRef.current?.setFocusedCell(150, 'cusip');
            apiRef.current?.ensureIndexVisible(150, 'middle');
          }}
        >
          Scroll to row 151
        </button>
        <button
          type="button"
          onClick={() => {
            apiRef.current?.setFocusedCell(0, 'notional');
            apiRef.current?.ensureColumnVisible('notional', 'middle');
          }}
        >
          Scroll to Notional col
        </button>
        <button type="button" onClick={() => apiRef.current?.clearFocusedCell()}>
          Clear focus
        </button>
      </div>
      <div className="grid-wrap">
        <TabularGrid<Bond>
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
          density="compact"
          cellSelection
          tooltipShowDelay={600}
          onReady={(api) => {
            apiRef.current = api;
          }}
        />
      </div>
    </main>
  );
}
