/**
 * FinOS Perspective grid fed by the shared STOMP positions feed. The point of
 * this page: Perspective's engine recomputes grouped aggregates on every
 * `table.update()`, so group rows tick live — a reference for grouped-agg
 * behavior under streaming load. Rows are mapped to a slim flat schema
 * (Perspective would otherwise infer ~1500 columns from the wide FI payload).
 */
import { useEffect, useRef, useState } from 'react';
import perspective from '@finos/perspective';
import type { Client, Table } from '@finos/perspective';
import perspective_viewer from '@finos/perspective-viewer';
import type { HTMLPerspectiveViewerElement } from '@finos/perspective-viewer';
import '@finos/perspective-viewer-datagrid';
import '@finos/perspective-viewer/dist/css/themes.css';
import SERVER_WASM from '@finos/perspective/dist/wasm/perspective-server.wasm?url';
import CLIENT_WASM from '@finos/perspective-viewer/dist/wasm/perspective-viewer.wasm?url';
import type { FiPosition } from '../stomp/fiPositionsSource';
import { useFiFeed, useFiUpdates } from '../stomp/sharedFeed';
import { FeedBadge } from '../stomp/FeedBadge';

// WASM engines load once per session; pages remount on every nav.
let clientPromise: Promise<Client> | null = null;
function ensurePerspective(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      await Promise.all([
        perspective.init_server(fetch(SERVER_WASM)),
        perspective_viewer.init_client(fetch(CLIENT_WASM)),
      ]);
      return perspective.worker();
    })();
  }
  return clientPromise;
}

const SCHEMA = {
  positionId: 'string',
  cusip: 'string',
  ticker: 'string',
  desk: 'string',
  trader: 'string',
  region: 'string',
  currency: 'string',
  sector: 'string',
  rating: 'string',
  instrumentType: 'string',
  quantity: 'float',
  notionalAmount: 'float',
  marketValue: 'float',
  currentPrice: 'float',
  pnl: 'float',
  dailyPnl: 'float',
  yield: 'float',
  dv01: 'float',
  spread: 'float',
} as const;

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function toPspRow(p: FiPosition): Record<keyof typeof SCHEMA, string | number | null> {
  const rating = p.rating as Record<string, unknown> | undefined;
  const issuer = p.issuer as Record<string, unknown> | undefined;
  return {
    positionId: String(p.positionId),
    cusip: str(p.cusip),
    ticker: str(p.ticker),
    desk: str(p.desk),
    trader: str(p.trader),
    region: str(p.region),
    currency: str(p.currency),
    sector: str(issuer?.sector),
    rating: str(rating?.composite),
    instrumentType: str(p.instrumentType),
    quantity: num(p.quantity),
    notionalAmount: num(p.notionalAmount),
    marketValue: num(p.marketValue),
    currentPrice: num(p.currentPrice),
    pnl: num(p.pnl),
    dailyPnl: num(p.dailyPnl),
    yield: num(p.yield),
    dv01: num(p.dv01),
    spread: num(p.spread),
  };
}

const DEFAULT_VIEW = {
  plugin: 'Datagrid',
  group_by: ['desk', 'currency'],
  columns: [
    'notionalAmount',
    'marketValue',
    'pnl',
    'dailyPnl',
    'dv01',
    'currentPrice',
    'yield',
    'quantity',
  ],
  aggregates: {
    notionalAmount: 'sum',
    marketValue: 'sum',
    pnl: 'sum',
    dailyPnl: 'sum',
    dv01: 'sum',
    currentPrice: 'avg',
    yield: 'avg',
    quantity: 'sum',
  },
  sort: [['marketValue', 'desc']] as Array<[string, string]>,
};

export function PerspectiveGridPage() {
  const { rows, status } = useFiFeed();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<HTMLPerspectiveViewerElement | null>(null);
  const tableRef = useRef<Table | null>(null);
  const [running, setRunning] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [updates, setUpdates] = useState(0);
  const totalRef = useRef(0);

  useEffect(() => {
    if (status !== 'ready' || !rows || !containerRef.current) return;
    let cancelled = false;
    const container = containerRef.current;
    const viewer = document.createElement('perspective-viewer');
    let table: Table | null = null;

    (async () => {
      const client = await ensurePerspective();
      // The d.ts data union omits the documented schema form; cast through.
      table = await client.table(
        SCHEMA as unknown as Record<string, unknown[]>,
        { index: 'positionId' },
      );
      await table.update(rows.map(toPspRow));
      if (cancelled) {
        await table.delete();
        table = null;
        return;
      }
      viewer.style.flex = '1';
      container.appendChild(viewer);
      await viewer.load(table);
      await viewer.restore({
        ...DEFAULT_VIEW,
        theme: document.body.classList.contains('light') ? 'Pro' : 'Pro Dark',
      });
      if (!cancelled) {
        tableRef.current = table;
        viewerRef.current = viewer;
        setLoaded(true);
      }
    })().catch((err) => console.error('[perspective] init failed', err));

    return () => {
      cancelled = true;
      tableRef.current = null;
      viewerRef.current = null;
      setLoaded(false);
      void (async () => {
        // Skip delete() if the element never upgraded (unmounted mid-init).
        if (typeof viewer.delete === 'function') await viewer.delete().catch(() => {});
        viewer.remove();
        await table?.delete().catch(() => {});
      })();
    };
  }, [status, rows]);

  useFiUpdates((batch) => {
    const table = tableRef.current;
    if (!table) return;
    void table.update(batch.map(toPspRow));
    totalRef.current += batch.length;
    setUpdates(totalRef.current);
  }, status === 'ready' && running);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Perspective (FinOS)</h2>
        <p>
          A <code>&lt;perspective-viewer&gt;</code> bound to the live STOMP positions feed
          via an indexed table (<code>index: positionId</code>) — the feed's full-row
          replacements map straight onto <code>table.update()</code>, so grouped
          aggregates (sum notional / MV / PnL, avg price / yield) recompute on every
          tick. Grouped by desk → currency by default; open the config panel (⚙ top
          left) to regroup, pivot, or switch aggregates.
        </p>
      </div>
      <div className="controls">
        <button className={running ? 'on' : ''} onClick={() => setRunning((r) => !r)}>
          {running ? 'Pause' : 'Resume'}
        </button>
        <button
          onClick={() => void viewerRef.current?.restore(DEFAULT_VIEW)}
        >
          Reset view
        </button>
      </div>
      <div className="grid-wrap perspective-wrap" ref={containerRef}>
        {status === 'ready' && !loaded ? (
          <div className="perspective-empty">Loading Perspective engine…</div>
        ) : null}
        {status === 'offline' ? (
          <div className="perspective-empty">
            STOMP server offline — this page has no synthetic fallback. Start it with{' '}
            <code>npm run dev:stomp</code> and reload.
          </div>
        ) : null}
        {status === 'connecting' || status === 'idle' ? (
          <div className="perspective-empty">Waiting for snapshot…</div>
        ) : null}
      </div>
      <div className="status">
        <span>
          Rows <b>{rows ? rows.length.toLocaleString() : '—'}</b>
        </span>
        <span>
          Updates applied <b>{updates.toLocaleString()}</b>
        </span>
        <FeedBadge status={status} />
      </div>
    </main>
  );
}
