/**
 * Perspective stress test: the FULL STOMP positions payload — 20k rows,
 * every leaf field flattened to a column (~370; the exact set varies by
 * instrument type, so the schema is the union over the snapshot) — with
 * live ticks streaming in. Exists to probe scroll performance and update
 * throughput at full width, so unlike the other Perspective page there is
 * no default grouping and no slim mapping.
 *
 * Uses its own STOMP connection (the shared feed is pinned to 5k rows).
 */
import { useEffect, useRef, useState } from 'react';
import type { Table } from '@finos/perspective';
import type { HTMLPerspectiveViewerElement } from '@finos/perspective-viewer';
import { ensurePerspective, perspectiveTheme } from '../perspectiveEngine';
import { connectFiPositions, type FiPosition } from '../stomp/fiPositionsSource';
import { FeedBadge } from '../stomp/FeedBadge';
import type { FeedStatus } from '../stomp/sharedFeed';

const SNAPSHOT_ROWS = 20000;
const LOAD_CHUNK = 2500;

type FlatRow = Record<string, string | number | boolean | null>;

function flatten(row: FiPosition): FlatRow {
  const out: FlatRow = {};
  const walk = (obj: Record<string, unknown>, prefix: string): void => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        walk(v as Record<string, unknown>, key);
      } else if (
        typeof v === 'string' ||
        typeof v === 'number' ||
        typeof v === 'boolean'
      ) {
        out[key] = v;
      } else {
        out[key] = null;
      }
    }
  };
  walk(row, '');
  return out;
}

/** Union schema over all rows; type conflicts degrade to string. */
function buildSchema(rows: FlatRow[]): Record<string, string> {
  const schema: Record<string, string> = {};
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (v === null || schema[k] === 'string') continue;
      const t =
        typeof v === 'number' ? 'float' : typeof v === 'boolean' ? 'boolean' : 'string';
      if (!(k in schema)) schema[k] = t;
      else if (schema[k] !== t) schema[k] = 'string';
    }
  }
  return schema;
}

type Phase = 'connecting' | 'snapshot' | 'loading' | 'live' | 'offline';

const BADGE_FOR_PHASE: Record<Phase, FeedStatus> = {
  connecting: 'connecting',
  snapshot: 'connecting',
  loading: 'connecting',
  live: 'ready',
  offline: 'offline',
};

export function PerspectiveStressPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<Table | null>(null);
  const runningRef = useRef(true);
  const totalRef = useRef(0);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [snapProgress, setSnapProgress] = useState(0);
  const [loadedRows, setLoadedRows] = useState(0);
  const [colCount, setColCount] = useState(0);
  const [updates, setUpdates] = useState(0);
  const [running, setRunning] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let gotData = false;
    const container = containerRef.current;
    if (!container) return;
    const viewer = document.createElement('perspective-viewer');
    let table: Table | null = null;

    const offlineTimer = setTimeout(() => {
      if (!gotData) setPhase('offline');
    }, 4000);

    async function loadSnapshot(rows: FiPosition[]): Promise<void> {
      setPhase('loading');
      const client = await ensurePerspective();
      // Flatten in chunks, yielding so the spinner (and other pages' feeds)
      // stay responsive during the ~7M-cell walk.
      const flatRows: FlatRow[] = new Array<FlatRow>(rows.length);
      for (let i = 0; i < rows.length; i += LOAD_CHUNK) {
        const end = Math.min(i + LOAD_CHUNK, rows.length);
        for (let j = i; j < end; j++) flatRows[j] = flatten(rows[j]);
        await new Promise((r) => setTimeout(r));
        if (cancelled) return;
      }
      const schema = buildSchema(flatRows);
      setColCount(Object.keys(schema).length);
      table = await client.table(
        schema as unknown as Record<string, unknown[]>,
        { index: 'positionId' },
      );
      if (cancelled) {
        await table.delete();
        table = null;
        return;
      }
      viewer.style.flex = '1';
      container!.appendChild(viewer);
      await viewer.load(table);
      await viewer.restore({
        plugin: 'Datagrid',
        columns: Object.keys(schema),
        theme: perspectiveTheme(),
      });
      // Stream the snapshot in chunks — the grid fills as batches land.
      for (let i = 0; i < flatRows.length; i += LOAD_CHUNK) {
        if (cancelled) return;
        await table.update(flatRows.slice(i, i + LOAD_CHUNK));
        setLoadedRows(Math.min(i + LOAD_CHUNK, flatRows.length));
      }
      if (cancelled) return;
      // Only now accept live ticks: an earlier tick could be overwritten by
      // a stale snapshot chunk landing after it.
      tableRef.current = table;
      setPhase('live');
    }

    const dispose = connectFiPositions(
      {
        rows: SNAPSHOT_ROWS,
        rate: 200,
        updatesPerTick: 50,
        clientId: `psp-stress-${Math.floor(Math.random() * 1e6)}`,
      },
      {
        onStatus: (text) => {
          if (
            !gotData &&
            (text.startsWith('error') ||
              text.startsWith('disconnected') ||
              text.includes('is the server running'))
          ) {
            setPhase('offline');
          }
        },
        onSnapshotProgress: (received) => {
          gotData = true;
          setPhase((p) => (p === 'connecting' ? 'snapshot' : p));
          setSnapProgress(received);
        },
        onReady: (rows) => {
          gotData = true;
          loadSnapshot(rows).catch((err) =>
            console.error('[perspective-stress] load failed', err),
          );
        },
        onUpdates: (batch) => {
          if (!runningRef.current) return;
          const t = tableRef.current;
          if (!t) return;
          void t.update(batch.map(flatten));
          totalRef.current += batch.length;
          setUpdates(totalRef.current);
        },
      },
    );

    return () => {
      cancelled = true;
      clearTimeout(offlineTimer);
      dispose();
      tableRef.current = null;
      void (async () => {
        // Skip delete() if the element never upgraded (unmounted mid-init).
        if (typeof viewer.delete === 'function') await viewer.delete().catch(() => {});
        viewer.remove();
        await table?.delete().catch(() => {});
      })();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const viewerFor = (): HTMLPerspectiveViewerElement | null =>
    containerRef.current?.querySelector('perspective-viewer') ?? null;

  return (
    <main className="page">
      <div className="page-head">
        <h2>Perspective stress — 20k rows × every column</h2>
        <p>
          The full STOMP positions payload with no slimming: every leaf field is
          flattened to a Perspective column ({colCount > 0 ? colCount : '~370'} of
          them, union schema over the snapshot) across 20,000 rows, live ticks
          applied as full-row replacements. Scroll both axes to probe the datagrid's
          viewport reads under ticking load; group via the ⚙ panel to stress
          aggregation too. This page opens its own 20k-row STOMP connection.
        </p>
      </div>
      <div className="controls">
        <button
          className={running ? 'on' : ''}
          onClick={() =>
            setRunning((r) => {
              runningRef.current = !r;
              return !r;
            })
          }
        >
          {running ? 'Pause' : 'Resume'}
        </button>
        <button onClick={() => void viewerFor()?.toggleConfig()}>Config panel</button>
      </div>
      <div className="grid-wrap perspective-wrap" ref={containerRef}>
        {phase === 'connecting' ? (
          <div className="perspective-empty">Connecting to STOMP…</div>
        ) : null}
        {phase === 'snapshot' ? (
          <div className="perspective-empty">
            Snapshot {snapProgress.toLocaleString()} / {SNAPSHOT_ROWS.toLocaleString()} rows…
          </div>
        ) : null}
        {phase === 'loading' && loadedRows === 0 ? (
          <div className="perspective-empty">Flattening rows &amp; building schema…</div>
        ) : null}
        {phase === 'offline' ? (
          <div className="perspective-empty">
            STOMP server offline — start it with <code>npm run dev:stomp</code> and reload.
          </div>
        ) : null}
      </div>
      <div className="status">
        <span>
          Rows <b>{loadedRows.toLocaleString()}</b> / {SNAPSHOT_ROWS.toLocaleString()}
        </span>
        <span>
          Columns <b>{colCount > 0 ? colCount.toLocaleString() : '—'}</b>
        </span>
        <span>
          Updates applied <b>{updates.toLocaleString()}</b>
        </span>
        <FeedBadge status={BADGE_FOR_PHASE[phase]} />
      </div>
    </main>
  );
}
