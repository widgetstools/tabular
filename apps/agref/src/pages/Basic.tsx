import { useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { gridTheme } from '../theme';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';

export function BasicPage() {
  const rowData = useMemo(() => makeBonds(500), []);
  const columnDefs = useMemo(() => bondColumns(), []);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Basic grid</h2>
        <p>AG Grid reference: pinned CUSIP, zebra rows, sortable headers, column resize/reorder.</p>
      </div>
      <div className="grid-wrap">
        <AgGridReact<Bond>
          theme={gridTheme}
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
        />
      </div>
    </main>
  );
}
