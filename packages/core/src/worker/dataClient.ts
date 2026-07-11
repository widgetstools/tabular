/**
 * Main-thread client for the data-plane worker: promise-per-request envelope
 * plus rAF-coalesced `modelUpdated` pushes (bursts collapse to one apply).
 */
import type {
  AggTransactionPayload,
  DataWorkerPush,
  DataWorkerRequest,
  DataWorkerResponse,
  GroupAggUpdate,
  ReqId,
  RenderDeltas,
  RenderPlaneConfig,
  RenderWindowResult,
  ViewportChunk,
  ViewportRequest,
  WorkerAutosizeColumn,
  WorkerClipboardRange,
  WorkerCsvExportPayload,
  WorkerModelOutput,
  WorkerPipelineConfig,
  WorkerXlsxExportPayload,
} from './protocol';
import type { WorkerRulesConfigPayload } from './passes/rulesPass';
import type { RulesEvalResult } from '@tabular/rules';

export interface DataWorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', cb: (e: { data: unknown }) => void): void;
  removeEventListener?(type: 'message', cb: (e: { data: unknown }) => void): void;
  terminate(): void;
}

type PendingHandler = {
  resolve: (msg: DataWorkerResponse) => void;
  reject: (e: Error) => void;
};

export class DataWorkerClient {
  private nextId: ReqId = 1;
  private pending = new Map<ReqId, PendingHandler>();
  private destroyed = false;
  private readonly messageHandler: (e: { data: unknown }) => void;

  private pendingOutput: WorkerModelOutput | null = null;
  private pendingRules: RulesEvalResult | undefined;
  private flushScheduled = false;

  /** Coalesced push state: latest agg record per groupId inside one frame. */
  private pendingAggUpdates = new Map<string, GroupAggUpdate>();
  private aggFlushScheduled = false;

  constructor(
    private worker: DataWorkerLike,
    private onModelUpdated: (output: WorkerModelOutput, rules?: RulesEvalResult) => void,
    private onAggregatesUpdated?: (updates: GroupAggUpdate[]) => void,
    // Additive (Task 6): render-delta push consumer.
    private onRenderDeltas?: (deltas: RenderDeltas) => void,
  ) {
    this.messageHandler = (e) => {
      if (this.destroyed) return;
      this.onMessage(e.data as DataWorkerResponse | DataWorkerPush);
    };
    worker.addEventListener('message', this.messageHandler);
  }

  private onMessage(msg: DataWorkerResponse | DataWorkerPush): void {
    if (msg.type === 'aggregatesUpdated') {
      if (!this.onAggregatesUpdated) return;
      for (const u of msg.updates) this.pendingAggUpdates.set(u.groupId, u);
      if (!this.aggFlushScheduled) {
        this.aggFlushScheduled = true;
        requestAnimationFrame(() => {
          this.aggFlushScheduled = false;
          if (this.destroyed || !this.pendingAggUpdates.size) return;
          const updates = [...this.pendingAggUpdates.values()];
          this.pendingAggUpdates.clear();
          this.onAggregatesUpdated?.(updates);
        });
      }
      return;
    }
    if (msg.type === 'renderDeltas') {
      // Additive (Task 6): render-delta pushes bypass coalescing — the DOM
      // grid flashes each tick as it arrives.
      this.onRenderDeltas?.(msg);
      return;
    }
    if (msg.type === 'modelUpdated') {
      this.pendingOutput = msg.output;
      this.pendingRules = msg.rules;
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        requestAnimationFrame(() => {
          this.flushScheduled = false;
          if (this.destroyed || !this.pendingOutput) return;
          const output = this.pendingOutput;
          const rules = this.pendingRules;
          this.pendingOutput = null;
          this.pendingRules = undefined;
          this.onModelUpdated(output, rules);
        });
      }
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(msg.error));
    else p.resolve(msg);
  }

  private send<T extends DataWorkerResponse>(
    req: Omit<DataWorkerRequest, 'id'>,
    pick: (msg: DataWorkerResponse) => T,
  ): Promise<T> {
    if (this.destroyed) return Promise.reject(new Error('worker destroyed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (msg) => resolve(pick(msg)),
        reject,
      });
      this.worker.postMessage({ ...req, id });
    });
  }

  private sendVoid(req: Omit<DataWorkerRequest, 'id'>): Promise<void> {
    return this.send(req, (msg) => {
      if (msg.type !== 'ok') throw new Error(`unexpected response: ${msg.type}`);
      return msg;
    }).then(() => undefined);
  }

  setPipelineConfig(config: WorkerPipelineConfig): Promise<void> {
    return this.sendVoid({ type: 'setPipelineConfig', payload: config });
  }

  setRulesConfig(payload: WorkerRulesConfigPayload | null): Promise<void> {
    return this.sendVoid({ type: 'setRulesConfig', payload });
  }

  setRowData(ids: string[], rows: unknown[]): Promise<void> {
    return this.sendVoid({ type: 'setRowData', payload: { ids, rows } });
  }

  applyTransaction(payload: AggTransactionPayload): Promise<void> {
    return this.sendVoid({ type: 'applyTransaction', payload });
  }

  rebuildModel(): Promise<void> {
    return this.sendVoid({ type: 'rebuildModel', payload: {} });
  }

  getViewport(req: ViewportRequest): Promise<ViewportChunk> {
    return this.send({ type: 'getViewport', payload: req }, (msg) => {
      if (msg.type !== 'viewport') throw new Error(`unexpected response: ${msg.type}`);
      return msg;
    }).then((m) => m.chunk);
  }

  /** Additive (Task 6): set the render config (columns + formats/styles). */
  setRenderConfig(config: RenderPlaneConfig): Promise<void> {
    return this.sendVoid({ type: 'setRenderConfig', payload: config });
  }

  /**
   * Additive (Task 6): request render-ready cells for `[firstRow, lastRow]`.
   * Mirrors the viewport-chunk request pattern.
   */
  renderWindow(firstRow: number, lastRow: number): Promise<RenderWindowResult> {
    return this.send(
      { type: 'renderWindow', payload: { firstRow, lastRow } },
      (msg) => {
        if (msg.type !== 'renderWindowResult') {
          throw new Error(`unexpected response: ${msg.type}`);
        }
        return msg;
      },
    );
  }

  clipboardSerialize(ranges: WorkerClipboardRange[], delimiter?: string): Promise<string> {
    return this.send(
      { type: 'clipboardSerialize', payload: { ranges, delimiter } },
      (msg) => {
        if (msg.type !== 'clipboardSerializeResult') {
          throw new Error(`unexpected response: ${msg.type}`);
        }
        return msg;
      },
    ).then((m) => m.tsv);
  }

  clipboardDeserialize(text: string, delimiter?: string): Promise<string[][]> {
    return this.send(
      { type: 'clipboardDeserialize', payload: { text, delimiter } },
      (msg) => {
        if (msg.type !== 'clipboardDeserializeResult') {
          throw new Error(`unexpected response: ${msg.type}`);
        }
        return msg;
      },
    ).then((m) => m.rows);
  }

  exportCsv(payload: WorkerCsvExportPayload): Promise<Uint8Array> {
    return this.send({ type: 'exportCsv', payload }, (msg) => {
      if (msg.type !== 'exportCsvResult') throw new Error(`unexpected response: ${msg.type}`);
      return msg;
    }).then((m) => m.bytes);
  }

  exportXlsx(payload: WorkerXlsxExportPayload): Promise<Uint8Array> {
    return this.send({ type: 'exportXlsx', payload }, (msg) => {
      if (msg.type !== 'exportXlsxResult') throw new Error(`unexpected response: ${msg.type}`);
      return msg;
    }).then((m) => m.bytes);
  }

  autosize(
    columns: WorkerAutosizeColumn[],
    opts?: { skipHeader?: boolean; maxSampleSize?: number },
  ): Promise<Record<string, number>> {
    return this.send(
      {
        type: 'autosize',
        payload: {
          columns,
          skipHeader: opts?.skipHeader,
          maxSampleSize: opts?.maxSampleSize,
        },
      },
      (msg) => {
        if (msg.type !== 'autosizeResult') throw new Error(`unexpected response: ${msg.type}`);
        return msg;
      },
    ).then((m) => m.widths);
  }

  destroy(): void {
    this.destroyed = true;
    this.pending.clear();
    this.pendingOutput = null;
    this.pendingAggUpdates.clear();
    this.worker.removeEventListener?.('message', this.messageHandler);
    this.worker.terminate();
  }
}
