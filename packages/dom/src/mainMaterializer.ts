/**
 * Main-thread `RenderView` (Task 5, fallback mode). A synchronous read model
 * over `RowModel` + `ColumnModel`: the DOM pool binds directly from live model
 * state, so `cell()` never returns `undefined` and `onUpdate` never fires.
 *
 * This is the fallback for when the worker data plane is ineligible or
 * disabled (`rowDataMode: 'main'`). It intentionally does UI-thread work
 * (value reads, format compilation, style registration), but that work is
 * cached per column — never per cell — so scrolling stays a class/text swap.
 */

import type {
  CellStyle,
  ColumnModel,
  CompiledFormat,
  FormatConfig,
  InternalColumn,
  RowModel,
  Tabular,
} from '@tabular/core';
import { AUTO_GROUP_COL_ID, resolveFormat } from '@tabular/core';
import { StyleTable } from './styles';
import type { CellRender, RenderView, RowMeta } from './renderView';

/**
 * Reads a possibly dot-pathed `field` off a row, mirroring `grid.ts`'s
 * `valueOf` dot-path branch (`field.split('.').reduce(...)`).
 */
export function readFieldValue<TData>(data: TData, field: string): unknown {
  if (data == null) return undefined;
  if (field.includes('.')) {
    return field.split('.').reduce<unknown>((acc, k) => {
      if (acc == null || typeof acc !== 'object') return undefined;
      return (acc as Record<string, unknown>)[k];
    }, data);
  }
  return (data as Record<string, unknown>)[field];
}

/** Max distinct dynamic (function `cellStyle`) entries before we stop registering new ones. */
const STYLE_CAP = 1024;

/**
 * Synchronous `RenderView` over the client-side row/column models. Column-keyed
 * caches (compiled formats, static cell styles) are populated lazily on first
 * touch and reused for the column's lifetime.
 */
export class MainMaterializer<TData> implements RenderView<TData> {
  private displayedCols: InternalColumn<TData>[];
  private readonly formatByCol = new Map<string, CompiledFormat | null>();
  private readonly staticStyleByCol = new Map<string, string>();
  private readonly styleKeyToId = new Map<string, number>();
  private readonly styleList: CellStyle[] = [];
  private styleVersion = 0;

  /**
   * @param rows Live row model (post filter/sort/group flatten).
   * @param cols Live column model.
   * @param styleTable Shared table the DOM grid owns and disposes; cell styles
   *   register here so each becomes a single generated class.
   * @param formatting Optional format DSL config (presets/overrides).
   * @param api Optional grid api for `valueGetter`/`valueFormatter`/function
   *   `cellStyle`. Absent in pure fallback mode, where those callbacks degrade
   *   to field reads / `String(value)` / static styles.
   */
  constructor(
    private readonly rows: RowModel<TData>,
    private readonly cols: ColumnModel<TData>,
    private readonly styleTable: StyleTable,
    private readonly formatting?: FormatConfig,
    private readonly api?: Tabular<TData>,
  ) {
    this.displayedCols = cols.displayed();
  }

  /** Re-reads the displayed column order; call after any column-set change. */
  refreshColumns(): void {
    this.displayedCols = this.cols.displayed();
  }

  /** @inheritdoc */
  rowCount(): number {
    return this.rows.displayedNodes.length;
  }

  /** @inheritdoc */
  rowMeta(rowIndex: number): RowMeta | undefined {
    const node = this.rows.displayedNodes[rowIndex];
    if (!node) return undefined;
    return {
      id: node.id,
      kind: node.footer ? 'footer' : node.group ? 'group' : 'leaf',
      level: node.level,
      expanded: node.expanded,
    };
  }

  /** @inheritdoc */
  cell(rowIndex: number, colIndex: number): CellRender | undefined {
    const node = this.rows.displayedNodes[rowIndex];
    const col = this.displayedCols[colIndex];
    if (!node || !col) return undefined;

    const isAuto = col.colId === AUTO_GROUP_COL_ID;

    // Footer / group auto-column captions. Footer must be checked first:
    // footer nodes also carry `group: true`, and their `key` arrives already
    // prefixed by the model ("Total G0", "Grand Total" — grouping.ts
    // `footerFor`), so it renders verbatim, mirroring grid.ts's
    // valueAtDisplayed (auto column returns `node.key` as-is).
    if (isAuto && node.footer) {
      return { text: node.key, styleClass: '' };
    }
    if (isAuto && node.group) {
      return { text: `${node.key} (${node.childCount})`, styleClass: '' };
    }

    // Aggregate cells on group / footer rows.
    if (node.group || node.footer) {
      const value = this.aggValue(node.aggData, col);
      return { text: this.formatText(value, col, node.data ?? undefined, rowIndex), styleClass: '' };
    }

    // Leaf cells.
    const value = this.leafValue(node.data, col, rowIndex);
    return {
      text: this.formatText(value, col, node.data ?? undefined, rowIndex),
      styleClass: this.styleClass(value, col, node.data ?? undefined, rowIndex),
    };
  }

  /** No-op: main mode has no fetch step (data is always resident). */
  requestWindow(): void {}

  /** No-op: main mode is synchronous, so updates never arrive out of band. */
  onUpdate(): void {}

  /** Reads a group/footer aggregate, matching `grid.ts` key precedence (colId then field). */
  private aggValue(aggData: Record<string, unknown>, col: InternalColumn<TData>): unknown {
    if (aggData[col.colId] !== undefined) return aggData[col.colId];
    const field = col.def.field;
    if (field && aggData[field] !== undefined) return aggData[field];
    return undefined;
  }

  /** Leaf value: `valueGetter` (when an api is available) else dot-path field read. */
  private leafValue(data: TData | null, col: InternalColumn<TData>, rowIndex: number): unknown {
    if (data == null) return undefined;
    const vg = col.def.valueGetter;
    if (vg && this.api) {
      return vg({ value: undefined, data, rowIndex, colDef: col.def, api: this.api });
    }
    const field = col.def.field;
    if (!field) return undefined;
    return readFieldValue(data, field);
  }

  /** value → display text: `valueFormatter` (with api) → format DSL → `String`. */
  private formatText(
    value: unknown,
    col: InternalColumn<TData>,
    data: TData | undefined,
    rowIndex: number,
  ): string {
    const vf = col.def.valueFormatter;
    if (vf && this.api) {
      return vf({ value, data, rowIndex, colDef: col.def, api: this.api });
    }
    const fmt = this.compiledFormat(col);
    if (fmt) return fmt.format(value);
    return value == null ? '' : String(value);
  }

  /** Resolves and caches the compiled format for a column (once per column). */
  private compiledFormat(col: InternalColumn<TData>): CompiledFormat | null {
    const cached = this.formatByCol.get(col.colId);
    if (cached !== undefined) return cached;
    const code = col.def.format;
    const compiled = code ? resolveFormat(code, this.formatting) : null;
    this.formatByCol.set(col.colId, compiled);
    return compiled;
  }

  /**
   * Style class for a cell. Static (object) `cellStyle` registers once per
   * column; function `cellStyle` (api only) evaluates per cell but dedupes
   * through the shared table, capped.
   */
  private styleClass(
    value: unknown,
    col: InternalColumn<TData>,
    data: TData | undefined,
    rowIndex: number,
  ): string {
    const cs = col.def.cellStyle;
    if (!cs) return '';
    if (typeof cs === 'function') {
      if (!this.api) return '';
      const s = cs({ value, data, rowIndex, colDef: col.def, api: this.api });
      return s ? this.registerStyle(s) : '';
    }
    return this.staticStyle(col, cs);
  }

  /** Registers (once) the static object `cellStyle` for a column. */
  private staticStyle(col: InternalColumn<TData>, cs: CellStyle): string {
    const cached = this.staticStyleByCol.get(col.colId);
    if (cached !== undefined) return cached;
    const cls = this.registerStyle(cs);
    this.staticStyleByCol.set(col.colId, cls);
    return cls;
  }

  /**
   * Interns a `CellStyle` into the shared `StyleTable`, returning its class
   * name (`''` once the cap is hit). Deduped by structural key so identical
   * styles collapse to one generated rule.
   */
  private registerStyle(s: CellStyle): string {
    const key = JSON.stringify(s);
    const existing = this.styleKeyToId.get(key);
    if (existing !== undefined) return this.styleTable.className(existing);
    if (this.styleList.length >= STYLE_CAP) return '';
    this.styleList.push(s);
    const id = this.styleList.length; // 1-based; id 0 is "no style"
    this.styleKeyToId.set(key, id);
    this.styleTable.setTable(++this.styleVersion, this.styleList);
    return this.styleTable.className(id);
  }
}
