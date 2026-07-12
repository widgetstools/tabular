import { useMemo, useRef } from 'react';
import type { AnyColDef, Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';
import { FI_ID, FI_GET_ROW_ID } from '../stomp/fiColumns';
import type { FiPosition } from '../stomp/fiPositionsSource';
import { useFiFeed, useFiUpdates } from '../stomp/sharedFeed';
import { FeedBadge } from '../stomp/FeedBadge';

/** Live columns: same column-group / sideBar / statusBar shape over FI
 * fields. issuer.name / issuer.sector / rating.composite are nested
 * dot-path columns. */
const liveColumnDefs: AnyColDef<FiPosition>[] = [
  { ...FI_ID, pinned: 'left' },
  {
    headerName: 'Instrument',
    children: [
      { field: 'issuer.name', headerName: 'Issuer', width: 160, filter: 'text' },
      {
        field: 'issuer.sector',
        headerName: 'Sector',
        width: 110,
        filter: 'text',
        enableRowGroup: true,
        enablePivot: true,
      },
      {
        field: 'rating.composite',
        headerName: 'Rating',
        width: 78,
        align: 'center',
        filter: 'text',
        enableRowGroup: true,
        enablePivot: true,
      },
    ],
  },
  {
    headerName: 'Market',
    children: [
      { field: 'currentPrice', headerName: 'Price', type: 'number', width: 92, enableValue: true, filter: 'number' },
      { field: 'spread', headerName: 'Spread', type: 'number', width: 84, enableValue: true, filter: 'number' },
      { field: 'notionalAmount', headerName: 'Notional', type: 'number', width: 116, enableValue: true, filter: 'number' },
    ],
  },
  {
    field: 'desk',
    headerName: 'Desk',
    width: 100,
    filter: 'text',
    enableRowGroup: true,
    enablePivot: true,
  },
];

export function MiscPage() {
  const { rows, status } = useFiFeed();
  const live = status === 'ready' && rows;
  const liveApiRef = useRef<Tabular<FiPosition> | null>(null);
  useFiUpdates(
    (batch) => liveApiRef.current?.applyTransactionAsync({ update: batch }),
    !!live,
  );

  const rowData = useMemo(() => makeBonds(300), []);
  const columnDefs = useMemo<AnyColDef<Bond>[]>(
    () => [
      { field: 'cusip', headerName: 'CUSIP', pinned: 'left', width: 110 },
      {
        headerName: 'Instrument',
        children: [
          { field: 'issuer', headerName: 'Issuer', width: 160, filter: 'text' },
          {
            field: 'sector',
            headerName: 'Sector',
            width: 110,
            filter: 'text',
            enableRowGroup: true,
            enablePivot: true,
          },
          {
            field: 'rating',
            headerName: 'Rating',
            width: 78,
            align: 'center',
            filter: 'text',
            enableRowGroup: true,
            enablePivot: true,
          },
        ],
      },
      {
        headerName: 'Market',
        children: [
          { field: 'price', headerName: 'Price', type: 'number', width: 92, enableValue: true, filter: 'number' },
          { field: 'spread', headerName: 'Spread', type: 'number', width: 84, enableValue: true, filter: 'number' },
          { field: 'notional', headerName: 'Notional', type: 'number', width: 116, enableValue: true, filter: 'number' },
        ],
      },
      {
        field: 'desk',
        headerName: 'Desk',
        width: 100,
        filter: 'text',
        enableRowGroup: true,
        enablePivot: true,
      },
    ],
    [],
  );
  const apiRef = useRef<Tabular<Bond> | null>(null);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Misc — status bar &amp; side panel</h2>
        <p>
          AG-shaped <code>statusBar</code> panels (row counts, selection, range aggregation) and{' '}
          <code>sideBar</code> with Columns + Filters tool panels. Column groups mirror AG examples —
          expand/collapse in the panel, drag to Row Groups / Values / Column Labels, and filter by column.
          {live ? (
            <>
              {' '}
              Live FI positions — <code>issuer.name</code> / <code>issuer.sector</code> /{' '}
              <code>rating.composite</code> are nested dot-path columns.
            </>
          ) : null}
        </p>
      </div>
      <div className="controls">
        <button
          type="button"
          onClick={() => (live ? liveApiRef.current : apiRef.current)?.openToolPanel('columns')}
        >
          Open Columns panel
        </button>
        <button
          type="button"
          onClick={() => (live ? liveApiRef.current : apiRef.current)?.openToolPanel('filters')}
        >
          Open Filters panel
        </button>
        <button
          type="button"
          onClick={() => (live ? liveApiRef.current : apiRef.current)?.closeToolPanel()}
        >
          Close panel
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
            floatingFilter
            rowSelection={{ mode: 'multiRow', enableClickSelection: false }}
            cellSelection
            rowGroupPanelShow="onlyWhenGrouping"
            pivotPanelShow="onlyWhenPivoting"
            sideBar
            statusBar={{
              statusPanels: [
                { statusPanel: 'agTotalAndFilteredRowCountComponent', align: 'left' },
                { statusPanel: 'agSelectedRowCountComponent', align: 'left' },
                { statusPanel: 'agAggregationComponent', align: 'right' },
              ],
            }}
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
            floatingFilter
            rowSelection={{ mode: 'multiRow', enableClickSelection: false }}
            cellSelection
            rowGroupPanelShow="onlyWhenGrouping"
            pivotPanelShow="onlyWhenPivoting"
            sideBar
            statusBar={{
              statusPanels: [
                { statusPanel: 'agTotalAndFilteredRowCountComponent', align: 'left' },
                { statusPanel: 'agSelectedRowCountComponent', align: 'left' },
                { statusPanel: 'agAggregationComponent', align: 'right' },
              ],
            }}
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
