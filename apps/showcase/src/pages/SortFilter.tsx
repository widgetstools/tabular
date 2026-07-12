import { useMemo, useRef, useState } from 'react';
import type { Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';
import { FI_COLUMNS, FI_GET_ROW_ID } from '../stomp/fiColumns';
import type { FiPosition } from '../stomp/fiPositionsSource';
import { useFiFeed, useFiUpdates } from '../stomp/sharedFeed';
import { FeedBadge } from '../stomp/FeedBadge';

/** Live columns: set filters on desk / region / rating.composite, numeric filters on measures. */
const liveColumnDefs = FI_COLUMNS.map((c) => {
  if (c.field === 'desk' || c.field === 'region' || c.field === 'rating.composite') {
    return { ...c, filter: 'set' as const };
  }
  if (
    c.field === 'quantity' ||
    c.field === 'notionalAmount' ||
    c.field === 'marketValue' ||
    c.field === 'pnl' ||
    c.field === 'dailyPnl' ||
    c.field === 'yield' ||
    c.field === 'dv01' ||
    c.field === 'spread' ||
    c.field === 'riskMetrics.var95'
  ) {
    return { ...c, filter: 'number' as const };
  }
  return c;
});

export function SortFilterPage() {
  const { rows, status } = useFiFeed();
  const live = status === 'ready' && rows;
  const rowData = useMemo(() => makeBonds(20_000), []);
  const columnDefs = useMemo(() => bondColumns(), []);
  const apiRef = useRef<Tabular<Bond> | null>(null);
  const liveApiRef = useRef<Tabular<FiPosition> | null>(null);
  const [quick, setQuick] = useState('');
  const [minSpread, setMinSpread] = useState('');
  const [issuer, setIssuer] = useState('');
  const [displayed, setDisplayed] = useState(20_000);
  const [sortDesc, setSortDesc] = useState('none');

  useFiUpdates(
    (batch) => liveApiRef.current?.applyTransactionAsync({ update: batch }),
    !!live,
  );

  const applySpread = (v: string) => {
    setMinSpread(v);
    const n = Number(v);
    const filter = v.trim() !== '' && !Number.isNaN(n) ? { type: 'greaterThan' as const, filter: n } : null;
    if (live) {
      liveApiRef.current?.setColumnFilter('spread', filter);
    } else {
      apiRef.current?.setColumnFilter('spread', filter);
    }
  };
  const applyIssuer = (v: string) => {
    setIssuer(v);
    const filter = v.trim() ? { type: 'contains' as const, filter: v } : null;
    if (live) {
      liveApiRef.current?.setColumnFilter('issuer.name', filter);
    } else {
      apiRef.current?.setColumnFilter('issuer', filter);
    }
  };

  return (
    <main className="page">
      <div className="page-head">
        <h2>Sorting &amp; filtering</h2>
        <p>
          {live ? 'Live FI positions' : '20,000 rows'}. Quick filter scans every displayed column;
          column filters combine with AND. A filtered column shows a 2px accent bar under its
          header — state drawn as a property of the column edge, not an icon. Click headers to
          sort; shift-click adds a secondary sort with a superscript index.
        </p>
      </div>
      <div className="controls">
        <input
          type="text"
          placeholder="Quick filter…"
          value={quick}
          onChange={(e) => {
            setQuick(e.target.value);
            (live ? liveApiRef.current : apiRef.current)?.setQuickFilter(e.target.value);
          }}
        />
        <label>
          Issuer contains{' '}
          <input type="text" value={issuer} onChange={(e) => applyIssuer(e.target.value)} />
        </label>
        <label>
          Spread &gt;{' '}
          <input
            type="number"
            value={minSpread}
            style={{ width: 90 }}
            onChange={(e) => applySpread(e.target.value)}
          />
        </label>
        <button
          onClick={() => {
            setQuick('');
            setMinSpread('');
            setIssuer('');
            (live ? liveApiRef.current : apiRef.current)?.setQuickFilter('');
            (live ? liveApiRef.current : apiRef.current)?.setFilterModel({});
          }}
        >
          Clear filters
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
            rowSelection="single"
            onReady={(api) => {
              liveApiRef.current = api;
              api.on('modelUpdated', (e) => setDisplayed(e.displayedRowCount));
              api.on('sortChanged', (e) =>
                setSortDesc(
                  e.sortModel.length
                    ? e.sortModel.map((s) => `${s.colId} ${s.sort}`).join(', ')
                    : 'none',
                ),
              );
            }}
          />
        ) : (
          <TabularGrid<Bond>
            key="synthetic"
            columnDefs={columnDefs}
            rowData={rowData}
            getRowId={(p) => p.data.id}
            density="compact"
            rowSelection="single"
            onReady={(api) => {
              apiRef.current = api;
              api.on('modelUpdated', (e) => setDisplayed(e.displayedRowCount));
              api.on('sortChanged', (e) =>
                setSortDesc(
                  e.sortModel.length
                    ? e.sortModel.map((s) => `${s.colId} ${s.sort}`).join(', ')
                    : 'none',
                ),
              );
            }}
          />
        )}
      </div>
      <div className="status">
        <span>
          Displayed <b>{displayed.toLocaleString()}</b> of{' '}
          <b>{live ? live.length.toLocaleString() : '20,000'}</b>
        </span>
        <span>
          Sort <b>{sortDesc}</b>
        </span>
        <FeedBadge status={status} />
      </div>
    </main>
  );
}
