import { useEffect, useMemo, useRef, useState } from 'react';
import type { Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, makeRng, tick, type Bond } from '../data';
import { bondColumns } from '../columns';
import { FI_COLUMNS, FI_GET_ROW_ID } from '../stomp/fiColumns';
import type { FiPosition } from '../stomp/fiPositionsSource';
import { useFiFeed, useFiUpdates } from '../stomp/sharedFeed';
import { FeedBadge } from '../stomp/FeedBadge';

export function LiveTicksPage() {
  const { rows: liveRows, status } = useFiFeed();
  const live = status === 'ready' && liveRows;
  const liveApiRef = useRef<Tabular<FiPosition> | null>(null);
  const [liveRunning, setLiveRunning] = useState(true);
  const [liveUpdates, setLiveUpdates] = useState(0);
  const liveTotalRef = useRef(0);
  useFiUpdates((batch) => {
    liveApiRef.current?.applyTransactionAsync({ update: batch });
    liveTotalRef.current += batch.length;
    setLiveUpdates(liveTotalRef.current);
  }, !!live && liveRunning);

  const rows = useMemo(() => makeBonds(5000), []);
  const columnDefs = useMemo(() => bondColumns(), []);
  const apiRef = useRef<Tabular<Bond> | null>(null);
  const [running, setRunning] = useState(true);
  const [rate, setRate] = useState(200);
  const [updates, setUpdates] = useState(0);
  const totalRef = useRef(0);

  useEffect(() => {
    if (!running || live) return;
    const rnd = makeRng(1234);
    const iv = setInterval(() => {
      const api = apiRef.current;
      if (!api) return;
      const batch = tick(rows, rate, rnd);
      // Keep the local array coherent with what the grid holds.
      for (const u of batch) {
        const idx = Number(u.id.slice(1));
        rows[idx] = u;
      }
      api.applyTransactionAsync({ update: batch });
      totalRef.current += batch.length;
      setUpdates(totalRef.current);
    }, 50);
    return () => clearInterval(iv);
  }, [running, rate, rows, live]);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Live ticks &amp; the decaying flash</h2>
        <p>
          The signature: each changed cell pulses at 22% alpha, holds 90ms, then decays over
          500ms — so one glance shows a gradient of how recently every instrument moved. Re-ticks
          coalesce (reset, never stack), and the direction hue persists after the flash fades.
          Updates batch through <code>applyTransactionAsync</code>.{' '}
          {live
            ? 'Live FI positions stream flashes straight from the STOMP feed; the rate select below is disabled here — live update rate is set server-side on the STOMP live feed page.'
            : null}
        </p>
      </div>
      <div className="controls">
        <button
          className={(live ? liveRunning : running) ? 'on' : ''}
          onClick={() => (live ? setLiveRunning((r) => !r) : setRunning((r) => !r))}
        >
          {(live ? liveRunning : running) ? 'Pause' : 'Resume'}
        </button>
        <label>
          Updates / 50ms {live ? '(synthetic fallback only)' : ''}
          <select
            value={rate}
            disabled={!!live}
            onChange={(e) => setRate(Number(e.target.value))}
            style={{ marginLeft: 8 }}
          >
            {[50, 200, 500, 1000].map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid-wrap">
        {live ? (
          <TabularGrid<FiPosition>
            key="stomp"
            columnDefs={FI_COLUMNS}
            rowData={liveRows}
            getRowId={FI_GET_ROW_ID}
            density="compact"
            rowSelection="single"
            onReady={(api) => (liveApiRef.current = api)}
          />
        ) : (
          <TabularGrid<Bond>
            key="synthetic"
            columnDefs={columnDefs}
            rowData={rows}
            getRowId={(p) => p.data.id}
            density="compact"
            rowSelection="single"
            onReady={(api) => (apiRef.current = api)}
          />
        )}
      </div>
      <div className="status">
        <span>
          Rows <b>{live ? liveRows.length.toLocaleString() : '5,000'}</b>
        </span>
        <span>
          Updates applied <b>{(live ? liveUpdates : updates).toLocaleString()}</b>
        </span>
        {live ? null : (
          <span>
            Rate <b>{(rate * 20).toLocaleString()}/s</b>
          </span>
        )}
        <FeedBadge status={status} />
      </div>
    </main>
  );
}
