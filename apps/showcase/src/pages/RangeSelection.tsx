import { useMemo, useState } from 'react';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';

function formatRange(
  range: { start: { rowIndex: number; colId: string }; end: { rowIndex: number; colId: string } } | null,
): string {
  if (!range) return 'none';
  const { start, end } = range;
  if (start.rowIndex === end.rowIndex && start.colId === end.colId) {
    return `${start.colId}[${start.rowIndex}]`;
  }
  return `${start.colId}[${start.rowIndex}] → ${end.colId}[${end.rowIndex}]`;
}

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
  const [rangeLabel, setRangeLabel] = useState('none');

  return (
    <main className="page">
      <div className="page-head">
        <h2>Range selection</h2>
        <p>
          AG Grid–style cell ranges: click a cell, drag to expand, shift-click or shift-arrow to
          extend from the range anchor. Dragging past the viewport edge auto-scrolls. Ranges paint
          correctly across pinned and scrollable columns. The fill handle (accent square at the
          range corner) drags to fill: numeric runs continue their linear series, other values
          repeat; hold <span className="kbd">⌥</span> to copy instead of series; dragging back into
          the range clears the reduced cells. Price/Yield/Spread/Trader are editable —{' '}
          <span className="kbd">Delete</span> clears the selected range, <span className="kbd">⌘Z</span>{' '}
          undoes fills and clears.
        </p>
      </div>
      <div className="grid-wrap">
        <TabularGrid<Bond>
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
          cellSelection={{ handle: { mode: 'fill', direction: 'xy' } }}
          suppressRowClickSelection
          undoRedoCellEditing
          density="compact"
          onReady={(api) => {
            api.on('rangeSelectionChanged', (e) => setRangeLabel(formatRange(e.range)));
            (window as unknown as { __rangeApi: unknown }).__rangeApi = api;
          }}
        />
      </div>
      <div className="status">
        <span>
          Range <b>{rangeLabel}</b>
        </span>
      </div>
    </main>
  );
}
