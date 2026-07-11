/**
 * Worker lifecycle coordinator — owns data-plane and agg side-channel clients
 * so the grid host stays paint/DOM focused.
 */
import { AggWorkerClient } from './client';
import { DataWorkerClient } from './dataClient';
import type {
  AggModel,
  AggTransactionPayload,
  GroupAggUpdate,
  ViewportChunk,
  ViewportRequest,
  WorkerModelOutput,
  WorkerPipelineConfig,
} from './protocol';
import type { CellChange } from '../rowModel';
import type { RulesEvalResult } from '@tabular/rules';

export interface WorkerCoordinatorHost {
  destroyed: boolean;
  requestPaint(): void;
  updateStatusBar(): void;
  flashCellChange(c: { rowId: string; colKey: string; dir: 1 | -1 | 0 }): void;
  enableCellFlash: boolean;
  applyWorkerModel(output: WorkerModelOutput): void;
  patchGroupAggregates(updates: GroupAggUpdate[]): CellChange[];
  fallbackToMain(reason: string): void;
  onRulesResult?(rules: RulesEvalResult): void;
  /** True when the main-thread row mirror is active (config-only worker sync). */
  readonly dataMirrorActive: boolean;
  restoreDataMirror(rows: unknown[]): void;
  syncWorkerRulesConfig(client: DataWorkerClient): Promise<void>;
}

export class WorkerCoordinator {
  private aggWorker: AggWorkerClient | null = null;
  private aggWorkerActive = false;

  private dataWorker: DataWorkerClient | null = null;
  private dataWorkerActive = false;
  private dataWorkerFallbackLogged = false;
  /** True after the worker has received the initial row payload. */
  private workerMirrorSynced = false;
  /** Snapshot retained for worker-fallback restore when the mirror is dropped. */
  private workerSeedRows: unknown[] | null = null;

  constructor(private readonly host: WorkerCoordinatorHost) {}

  /** Returns true if data plane is active. */
  get dataPlaneActive(): boolean {
    return this.dataWorkerActive;
  }

  get aggSideChannelActive(): boolean {
    return this.aggWorkerActive;
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

  syncAggSideChannel(model: AggModel | null, ids: string[], rows: unknown[]): void {
    this.syncAggWorker(model, ids, rows);
  }

  forwardTransaction(tx: AggTransactionPayload): void {
    this.forwardTransactionToDataWorker(tx);
  }

  /** Stream update-only transaction to the agg side-channel. */
  forwardAggTransaction(tx: AggTransactionPayload): void {
    this.forwardUpdatesToAggWorker(tx);
  }

  requestViewport(req: ViewportRequest): Promise<ViewportChunk | null> {
    if (!this.dataWorkerActive || !this.dataWorker) return Promise.resolve(null);
    return this.dataWorker.getViewport(req).catch(() => null);
  }

  teardown(): void {
    this.aggWorker?.destroy();
    this.aggWorker = null;
    this.aggWorkerActive = false;
    this.teardownDataWorker();
  }

  private syncAggWorker(model: AggModel | null, ids: string[], rows: unknown[]): void {
    if (!model) {
      this.aggWorkerActive = false;
      return;
    }
    if (!this.aggWorker) {
      try {
        const worker = new Worker(new URL('./aggWorker.ts', import.meta.url), {
          type: 'module',
        });
        this.aggWorker = new AggWorkerClient(worker, (updates) => {
          if (this.host.destroyed || !this.aggWorkerActive) return;
          const aggChanges = this.host.patchGroupAggregates(updates);
          if (aggChanges.length) {
            if (this.host.enableCellFlash) {
              for (const c of aggChanges) this.host.flashCellChange(c);
            }
            this.host.updateStatusBar();
            this.host.requestPaint();
          }
        });
      } catch {
        // Worker construction can fail in non-bundled / test environments —
        // aggregation silently stays on the main thread.
        this.aggWorkerActive = false;
        return;
      }
    }
    this.aggWorkerActive = true;
    void this.aggWorker.setAggModel(model);
    void this.aggWorker.setRowData(ids, rows);
  }

  /** Stream an update-only transaction to the aggregation worker. */
  private forwardUpdatesToAggWorker(tx: AggTransactionPayload): void {
    if (!this.aggWorkerActive || !this.aggWorker || !tx.update?.length) return;
    void this.aggWorker.applyTransaction(tx);
  }

  private ensureDataWorker(): DataWorkerClient | null {
    if (this.dataWorker) return this.dataWorker;
    try {
      const worker = new Worker(new URL('./dataWorker.ts', import.meta.url), {
        type: 'module',
      });
      this.dataWorker = new DataWorkerClient(worker, (output, rules) => {
        if (this.host.destroyed || !this.dataWorkerActive) return;
        this.host.applyWorkerModel(output);
        if (rules) this.host.onRulesResult?.(rules);
      });
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
    this.aggWorkerActive = false;

    const configOnly = this.workerMirrorSynced && this.host.dataMirrorActive;

    if (configOnly) {
      void client
        .setPipelineConfig(config)
        .then(() => this.host.syncWorkerRulesConfig(client))
        .then(() => client.rebuildModel())
        .catch((err) => this.fallbackDataWorker(err instanceof Error ? err.message : String(err)));
      return;
    }

    if (!this.workerSeedRows?.length && rows.length) {
      this.workerSeedRows = rows.slice();
    }

    void client
      .setPipelineConfig(config)
      .then(() => this.host.syncWorkerRulesConfig(client))
      .then(() => client.setRowData(ids, rows))
      .then(() => client.rebuildModel())
      .then(() => {
        this.workerMirrorSynced = true;
      })
      .catch((err) => this.fallbackDataWorker(err instanceof Error ? err.message : String(err)));
  }

  private fallbackDataWorker(reason: string): void {
    if (!this.dataWorkerFallbackLogged) {
      this.dataWorkerFallbackLogged = true;
      console.warn(`[tabular] worker data plane unavailable (${reason}); using main thread`);
    }
    if (this.host.dataMirrorActive && this.workerSeedRows?.length) {
      this.host.restoreDataMirror(this.workerSeedRows);
    }
    this.workerMirrorSynced = false;
    this.teardownDataWorker();
    this.host.fallbackToMain(reason);
  }

  private teardownDataWorker(): void {
    this.dataWorkerActive = false;
    this.workerMirrorSynced = false;
    this.dataWorker?.destroy();
    this.dataWorker = null;
  }

  /** Stream a transaction batch to the data-plane worker. */
  private forwardTransactionToDataWorker(tx: AggTransactionPayload): void {
    if (!this.dataWorkerActive || !this.dataWorker) return;
    if (!tx.addIds?.length && !tx.updateIds?.length && !tx.removeIds?.length) return;
    void this.dataWorker
      .applyTransaction(tx)
      .catch((err) => this.fallbackDataWorker(err instanceof Error ? err.message : String(err)));
  }
}
