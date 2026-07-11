/**
 * Worker-side render materializer (Task 6). Turns the pipeline's displayed
 * output into render-ready cells: formatted text plus deduped style-table ids
 * for a viewport window, and pre-rendered tick deltas after updates.
 *
 * ADDITIVE: this module only reads the pipeline's public surface
 * (`displayed`, `getRow`). It never mutates pipeline state, so the known WIP
 * issues on the data-plane path are untouched.
 */
import { compileFormat } from '@tabular/format';
import type { CompiledFormat } from '@tabular/format';
import type { CellStyle } from '../types';
import type { DataPipeline } from './pipeline';
import type { RenderPlaneConfig, WorkerDisplayEntry } from './protocol';

/** Max distinct styles the table holds before LRU eviction kicks in. */
const STYLE_TABLE_CAP = 1024;

/** rowKind wire codes (mirror of RenderWindowResult.rowKind). */
const KIND_LEAF = 0;
const KIND_GROUP = 1;
const KIND_FOOTER = 2;

/** One resolved display column with its compiled formatter (cached once). */
interface RenderColumn {
  colId: string;
  field: string;
  type?: 'number';
  format?: CompiledFormat;
  cellStyle?: CellStyle;
}

/** Rendered window returned by {@link RenderPlane.materialize}. */
export interface MaterializedWindow {
  modelRevision: number;
  firstRow: number;
  rowIds: string[];
  rowKind: Uint8Array;
  rowLevel: Uint8Array;
  rowExpanded: Uint8Array;
  /** rows × cols, row-major. */
  text: string[];
  styleIds: Uint16Array;
  styleTableVersion: number;
  /**
   * Full style-table snapshot — present only when the caller's known
   * `styleTableVersion` (passed to `materialize`) is stale or omitted.
   */
  styleTable?: CellStyle[];
}

/** One rendered tick delta produced by {@link RenderPlane.deltasFor}. */
export interface RenderDelta {
  /** Window-relative row index (displayed index − firstRow). */
  rowIndex: number;
  /** Column index into the render config's `cols`. */
  colIndex: number;
  text: string;
  styleId: number;
  dir: 1 | -1 | 0;
}

/** One cell change to render as a delta. */
export interface RenderCellChange {
  rowId: string;
  colId: string;
  dir: 1 | -1 | 0;
}

/**
 * LRU-capped style table. Maps an effective {@link CellStyle} to a 1-based id
 * (0 means "no style"). Deduped by JSON key. At {@link STYLE_TABLE_CAP} the
 * least-recently-used entry is evicted and its id reused; `version` bumps on
 * every content change so the client can refetch a stale table.
 */
class StyleTable {
  /** styleKey → { id, style }; Map insertion order = LRU recency (oldest first). */
  private entries = new Map<string, { id: number; style: CellStyle }>();
  /** id (1-based) → style; index is id-1. */
  private byId: CellStyle[] = [];
  private nextId = 0;
  private warned = false;

  version = 0;

  /** Resolve (or allocate) the id for a style; 0 for empty/undefined styles. */
  idFor(style: CellStyle | undefined): number {
    if (!style || isEmptyStyle(style)) return 0;
    const key = JSON.stringify(style);
    const hit = this.entries.get(key);
    if (hit) {
      // Touch: move to most-recently-used (re-insert at Map tail).
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.id;
    }
    let id: number;
    if (this.entries.size < STYLE_TABLE_CAP) {
      id = ++this.nextId;
    } else {
      // Evict least-recently-used (first Map entry) and reuse its id.
      const oldestKey = this.entries.keys().next().value as string;
      const oldest = this.entries.get(oldestKey)!;
      this.entries.delete(oldestKey);
      id = oldest.id;
      if (!this.warned) {
        this.warned = true;
        console.warn(
          `[render-plane] style table hit ${STYLE_TABLE_CAP} entries; evicting LRU styles`,
        );
      }
    }
    this.byId[id - 1] = style;
    this.entries.set(key, { id, style });
    this.version++;
    return id;
  }

  /** Full snapshot indexed by id-1 (holes for never-allocated ids are `{}`). */
  snapshot(): CellStyle[] {
    return this.byId.map((s) => s ?? {});
  }
}

/** True when a style has no own enumerable keys (renders as no-op). */
function isEmptyStyle(style: CellStyle): boolean {
  for (const _ in style) return false;
  return true;
}

/**
 * Materializes render-ready cells from a {@link DataPipeline}'s displayed
 * output. Constructed once per render config; the worker bumps
 * {@link RenderPlane.bumpRevision} whenever the model it reads changes.
 */
export class RenderPlane {
  private cols: RenderColumn[];
  private colIndexById = new Map<string, number>();
  private styleTable = new StyleTable();
  private revision = 0;
  /**
   * Last-seen `pipeline.displayed` array reference. Every model rebuild
   * produces a fresh array (`finishRebuild`), so an identity change means the
   * displayed model changed — the revision bumps even for rebuilds the worker
   * glue didn't observe explicitly (e.g. add/remove-only transactions).
   */
  private lastDisplayedRef: readonly WorkerDisplayEntry[] | null = null;

  /**
   * @param pipeline worker data pipeline whose displayed output is rendered.
   * @param config   display columns + formats/styles (compiled once here).
   */
  constructor(
    private pipeline: DataPipeline,
    private config: RenderPlaneConfig,
  ) {
    this.cols = config.cols.map((c) => ({
      colId: c.colId,
      field: c.field,
      type: c.type,
      // Compile the format DSL once per column (never throws).
      format: c.format ? compileFormat(c.format) : undefined,
      cellStyle: c.cellStyle,
    }));
    this.cols.forEach((c, i) => this.colIndexById.set(c.colId, i));
  }

  /** Monotonic model revision stamped on every response. */
  get modelRevision(): number {
    return this.revision;
  }

  /** Bump the revision — call on every rebuild/update the plane observes. */
  bumpRevision(): void {
    this.revision++;
  }

  /**
   * Bump the revision when the pipeline's displayed model was rebuilt since
   * the plane last looked (fresh array identity). Keeps `modelRevision`
   * monotonic across structural rebuilds without touching existing worker
   * message flows. Called at the top of `materialize`/`deltasFor`.
   */
  private syncRevision(displayed: readonly WorkerDisplayEntry[]): void {
    if (this.lastDisplayedRef !== displayed) {
      if (this.lastDisplayedRef !== null) this.revision++;
      this.lastDisplayedRef = displayed;
    }
  }

  /** Current style-table version (bumps when the table's contents change). */
  get styleTableVersion(): number {
    return this.styleTable.version;
  }

  /** Full style-table snapshot (id-1 indexed). */
  styleTableSnapshot(): CellStyle[] {
    return this.styleTable.snapshot();
  }

  /**
   * Materialize the flat text/styleId arrays for displayed rows
   * `[firstRow, lastRow]` (inclusive, clamped to the displayed length).
   *
   * @param clientStyleTableVersion style-table version the caller already
   *   holds; the snapshot is included only when stale (omit to always get it).
   */
  materialize(
    firstRow: number,
    lastRow: number,
    clientStyleTableVersion?: number,
  ): MaterializedWindow {
    const displayed = this.pipeline.displayed;
    this.syncRevision(displayed);
    const first = Math.max(0, firstRow);
    const last = Math.min(lastRow, displayed.length - 1);
    const rowCount = Math.max(0, last - first + 1);
    const colCount = this.cols.length;

    const rowIds: string[] = new Array(rowCount);
    const rowKind = new Uint8Array(rowCount);
    const rowLevel = new Uint8Array(rowCount);
    const rowExpanded = new Uint8Array(rowCount);
    const text: string[] = new Array(rowCount * colCount);
    const styleIds = new Uint16Array(rowCount * colCount);

    for (let r = 0; r < rowCount; r++) {
      const entry = displayed[first + r]!;
      rowIds[r] = entry.id;
      rowKind[r] = kindCode(entry.kind);
      rowLevel[r] = entry.level;
      rowExpanded[r] = entry.expanded ? 1 : 0;
      const row = entry.kind === 'leaf' ? this.pipeline.getRow(entry.id) : undefined;
      for (let c = 0; c < colCount; c++) {
        const cell = this.renderCell(entry, row, this.cols[c]!);
        const idx = r * colCount + c;
        text[idx] = cell.text;
        styleIds[idx] = this.styleTable.idFor(cell.style);
      }
    }

    // Decide AFTER filling arrays — materializing may allocate new style ids.
    const styleTableVersion = this.styleTable.version;
    const includeTable = styleTableVersion !== clientStyleTableVersion;
    return {
      modelRevision: this.revision,
      firstRow: first,
      rowIds,
      rowKind,
      rowLevel,
      rowExpanded,
      text,
      styleIds,
      styleTableVersion,
      // Lazy: snapshot only when the caller's known version is stale.
      ...(includeTable ? { styleTable: this.styleTable.snapshot() } : {}),
    };
  }

  /**
   * Produce rendered deltas for `changes` whose row is displayed inside
   * `[firstRow, lastRow]`. `rowIndex` is window-relative so it aligns with the
   * arrays from {@link materialize}. Out-of-window changes are dropped.
   */
  deltasFor(changes: RenderCellChange[], firstRow: number, lastRow: number): RenderDelta[] {
    const displayed = this.pipeline.displayed;
    this.syncRevision(displayed);
    const first = Math.max(0, firstRow);
    const last = Math.min(lastRow, displayed.length - 1);
    if (last < first) return [];

    const indexById = new Map<string, number>();
    for (let i = first; i <= last; i++) indexById.set(displayed[i]!.id, i);

    const out: RenderDelta[] = [];
    for (const change of changes) {
      const displayedIndex = indexById.get(change.rowId);
      if (displayedIndex === undefined) continue;
      const colIndex = this.colIndexById.get(change.colId);
      if (colIndex === undefined) continue;
      const entry = displayed[displayedIndex]!;
      const row = entry.kind === 'leaf' ? this.pipeline.getRow(entry.id) : undefined;
      const cell = this.renderCell(entry, row, this.cols[colIndex]!);
      out.push({
        rowIndex: displayedIndex - first,
        colIndex,
        text: cell.text,
        styleId: this.styleTable.idFor(cell.style),
        dir: change.dir,
      });
    }
    return out;
  }

  /**
   * Derive render tick changes from an update transaction: for each updated
   * row and render column whose field value changed, emit a change whose `dir`
   * is the numeric tick direction (0 for non-numeric columns). The caller
   * supplies pre-apply and post-apply value readers.
   */
  tickChanges(
    updateIds: string[],
    oldValueOf: (id: string, field: string) => unknown,
    newValueOf: (id: string, field: string) => unknown,
  ): RenderCellChange[] {
    const out: RenderCellChange[] = [];
    for (const id of updateIds) {
      for (const col of this.cols) {
        const before = oldValueOf(id, col.field);
        const after = newValueOf(id, col.field);
        if (before === after) continue;
        let dir: 1 | -1 | 0 = 0;
        if (col.type === 'number' && typeof before === 'number' && typeof after === 'number') {
          dir = after > before ? 1 : after < before ? -1 : 0;
        }
        out.push({ rowId: id, colId: col.colId, dir });
      }
    }
    return out;
  }

  /**
   * Render one cell: formatted text + effective style. Group/footer rows
   * label the group-indent column and read agg data for value columns;
   * leaves format the raw field value.
   *
   * Labels: groupPass emits footer keys ALREADY prefixed (`Total ${key}`)
   * and grandTotal key `Grand Total`, so both render `entry.key` verbatim.
   * Only real group rows get the `${key} (${childCount})` suffix.
   *
   * rules styles: wired when worker rules land on this path — today only static
   * column styles participate in the style table.
   */
  private renderCell(
    entry: WorkerDisplayEntry,
    row: Record<string, unknown> | undefined,
    col: RenderColumn,
  ): { text: string; style: CellStyle | undefined } {
    const style = col.cellStyle;

    if (entry.kind !== 'leaf') {
      if (col.colId === this.config.groupIndentColId) {
        const label =
          entry.kind === 'group' ? `${entry.key} (${entry.childCount})` : entry.key;
        return { text: label, style };
      }
      // Value columns on group/footer rows read the aggregate data.
      const value = entry.aggData[col.colId] ?? entry.aggData[col.field];
      return { text: this.format(col, value), style };
    }

    const value = row ? row[col.field] : undefined;
    return { text: this.format(col, value), style };
  }

  /** Format a value with the column's compiled DSL (or `String`). */
  private format(col: RenderColumn, value: unknown): string {
    if (value == null) return '';
    if (col.format) return col.format.format(value);
    return String(value);
  }
}

function kindCode(kind: WorkerDisplayEntry['kind']): number {
  if (kind === 'leaf') return KIND_LEAF;
  if (kind === 'footer') return KIND_FOOTER;
  return KIND_GROUP; // group | grandTotal
}
