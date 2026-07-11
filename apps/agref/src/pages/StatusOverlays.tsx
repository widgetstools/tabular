import { useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { gridTheme } from '../theme';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';

export function StatusOverlaysPage() {
  const rowData = useMemo(() => makeBonds(500), []);
  const columnDefs = useMemo<ColDef<Bond>[]>(
    () =>
      bondColumns().map((c) =>
        ['price', 'yld', 'spread', 'notional', 'trader'].includes(c.field as string)
          ? { ...c, editable: true }
          : c,
      ),
    [],
  );
  const gridRef = useRef<AgGridReact<Bond>>(null);
  const [quick, setQuick] = useState('');
  const [loading, setLoading] = useState(false);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Status bar &amp; overlays</h2>
        <p>
          Status bar panels (row counts, selected count, range aggregation), the v32+{' '}
          <code>loading</code> grid option, auto no-rows overlay, clipboard paste (⌘V) and
          undo/redo (⌘Z / ⇧⌘Z) on editable columns.
        </p>
      </div>
      <div className="controls">
        <input
          type="text"
          placeholder="Quick filter (type gibberish for no-rows)…"
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
        />
        <button onClick={() => setLoading(true)}>Show loading</button>
        <button onClick={() => setLoading(false)}>Hide overlay</button>
      </div>
      <div className="grid-wrap">
        <AgGridReact<Bond>
          ref={gridRef}
          theme={gridTheme}
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
          quickFilterText={quick}
          loading={loading}
          rowSelection={{ mode: 'multiRow', enableClickSelection: false }}
          cellSelection
          undoRedoCellEditing
          undoRedoCellEditingLimit={100}
          statusBar={{
            statusPanels: [
              { statusPanel: 'agTotalAndFilteredRowCountComponent', align: 'left' },
              { statusPanel: 'agSelectedRowCountComponent', align: 'left' },
              { statusPanel: 'agAggregationComponent', align: 'right' },
            ],
          }}
        />
      </div>
    </main>
  );
}
