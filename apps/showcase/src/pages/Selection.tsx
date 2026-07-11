import { useMemo, useRef, useState } from 'react';
import type { Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';

export function SelectionPage() {
  const rowData = useMemo(() => makeBonds(2000), []);
  const columnDefs = useMemo(() => bondColumns(), []);
  const apiRef = useRef<Tabular<Bond> | null>(null);
  const [selected, setSelected] = useState<Bond[]>([]);

  const agg = useMemo(() => {
    if (!selected.length) return null;
    const notional = selected.reduce((s, b) => s + b.notional, 0);
    const pnl = selected.reduce((s, b) => s + b.pnl, 0);
    // Weighted-average spread over notional — the FI rollup that matters.
    const wSpread = selected.reduce((s, b) => s + b.spread * b.notional, 0) / notional;
    return { notional, pnl, wSpread };
  }, [selected]);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Selection</h2>
        <p>
          Multiple row selection with checkbox column and header select-all. Click sets,{' '}
          <span className="kbd">Ctrl</span>-click toggles, <span className="kbd">Shift</span>-click
          extends from the anchor, <span className="kbd">Ctrl+A</span> selects all,{' '}
          <span className="kbd">Esc</span> clears.
        </p>
      </div>
      <div className="controls">
        <button onClick={() => apiRef.current?.selectAll()}>Select all</button>
        <button onClick={() => apiRef.current?.deselectAll()}>Clear</button>
      </div>
      <div className="grid-wrap">
        <TabularGrid<Bond>
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
          density="compact"
          rowSelection={{ mode: 'multiRow', checkboxes: true, headerCheckbox: true }}
          onReady={(api) => {
            apiRef.current = api;
            api.on('selectionChanged', () => setSelected(api.getSelectedRows()));
          }}
        />
      </div>
      <div className="status">
        <span>
          Selected <b>{selected.length.toLocaleString()}</b> of <b>2,000</b>
        </span>
        {agg && (
          <>
            <span>
              Σ Notional <b>{agg.notional.toLocaleString()}</b>
            </span>
            <span>
              Σ PnL <b>{Math.round(agg.pnl).toLocaleString()}</b>
            </span>
            <span>
              Wtd Avg Spread <b>{agg.wSpread.toFixed(1)}</b>
            </span>
          </>
        )}
      </div>
    </main>
  );
}
