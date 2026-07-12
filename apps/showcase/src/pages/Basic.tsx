import { useMemo, useRef, useState } from 'react';
import type { Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds } from '../data';
import { bondColumns } from '../columns';
import { FI_COLUMNS, FI_GET_ROW_ID } from '../stomp/fiColumns';
import type { FiPosition } from '../stomp/fiPositionsSource';
import { useFiFeed, useFiUpdates } from '../stomp/sharedFeed';
import { FeedBadge } from '../stomp/FeedBadge';

/**
 * STOMP-fed when the view server is up (live FI positions incl. nested
 * dot-path columns); falls back to the original synthetic bonds offline.
 */
export function BasicPage() {
  const { rows, status } = useFiFeed();
  const apiRef = useRef<Tabular<FiPosition> | null>(null);
  const fallbackRows = useMemo(() => makeBonds(500), []);
  const fallbackCols = useMemo(() => bondColumns(), []);
  const [counts, setCounts] = useState({ total: 0, displayed: 0 });
  const live = status === 'ready' && rows;

  useFiUpdates((batch) => apiRef.current?.applyTransactionAsync({ update: batch }), !!live);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Basic grid</h2>
        <p>
          Canvas rendering — no DOM per row. Live FI positions from the STOMP feed (nested{' '}
          <code>rating.*</code> / <code>issuer.*</code> columns read via dot-paths); click a header
          to sort (asc → desc → none), shift-click for multi-sort, drag a header edge to resize.
        </p>
      </div>
      <div className="grid-wrap">
        {live ? (
          <TabularGrid<FiPosition>
            key="stomp"
            columnDefs={FI_COLUMNS}
            rowData={rows}
            getRowId={FI_GET_ROW_ID}
            rowSelection="single"
            density="compact"
            onReady={(api) => {
              apiRef.current = api;
              api.on('modelUpdated', (e) =>
                setCounts({ total: e.rowCount, displayed: e.displayedRowCount }),
              );
            }}
          />
        ) : (
          <TabularGrid
            key="synthetic"
            columnDefs={fallbackCols}
            rowData={fallbackRows}
            getRowId={(p) => (p.data as { id: string }).id}
            rowSelection="single"
            density="compact"
            onReady={(api) =>
              api.on('modelUpdated', (e) =>
                setCounts({ total: e.rowCount, displayed: e.displayedRowCount }),
              )
            }
          />
        )}
      </div>
      <div className="status">
        <span>
          Rows <b>{counts.total.toLocaleString()}</b>
        </span>
        <span>
          Displayed <b>{counts.displayed.toLocaleString()}</b>
        </span>
        <FeedBadge status={status} />
      </div>
    </main>
  );
}
