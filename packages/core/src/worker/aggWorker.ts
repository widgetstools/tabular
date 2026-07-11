/**
 * Aggregation worker (cgrid-style data plane, scoped to realtime group
 * aggregation). Owns a mirror of the row store and maintains per-group
 * accumulators incrementally via AggEngine in incrementalAgg.ts.
 *
 * After every transaction batch the worker pushes `aggregatesUpdated` with
 * one record per dirty group; the main thread patches the values into the
 * live group rows and repaints — no model rebuild, no main-thread scan.
 */
import type {
  AggWorkerPush,
  AggWorkerRequest,
  AggWorkerResponse,
} from './protocol';
import { AggEngine } from './incrementalAgg';

// ── worker entry ─────────────────────────────────────────────────────

/* v8 ignore start — exercised only inside a real Worker context. */
interface WorkerScope {
  postMessage(msg: unknown): void;
  onmessage: ((e: MessageEvent<AggWorkerRequest>) => void) | null;
  document?: unknown;
}
declare const self: WorkerScope | undefined;

// `document` check keeps the handler from installing when this module is
// bundled into the main thread (self === window there).
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && self.document === undefined) {
  const engine = new AggEngine();
  const scope = self;
  scope.onmessage = (e: MessageEvent<AggWorkerRequest>) => {
    const msg = e.data;
    try {
      switch (msg.type) {
        case 'setAggModel':
          engine.setAggModel(msg.payload);
          break;
        case 'setRowData':
          engine.setRowData(msg.payload.ids, msg.payload.rows as Record<string, unknown>[]);
          break;
        case 'applyTransaction': {
          const updates = engine.applyTransaction(msg.payload);
          if (updates.length) {
            const push: AggWorkerPush = { type: 'aggregatesUpdated', updates };
            scope.postMessage(push);
          }
          break;
        }
      }
      const ok: AggWorkerResponse = { id: msg.id, type: 'ok', rowCount: 0 };
      scope.postMessage(ok);
    } catch (err) {
      const fail: AggWorkerResponse = { id: msg.id, type: 'error', error: String(err) };
      scope.postMessage(fail);
    }
  };
}
/* v8 ignore stop */
