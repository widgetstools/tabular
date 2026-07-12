import { useMemo, useRef, useState } from 'react';
import type { Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';
import { FI_COLUMNS, FI_GET_ROW_ID } from '../stomp/fiColumns';
import type { FiPosition } from '../stomp/fiPositionsSource';
import { useFiFeed, useFiUpdates } from '../stomp/sharedFeed';
import { FeedBadge } from '../stomp/FeedBadge';

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

export function SelectionPage() {
  const { rows, status } = useFiFeed();
  const live = status === 'ready' && rows;
  const rowData = useMemo(() => makeBonds(2000), []);
  const columnDefs = useMemo(() => bondColumns(), []);
  const apiRef = useRef<Tabular<Bond> | null>(null);
  const liveApiRef = useRef<Tabular<FiPosition> | null>(null);
  const [selected, setSelected] = useState<Bond[]>([]);
  const [liveSelected, setLiveSelected] = useState<FiPosition[]>([]);

  useFiUpdates(
    (batch) => liveApiRef.current?.applyTransactionAsync({ update: batch }),
    !!live,
  );

  const agg = useMemo(() => {
    if (!selected.length) return null;
    const notional = selected.reduce((s, b) => s + b.notional, 0);
    const pnl = selected.reduce((s, b) => s + b.pnl, 0);
    // Weighted-average spread over notional — the FI rollup that matters.
    const wSpread = selected.reduce((s, b) => s + b.spread * b.notional, 0) / notional;
    return { notional, pnl, wSpread };
  }, [selected]);

  const liveAgg = useMemo(() => {
    if (!liveSelected.length) return null;
    const notional = liveSelected.reduce((s, b) => s + num(b.notionalAmount), 0);
    const pnl = liveSelected.reduce((s, b) => s + num(b.pnl), 0);
    const wSpread =
      liveSelected.reduce((s, b) => s + num(b.spread) * num(b.notionalAmount), 0) / notional;
    return { notional, pnl, wSpread };
  }, [liveSelected]);

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
        <button onClick={() => (live ? liveApiRef.current : apiRef.current)?.selectAll()}>
          Select all
        </button>
        <button onClick={() => (live ? liveApiRef.current : apiRef.current)?.deselectAll()}>
          Clear
        </button>
      </div>
      <div className="grid-wrap">
        {live ? (
          <TabularGrid<FiPosition>
            key="stomp"
            columnDefs={FI_COLUMNS}
            rowData={rows}
            getRowId={FI_GET_ROW_ID}
            density="compact"
            rowSelection={{ mode: 'multiRow', checkboxes: true, headerCheckbox: true }}
            onReady={(api) => {
              liveApiRef.current = api;
              api.on('selectionChanged', () => setLiveSelected(api.getSelectedRows()));
            }}
          />
        ) : (
          <TabularGrid<Bond>
            key="synthetic"
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
        )}
      </div>
      <div className="status">
        <span>
          Selected <b>{(live ? liveSelected.length : selected.length).toLocaleString()}</b> of{' '}
          <b>{live ? live.length.toLocaleString() : '2,000'}</b>
        </span>
        {live
          ? liveAgg && (
              <>
                <span>
                  Σ Notional <b>{liveAgg.notional.toLocaleString()}</b>
                </span>
                <span>
                  Σ PnL <b>{Math.round(liveAgg.pnl).toLocaleString()}</b>
                </span>
                <span>
                  Wtd Avg Spread <b>{liveAgg.wSpread.toFixed(1)}</b>
                </span>
              </>
            )
          : agg && (
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
        <FeedBadge status={status} />
      </div>
    </main>
  );
}
