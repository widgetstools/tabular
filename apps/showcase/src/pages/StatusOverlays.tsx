import { useMemo, useRef, useState } from 'react';
import { TabularGrid, type TabularGridHandle } from '@tabular/react';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';

export function StatusOverlaysPage() {
  const rowData = useMemo(() => makeBonds(500), []);
  const columnDefs = useMemo(() => bondColumns(), []);
  const gridRef = useRef<TabularGridHandle<Bond>>(null);
  const [quick, setQuick] = useState('');

  return (
    <main className="page">
      <div className="page-head">
        <h2>Status bar &amp; overlays</h2>
        <p>
          The status bar shows row counts, selection count, and live range aggregates (average,
          count, min, max, sum) — drag a cell range over numeric columns to see them. The loading
          overlay is API-driven; the no-rows overlay appears automatically when a filter empties
          the grid (try a quick filter with no matches).
        </p>
      </div>
      <div className="controls">
        <input
          type="text"
          placeholder="Quick filter (type gibberish for no-rows)…"
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
        />
        <button onClick={() => gridRef.current?.api?.setGridOption('loading', true)}>
          Show loading
        </button>
        <button onClick={() => gridRef.current?.api?.setGridOption('loading', false)}>
          Hide overlay
        </button>
      </div>
      <div className="grid-wrap">
        <TabularGrid<Bond>
          ref={gridRef}
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
          quickFilterText={quick}
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
          density="compact"
        />
      </div>
      <div className="status">
        <span>
          Copy a range with <b>⌘C</b>, paste with <b>⌘V</b> onto editable grids, undo with{' '}
          <b>⌘Z</b> / redo <b>⇧⌘Z</b>.
        </span>
      </div>
    </main>
  );
}
