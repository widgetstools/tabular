import { useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { AgGridReact as AgGridReactType } from 'ag-grid-react';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';
import { gridTheme } from '../theme';

export function PaginationPage() {
  const rowData = useMemo(() => makeBonds(500), []);
  const columnDefs = useMemo(() => bondColumns(), []);
  const gridRef = useRef<AgGridReactType<Bond>>(null);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Pagination</h2>
        <p>AG Grid client-side pagination — parity reference for page panel and API.</p>
      </div>
      <div className="controls">
        <button type="button" onClick={() => gridRef.current?.api.paginationGoToFirstPage()}>
          First page
        </button>
        <button type="button" onClick={() => gridRef.current?.api.paginationGoToNextPage()}>
          Next page
        </button>
        <button type="button" onClick={() => gridRef.current?.api.paginationGoToPage(2)}>
          Go to page 3
        </button>
      </div>
      <div className="grid-wrap">
        <AgGridReact<Bond>
          ref={gridRef}
          theme={gridTheme}
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
          pagination
          paginationPageSize={100}
          paginationPageSizeSelector={[50, 100, 200]}
        />
      </div>
    </main>
  );
}
