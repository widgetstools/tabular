import { useEffect, useMemo, useRef, useState } from 'react';
import type { ColDef, Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, makeRng, tick, type Bond } from '../data';
import { FI_ID, FI_DESC, FI_NESTED, FI_GET_ROW_ID } from '../stomp/fiColumns';
import type { FiPosition } from '../stomp/fiPositionsSource';
import { useFiFeed, useFiUpdates } from '../stomp/sharedFeed';
import { FeedBadge } from '../stomp/FeedBadge';

const ROWS = 100_000;

/**
 * Live columns: grouped desk → rating.composite (nested), with live sum /
 * weighted-avg / max / avg rollups fed straight from the STOMP update
 * stream — the feed itself is the realtime source here, no synthetic pump.
 */
const liveColumnDefs: ColDef<FiPosition>[] = [
  FI_ID,
  ...FI_DESC.map((c) => (c.field === 'desk' ? { ...c, rowGroup: true, hide: true } : c)),
  ...FI_NESTED.map((c) =>
    c.field === 'rating.composite' ? { ...c, rowGroup: true, hide: true } : c,
  ),
  { field: 'ticker', headerName: 'Ticker', width: 90 },
  { field: 'instrumentName', headerName: 'Instrument', width: 170 },
  {
    field: 'notionalAmount',
    headerName: 'Notional',
    aggFunc: 'sum',
    type: 'number',
    width: 140,
    format: '#,##0',
  },
  {
    field: 'pnl',
    headerName: 'PnL',
    aggFunc: 'sum',
    type: 'number',
    width: 130,
    format: '#,##0',
    enableCellChangeFlash: true,
  },
  {
    field: 'currentPrice',
    headerName: 'Price',
    aggFunc: 'weightedAverage',
    weightField: 'notionalAmount',
    type: 'number',
    width: 110,
    format: '#,##0.0000',
    enableCellChangeFlash: true,
  },
  {
    field: 'spread',
    headerName: 'Spread',
    aggFunc: 'max',
    type: 'number',
    width: 110,
    enableCellChangeFlash: true,
  },
  { field: 'yield', headerName: 'Yield', aggFunc: 'avg', type: 'number', width: 100, format: '#,##0.000' },
];

/**
 * Realtime aggregation over the unified data-plane worker: filter/sort/group
 * and incremental tick-fast-path aggregates all run in one worker. Update
 * batches that only touch agg-input fields stream `aggregatesUpdated` pushes;
 * the main thread patches group totals without a full model rebuild.
 */
export function RealtimeAggPage() {
  const { rows: liveRows, status } = useFiFeed();
  const live = status === 'ready' && liveRows;
  const liveApiRef = useRef<Tabular<FiPosition> | null>(null);
  const [liveUpdates, setLiveUpdates] = useState(0);
  const liveTotalRef = useRef(0);
  useFiUpdates((batch) => {
    liveApiRef.current?.applyTransactionAsync({ update: batch });
    liveTotalRef.current += batch.length;
    setLiveUpdates(liveTotalRef.current);
  }, !!live);

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

  // Tick pump (synthetic fallback only) — mutates random rows and streams
  // them through applyTransactionAsync (coalesced per ~60ms window by the
  // grid). Skipped entirely on the live path, where the STOMP feed's own
  // update stream is the realtime source.
  useEffect(() => {
    if (!running || live) return;
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
  }, [running, rate, rows, live]);

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
          {live ? (
            <>
              Live FI positions grouped desk → <code>rating.composite</code> (nested) with live
              sum / weighted-avg / max / avg rollups — the STOMP update stream itself is the
              realtime source, no synthetic pump.
            </>
          ) : (
            <>
              {ROWS.toLocaleString()} positions grouped desk → sector with live sum /
              weighted-avg / max / avg rollups.
            </>
          )}{' '}
          The worker data plane is the default; append <code>?main=1</code> to force the UI
          thread. Incremental accumulators run in the worker — each tick batch costs O(changed
          rows) and the main thread only patches changed group aggregates. Collapse the groups and
          watch the totals move.
        </p>
      </div>
      <div className="controls">
        {live ? null : (
          <>
            <button className={running ? 'on' : ''} onClick={() => setRunning((r) => !r)}>
              {running ? 'Pause' : 'Resume'}
            </button>
            <label>
              Updates / 50ms
              <select
                value={rate}
                onChange={(e) => setRate(Number(e.target.value))}
                style={{ marginLeft: 8 }}
              >
                {[500, 2000, 5000, 10000].map((r) => (
                  <option key={r} value={r}>
                    {r.toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
      <div className="grid-wrap">
        {live ? (
          <TabularGrid<FiPosition>
            key="stomp"
            columnDefs={liveColumnDefs}
            rowData={liveRows}
            getRowId={FI_GET_ROW_ID}
            density="compact"
            groupDefaultExpanded={0}
            groupTotalRow="bottom"
            grandTotalRow="bottom"
            suppressAggFuncInHeader
            onReady={(api) => {
              liveApiRef.current = api;
            }}
          />
        ) : (
          <TabularGrid<Bond>
            key="synthetic"
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
        )}
      </div>
      <div className="status">
        <span>
          Rows <b>{live ? liveRows.length.toLocaleString() : ROWS.toLocaleString()}</b>
        </span>
        <span>
          Updates applied <b>{(live ? liveUpdates : updates).toLocaleString()}</b>
        </span>
        <FeedBadge status={status} />
        {live ? null : (
          <span>
            Rate <b>{(rate * 20).toLocaleString()}/s</b>
          </span>
        )}
        <span>
          Paint <b>{fps} fps</b>
        </span>
      </div>
    </main>
  );
}
