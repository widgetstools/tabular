/**
 * PGrid full demo: the complete STOMP positions payload — 20k rows, every
 * leaf field flattened to a column (~370, union schema over the snapshot) —
 * with live ticks applied as full-row replacements at ~10k updates/s.
 *
 * There is NO refresh or polling code on this page: grouped and pivoted
 * aggregates tick because `view.on_update` is the grid's row-model push
 * channel. Uses its own STOMP connection (the shared feed is pinned to 5k).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ColDef, GridOptions, PspGrid } from 'pgrid';
import { PspGridReact } from 'pgrid/react';
import { connectFiPositions } from '../stomp/fiPositionsSource';
import { FeedBadge } from '../stomp/FeedBadge';
import type { FeedStatus } from '../stomp/sharedFeed';
import { buildSchema, flatten, type FlatRow } from '../stomp/flattenFi';

const SNAPSHOT_ROWS = 20000;
const FLATTEN_CHUNK = 2500;

/** Default aggregations (spec Task 9): sums on the money columns, avgs on the per-unit ones. */
const AGG: Record<string, 'sum' | 'avg'> = {
  marketValue: 'sum',
  pnl: 'sum',
  dailyPnl: 'sum',
  currentPrice: 'avg',
  yield: 'avg',
};

/** Columns pinned to the front of the flat view, in this order. */
const LEAD = [
  'positionId',
  'desk',
  'currency',
  'marketValue',
  'pnl',
  'dailyPnl',
  'currentPrice',
  'yield',
  'trader',
  'region',
  'instrumentType',
];

function buildColumnDefs(schema: Record<string, string>): ColDef[] {
  const keys = Object.keys(schema).sort(
    (a, b) => {
      const ia = LEAD.indexOf(a);
      const ib = LEAD.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? LEAD.length : ia) - (ib === -1 ? LEAD.length : ib);
      return a < b ? -1 : a > b ? 1 : 0;
    },
  );
  return keys.map((field) => {
    const engineType = schema[field];
    const type =
      engineType === 'float' ? 'float' : engineType === 'boolean' ? 'boolean' : 'string';
    return {
      field,
      headerName: field,
      type,
      width: field === 'positionId' || field === 'cusip' ? 150 : 120,
      rowGroup: field === 'desk',
      aggFunc: AGG[field] ?? null,
      format: type === 'float' ? '#,##0.00' : undefined,
    } as ColDef;
  });
}

type Phase = 'connecting' | 'snapshot' | 'loading' | 'live' | 'offline';

const BADGE_FOR_PHASE: Record<Phase, FeedStatus> = {
  connecting: 'connecting',
  snapshot: 'connecting',
  loading: 'connecting',
  live: 'ready',
  offline: 'offline',
};

interface Meta {
  schema: Record<string, string>;
  columnDefs: ColDef[];
  flatRows: FlatRow[];
}

export function PGridPage() {
  const gridRef = useRef<PspGrid | null>(null);
  const totalRef = useRef(0);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [snapProgress, setSnapProgress] = useState(0);
  const [updates, setUpdates] = useState(0);
  const [meta, setMeta] = useState<Meta | null>(null);

  useEffect(() => {
    let cancelled = false;
    let gotData = false;
    const offlineTimer = setTimeout(() => {
      if (!gotData) setPhase('offline');
    }, 4000);

    const dispose = connectFiPositions(
      {
        rows: SNAPSHOT_ROWS,
        rate: 200,
        updatesPerTick: 50,
        clientId: `pgrid-${Math.floor(Math.random() * 1e6)}`,
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
          void (async () => {
            setPhase('loading');
            // Flatten in chunks, yielding so other pages' feeds stay live.
            const flatRows: FlatRow[] = new Array<FlatRow>(rows.length);
            for (let i = 0; i < rows.length; i += FLATTEN_CHUNK) {
              const end = Math.min(i + FLATTEN_CHUNK, rows.length);
              for (let j = i; j < end; j++) flatRows[j] = flatten(rows[j]);
              await new Promise((r) => setTimeout(r));
              if (cancelled) return;
            }
            const schema = buildSchema(flatRows);
            setMeta({ schema, columnDefs: buildColumnDefs(schema), flatRows });
          })();
        },
        onUpdates: (batch) => {
          const grid = gridRef.current;
          if (!grid) return;
          grid.update(batch.map(flatten));
          totalRef.current += batch.length;
        },
      },
    );

    const counter = setInterval(() => setUpdates(totalRef.current), 500);
    return () => {
      cancelled = true;
      clearTimeout(offlineTimer);
      clearInterval(counter);
      dispose();
      gridRef.current = null;
    };
  }, []);

  const options = useMemo<GridOptions | null>(
    () =>
      meta && {
        columnDefs: meta.columnDefs,
        rowIdField: 'positionId',
        theme: 'dark',
        groupDefaultExpanded: 0,
        rowGroupPanelShow: 'always',
        pivotPanelShow: 'always',
        sideBar: true,
      },
    [meta],
  );

  return (
    <main className="page">
      <div className="page-head">
        <h2>PGrid — Perspective-native DOM grid, full STOMP feed</h2>
        <p>
          The row model IS a Perspective view: 20k positions × {meta ? meta.columnDefs.length : '~370'}{' '}
          union-schema columns, grouped by desk, ticking at ~10k updates/s. Group and pivot
          aggregates tick push-based via <code>view.on_update</code> — zero polling, zero refresh
          interval anywhere on this page. Drag headers to the group/pivot strips, toggle pivot
          mode, expand groups mid-stream.
        </p>
      </div>
      <div className="controls">
        <FeedBadge status={BADGE_FOR_PHASE[phase]} />
        <span>
          {phase === 'snapshot' && `snapshot ${snapProgress.toLocaleString()} rows…`}
          {phase === 'loading' && 'flattening + loading into the engine…'}
          {phase === 'live' &&
            `${SNAPSHOT_ROWS.toLocaleString()} rows · ${meta?.columnDefs.length ?? 0} cols · ${updates.toLocaleString()} row updates applied`}
          {phase === 'offline' && 'STOMP server offline — run apps/stomp-view-server (ws://localhost:8081)'}
          {phase === 'connecting' && 'connecting to ws://localhost:8081…'}
        </span>
      </div>
      <div className="grid-wrap">
        {options && meta ? (
          <PspGridReact
            options={options}
            schema={meta.schema}
            onReady={(grid) => {
              gridRef.current = grid;
              // Bench hook (Task 10): lets the harness probe latency/heap.
              (window as unknown as Record<string, unknown>).__pgrid = grid;
              void grid
                .load(meta.flatRows)
                .then(() => setPhase('live'))
                .catch((err) => console.error('[pgrid] load failed', err));
            }}
          />
        ) : null}
      </div>
    </main>
  );
}
