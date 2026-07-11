import { useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { gridTheme } from '../theme';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';

export function RangeSelectionPage() {
  const rowData = useMemo(() => makeBonds(800), []);
  const columnDefs = useMemo(
    () =>
      bondColumns().map((c) =>
        c.field === 'price' || c.field === 'yld' || c.field === 'spread' || c.field === 'trader'
          ? { ...c, editable: true }
          : c,
      ),
    [],
  );

  return (
    <main className="page">
      <div className="page-head">
        <h2>Range selection</h2>
        <p>
          Cell ranges: click, drag, shift-click / shift-arrow to extend; spans pinned columns.
          Fill handle enabled (drag the range corner: numeric series / copy, drag back to reduce).
          Price/Yield/Spread/Trader editable; Delete clears the range; ⌘Z undoes.
        </p>
      </div>
      <div className="grid-wrap">
        <AgGridReact<Bond>
          theme={gridTheme}
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
          cellSelection={{ handle: { mode: 'fill', direction: 'xy' } }}
          undoRedoCellEditing
        />
      </div>
    </main>
  );
}
