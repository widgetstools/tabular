/**
 * Worker lifecycle coordinator — owns the data-plane client so the grid host
 * stays paint/DOM focused.
 */
import { DataWorkerClient } from './dataClient';
import type {
  AggTransactionPayload,
  GroupAggUpdate,
  RenderDeltas,
  ViewportChunk,
  ViewportRequest,
  WorkerModelOutput,
  WorkerPipelineConfig,
} from './protocol';
import type { CellChange } from '../rowModel';
import type { RulesEvalResult } from '@tabular/rules';

export interface WorkerCoordinatorHost {
  destroyed: boolean;
  requestPaint(opts?: { prefetch?: boolean }): void;
  /** Force a viewport chunk refetch without blanking the current frame. */
  invalidateViewportPrefetch(): void;
  /** True when paint uses chunk-only mode (Extreme); ticks must refresh chunks. */
  readonly workerOwnsRowData: boolean;
  updateStatusBar(): void;
  flashCellChange(c: { rowId: string; colKey: string; dir: 1 | -1 | 0 }): void;
  enableCellFlash: boolean;
  applyWorkerModel(output: WorkerModelOutput): void;
  patchGroupAggregates(updates: GroupAggUpdate[]): CellChange[];
  fallbackToMain(reason: string): void;
  onRulesResult?(rules: RulesEvalResult): void;
  /**
   * Render plane (Task 6/7): pushed pre-rendered tick deltas for the last
   * requested render window. Only the DOM worker materializer sets this; the
   * canvas host leaves it undefined (deltas are then ignored).
   */
  onRenderDeltas?(deltas: RenderDeltas): void;
  /** True when the main-thread row mirror is still retained. */
  readonly dataMirrorActive: boolean;
  restoreDataMirror(rows: unknown[]): void;
  syncWorkerRulesConfig(client: DataWorkerClient): Promise<void>;
  /** Called once when deprecated workerAggregation=false with data plane active. */
  warnWorkerAggregationIgnored?(): void;
}

function mergeAggTx(into: AggTransactionPayload, tx: AggTransactionPayload): void {
  if (tx.addIds?.length) {
    (into.addIds ??= []).push(...tx.addIds);
    (into.add ??= []).push(...(tx.add ?? []));
  }
  if (tx.removeIds?.length) {
    (into.removeIds ??= []).push(...tx.removeIds);
  }
  if (tx.updateIds?.length) {
    into.updateIds ??= [];
    into.update ??= [];
    const seen = new Map<string, number>();
    for (let i = 0; i < into.updateIds.length; i++) seen.set(into.updateIds[i]!, i);
    for (let i = 0; i < tx.updateIds.length; i++) {
      const id = tx.updateIds[i]!;
      const row = tx.update![i];
      const prev = seen.get(id);
      if (prev !== undefined) {
        into.update[prev] = row;
      } else {
        seen.set(id, into.updateIds.length);
        into.updateIds.push(id);
        into.update.push(row);
      }
    }
  }
}

export class WorkerCoordinator {
  private dataWorker: DataWorkerClient | null = null;
  private dataWorkerActive = false;
  private dataWorkerFallbackLogged = false;
  /** True after the worker has received the initial row payload. */
  private workerMirrorSynced = false;
  /** Snapshot retained for worker-fallback restore when the mirror is dropped. */
  private workerSeedRows: unknown[] | null = null;
  /**
   * Serialise all worker RPCs. Tick floods otherwise starve setPipelineConfig +
   * rebuildModel (expand/collapse never lands).
   */
  private opChain: Promise<void> = Promise.resolve();
  /** Coalesced update-only payloads waiting for the next op-chain slot. */
  private pendingTx: AggTransactionPayload | null = null;
  private txFlushEnqueued = false;

  constructor(private readonly host: WorkerCoordinatorHost) {}

  /** Returns true if data plane is active. */
  get dataPlaneActive(): boolean {
    return this.dataWorkerActive;
  }

  get fallbackLogged(): boolean {
    return this.dataWorkerFallbackLogged;
  }

  /** Data worker client when constructed (may be inactive). */
  get dataClient(): DataWorkerClient | null {
    return this.dataWorker;
  }

  /** Reset mirror sync state after a full row-data replace. */
  onRowDataReset(rows: unknown[]): void {
    this.workerMirrorSynced = false;
    this.workerSeedRows = rows.slice();
  }

  /** Log once when worker data plane is ineligible for current options. */
  logIneligibleWarning(): void {
    if (this.dataWorkerFallbackLogged) return;
    this.dataWorkerFallbackLogged = true;
    console.warn('[tabular] worker data plane ineligible for current options; using main thread');
  }

  syncDataPlane(config: WorkerPipelineConfig | null, ids: string[], rows: unknown[]): void {
    if (!config) return;
    this.syncDataWorker(config, ids, rows);
  }

  forwardTransaction(tx: AggTransactionPayload): void {
    this.forwardTransactionToDataWorker(tx);
  }

  requestViewport(req: ViewportRequest): Promise<ViewportChunk | null> {
    if (!this.dataWorkerActive || !this.dataWorker) return Promise.resolve(null);
    return this.dataWorker.getViewport(req).catch((err) => {
      console.warn(
        '[tabular] viewport prefetch failed',
        err instanceof Error ? err.message : String(err),
      );
      return null;
    });
  }

  teardown(): void {
    this.teardownDataWorker();
  }

  private enqueue(op: () => Promise<void>): void {
    this.opChain = this.opChain.then(op).catch((err) => {
      this.fallbackDataWorker(err instanceof Error ? err.message : String(err));
    });
  }

  private ensureDataWorker(): DataWorkerClient | null {
    if (this.dataWorker) return this.dataWorker;
    try {
      const worker = new Worker(new URL('./dataWorker.ts', import.meta.url), {
        type: 'module',
      });
      this.dataWorker = new DataWorkerClient(
        worker,
        (output, rules) => {
          if (this.host.destroyed || !this.dataWorkerActive) return;
          this.host.applyWorkerModel(output);
          if (rules) this.host.onRulesResult?.(rules);
        },
        (updates) => {
          if (this.host.destroyed || !this.dataWorkerActive) return;
          const aggChanges = this.host.patchGroupAggregates(updates);
          if (aggChanges.length) {
            if (this.host.enableCellFlash) {
              for (const c of aggChanges) this.host.flashCellChange(c);
            }
            this.host.updateStatusBar();
          }
          // Leaf cells also changed on the worker — refresh viewport only in
          // chunk-only (owns) mode; mirror mode paints from main row objects.
          if (this.host.workerOwnsRowData) {
            this.host.invalidateViewportPrefetch();
            this.host.requestPaint();
          } else {
            this.host.requestPaint({ prefetch: false });
          }
        },
        // Render plane (Task 7): forward pre-rendered tick deltas to the host
        // (DOM worker materializer stamps them; canvas host leaves it unset).
        (deltas) => {
          if (this.host.destroyed || !this.dataWorkerActive) return;
          this.host.onRenderDeltas?.(deltas);
        },
        // Task 7: a worker crash (uncaught error / killed in DevTools) degrades
        // to the main thread through the same fallback path as op-chain errors.
        () => {
          if (this.host.destroyed) return;
          this.fallbackDataWorker('worker error');
        },
      );
      return this.dataWorker;
    } catch {
      this.fallbackDataWorker('worker construction failed');
      return null;
    }
  }

  private syncDataWorker(config: WorkerPipelineConfig, ids: string[], rows: unknown[]): void {
    const client = this.ensureDataWorker();
    if (!client) return;
    this.dataWorkerActive = true;
    this.host.warnWorkerAggregationIgnored?.();

    if (!this.workerSeedRows?.length && rows.length) {
      this.workerSeedRows = rows.slice();
    }

    // Drop coalesced ticks that targeted the pre-rebuild model; fresh ticks
    // after rebuild will repopulate pendingTx.
    this.pendingTx = null;

    const mirrorSynced = this.workerMirrorSynced;
    this.enqueue(async () => {
      if (this.host.destroyed || !this.dataWorkerActive || this.dataWorker !== client) return;
      await client.setPipelineConfig(config);
      await this.host.syncWorkerRulesConfig(client);
      if (!mirrorSynced) {
        await client.setRowData(ids, rows);
      }
      await client.rebuildModel();
      this.workerMirrorSynced = true;
    });
  }

  private fallbackDataWorker(reason: string): void {
    if (!this.dataWorkerFallbackLogged) {
      this.dataWorkerFallbackLogged = true;
      console.warn(`[tabular] worker data plane unavailable (${reason}); using main thread`);
    }
    if (!this.host.dataMirrorActive && this.workerSeedRows?.length) {
      this.host.restoreDataMirror(this.workerSeedRows);
    }
    this.workerMirrorSynced = false;
    this.teardownDataWorker();
    this.host.fallbackToMain(reason);
  }

  private teardownDataWorker(): void {
    this.dataWorkerActive = false;
    this.workerMirrorSynced = false;
    this.pendingTx = null;
    this.txFlushEnqueued = false;
    this.opChain = Promise.resolve();
    this.dataWorker?.destroy();
    this.dataWorker = null;
  }

  /** Stream a transaction batch to the data-plane worker (coalesced + serialised). */
  private forwardTransactionToDataWorker(tx: AggTransactionPayload): void {
    if (!this.dataWorkerActive || !this.dataWorker) return;
    if (!tx.addIds?.length && !tx.updateIds?.length && !tx.removeIds?.length) return;

    if (!this.pendingTx) this.pendingTx = {};
    mergeAggTx(this.pendingTx, tx);
    if (this.txFlushEnqueued) return;
    this.txFlushEnqueued = true;

    this.enqueue(async () => {
      this.txFlushEnqueued = false;
      const client = this.dataWorker;
      if (this.host.destroyed || !this.dataWorkerActive || !client) return;
      const batch = this.pendingTx;
      this.pendingTx = null;
      if (!batch) return;
      if (!batch.addIds?.length && !batch.updateIds?.length && !batch.removeIds?.length) return;
      await client.applyTransaction(batch);
      if (this.host.destroyed || !this.dataWorkerActive) return;
      if (this.host.workerOwnsRowData) {
        this.host.invalidateViewportPrefetch();
        this.host.requestPaint();
      } else {
        // Mirror already updated on main — paint without getViewport thrash.
        this.host.requestPaint({ prefetch: false });
      }
    });
  }
}
