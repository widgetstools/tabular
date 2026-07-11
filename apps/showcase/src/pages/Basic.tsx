import { useMemo, useState } from 'react';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';

export function BasicPage() {
  const rowData = useMemo(() => makeBonds(500), []);
  const columnDefs = useMemo(() => bondColumns(), []);
  const [counts, setCounts] = useState({ total: 0, displayed: 0 });

  return (
    <main className="page">
      <div className="page-head">
        <h2>Basic grid</h2>
        <p>
          500 bonds rendered on canvas — no DOM per row. CUSIP is pinned left; numeric columns are
          right-aligned tabular monospace. Click a header to sort (asc → desc → none), shift-click
          for multi-sort, and drag a header edge to resize.
        </p>
      </div>
      <div className="grid-wrap">
        <TabularGrid<Bond>
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
          rowSelection="single"
          density="compact"
          onReady={(api) =>
            api.on('modelUpdated', (e) =>
              setCounts({ total: e.rowCount, displayed: e.displayedRowCount }),
            )
          }
        />
      </div>
      <div className="status">
        <span>
          Rows <b>{counts.total.toLocaleString()}</b>
        </span>
        <span>
          Displayed <b>{counts.displayed.toLocaleString()}</b>
        </span>
      </div>
    </main>
  );
}
