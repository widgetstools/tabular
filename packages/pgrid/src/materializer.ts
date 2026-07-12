/**
 * Materializer — the async RenderView over ViewHost (spec §4, §6). Caches the
 * last window slice, formats values through an Intl formatter cache, and
 * computes one-frame flash directions from a previous-frame double buffer.
 * Sits above the P4 engine-swap seam: no `@finos/perspective` imports.
 */
import type { CellRender, ColDef, RowMeta } from './types';
import type { ViewHost } from './viewHost';
import type { WindowSlice } from './types';
import type { Viewport } from './windowMath';

/** What the DOM plane binds from; kept engine-free so P4 can swap the producer. */
export interface RenderView {
  rowCount(): number;
  /** undefined while the window read is in flight or the row is outside it. */
  rowMeta(rowIndex: number): RowMeta | undefined;
  cell(rowIndex: number, colIndex: number): CellRender | undefined;
  requestWindow(v: Viewport, cols: { firstCol: number; lastCol: number }): void;
  /** New data ready → rebind. */
  onFrame(cb: () => void): void;
}

/** The requested window identity — the flash gate compares these (spec §6). */
interface WindowReq {
  firstRow: number;
  lastRow: number;
  firstCol: number;
  lastCol: number;
}

/** Group-row label for the first visible column: deepest path part, or TOTAL at the root. */
export function groupLabel(meta: RowMeta): string {
  return meta.path[meta.level - 1] ?? 'TOTAL';
}

/** Formatter per (type, format) — Intl.NumberFormat construction is expensive. */
const formatterCache = new Map<string, (v: number) => string>();

/**
 * '#,##0.00' pattern subset: fraction digits = characters after the '.',
 * grouping iff the pattern contains ','. Anything richer is a later phase.
 */
function numberFormatter(pattern: string): (v: number) => string {
  const dot = pattern.indexOf('.');
  const decimals = dot >= 0 ? pattern.length - dot - 1 : 0;
  const nf = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: pattern.includes(','),
  });
  return (v) => nf.format(v);
}

/** Format one raw engine value for display; null/undefined render empty. */
export function formatValue(v: unknown, def: ColDef | undefined): string {
  if (v == null) return '';
  if (typeof v === 'number' && def?.format) {
    const key = `${def.type ?? 'float'}|${def.format}`;
    let f = formatterCache.get(key);
    if (!f) {
      f = numberFormatter(def.format);
      formatterCache.set(key, f);
    }
    return f(v);
  }
  return String(v);
}

export class Materializer implements RenderView {
  private slice: WindowSlice | null = null;
  /** The request the current slice was read with (also the flash-gate key). */
  private sliceReq: WindowReq | null = null;
  private lastReq: WindowReq | null = null;
  private inFlight = false;
  private refetch = false;
  /** Previous-frame raw values keyed by `rowId + ' ' + colPath` (spec §6). */
  private prevFrame = new Map<string, unknown>();
  /** Per-frame memo of rendered cells; cleared on every slice swap. */
  private frameCells = new Map<string, CellRender>();
  private frameCbs = new Set<() => void>();

  constructor(
    private readonly host: ViewHost,
    private readonly getColDef: (path: string) => ColDef | undefined,
  ) {}

  rowCount(): number {
    return this.host.rowCount();
  }

  rowMeta(rowIndex: number): RowMeta | undefined {
    const s = this.slice;
    if (!s) return undefined;
    const i = rowIndex - s.firstRow;
    return i >= 0 && i < s.rowCount ? s.metas[i] : undefined;
  }

  cell(rowIndex: number, colIndex: number): CellRender | undefined {
    const s = this.slice;
    const req = this.sliceReq;
    if (!s || !req) return undefined;
    const r = rowIndex - s.firstRow;
    const c = colIndex - req.firstCol;
    if (r < 0 || r >= s.rowCount || c < 0 || c >= s.cols.length) return undefined;
    const memoKey = `${rowIndex}:${colIndex}`;
    const memo = this.frameCells.get(memoKey);
    if (memo) return memo;
    const meta = s.metas[r];
    const path = s.cols[c];
    const raw = s.values[c][r];
    const def = this.getColDef(path);
    // Group rows label the first visible column with the deepest path part —
    // but only where the aggregate is blanked (aggDepth opt-in): visible
    // ticking group aggregates are the point of the project.
    const text =
      meta.kind === 'group' && c === 0 && raw == null ? groupLabel(meta) : formatValue(raw, def);
    let flash: 1 | -1 | 0 = 0;
    const old = this.prevFrame.get(`${meta.id} ${path}`);
    if (old !== undefined && !Object.is(old, raw)) {
      flash = typeof raw === 'number' && typeof old === 'number' ? (raw > old ? 1 : -1) : 1;
    }
    const numeric = def?.type === 'float' || def?.type === 'integer' || typeof raw === 'number';
    const cell: CellRender = { text, styleClass: numeric ? 'num' : '', flash };
    this.frameCells.set(memoKey, cell);
    return cell;
  }

  requestWindow(v: Viewport, cols: { firstCol: number; lastCol: number }): void {
    this.lastReq = {
      firstRow: v.firstRow,
      lastRow: v.lastRow,
      firstCol: cols.firstCol,
      lastCol: cols.lastCol,
    };
    void this.fetch();
  }

  /** Model updated (push) → re-read the last requested window. */
  invalidate(): void {
    if (!this.lastReq) return;
    void this.fetch();
  }

  onFrame(cb: () => void): void {
    this.frameCbs.add(cb);
  }

  /** One read in flight at a time; requests landing mid-read coalesce into one refetch. */
  private async fetch(): Promise<void> {
    if (this.inFlight) {
      this.refetch = true;
      return;
    }
    this.inFlight = true;
    try {
      do {
        this.refetch = false;
        const req = this.lastReq;
        if (!req) break;
        const next = await this.host.window(req.firstRow, req.lastRow, req.firstCol, req.lastCol);
        this.swap(next, req);
        for (const cb of this.frameCbs) cb();
      } while (this.refetch);
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Install the new slice. The previous-frame buffer rotates ONLY when the
   * requested window is unchanged (spec §6 flash gate) — scrolling to new rows
   * or columns must never flash.
   */
  private swap(next: WindowSlice, req: WindowReq): void {
    const prev = this.sliceReq;
    const sameViewport =
      prev != null &&
      prev.firstRow === req.firstRow &&
      prev.lastRow === req.lastRow &&
      prev.firstCol === req.firstCol &&
      prev.lastCol === req.lastCol;
    this.prevFrame.clear();
    if (sameViewport && this.slice) {
      const s = this.slice;
      for (let c = 0; c < s.cols.length; c++) {
        for (let r = 0; r < s.rowCount; r++) {
          this.prevFrame.set(`${s.metas[r].id} ${s.cols[c]}`, s.values[c][r]);
        }
      }
    }
    this.slice = next;
    this.sliceReq = req;
    this.frameCells.clear();
  }
}
