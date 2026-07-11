import { useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { gridTheme } from '../theme';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';

export function SelectionPage() {
  const rowData = useMemo(() => makeBonds(800), []);
  const columnDefs = useMemo(() => bondColumns(), []);
  const [count, setCount] = useState(0);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Selection</h2>
        <p>Multi-row selection with checkboxes; click, ctrl/cmd-click, shift-click ranges.</p>
      </div>
      <div className="grid-wrap">
        <AgGridReact<Bond>
          theme={gridTheme}
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
          rowSelection={{ mode: 'multiRow', checkboxes: true, headerCheckbox: true }}
          onSelectionChanged={(e) => setCount(e.api.getSelectedRows().length)}
        />
      </div>
      <div className="status">
        <span>
          Selected <b>{count}</b>
        </span>
      </div>
    </main>
  );
}
