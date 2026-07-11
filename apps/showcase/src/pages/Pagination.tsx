import { useMemo, useRef } from 'react';
import type { Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';

export function PaginationPage() {
  const rowData = useMemo(() => makeBonds(500), []);
  const columnDefs = useMemo(() => bondColumns(), []);
  const apiRef = useRef<Tabular<Bond> | null>(null);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Pagination</h2>
        <p>
          Client-side pagination with the AG-shaped panel: page-size selector, row range label
          (&quot;1 to 100 of 500&quot;), and first/prev/next/last navigation. Toggle{' '}
          <code>paginationAutoPageSize</code> to fit rows to the viewport.
        </p>
      </div>
      <div className="controls">
        <label>
          Auto page size{' '}
          <input
            type="checkbox"
            onChange={(e) =>
              apiRef.current?.updateOptions({ paginationAutoPageSize: e.target.checked })
            }
          />
        </label>
        <button type="button" onClick={() => apiRef.current?.paginationGoToFirstPage()}>
          First page
        </button>
        <button type="button" onClick={() => apiRef.current?.paginationGoToNextPage()}>
          Next page
        </button>
        <button type="button" onClick={() => apiRef.current?.paginationGoToPage(2)}>
          Go to page 3
        </button>
      </div>
      <div className="grid-wrap">
        <TabularGrid<Bond>
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
      </div>
    </main>
  );
}
