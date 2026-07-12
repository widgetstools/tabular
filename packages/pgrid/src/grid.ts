/**
 * PspGrid — the orchestrator (spec §3/§4). One indexed Perspective table; grid
 * state compiles to one view (ViewHost); the Materializer is the async
 * RenderView; the RowPool stamps a recycled DOM window. `view.on_update` is
 * the only refresh channel — there is no polling anywhere.
 *
 * Group labels render in a display-only "auto group column" (ag-grid
 * semantics): a grid-side RenderView adapter offsets data columns by one when
 * grouped and synthesizes label cells from row metas, so ticking group
 * aggregates stay visible in the value columns.
 */
import { createIndexedTable } from './engine';
import type { TableHandle } from './engine';
import { Header, colTitle } from './header';
import type { HeaderCol } from './header';
import { Materializer, groupLabel } from './materializer';
import type { RenderView } from './materializer';
import { Panels } from './panels';
import { RowPool } from './pool';
import type { PoolGeometry } from './pool';
import { applyTheme, ensureStyles, CLS } from './styles';
import type { ColDef, GridOptions, GridState } from './types';
import { compileView, splitPath } from './viewCompiler';
import type { PspViewConfig } from './viewCompiler';
import { computeViewport, panelHeight, poolSize, visibleCols } from './windowMath';
import type { Viewport } from './windowMath';
import { ViewHost } from './viewHost';

/** Must match the stylesheet's `--pg-row-h`. */
const ROW_H = 26;
/** Px per group nesting level (first visible cell indent + chevron offset). */
const GROUP_INDENT = 12;
/** Display-only column id for the auto group column — never reaches the engine. */
const GROUP_COL = '__group__';
const GROUP_COL_W = 200;
const DEFAULT_COL_W = 120;

export type GridEvent = 'ready' | 'model-updated' | 'column-state-changed';

interface ColRange {
  firstCol: number;
  lastCol: number;
}

export class PspGrid {
  private readonly panelsEl: HTMLDivElement;
  private readonly bodyEl: HTMLDivElement;
  private readonly sidebarEl: HTMLDivElement;
  private readonly headerEl: HTMLDivElement;
  private readonly scroller: HTMLDivElement;
  private readonly spacer: HTMLDivElement;
  private readonly layer: HTMLDivElement;
  private readonly header: Header;
  private readonly panels: Panels;
  private readonly pool: RowPool;
  private readonly abort = new AbortController();

  private state: GridState;
  private cfg: PspViewConfig;
  private table: TableHandle | null = null;
  private host: ViewHost | null = null;
  private mat: Materializer | null = null;
  private rv: RenderView | null = null;

  private displayCols: HeaderCol[] = [];
  private colWidths: number[] = [];
  private colLefts: number[] = [];
  private totalWidth = 0;
  /** 1 when the auto group column is present, 0 otherwise. */
  private groupOffset = 0;
  private groupColW = GROUP_COL_W;
  /** Column-path fingerprint of the last rebuild — updates can grow the pivot column set. */
  private pathsKey = '';

  private lastV: Viewport | null = null;
  private lastC: ColRange | null = null;
  /** Layer placement of the last data-backed paint; anchors the stale-pixel glue. */
  private painted: { scrollTop: number; layerTop: number } | null = null;
  /** True while stale pixels are glued to the viewport (window read in flight). */
  private glued = false;
  private poolAllocSize = -1;
  private poolAllocCols = -1;
  private raf: number | null = null;
  private syncForce = false;
  private destroyed = false;
  private frameWaiters: (() => void)[] = [];
  private listeners = new Map<GridEvent, Set<() => void>>();

  constructor(
    private readonly root: HTMLElement,
    private readonly options: GridOptions,
  ) {
    ensureStyles();
    root.classList.add(CLS.root);
    applyTheme(root, options.theme ?? 'dark');
    this.state = this.deriveState();
    this.cfg = compileView(this.state);

    this.panelsEl = document.createElement('div');
    this.headerEl = document.createElement('div');
    this.header = new Header(this.headerEl, {
      onSortClick: (colId, additive) => this.handleSortClick(colId, additive),
      onResize: (colId, w) => this.handleResize(colId, w),
      onDragStart: (colId, ev) => this.panels.startHeaderDrag(colId, ev),
    });
    this.sidebarEl = document.createElement('div');
    this.panels = new Panels(
      this.panelsEl,
      this.sidebarEl,
      {
        onGroupChange: (fields) => void this.applyColumnState({ rowGroupCols: fields }),
        onPivotChange: (fields) => void this.applyColumnState({ pivotCols: fields }),
        onValueChange: (cols) => void this.applyColumnState({ valueCols: cols }),
        onPivotMode: (on) => void this.setPivotMode(on),
      },
      {
        groupPanel: options.rowGroupPanelShow === 'always',
        pivotPanel: options.pivotPanelShow === 'always',
        sideBar: options.sideBar ?? false,
      },
    );
    this.scroller = document.createElement('div');
    this.scroller.className = CLS.scroller;
    this.spacer = document.createElement('div');
    this.spacer.className = CLS.spacer;
    this.layer = document.createElement('div');
    this.layer.className = CLS.layer;
    this.scroller.append(this.spacer, this.layer);
    // panels strip on top; below it the header+scroller column with the
    // columns sidebar to its right.
    const main = document.createElement('div');
    main.style.cssText = 'display:flex;flex-direction:column;flex:1;min-width:0;';
    main.append(this.headerEl, this.scroller);
    this.bodyEl = document.createElement('div');
    this.bodyEl.style.cssText = 'display:flex;flex:1;min-height:0;';
    this.bodyEl.append(main, this.sidebarEl);
    root.append(this.panelsEl, this.bodyEl);
    this.pool = new RowPool(this.layer);

    const signal = this.abort.signal;
    this.scroller.addEventListener('scroll', () => this.scheduleSync(), { passive: true, signal });
    // One delegated listener set on the grid root (Global Constraints).
    root.addEventListener(
      'click',
      (ev) => {
        const chev = (ev.target as HTMLElement).closest?.(`.${CLS.chevron}`);
        if (!(chev instanceof HTMLElement)) return;
        const rowEl = chev.closest(`.${CLS.row}`);
        const r = Number((rowEl as HTMLElement | null)?.dataset.row ?? NaN);
        if (Number.isFinite(r)) void this.toggleExpand(r);
      },
      { signal },
    );
  }

  /** Creates the indexed table and the initial view; resolves on 'ready'. */
  async setSchema(schema: Record<string, string>): Promise<void> {
    const table = await createIndexedTable(schema, this.options.rowIdField);
    if (this.destroyed) {
      await table.delete();
      return;
    }
    this.table = table;
    const host = new ViewHost(table, {
      onModelUpdated: (rowCountChanged) => this.onModelUpdated(rowCountChanged),
    });
    this.host = host;
    await host.setConfig(this.cfg, this.options.groupDefaultExpanded ?? 0);
    if (this.destroyed) {
      this.host = null;
      this.table = null;
      await host.dispose();
      await table.delete();
      return;
    }
    const mat = new Materializer(host, (path) => this.colDefFor(path));
    this.mat = mat;
    mat.onFrame(() => this.paint());
    this.rv = this.makeRenderView(mat);
    this.rebuildColumns();
    this.header.render(this.state, this.displayCols, this.cfg);
    this.panels.render(this.state);
    this.sync(true);
    this.emit('ready');
  }

  /** Loads a snapshot; resolves once the engine has ingested it (barrier read). */
  async load(rows: Record<string, unknown>[]): Promise<void> {
    const host = this.host;
    const table = this.table;
    if (!table || !host) throw new Error('pgrid: call setSchema() before load()');
    table.update(rows);
    // The engine processes messages in order: a view read resolving after the
    // update means the batch is in. rowCount refresh + repaint arrive via the
    // on_update push channel.
    await host.window(0, 0, 0, 0);
  }

  /** Ticking updates — fire-and-forget; `view.on_update` repaints. */
  update(rows: Record<string, unknown>[]): void {
    this.table?.update(rows);
  }

  /** Merge a partial state, recompile the view, repaint. Scroll resets per spec §5.5. */
  async applyColumnState(partial: Partial<GridState>): Promise<void> {
    const host = this.host;
    if (!host) return;
    const prev = this.cfg;
    this.state = { ...this.state, ...partial };
    this.cfg = compileView(this.state);
    await host.setConfig(this.cfg, this.options.groupDefaultExpanded ?? 0);
    if (this.destroyed) return;
    if (JSON.stringify(prev.group_by) !== JSON.stringify(this.cfg.group_by)) {
      this.scroller.scrollTop = 0;
    }
    if (JSON.stringify(prev.split_by) !== JSON.stringify(this.cfg.split_by)) {
      this.scroller.scrollLeft = 0;
    }
    this.rebuildColumns();
    this.header.render(this.state, this.displayCols, this.cfg);
    this.panels.render(this.state);
    this.sync(true);
    this.emit('column-state-changed');
  }

  getColumnState(): GridState {
    return JSON.parse(JSON.stringify(this.state)) as GridState;
  }

  setPivotMode(on: boolean): Promise<void> {
    return this.applyColumnState({ pivotMode: on });
  }

  on(event: GridEvent, cb: () => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abort.abort();
    if (this.raf != null) cancelAnimationFrame(this.raf);
    for (const w of this.frameWaiters.splice(0)) w();
    this.pool.clear();
    // Remove only elements this instance created — the root may already host a
    // successor grid (React StrictMode double-mount).
    this.panelsEl.remove();
    this.bodyEl.remove();
    this.root.classList.remove(CLS.root);
    const host = this.host;
    const table = this.table;
    this.host = null;
    this.mat = null;
    this.rv = null;
    this.table = null;
    if (host) await host.dispose();
    if (table) await table.delete();
  }

  // ── state / columns ────────────────────────────────────────────────────

  /** Initial GridState from columnDefs (rowGroup/pivot/aggFunc), defaultColDef pre-merged. */
  private deriveState(): GridState {
    const defaults = this.options.defaultColDef;
    const defs = this.options.columnDefs.map((d) => (defaults ? { ...defaults, ...d } : d));
    const byIndex = (key: 'rowGroupIndex' | 'pivotIndex') => (a: ColDef, b: ColDef) =>
      (a[key] ?? 0) - (b[key] ?? 0);
    return {
      columnDefs: defs,
      rowGroupCols: defs.filter((d) => d.rowGroup).sort(byIndex('rowGroupIndex')).map((d) => d.field),
      pivotCols: defs.filter((d) => d.pivot).sort(byIndex('pivotIndex')).map((d) => d.field),
      valueCols: defs
        .filter((d) => d.aggFunc)
        .map((d) => ({ field: d.field, aggFunc: d.aggFunc as string })),
      sortModel: [],
      filterModel: {},
      pivotMode: this.options.pivotMode ?? false,
    };
  }

  private defFor(field: string): ColDef | undefined {
    return this.state.columnDefs.find((d) => d.field === field);
  }

  /** Engine column path → ColDef; pivot paths resolve through the measure name. */
  private colDefFor(path: string): ColDef | undefined {
    const field = this.cfg.split_by.length > 0 ? splitPath(path, this.cfg).measure : path;
    return this.defFor(field);
  }

  /** Rebuild the display column model (auto group column + engine paths) and geometry. */
  private rebuildColumns(): void {
    const host = this.host;
    if (!host) return;
    const grouped = this.cfg.group_by.length > 0;
    this.groupOffset = grouped ? 1 : 0;
    const cols: HeaderCol[] = [];
    if (grouped) {
      cols.push({
        colId: GROUP_COL,
        path: '',
        title: this.state.rowGroupCols.map((f) => colTitle(this.defFor(f), f)).join(' / '),
        width: this.groupColW,
        numeric: false,
        sortable: false,
      });
    }
    for (const path of host.columnPaths()) {
      const def = this.colDefFor(path);
      const field = this.cfg.split_by.length > 0 ? splitPath(path, this.cfg).measure : path;
      cols.push({
        colId: field,
        path,
        title: this.cfg.split_by.length > 0 ? colTitle(def, field) : colTitle(def, path),
        width: def?.width ?? DEFAULT_COL_W,
        numeric: def?.type === 'float' || def?.type === 'integer',
        sortable: true,
      });
    }
    this.displayCols = cols;
    this.colWidths = cols.map((c) => c.width);
    this.colLefts = [];
    let x = 0;
    for (const c of cols) {
      this.colLefts.push(x);
      x += c.width;
    }
    this.totalWidth = x;
    this.pathsKey = host.columnPaths().join('\u0000');
  }

  /** RenderView over the materializer that prepends the display-only group column. */
  private makeRenderView(mat: Materializer): RenderView {
    return {
      rowCount: () => mat.rowCount(),
      rowMeta: (r) => mat.rowMeta(r),
      cell: (r, c) => {
        const off = this.groupOffset;
        if (off && c === 0) {
          const meta = mat.rowMeta(r);
          if (!meta) return undefined;
          // Only group values render here (ag-grid semantics); leaf rows sit
          // on the injected index level and leave the group column blank.
          return { text: meta.kind === 'group' ? groupLabel(meta) : '', styleClass: '', flash: 0 };
        }
        return mat.cell(r, c - off);
      },
      requestWindow: (v, cols) => {
        const off = this.groupOffset;
        mat.requestWindow(v, {
          firstCol: Math.max(0, cols.firstCol - off),
          lastCol: Math.max(0, cols.lastCol - off),
        });
      },
      onFrame: (cb) => mat.onFrame(cb),
    };
  }

  // ── viewport sync loop ─────────────────────────────────────────────────

  private scheduleSync(force = false): void {
    this.syncForce = this.syncForce || force;
    if (this.raf != null || this.destroyed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      const force2 = this.syncForce;
      this.syncForce = false;
      this.sync(force2);
    });
  }

  private sync(force = false): void {
    const host = this.host;
    const rv = this.rv;
    if (!host || !rv || this.destroyed) return;
    const rowCount = host.rowCount();
    const clipH = this.scroller.clientHeight;
    const clipW = this.scroller.clientWidth;
    const panelH = panelHeight(rowCount, ROW_H, 0);
    this.spacer.style.height = `${panelH}px`;
    this.spacer.style.width = `${this.totalWidth}px`;
    const v = computeViewport(this.scroller.scrollTop, panelH, clipH, rowCount, ROW_H);
    const c = visibleCols(this.scroller.scrollLeft, clipW, this.colWidths);
    this.header.setScrollLeft(this.scroller.scrollLeft);
    const lv = this.lastV;
    const lc = this.lastC;
    // Draw-skip fast path: logical window and sub-cell offset unchanged.
    if (
      !force &&
      lv &&
      lc &&
      lv.firstRow === v.firstRow &&
      lv.lastRow === v.lastRow &&
      lv.subCellPx === v.subCellPx &&
      lc.firstCol === c.firstCol &&
      lc.lastCol === c.lastCol
    ) {
      return;
    }
    this.lastV = v;
    this.lastC = c;
    rv.requestWindow(v, c);
    const scrollTop = this.scroller.scrollTop;
    if (!rv.rowMeta(v.anchor) && this.painted) {
      // The engine hasn't caught up to this window (read in flight): glue the
      // previously painted pixels to the viewport — they track the scroll 1:1
      // so fast scrolling shows stale rows instead of a blank pane (the FinOS
      // datagrid behaves the same mid-fetch). paint() re-syncs on data.
      this.glued = true;
      this.layer.style.transform = `translate3d(0, ${
        this.painted.layerTop + (scrollTop - this.painted.scrollTop)
      }px, 0)`;
      return;
    }
    this.glued = false;
    // The layer sits at the window top; rows inside are window-relative, so
    // the 10M-px clamp never reaches element coordinates.
    const layerTop = scrollTop - (v.anchor - v.firstRow) * ROW_H;
    this.layer.style.transform = `translate3d(0, ${layerTop}px, 0)`;
    this.painted = { scrollTop, layerTop };
    const size = poolSize(clipH, ROW_H, rowCount);
    const colCount = Math.max(0, c.lastCol - c.firstCol + 1);
    if (size !== this.poolAllocSize || colCount !== this.poolAllocCols) {
      this.pool.setSize(size, colCount);
      this.poolAllocSize = size;
      this.poolAllocCols = colCount;
    }
    this.bind(v, c);
  }

  /** Stamp the pool from the current frame and report paint cost to the throttle. */
  private bind(v: Viewport, c: ColRange): void {
    const host = this.host;
    const rv = this.rv;
    if (!host || !rv) return;
    const t0 = performance.now();
    this.pool.bindWindow(v, rv, this.geometry(c));
    host.notePaintDuration(performance.now() - t0);
  }

  private geometry(c: ColRange): PoolGeometry {
    return {
      colWidths: this.colWidths,
      colLefts: this.colLefts,
      rowHeight: ROW_H,
      groupIndent: GROUP_INDENT,
      totalWidth: this.totalWidth,
      firstCol: c.firstCol,
      lastCol: c.lastCol,
    };
  }

  /** New materializer frame → rebind the stamped window. */
  private paint(): void {
    if (!this.destroyed && this.lastV && this.lastC) {
      if (this.glued) {
        // Fresh data after a glued scroll: recompute layer placement for the
        // CURRENT scroll position and stamp (sync re-requests if it moved on).
        this.sync(true);
      } else {
        this.bind(this.lastV, this.lastC);
      }
    }
    for (const w of this.frameWaiters.splice(0)) w();
  }

  private nextFrame(): Promise<void> {
    return new Promise((resolve) => this.frameWaiters.push(resolve));
  }

  private onModelUpdated(rowCountChanged: boolean): void {
    if (this.destroyed) return;
    // An update can add pivot columns (new split value in the data): rebuild
    // the display columns and header before repainting so data stays under
    // the right headers.
    if (this.host && this.host.columnPaths().join('\u0000') !== this.pathsKey) {
      this.rebuildColumns();
      this.header.render(this.state, this.displayCols, this.cfg);
      this.scheduleSync(true);
    }
    this.mat?.invalidate();
    if (rowCountChanged) this.scheduleSync(true);
    this.emit('model-updated');
  }

  // ── interactions ───────────────────────────────────────────────────────

  /** Sort click rotation: none → desc → asc → none (spec §5.7); additive keeps other columns. */
  private handleSortClick(colId: string, additive: boolean): void {
    const current = this.state.sortModel.find((s) => s.colId === colId);
    const next: 'desc' | 'asc' | null = !current ? 'desc' : current.sort === 'desc' ? 'asc' : null;
    let sortModel = additive ? this.state.sortModel.filter((s) => s.colId !== colId) : [];
    if (next) sortModel = [...sortModel, { colId, sort: next }];
    void this.applyColumnState({ sortModel });
  }

  /** Pure geometry — no view rebuild; header cell width is updated in place by the Header. */
  private handleResize(colId: string, w: number): void {
    if (colId === GROUP_COL) {
      this.groupColW = w;
    } else {
      this.state = {
        ...this.state,
        columnDefs: this.state.columnDefs.map((d) => (d.field === colId ? { ...d, width: w } : d)),
      };
    }
    this.rebuildColumns();
    this.scheduleSync(true);
  }

  /**
   * Expand/collapse by view row index, identity-checked against a FRESH
   * engine read (spec §10): under ticking updates the stamped index and
   * expanded flag can be a frame stale — the fresh read serializes behind
   * pending engine updates, and on identity mismatch the row is re-resolved
   * by path. Awaited through the next repaint (Global Constraints).
   */
  private async toggleExpand(r: number): Promise<void> {
    const host = this.host;
    const rv = this.rv;
    const mat = this.mat;
    if (!host || !rv || !mat) return;
    const meta = rv.rowMeta(r);
    if (!meta || meta.kind !== 'group' || !meta.expandable) return;
    const key = meta.path.join('\u0000');
    let target = r;
    let fresh = (await host.window(r, r, 0, 0)).metas[0];
    if (!fresh || fresh.path.join('\u0000') !== key) {
      const around = await host.window(Math.max(0, r - 50), r + 50, 0, 0);
      const idx = around.metas.findIndex((m) => m.path.join('\u0000') === key);
      if (idx === -1) return;
      target = around.firstRow + idx;
      fresh = around.metas[idx];
    }
    if (this.destroyed || fresh.kind !== 'group' || !fresh.expandable) return;
    if (fresh.expanded) await host.collapse(target);
    else await host.expand(target);
    if (this.destroyed) return;
    const painted = this.nextFrame();
    mat.invalidate();
    this.sync(true);
    await painted;
  }

  private emit(event: GridEvent): void {
    const set = this.listeners.get(event);
    if (set) for (const cb of set) cb();
  }
}
