/**
 * ViewHost — owns the Table+View lifecycle (spec §5). With engine.ts this is
 * the only module allowed to touch `@finos/perspective`, and here only type
 * imports appear: no engine code runs until a table method is called, so
 * modules above the seam (and CJS test scripts) can import this statically.
 */
import type { View } from '@finos/perspective';
import type { TableHandle } from './engine';
import type { RowMeta, WindowSlice } from './types';
import { isEquivalent, META_COLUMN_RE } from './viewCompiler';
import type { PspViewConfig } from './viewCompiler';

export interface ViewHostEvents {
  /** Fired at most once per throttle window; adaptive throttle lives inside. */
  onModelUpdated(rowCountChanged: boolean): void;
}

export class ViewHost {
  private view: View | null = null;
  /** The user-facing config (pre leaf-level injection) — the equivalence key. */
  private userCfg: PspViewConfig | null = null;
  private numRows = 0;
  private colPaths: string[] = [];
  private updateId: number | null = null;
  private lastPaintMs = 16;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private trailingUpdate = false;
  private disposed = false;
  /**
   * Blank aggregate cells on group rows shallower than this (spec §5.3). The
   * FinOS datagrid exposes it per column as `aggregate_depth`, default 0 —
   * i.e. no blanking unless opted in; phase-1 ColDefs don't yet.
   */
  private aggDepth = 0;

  constructor(
    private readonly table: TableHandle,
    private readonly events: ViewHostEvents,
  ) {}

  /** Rebuilds only when !isEquivalent(prev, next); resolves when active. */
  async setConfig(cfg: PspViewConfig, groupDefaultExpanded: number): Promise<void> {
    if (this.view && this.userCfg && isEquivalent(this.userCfg, cfg)) return;
    const raw = this.table.raw();
    const engineCfg: PspViewConfig = { ...cfg, group_by: [...cfg.group_by] };
    if (cfg.group_by.length > 0) {
      // Perspective's grouped tree is exactly group_by.length levels deep —
      // there is no leaf level below the deepest group. Append the table's
      // index column as an extra grouping level so groups expand to the
      // underlying rows (ag-grid semantics).
      const indexCol = await raw.get_index();
      if (indexCol && !engineCfg.group_by.includes(indexCol)) engineCfg.group_by.push(indexCol);
    }
    // Build the new view before touching the old one — there is never a gap
    // with no live view (spec §5.5).
    const next = await raw.view(engineCfg as never);
    const updateId = (await next.on_update(() => this.onEngineUpdate())) as number;
    if (cfg.group_by.length > 0) {
      // set_depth throws past the engine tree depth; -1 means expand-all.
      const maxDepth = engineCfg.group_by.length;
      const depth = groupDefaultExpanded < 0 ? maxDepth : Math.min(groupDefaultExpanded, maxDepth);
      await next.set_depth(depth);
    }
    const old = this.view;
    const oldId = this.updateId;
    this.view = next;
    this.updateId = updateId;
    this.userCfg = cfg;
    await this.refreshRowCount();
    const paths = (await next.column_paths()) as string[];
    this.colPaths = paths.filter((p) => !META_COLUMN_RE.test(p));
    if (old) {
      if (oldId != null) await old.remove_update(oldId);
      await old.delete();
    }
  }

  /** Cached; refreshed on update/expand/collapse/setDepth. */
  rowCount(): number {
    return this.numRows;
  }

  /** Meta-filtered, cached per view. */
  columnPaths(): string[] {
    return this.colPaths;
  }

  /** Grid reports its materialize+paint duration here to pace the update throttle. */
  notePaintDuration(ms: number): void {
    this.lastPaintMs = ms;
  }

  async window(firstRow: number, lastRow: number, firstCol: number, lastCol: number): Promise<WindowSlice> {
    const v = this.view;
    if (!v) return { firstRow, rowCount: 0, metas: [], cols: [], values: [] };
    const userDepth = this.userCfg?.group_by.length ?? 0;
    const grouped = userDepth > 0;
    // end_row is lastRow + 2: one row past the window, so the last row's
    // expanded state (derived from whether the next row's path is deeper) is
    // computable from this same read.
    const parsed = JSON.parse(
      await v.to_columns_string({
        start_row: firstRow,
        end_row: lastRow + 2,
        start_col: firstCol,
        end_col: lastCol + 1,
        id: true,
      } as never),
    ) as Record<string, unknown[]>;
    const rowPaths = (parsed['__ROW_PATH__'] as unknown[][] | undefined) ?? null;
    const ids = (parsed['__ID__'] as unknown[][] | undefined) ?? null;
    // Columns come from the cached path list, NOT the response keys: with
    // split_by, an update can add pivot columns to the engine before the
    // grid's header/geometry rebuild sees them (the FinOS datagrid guards the
    // same seam) — keying by cache keeps data and headers consistent, and the
    // new column set lands atomically on the next update flush.
    const cols = this.colPaths.slice(firstCol, lastCol + 1);
    const firstKey = Object.keys(parsed).find((k) => !META_COLUMN_RE.test(k));
    const returned =
      rowPaths?.length ?? ids?.length ?? (firstKey ? parsed[firstKey].length : 0);
    const rowCount = Math.min(returned, lastRow - firstRow + 1);
    const metas: RowMeta[] = [];
    for (let i = 0; i < rowCount; i++) {
      const path = (rowPaths?.[i] ?? []).map((p) => String(p));
      // Rows deeper than the user's group levels sit on the injected index
      // level: they are the actual leaves.
      const isGroup = grouped && path.length <= userDepth;
      const nextPath = rowPaths?.[i + 1];
      metas.push({
        id: isGroup ? path.join('|') : (ids?.[i] ?? []).map(String).join('|'),
        kind: isGroup ? 'group' : 'leaf',
        level: path.length,
        path,
        expanded: isGroup && nextPath != null && nextPath.length > path.length,
      });
    }
    const values = cols.map((c) => {
      const arr: unknown[] =
        (parsed[c] as unknown[] | undefined)?.slice(0, rowCount) ??
        new Array<unknown>(rowCount).fill(null);
      if (grouped && this.aggDepth > 0) {
        for (let i = 0; i < rowCount; i++) {
          if (metas[i].path.length < this.aggDepth) arr[i] = null;
        }
      }
      return arr;
    });
    return { firstRow, rowCount, metas, cols, values };
  }

  /** Refreshes rowCount before resolving — callers await, then redraw (Global Constraints). */
  async expand(viewRowIndex: number): Promise<void> {
    if (!this.view) return;
    await this.view.expand(viewRowIndex);
    await this.refreshRowCount();
  }

  async collapse(viewRowIndex: number): Promise<void> {
    if (!this.view) return;
    await this.view.collapse(viewRowIndex);
    await this.refreshRowCount();
  }

  async setDepth(n: number): Promise<void> {
    if (!this.view) return;
    await this.view.set_depth(n);
    await this.refreshRowCount();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    const v = this.view;
    this.view = null;
    this.userCfg = null;
    if (v) {
      if (this.updateId != null) await v.remove_update(this.updateId);
      await v.delete();
    }
  }

  private async refreshRowCount(): Promise<void> {
    const v = this.view;
    if (!v) return;
    if (this.userCfg && this.userCfg.split_by.length > 0) {
      // num_rows() counts physical rows; with split_by the traversal count
      // lives in dimensions (spec §5.1).
      const dims = (await v.dimensions()) as { num_view_rows: number };
      this.numRows = dims.num_view_rows;
    } else {
      this.numRows = await v.num_rows();
    }
  }

  /**
   * Adaptive throttle (spec §5.4): trailing-edge timer paced by the last
   * paint duration; a burst during the window coalesces into one more firing.
   */
  private onEngineUpdate(): void {
    if (this.disposed) return;
    if (this.throttleTimer) {
      this.trailingUpdate = true;
      return;
    }
    this.throttleTimer = setTimeout(() => {
      void this.flushUpdate();
    }, Math.max(16, this.lastPaintMs));
  }

  private async flushUpdate(): Promise<void> {
    this.throttleTimer = null;
    if (this.disposed || !this.view) return;
    const prev = this.numRows;
    await this.refreshRowCount();
    if (this.userCfg && this.userCfg.split_by.length > 0) {
      // Updates can add/remove pivot columns (a new split value arrived);
      // refresh the cache so window reads and the grid's rebuild see them.
      const paths = (await this.view.column_paths()) as string[];
      this.colPaths = paths.filter((p) => !META_COLUMN_RE.test(p));
    }
    if (this.disposed) return;
    this.events.onModelUpdated(this.numRows !== prev);
    if (this.trailingUpdate) {
      this.trailingUpdate = false;
      this.onEngineUpdate();
    }
  }
}
