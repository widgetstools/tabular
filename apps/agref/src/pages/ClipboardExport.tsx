import { useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { AgGridReact as AgGridReactType } from 'ag-grid-react';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';
import { gridTheme } from '../theme';

export function ClipboardExportPage() {
  const rowData = useMemo(() => makeBonds(120), []);
  const columnDefs = useMemo(() => bondColumns(), []);
  const gridRef = useRef<AgGridReactType<Bond>>(null);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Clipboard &amp; export</h2>
        <p>AG Grid reference — copy/paste and CSV/Excel export.</p>
      </div>
      <div className="controls">
        <button
          type="button"
          onClick={() => gridRef.current?.api.copyToClipboard({ includeHeaders: true })}
        >
          Copy with headers
        </button>
        <button type="button" onClick={() => gridRef.current?.api.exportDataAsCsv({ fileName: 'bonds.csv' })}>
          Download CSV
        </button>
        <button type="button" onClick={() => gridRef.current?.api.exportDataAsExcel({ fileName: 'bonds.xlsx' })}>
          Download Excel
        </button>
      </div>
      <div className="grid-wrap">
        <AgGridReact<Bond>
          ref={gridRef}
          theme={gridTheme}
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
          rowSelection={{ mode: 'multiRow', checkboxes: true, headerCheckbox: true }}
          copyHeadersToClipboard
        />
      </div>
    </main>
  );
}
