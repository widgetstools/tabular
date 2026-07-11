import { useMemo, useRef, useState } from 'react';
import type { ColDef, Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';

const mainMode =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('main') === '1';

const compareMode =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('compare') === '1';

export function GroupingPage() {
  const rowData = useMemo(() => makeBonds(2_000), []);
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
          Group by desk → sector with an auto group column (▸/▾). Aggregations: sum on notional /
          PnL / DV01, weighted-average spread and yield by notional. Group total rows and a grand
          total appear at the bottom of each expanded group. Sticky group headers keep the current
          group label visible while scrolling within it. Uses the worker data plane by default
          {compareMode && !mainMode ? (
            <>
              {' '}
              (<b>compare mode</b> via <code>?compare=1</code>)
            </>
          ) : null}
          {mainMode ? (
            <>
              {' '}
              — forced <b>main thread</b> via <code>?main=1</code>
            </>
          ) : null}
          .
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
        <TabularGrid<Bond>
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
            api.on('rowGroupOpened', () =>
              setDisplayed(api.getDisplayedRowCount()),
            );
          }}
        />
      </div>
      <div className="status">
        <span>
          Displayed nodes <b>{displayed.toLocaleString()}</b> (groups + leaves)
        </span>
        <span>
          Source rows <b>2,000</b>
        </span>
      </div>
    </main>
  );
}
