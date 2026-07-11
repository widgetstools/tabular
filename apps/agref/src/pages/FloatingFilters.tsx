import { useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { gridTheme } from '../theme';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';

export function FloatingFiltersPage() {
  const rowData = useMemo(() => makeBonds(15_000), []);
  const columnDefs = useMemo(() => bondColumns(), []);
  const [quick, setQuick] = useState('');

  return (
    <main className="page">
      <div className="page-head">
        <h2>Floating filters</h2>
        <p>Filter row under the column headers; text and number filter inputs with clear buttons.</p>
      </div>
      <div className="controls">
        <input
          type="text"
          placeholder="Quick filter…"
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
        />
      </div>
      <div className="grid-wrap">
        <AgGridReact<Bond>
          theme={gridTheme}
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
          quickFilterText={quick}
          defaultColDef={{ filter: 'agTextColumnFilter', floatingFilter: true }}
        />
      </div>
    </main>
  );
}
