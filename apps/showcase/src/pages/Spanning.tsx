import { useEffect, useMemo, useRef, useState } from 'react';
import type { ColDef, Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { fetchOlympicData, type OlympicRow } from '../olympic';
import { FI_ID, FI_GET_ROW_ID } from '../stomp/fiColumns';
import type { FiPosition } from '../stomp/fiPositionsSource';
import { useFiFeed, useFiUpdates } from '../stomp/sharedFeed';
import { FeedBadge } from '../stomp/FeedBadge';

type SpanMode = 'colspan' | 'rowspan';

const COUNTRY_BG = 'rgba(43, 108, 176, 0.35)';

/** Live colSpan demo: Desk stands in for Country — 'Govies' spans 2
 * columns, 'IG Credit' spans 4, mirroring the Russia/US example. */
const liveColSpanDefs: ColDef<FiPosition>[] = [
  { ...FI_ID, pinned: 'left', width: 110 },
  { field: 'ticker', headerName: 'Ticker', pinned: 'left', width: 90 },
  {
    field: 'desk',
    headerName: 'Desk',
    width: 150,
    colSpan: (p) => {
      const desk = p.data?.desk;
      if (desk === 'Govies') return 2;
      if (desk === 'IG Credit') return 4;
      return 1;
    },
    cellStyle: { backgroundColor: COUNTRY_BG },
  },
  { field: 'region', headerName: 'Region', width: 100 },
  { field: 'quantity', headerName: 'Qty', type: 'number', width: 90, format: '#,##0' },
  { field: 'maturityDate', headerName: 'Maturity', width: 110 },
  { field: 'issuer.sector', headerName: 'Sector', width: 110 },
  { field: 'notionalAmount', headerName: 'Notional', type: 'number', width: 120, format: '#,##0' },
  { field: 'marketValue', headerName: 'Mkt Value', type: 'number', width: 120, format: '#,##0' },
  { field: 'pnl', headerName: 'PnL', type: 'number', width: 100, format: '#,##0' },
  { field: 'dv01', headerName: 'DV01', type: 'number', width: 90, format: '#,##0.00' },
];

/** Live rowSpan demo: sorted by issuer.sector → desk → rating.composite so
 * contiguous equal values are visible and merge. A sector is excluded from
 * merging (mirrors the Algeria exclusion on Country). */
const liveRowSpanDefs: ColDef<FiPosition>[] = [
  {
    field: 'issuer.sector',
    headerName: 'Sector',
    width: 130,
    spanRows: ({ valueA, valueB }) => valueA !== 'Real Estate' && valueA === valueB,
  },
  {
    field: 'desk',
    headerName: 'Desk',
    width: 110,
    spanRows: true,
  },
  {
    field: 'rating.composite',
    headerName: 'Rating',
    width: 90,
    spanRows: true,
  },
  { ...FI_ID, width: 110 },
  { field: 'ticker', headerName: 'Ticker', width: 90 },
  { field: 'quantity', headerName: 'Qty', type: 'number', width: 90, format: '#,##0' },
  { field: 'notionalAmount', headerName: 'Notional', type: 'number', width: 120, format: '#,##0' },
  { field: 'pnl', headerName: 'PnL', type: 'number', width: 100, format: '#,##0' },
  { field: 'dv01', headerName: 'DV01', type: 'number', width: 90, format: '#,##0.00' },
];

/**
 * Mirrors AG Grid column-spanning + row-spanning docs.
 * https://www.ag-grid.com/react-data-grid/column-spanning/
 * https://www.ag-grid.com/react-data-grid/row-spanning/
 */
export function SpanningPage() {
  const { rows, status } = useFiFeed();
  const live = status === 'ready' && rows;
  const liveApiRef = useRef<Tabular<FiPosition> | null>(null);
  useFiUpdates(
    (batch) => liveApiRef.current?.applyTransactionAsync({ update: batch }),
    !!live,
  );

  const [rowData, setRowData] = useState<OlympicRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<SpanMode>('colspan');

  useEffect(() => {
    fetchOlympicData()
      .then(setRowData)
      .catch((e) => setLoadError(String(e)));
  }, []);

  const colSpanDefs = useMemo<ColDef<OlympicRow>[]>(
    () => [
      { field: 'athlete', pinned: 'left', width: 150 },
      { field: 'age', pinned: 'left', type: 'number', width: 90 },
      {
        field: 'country',
        width: 150,
        // AG docs example: Russia spans 2 columns, United States spans 4.
        colSpan: (p) => {
          const country = p.data?.country;
          if (country === 'Russia') return 2;
          if (country === 'United States') return 4;
          return 1;
        },
        cellStyle: { backgroundColor: COUNTRY_BG },
      },
      {
        field: 'year',
        type: 'number',
        width: 90,
        valueFormatter: (p) => (p.value == null ? '' : String(p.value)),
      },
      { field: 'date', width: 110 },
      { field: 'sport', width: 150 },
      { field: 'gold', type: 'number', width: 90 },
      { field: 'silver', type: 'number', width: 90 },
      { field: 'bronze', type: 'number', width: 90 },
      { field: 'total', type: 'number', width: 90 },
    ],
    [],
  );

  const rowSpanDefs = useMemo<ColDef<OlympicRow>[]>(
    () => [
      {
        field: 'country',
        width: 150,
        sort: 'asc',
        // Custom merge (AG docs): Algeria never merges.
        spanRows: ({ valueA, valueB }) => valueA !== 'Algeria' && valueA === valueB,
      },
      {
        field: 'year',
        type: 'number',
        width: 90,
        spanRows: true,
        valueFormatter: (p) => (p.value == null ? '' : String(p.value)),
      },
      { field: 'sport', width: 150, spanRows: true },
      { field: 'athlete', width: 150 },
      { field: 'age', type: 'number', width: 90 },
      { field: 'gold', type: 'number', width: 90 },
      { field: 'silver', type: 'number', width: 90 },
      { field: 'bronze', type: 'number', width: 90 },
      { field: 'total', type: 'number', width: 90 },
    ],
    [],
  );

  const colspan = mode === 'colspan';

  return (
    <main className="page">
      <div className="page-head">
        <h2>Cell spanning</h2>
        <p>
          <b>Column spanning</b>: <code>colSpan</code> — Russia spans 2 columns, United States
          spans 4; spans stop at the pinned-region boundary (drag Country into the pinned area to
          see it constrained). <b>Row spanning</b>: <code>enableCellSpan</code> +{' '}
          <code>spanRows</code> — contiguous equal values merge; Algeria is excluded via a custom
          callback. Click a merged cell to focus its anchor; arrows skip covered cells.
          {live ? (
            <>
              {' '}
              Live FI positions — Desk stands in for Country in the colSpan demo; the rowSpan demo
              sorts by <code>issuer.sector</code> → Desk → <code>rating.composite</code> so
              contiguous spans are visible (a sector is excluded from merging, mirroring Algeria).
            </>
          ) : null}
        </p>
      </div>
      <div className="controls">
        <button type="button" className={colspan ? 'active' : ''} onClick={() => setMode('colspan')}>
          Column spanning
        </button>
        <button type="button" className={!colspan ? 'active' : ''} onClick={() => setMode('rowspan')}>
          Row spanning
        </button>
      </div>
      {live ? (
        <div className="grid-wrap">
          <TabularGrid<FiPosition>
            key={`stomp-${mode}`}
            columnDefs={colspan ? liveColSpanDefs : liveRowSpanDefs}
            rowData={rows}
            getRowId={FI_GET_ROW_ID}
            enableCellSpan={!colspan}
            cellSelection
            density="compact"
            onReady={(api) => {
              liveApiRef.current = api;
              if (!colspan) {
                // Multi-column sort so contiguous equal values line up and
                // the spanRows merges above are actually visible.
                api.setSort('issuer.sector', 'asc', false);
                api.setSort('desk', 'asc', true);
                api.setSort('rating.composite', 'asc', true);
              }
            }}
          />
        </div>
      ) : loadError ? (
        <div className="status">Failed to load Olympic data: {loadError}</div>
      ) : (
        <div className="grid-wrap">
          <TabularGrid<OlympicRow>
            key={mode}
            columnDefs={colspan ? colSpanDefs : rowSpanDefs}
            rowData={rowData}
            enableCellSpan={!colspan}
            cellSelection
            density="compact"
          />
        </div>
      )}
      <div className="status">
        <FeedBadge status={status} />
      </div>
    </main>
  );
}
