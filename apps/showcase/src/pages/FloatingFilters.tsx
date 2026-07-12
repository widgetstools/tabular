import { useMemo, useRef, useState } from 'react';
import type { Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';
import { FI_COLUMNS, FI_GET_ROW_ID } from '../stomp/fiColumns';
import type { FiPosition } from '../stomp/fiPositionsSource';
import { useFiFeed, useFiUpdates } from '../stomp/sharedFeed';
import { FeedBadge } from '../stomp/FeedBadge';

/** Live columns: set filters on desk/rating.composite/issuer.sector, text on ticker, number on measures. */
const liveColumnDefs = FI_COLUMNS.map((c) => {
  if (c.field === 'desk' || c.field === 'rating.composite' || c.field === 'issuer.sector') {
    return { ...c, filter: 'set' as const };
  }
  if (c.field === 'ticker') {
    return { ...c, filter: 'text' as const };
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

export function FloatingFiltersPage() {
  const { rows, status } = useFiFeed();
  const live = status === 'ready' && rows;
  const rowData = useMemo(() => makeBonds(15_000), []);
  const columnDefs = useMemo(
    () =>
      bondColumns().map((c) =>
        // Categorical columns get AG-style set filters (checkbox dropdowns).
        c.field === 'sector' || c.field === 'rating' || c.field === 'desk'
          ? { ...c, filter: 'set' as const }
          : c,
      ),
    [],
  );
  const apiRef = useRef<Tabular<Bond> | null>(null);
  const liveApiRef = useRef<Tabular<FiPosition> | null>(null);
  const [quick, setQuick] = useState('');
  const [displayed, setDisplayed] = useState(15_000);
  const [modified, setModified] = useState('—');
  const [hideHy, setHideHy] = useState(false);

  useFiUpdates(
    (batch) => liveApiRef.current?.applyTransactionAsync({ update: batch }),
    !!live,
  );

  return (
    <main className="page">
      <div className="page-head">
        <h2>Floating filters</h2>
        <p>
          Filter row sits below column headers on <code>surface.raised</code> with a structural
          underline. Canvas shows the active filter; click a cell to open a DOM input.{' '}
          {live ? (
            <>
              <b>Desk, Rating and Sector are set filters</b> — click their filter cell for a
              checkbox dropdown; Ticker is a text filter.
            </>
          ) : (
            <>
              <b>Sector, Rating and Desk are set filters</b> — click their filter cell for a
              checkbox dropdown; typing in the filter box searches the values.
            </>
          )}{' '}
          Quick filter tokenizes on whitespace (all tokens must match). External filter example
          hides HY-rated {live ? 'positions' : 'bonds'}.
        </p>
      </div>
      <div className="controls">
        <input
          type="text"
          placeholder="Quick filter (tokenized)…"
          value={quick}
          onChange={(e) => {
            setQuick(e.target.value);
            (live ? liveApiRef.current : apiRef.current)?.setQuickFilter(e.target.value);
          }}
        />
        <label>
          <input
            type="checkbox"
            checked={hideHy}
            onChange={(e) => {
              setHideHy(e.target.checked);
            }}
          />{' '}
          External: hide HY ratings
        </label>
        <button
          onClick={() => {
            setQuick('');
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
            floatingFilter
            defaultColDef={{ filter: true, floatingFilter: true }}
            density="compact"
            isExternalFilterPresent={() => hideHy}
            doesExternalFilterPass={(row) =>
              !String((row.rating as { composite?: string } | undefined)?.composite ?? '').startsWith('HY')
            }
            onReady={(api) => {
              liveApiRef.current = api;
              api.on('modelUpdated', (e) => setDisplayed(e.displayedRowCount));
              api.on('filterModified', (e) =>
                setModified(e.filter ? `${e.colId}: ${JSON.stringify(e.filter)}` : `${e.colId}: cleared`),
              );
            }}
          />
        ) : (
          <TabularGrid<Bond>
            key="synthetic"
            columnDefs={columnDefs}
            rowData={rowData}
            getRowId={(p) => p.data.id}
            floatingFilter
            defaultColDef={{ filter: true, floatingFilter: true }}
            density="compact"
            isExternalFilterPresent={() => hideHy}
            doesExternalFilterPass={(row) => !row.rating.startsWith('HY')}
            onReady={(api) => {
              apiRef.current = api;
              api.on('modelUpdated', (e) => setDisplayed(e.displayedRowCount));
              api.on('filterModified', (e) =>
                setModified(e.filter ? `${e.colId}: ${JSON.stringify(e.filter)}` : `${e.colId}: cleared`),
              );
            }}
          />
        )}
      </div>
      <div className="status">
        <span>
          Displayed <b>{displayed.toLocaleString()}</b> of{' '}
          <b>{live ? live.length.toLocaleString() : '15,000'}</b>
        </span>
        <span>
          Last filter edit <b>{modified}</b>
        </span>
        <FeedBadge status={status} />
      </div>
    </main>
  );
}
