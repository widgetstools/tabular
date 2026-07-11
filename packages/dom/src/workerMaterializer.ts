/**
 * Worker-backed `RenderView` (Task 7). In worker mode the UI thread does NO
 * formatting, style resolution, or expression evaluation — it stamps only the
 * precomputed text + style-table ids the worker render plane (Task 6) ships.
 *
 * This view caches the last `renderWindowResult` and resolves `cell()`/
 * `rowMeta()` straight out of those flat arrays; `requestWindow()` fetches a new
 * window (coalesced) and pushed `renderDeltas` patch the cache + restamp
 * individual cells for live ticks. The synchronous {@link MainMaterializer}
 * stays as the fallback behind the same seam.
 */

import type {
  DataWorkerClient,
  RenderDeltas,
  RenderPlaneConfig,
  RenderWindowResult,
  RowModel,
} from '@tabular/core';
import type { StyleTable } from './styles';
import type { CellRender, RenderView, RowMeta } from './renderView';

/** rowKind wire codes (mirror of RenderWindowResult.rowKind). */
const KIND_LEAF = 0;
const KIND_FOOTER = 2;

function kindOf(code: number): RowMeta['kind'] {
  if (code === KIND_LEAF) return 'leaf';
  if (code === KIND_FOOTER) return 'footer';
  return 'group';
}

/** Cached render window: flat, row-major arrays keyed off `first`. */
interface CachedWindow {
  /** Absolute displayed index of the first cached row. */
  first: number;
  rowCount: number;
  rowIds: string[];
  rowKind: Uint8Array;
  rowLevel: Uint8Array;
  rowExpanded: Uint8Array;
  /** rows × cols, row-major. */
  text: string[];
  styleIds: Uint16Array;
}

/** Grid hooks the materializer drives on pushed render deltas. */
export interface WorkerMaterializerCallbacks {
  /**
   * Restamp one already-patched cell in place (absolute displayed row index,
   * display column index, tick flash direction). The grid forwards to
   * `RowPool.rebindCell`, which reads the freshly patched `cell()`.
   */
  onDelta(rowIndex: number, colIndex: number, dir: 1 | -1 | 0): void;
}

/**
 * Async `RenderView` over the worker render plane. Constructed per render
 * config; the grid recreates it whenever the config changes (sort/group/column
 * set), and routes pushed {@link RenderDeltas} into {@link applyDeltas}.
 */
export class WorkerMaterializer<TData> implements RenderView<TData> {
  private win: CachedWindow | null = null;
  private readonly colCount: number;
  /** Highest model revision applied; drops stale window/delta messages. */
  private lastRevision = -1;
  /** Monotonic request id; only the newest window result is kept (scroll race). */
  private reqSeq = 0;
  private appliedSeq = 0;
  private lastRequested: { first: number; last: number } | null = null;
  /** Set after a model update so the next requestWindow refetches the range. */
  private forceNextRequest = true;
  private updateCb: (() => void) | null = null;

  /**
   * @param rows      live row model (its displayed length drives `rowCount`;
   *   the coordinator keeps it in sync via `applyWorkerModel`).
   * @param getClient resolves the current worker client (may change on
   *   teardown/fallback; render-window requests read it lazily).
   * @param config    render config (only its column count is needed here).
   * @param styleTable shared DOM style table the pool applies class names from.
   * @param callbacks grid hooks for pushed tick deltas.
   */
  constructor(
    private readonly rows: RowModel<TData>,
    private readonly getClient: () => DataWorkerClient | null,
    config: RenderPlaneConfig,
    private readonly styleTable: StyleTable,
    private readonly callbacks: WorkerMaterializerCallbacks,
  ) {
    this.colCount = config.cols.length;
  }

  /** @inheritdoc */
  rowCount(): number {
    return this.rows.displayedNodes.length;
  }

  /** @inheritdoc */
  rowMeta(rowIndex: number): RowMeta | undefined {
    const w = this.win;
    if (!w) return undefined;
    const local = rowIndex - w.first;
    if (local < 0 || local >= w.rowCount) return undefined;
    return {
      id: w.rowIds[local]!,
      kind: kindOf(w.rowKind[local]!),
      level: w.rowLevel[local]!,
      expanded: w.rowExpanded[local] === 1,
    };
  }

  /** @inheritdoc */
  cell(rowIndex: number, colIndex: number): CellRender | undefined {
    const w = this.win;
    if (!w) return undefined;
    const local = rowIndex - w.first;
    if (local < 0 || local >= w.rowCount || colIndex < 0 || colIndex >= this.colCount) {
      return undefined;
    }
    const idx = local * this.colCount + colIndex;
    return {
      text: w.text[idx] ?? '',
      styleClass: this.styleTable.className(w.styleIds[idx] ?? 0),
    };
  }

  /** @inheritdoc — fetch the window (coalesced; skipped if the range is unchanged). */
  requestWindow(firstRow: number, lastRow: number): void {
    if (
      !this.forceNextRequest &&
      this.lastRequested &&
      this.lastRequested.first === firstRow &&
      this.lastRequested.last === lastRow
    ) {
      return;
    }
    const client = this.getClient();
    if (!client) return;
    this.lastRequested = { first: firstRow, last: lastRow };
    this.forceNextRequest = false;
    const seq = ++this.reqSeq;
    client.renderWindow(firstRow, lastRow).then(
      (res) => this.onWindowResult(res, seq),
      () => {
        // Worker torn down or request superseded — ignore; the pool re-requests
        // on the next bind and fallback (if any) repaints from the main view.
      },
    );
  }

  /** @inheritdoc */
  onUpdate(cb: () => void): void {
    this.updateCb = cb;
  }

  /**
   * Force the next {@link requestWindow} to refetch (the model changed under a
   * possibly-identical scroll window). Called by the grid host on every worker
   * model update.
   */
  invalidate(): void {
    this.forceNextRequest = true;
    this.lastRequested = null;
  }

  private onWindowResult(res: RenderWindowResult, seq: number): void {
    if (seq < this.appliedSeq) return; // superseded by a newer request
    if (res.modelRevision < this.lastRevision) return; // stale model
    this.appliedSeq = seq;
    this.lastRevision = res.modelRevision;
    // Apply the style table BEFORE any styleId from this message is resolved.
    if (res.styleTable) this.styleTable.setTable(res.styleTableVersion, res.styleTable);
    this.win = {
      first: res.firstRow,
      rowCount: res.rowIds.length,
      rowIds: res.rowIds,
      rowKind: res.rowKind,
      rowLevel: res.rowLevel,
      rowExpanded: res.rowExpanded,
      text: res.text,
      styleIds: res.styleIds,
    };
    this.updateCb?.();
  }

  /**
   * Apply a pushed render-delta batch: patch the cached window arrays (so a
   * later bindWindow stays consistent) then restamp each affected cell. Deltas
   * are dropped when the batch's model revision doesn't match the cached
   * window, or when a delta's absolute row falls outside the current window
   * (the client may have scrolled past the worker's last-seen window).
   */
  applyDeltas(msg: RenderDeltas): void {
    const w = this.win;
    if (!w) return;
    // Drop only STALE deltas (older than the cached window). The worker bumps
    // the model revision on every applied transaction, so an update-only tick's
    // delta always carries `windowRevision + 1` even though the displayed model
    // is structurally identical (same rows/order) — its firstRow-relative
    // mapping is still valid, so accept it and advance our revision. Structural
    // rebuilds don't push deltas (pushRenderDeltas needs updateIds); they arrive
    // as a model update that invalidates + refetches the window instead.
    if (msg.modelRevision < this.lastRevision) return;
    this.lastRevision = msg.modelRevision;
    // Apply the style table BEFORE resolving any styleId from this message.
    if (msg.styleTable) this.styleTable.setTable(msg.styleTableVersion, msg.styleTable);
    for (const d of msg.deltas) {
      const abs = msg.firstRow + d.rowIndex;
      const local = abs - w.first;
      if (local < 0 || local >= w.rowCount) continue; // no overlap with current window
      if (d.colIndex < 0 || d.colIndex >= this.colCount) continue;
      const idx = local * this.colCount + d.colIndex;
      w.text[idx] = d.text;
      w.styleIds[idx] = d.styleId;
      this.callbacks.onDelta(abs, d.colIndex, d.dir);
    }
  }
}
