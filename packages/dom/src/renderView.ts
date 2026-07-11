/**
 * The worker/main seam: a read model the row pool binds from. Two
 * implementations are planned — `MainMaterializer` (Task 5, synchronous over
 * `RowModel`) and `WorkerMaterializer` (Task 7, async over the render-window
 * protocol). This module is DOM-free; it only declares the contract.
 */

/** One precomputed cell: everything the UI needs to stamp it. */
export interface CellRender {
  /** Display text, already formatted. */
  text: string;
  /** '' or a `StyleTable` class name; the pool applies it verbatim. */
  styleClass: string;
}

/** Row-level metadata the pool needs to lay out and classify a row. */
export interface RowMeta {
  /** Stable row identity, used for selection lookups. */
  id: string;
  /** Row kind driving CSS classes and group-indent behavior. */
  kind: 'leaf' | 'group' | 'footer';
  /** Group nesting depth, used to compute indent for the first cell. */
  level: number;
  /** Whether a group row is currently expanded. */
  expanded: boolean;
}

/**
 * Read model the pool binds from. `cell()` may return `undefined` while data
 * is in flight — the pool leaves the previous content in place
 * (stale-but-correct) rather than blanking it.
 */
export interface RenderView<_TData> {
  /** Total row count in the current view (post-filter/sort/group). */
  rowCount(): number;
  /** Metadata for a row, or `undefined` while it is not yet available. */
  rowMeta(rowIndex: number): RowMeta | undefined;
  /** Precomputed cell content, or `undefined` while it is not yet available. */
  cell(rowIndex: number, colIndex: number): CellRender | undefined;
  /** Hint: the pool is about to bind this window; async impls fetch it. */
  requestWindow(firstRow: number, lastRow: number): void;
  /** Fires when new data for the current window arrived (rebind needed). */
  onUpdate(cb: () => void): void;
}
