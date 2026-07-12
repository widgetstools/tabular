/**
 * FI positions datasource over apps/stomp-view-server.
 *
 * Protocol: SUBSCRIBE /snapshot/positions/{clientId}, then SEND the trigger
 * /snapshot/positions/{clientId}/{rate}/{batchSize} with optional headers
 * `snapshot-rows` (1k-20k) and `updates-per-tick` (bundles N mutations per
 * MESSAGE so throughput can exceed the server's ~1ms timer floor; rate=200 ×
 * updates-per-tick=50 → 10,000 updates/s). Snapshot arrives as JSON-array
 * batches (message-type: snapshot), then a snapshot-complete text frame,
 * then live updates as JSON arrays of FULL row clones (message-type:
 * live-update) — replace semantics, keyed by positionId.
 */
import { StompClient } from './stompClient';

/** Wide (~1500 flattened paths) nested FI position row. */
export interface FiPosition {
  positionId: string;
  cusip: string;
  [key: string]: unknown;
}

export interface FiSourceOptions {
  url?: string;
  /** Snapshot size; server clamps to [1000, 20000]. */
  rows?: number;
  /** Server ticks per second. */
  rate?: number;
  /** Row mutations bundled per tick MESSAGE. */
  updatesPerTick?: number;
  /** Snapshot delivery batch size. */
  batchSize?: number;
  clientId?: string;
}

export interface FiSourceEvents {
  onStatus: (text: string) => void;
  onSnapshotProgress: (received: number) => void;
  /** Full snapshot delivered — set as rowData. */
  onReady: (rows: FiPosition[]) => void;
  /** Live update batch — apply as a replace-update transaction. */
  onUpdates: (rows: FiPosition[]) => void;
}

/** Connects and streams; returns a dispose function. */
export function connectFiPositions(
  opts: FiSourceOptions,
  events: FiSourceEvents,
): () => void {
  const url = opts.url ?? 'ws://localhost:8081';
  const clientId = opts.clientId ?? `tabular-${Math.floor(Math.random() * 1e6)}`;
  const rate = opts.rate ?? 200;
  const updatesPerTick = opts.updatesPerTick ?? 50;
  const batchSize = opts.batchSize ?? 500;
  const snapshot: FiPosition[] = [];
  let ready = false;
  let disposed = false;

  const client = new StompClient(url, {
    onMessage: (f) => {
      if (disposed) return;
      const type = f.headers['message-type'];
      if (type === 'snapshot') {
        const rows = JSON.parse(f.body) as FiPosition[];
        snapshot.push(...rows);
        events.onSnapshotProgress(snapshot.length);
      } else if (type === 'snapshot-complete' || f.body.startsWith('Success:')) {
        ready = true;
        events.onStatus(`snapshot complete: ${snapshot.length} rows; live updates starting`);
        events.onReady(snapshot);
      } else if (type === 'live-update') {
        if (!ready) return;
        events.onUpdates(JSON.parse(f.body) as FiPosition[]);
      }
    },
    onError: (reason) => events.onStatus(`error: ${reason}`),
    onClose: () => events.onStatus('disconnected'),
  });

  const destination = `/snapshot/positions/${clientId}`;
  client
    .connect()
    .then(() => {
      if (disposed) return;
      events.onStatus('connected; requesting snapshot');
      client.subscribe(destination, 'sub-1');
      client.send(
        `${destination}/${rate}/${batchSize}`,
        {
          'snapshot-rows': String(opts.rows ?? 5000),
          'updates-per-tick': String(updatesPerTick),
        },
        '',
      );
    })
    .catch((e: Error) => {
      events.onStatus(`${e.message} — is the server running? (npm run dev:stomp)`);
    });

  return () => {
    disposed = true;
    client.close();
  };
}
