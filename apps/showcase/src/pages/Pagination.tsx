import { useMemo, useRef } from 'react';
import type { Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';
import { FI_COLUMNS, FI_GET_ROW_ID } from '../stomp/fiColumns';
import type { FiPosition } from '../stomp/fiPositionsSource';
import { useFiFeed, useFiUpdates } from '../stomp/sharedFeed';
import { FeedBadge } from '../stomp/FeedBadge';

export function PaginationPage() {
  const { rows, status } = useFiFeed();
  const live = status === 'ready' && rows;
  const rowData = useMemo(() => makeBonds(500), []);
  const columnDefs = useMemo(() => bondColumns(), []);
  const apiRef = useRef<Tabular<Bond> | null>(null);
  const liveApiRef = useRef<Tabular<FiPosition> | null>(null);

  useFiUpdates(
    (batch) => liveApiRef.current?.applyTransactionAsync({ update: batch }),
    !!live,
  );

  return (
    <main className="page">
      <div className="page-head">
        <h2>Pagination</h2>
        <p>
          Client-side pagination with the AG-shaped panel: page-size selector, row range label
          (&quot;1 to 100 of {live ? live.length.toLocaleString() : '500'}&quot;), and
          first/prev/next/last navigation. Toggle <code>paginationAutoPageSize</code> to fit rows
          to the viewport. Live FI positions from the STOMP feed.
        </p>
      </div>
      <div className="controls">
        <label>
          Auto page size{' '}
          <input
            type="checkbox"
            onChange={(e) =>
              (live ? liveApiRef.current : apiRef.current)?.updateOptions({
                paginationAutoPageSize: e.target.checked,
              })
            }
          />
        </label>
        <button
          type="button"
          onClick={() => (live ? liveApiRef.current : apiRef.current)?.paginationGoToFirstPage()}
        >
          First page
        </button>
        <button
          type="button"
          onClick={() => (live ? liveApiRef.current : apiRef.current)?.paginationGoToNextPage()}
        >
          Next page
        </button>
        <button
          type="button"
          onClick={() => (live ? liveApiRef.current : apiRef.current)?.paginationGoToPage(2)}
        >
          Go to page 3
        </button>
        <FeedBadge status={status} />
      </div>
      <div className="grid-wrap">
        {live ? (
          <TabularGrid<FiPosition>
            key="stomp"
            columnDefs={FI_COLUMNS}
            rowData={rows}
            getRowId={FI_GET_ROW_ID}
            density="compact"
            pagination
            paginationPageSize={100}
            paginationPageSizeSelector={[50, 100, 200]}
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
            pagination
            paginationPageSize={100}
            paginationPageSizeSelector={[50, 100, 200]}
            onReady={(api) => {
              apiRef.current = api;
            }}
          />
        )}
      </div>
    </main>
  );
}
