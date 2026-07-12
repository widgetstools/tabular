import { useMemo, useRef, useState } from 'react';
import type { ColDef, Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';
import { FI_ID, FI_DESC, FI_NESTED, FI_MEASURES, FI_GET_ROW_ID } from '../stomp/fiColumns';
import type { FiPosition } from '../stomp/fiPositionsSource';
import { useFiFeed, useFiUpdates } from '../stomp/sharedFeed';
import { FeedBadge } from '../stomp/FeedBadge';

const mainMode =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('main') === '1';

const compareMode =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('compare') === '1';

/**
 * Live columns: row-group desk → issuer.sector (deliberately nested group
 * key), aggregate sum on notionalAmount/pnl/dv01 + VaR 95.
 */
const liveColumnDefs: ColDef<FiPosition>[] = [
  FI_ID,
  ...FI_DESC.map((c) =>
    c.field === 'desk' ? { ...c, rowGroup: true, rowGroupIndex: 0 } : c,
  ),
  ...FI_NESTED.map((c) =>
    c.field === 'issuer.sector' ? { ...c, rowGroup: true, rowGroupIndex: 1 } : c,
  ),
  ...FI_MEASURES,
];

export function GroupingPage() {
  const { rows, status } = useFiFeed();
  const live = status === 'ready' && rows;
  const rowData = useMemo(() => makeBonds(2_000), []);
  const liveApiRef = useRef<Tabular<FiPosition> | null>(null);
  const [liveDisplayed, setLiveDisplayed] = useState(0);
  useFiUpdates(
    (batch) => liveApiRef.current?.applyTransactionAsync({ update: batch }),
    !!live,
  );
  const columnDefs = useMemo<ColDef<Bond>[]>(
    () => [
      { field: 'desk', headerName: 'Desk', rowGroup: true, rowGroupIndex: 0, enableRowGroup: true },
      { field: 'sector', headerName: 'Sector', rowGroup: true, rowGroupIndex: 1, enableRowGroup: true },
      { field: 'cusip', headerName: 'CUSIP', width: 110 },
      { field: 'issuer', headerName: 'Issuer', width: 150, enableRowGroup: true },
      { field: 'rating', headerName: 'Rating', width: 78, align: 'center', enableRowGroup: true },
      {
        field: 'spread',
        headerName: 'Spread',
        type: 'number',
        width: 90,
        aggFunc: 'weightedAverage',
        weightField: 'notional',
      },
      {
        field: 'yld',
        headerName: 'Yield',
        type: 'number',
        width: 84,
        aggFunc: 'weightedAverage',
        weightField: 'notional',
      },
      { field: 'notional', headerName: 'Notional', type: 'number', width: 116, aggFunc: 'sum' },
      { field: 'pnl', headerName: 'PnL', type: 'number', width: 100, aggFunc: 'sum' },
      { field: 'dv01', headerName: 'DV01', type: 'number', width: 96, aggFunc: 'sum' },
    ],
    [],
  );
  const apiRef = useRef<Tabular<Bond> | null>(null);
  const [displayed, setDisplayed] = useState(0);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Row grouping &amp; aggregation</h2>
        <p>
          {live ? (
            <>
              Live FI positions grouped desk → <code>issuer.sector</code> (a nested dot-path group
              key) with an auto group column (▸/▾). Aggregations: sum on notional / PnL / DV01 +
              VaR 95.
            </>
          ) : (
            <>
              Group by desk → sector with an auto group column (▸/▾). Aggregations: sum on
              notional / PnL / DV01, weighted-average spread and yield by notional.
            </>
          )}{' '}
          Group total rows and a grand total appear at the bottom of each expanded group. Sticky
          group headers keep the current group label visible while scrolling within it. The worker
          data plane is the default; append <code>?main=1</code> to force the UI thread
          {compareMode && !mainMode ? (
            <>
              , or <code>?compare=1</code> for differential checks
            </>
          ) : null}
          .
        </p>
      </div>
      <div className="controls">
        <button
          type="button"
          onClick={() => (live ? liveApiRef.current : apiRef.current)?.expandAll()}
        >
          Expand all
        </button>
        <button
          type="button"
          onClick={() => (live ? liveApiRef.current : apiRef.current)?.collapseAll()}
        >
          Collapse all
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
            groupDefaultExpanded={1}
            groupTotalRow="bottom"
            grandTotalRow="bottom"
            rowGroupPanelShow="always"
            rowSelection="single"
            suppressAggFuncInHeader
            onReady={(api) => {
              liveApiRef.current = api;
              api.on('modelUpdated', (e) => setLiveDisplayed(e.displayedRowCount));
              api.on('rowGroupOpened', () => setLiveDisplayed(api.getDisplayedRowCount()));
            }}
          />
        ) : (
          <TabularGrid<Bond>
            key="synthetic"
            columnDefs={columnDefs}
            rowData={rowData}
            getRowId={(p) => p.data.id}
            density="compact"
            groupDefaultExpanded={1}
            groupTotalRow="bottom"
            grandTotalRow="bottom"
            rowGroupPanelShow="always"
            rowSelection="single"
            suppressAggFuncInHeader
            rowDataMode={mainMode ? 'main' : undefined}
            workerCompareMode={compareMode && !mainMode}
            onReady={(api) => {
              apiRef.current = api;
              api.on('modelUpdated', (e) => setDisplayed(e.displayedRowCount));
              api.on('rowGroupOpened', () => setDisplayed(api.getDisplayedRowCount()));
            }}
          />
        )}
      </div>
      <div className="status">
        <span>
          Displayed nodes <b>{(live ? liveDisplayed : displayed).toLocaleString()}</b> (groups +
          leaves)
        </span>
        <span>
          Source rows <b>{live ? rows.length.toLocaleString() : '2,000'}</b>
        </span>
        <FeedBadge status={status} />
      </div>
    </main>
  );
}
