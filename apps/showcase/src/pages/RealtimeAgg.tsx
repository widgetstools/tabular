import { useEffect, useMemo, useRef, useState } from 'react';
import type { ColDef, Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, makeRng, tick, type Bond } from '../data';

const ROWS = 100_000;

/**
 * Realtime aggregation over the unified data-plane worker: filter/sort/group
 * and incremental tick-fast-path aggregates all run in one worker. Update
 * batches that only touch agg-input fields stream `aggregatesUpdated` pushes;
 * the main thread patches group totals without a full model rebuild.
 */
export function RealtimeAggPage() {
  const rows = useMemo(() => makeBonds(ROWS, 7), []);
  const apiRef = useRef<Tabular<Bond> | null>(null);
  const [running, setRunning] = useState(true);
  const [rate, setRate] = useState(2000);
  const [updates, setUpdates] = useState(0);
  const [fps, setFps] = useState(0);
  const totalRef = useRef(0);

  const columnDefs = useMemo<ColDef<Bond>[]>(
    () => [
      { field: 'desk', rowGroup: true, hide: true },
      { field: 'sector', rowGroup: true, hide: true },
      { field: 'issuer', width: 160 },
      { field: 'rating', width: 90 },
      { field: 'notional', aggFunc: 'sum', type: 'number', width: 140 },
      { field: 'pnl', headerName: 'PnL', aggFunc: 'sum', type: 'number', width: 130, enableCellChangeFlash: true },
      {
        field: 'price',
        aggFunc: 'weightedAverage',
        weightField: 'notional',
        type: 'number',
        width: 110,
        enableCellChangeFlash: true,
      },
      { field: 'spread', aggFunc: 'max', type: 'number', width: 110, enableCellChangeFlash: true },
      { field: 'yld', headerName: 'Yield', aggFunc: 'avg', type: 'number', width: 100 },
    ],
    [],
  );

  // Tick pump — mutates random rows and streams them through
  // applyTransactionAsync (coalesced per ~60ms window by the grid).
  useEffect(() => {
    if (!running) return;
    const rnd = makeRng(99);
    const iv = setInterval(() => {
      const api = apiRef.current;
      if (!api) return;
      const batch = tick(rows, rate, rnd);
      for (const u of batch) rows[Number(u.id.slice(1))] = u;
      api.applyTransactionAsync({ update: batch });
      totalRef.current += batch.length;
    }, 50);
    const meter = setInterval(() => setUpdates(totalRef.current), 500);
    return () => {
      clearInterval(iv);
      clearInterval(meter);
    };
  }, [running, rate, rows]);

  // Frame meter — actual paint cadence while ticks stream.
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let t0 = performance.now();
    const loop = (now: number) => {
      frames++;
      if (now - t0 >= 1000) {
        setFps(Math.round((frames * 1000) / (now - t0)));
        frames = 0;
        t0 = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Realtime aggregation</h2>
        <p>
          {ROWS.toLocaleString()} positions grouped desk → sector with live sum / weighted-avg /
          max / avg rollups. The worker data plane is the default; append <code>?main=1</code> to
          force the UI thread. Incremental accumulators run in the worker — each tick batch costs
          O(changed rows) and the main thread only patches changed group aggregates. Collapse the
          groups and watch the totals move.
        </p>
      </div>
      <div className="controls">
        <button className={running ? 'on' : ''} onClick={() => setRunning((r) => !r)}>
          {running ? 'Pause' : 'Resume'}
        </button>
        <label>
          Updates / 50ms
          <select value={rate} onChange={(e) => setRate(Number(e.target.value))} style={{ marginLeft: 8 }}>
            {[500, 2000, 5000, 10000].map((r) => (
              <option key={r} value={r}>
                {r.toLocaleString()}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid-wrap">
        <TabularGrid<Bond>
          columnDefs={columnDefs}
          rowData={rows}
          getRowId={(p) => p.data.id}
          density="compact"
          groupDefaultExpanded={0}
          groupTotalRow="bottom"
          grandTotalRow="bottom"
          suppressAggFuncInHeader
          onReady={(api) => {
            apiRef.current = api;
            (window as unknown as { __rtApi?: unknown }).__rtApi = api;
          }}
        />
      </div>
      <div className="status">
        <span>
          Rows <b>{ROWS.toLocaleString()}</b>
        </span>
        <span>
          Updates applied <b>{updates.toLocaleString()}</b>
        </span>
        <span>
          Rate <b>{(rate * 20).toLocaleString()}/s</b>
        </span>
        <span>
          Paint <b>{fps} fps</b>
        </span>
      </div>
    </main>
  );
}
