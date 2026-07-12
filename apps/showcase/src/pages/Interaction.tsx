import { useMemo, useRef } from 'react';
import type { ColDef, Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';
import { FI_ID, FI_GET_ROW_ID } from '../stomp/fiColumns';
import type { FiPosition } from '../stomp/fiPositionsSource';
import { useFiFeed, useFiUpdates } from '../stomp/sharedFeed';
import { FeedBadge } from '../stomp/FeedBadge';

/** Live columns: same tooltip/formatter demos over FI fields — issuer.name
 * and issuer.sector are the nested dot-path columns. */
const liveColumnDefs: ColDef<FiPosition>[] = [
  { ...FI_ID, pinned: 'left' },
  {
    field: 'issuer.name',
    headerName: 'Issuer',
    width: 140,
    tooltipField: 'issuer.name',
  },
  {
    field: 'issuer.sector',
    headerName: 'Sector',
    width: 100,
    headerTooltip: 'GICS sector classification',
  },
  { field: 'rating.composite', headerName: 'Rating', width: 78, align: 'center' },
  {
    field: 'currentPrice',
    headerName: 'Price',
    type: 'number',
    width: 92,
    editable: true,
    tooltipValueGetter: (p: { value: unknown }) =>
      p.value == null ? '' : `Last price: ${Number(p.value).toFixed(2)}`,
  },
  {
    field: 'notionalAmount',
    headerName: 'Notional',
    type: 'number',
    width: 116,
    valueFormatter: (p: { value: unknown }) =>
      typeof p.value === 'number' ? Math.round(p.value).toLocaleString() : '',
  },
];

export function InteractionPage() {
  const { rows, status } = useFiFeed();
  const live = status === 'ready' && rows;
  const liveApiRef = useRef<Tabular<FiPosition> | null>(null);
  useFiUpdates(
    (batch) => liveApiRef.current?.applyTransactionAsync({ update: batch }),
    !!live,
  );

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
          {live ? (
            <>
              {' '}
              Live FI positions — <code>issuer.name</code> / <code>issuer.sector</code> are nested
              dot-path columns.
            </>
          ) : null}
        </p>
      </div>
      <div className="controls">
        <button
          type="button"
          onClick={() => {
            const api = live ? liveApiRef.current : apiRef.current;
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
            const api = live ? liveApiRef.current : apiRef.current;
            api?.setFocusedCell(150, 'cusip');
            api?.ensureIndexVisible(150, 'middle');
          }}
        >
          Scroll to row 151
        </button>
        <button
          type="button"
          onClick={() => {
            const api = live ? liveApiRef.current : apiRef.current;
            api?.setFocusedCell(0, live ? 'notionalAmount' : 'notional');
            api?.ensureColumnVisible(live ? 'notionalAmount' : 'notional', 'middle');
          }}
        >
          Scroll to Notional col
        </button>
        <button
          type="button"
          onClick={() => (live ? liveApiRef.current : apiRef.current)?.clearFocusedCell()}
        >
          Clear focus
        </button>
      </div>
      <div className="grid-wrap">
        {live ? (
          <TabularGrid<FiPosition>
            key="stomp"
            columnDefs={liveColumnDefs}
            rowData={rows}
            getRowId={FI_GET_ROW_ID}
            density="compact"
            cellSelection
            tooltipShowDelay={600}
            onReady={(api) => {
              liveApiRef.current = api;
            }}
          />
        ) : (
          <TabularGrid<Bond>
            key="synthetic"
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
        )}
      </div>
      <div className="status">
        <FeedBadge status={status} />
      </div>
    </main>
  );
}
