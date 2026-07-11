/**
 * Aggregation worker protocol (modeled on cgrid's kernel/worker/protocol.ts,
 * scoped to realtime aggregation). The worker mirrors the row store and owns
 * incremental per-group aggregation; the main thread patches the pushed
 * results into live group rows without rebuilding the row model.
 *
 * Functions cannot cross the boundary, so only field-based agg columns with
 * built-in agg functions participate. Columns with function `aggFunc`s or
 * `valueGetter`s keep the main-thread path.
 */

export type ReqId = number;

/** Built-in agg functions the worker can run incrementally. */
export type WorkerAggFuncName =
  | 'sum'
  | 'min'
  | 'max'
  | 'avg'
  | 'count'
  | 'first'
  | 'last'
  | 'weightedAverage';

export interface AggWorkerGroupCol {
  colId: string;
  field: string;
}

export interface AggWorkerAggCol {
  colId: string;
  field: string;
  aggFunc: WorkerAggFuncName;
  /** Weight field for weightedAverage (e.g. notional). */
  weightField?: string;
}

export interface AggModel {
  groupCols: AggWorkerGroupCol[];
  aggCols: AggWorkerAggCol[];
  /** Also maintain the grand-total record (id `grand-total`). */
  grandTotal: boolean;
}

export interface AggTransactionPayload {
  addIds?: string[];
  add?: unknown[];
  updateIds?: string[];
  update?: unknown[];
  removeIds?: string[];
}

/** @deprecated Standalone agg worker retired — use data-plane pushes. */
export type AggWorkerRequest =
  | { id: ReqId; type: 'setAggModel'; payload: AggModel }
  | { id: ReqId; type: 'setRowData'; payload: { ids: string[]; rows: unknown[] } }
  | { id: ReqId; type: 'applyTransaction'; payload: AggTransactionPayload };

/** One changed group: `groupId` matches the main-thread `GroupNode.id`
 *  (`g:{colId}:{path}`), or `grand-total`. `agg` is keyed by colId AND
 *  field (the same aliasing `aggregateTree` writes). */
export interface GroupAggUpdate {
  groupId: string;
  agg: Record<string, unknown>;
}

export type AggWorkerResponse =
  | { id: ReqId; type: 'ok'; rowCount: number }
  | { id: ReqId; type: 'error'; error: string };

export type AggWorkerPush = {
  type: 'aggregatesUpdated';
  updates: GroupAggUpdate[];
};

// ── Data plane (W1–W6) ───────────────────────────────────────────────

export interface WorkerFilterCol {
  colId: string;
  field: string;
}

export interface WorkerSortCol {
  colId: string;
  field: string;
  type?: 'number' | 'text' | 'date';
}

export interface WorkerGroupCol {
  colId: string;
  field: string;
}

export interface WorkerAggColSpec {
  colId: string;
  field: string;
  aggFunc: WorkerAggFuncName;
  weightField?: string;
}

/** Virtual row field key for a materialized `calc` column on the worker. */
export function workerCalcField(colId: string): string {
  return `__calc:${colId}`;
}

export interface WorkerCalcCol {
  colId: string;
  source: string;
  /** Overlay field written by CalcPass (defaults to workerCalcField(colId)). */
  field: string;
  /** Serialized aggregate pre-pass specs from compileCalc. */
  prePass?: import('@tabular/calc').AggSpec[];
  usesPrev?: boolean;
}

/** Pipeline configuration shipped on every model rebuild. */
export interface WorkerPipelineConfig {
  filterCols: WorkerFilterCol[];
  sortCols: WorkerSortCol[];
  /** Calc columns materialized before filter/sort/group (field-only deps). */
  calcCols: WorkerCalcCol[];
  filterModel: import('../types').FilterModel;
  quickFilterTerms: string[];
  sortModel: import('../types').SortModelItem[];
  groupCols: WorkerGroupCol[];
  aggCols: WorkerAggColSpec[];
  groupDefaultExpanded: number;
  /** Explicit expand/collapse overrides (group id → expanded). */
  expandedState: Array<[string, boolean]>;
  groupTotalRow?: 'top' | 'bottom';
  groupSuppressBlankHeader?: boolean;
  grandTotalRow?: 'top' | 'bottom';
  suppressLeafRows?: boolean;
  /** Pivot mode — pivot aggregation runs after group pass when pivot cols + value cols present. */
  pivotMode?: boolean;
  pivotCols?: Array<{ colId: string; field: string }>;
  valueCols?: WorkerAggColSpec[];
}

export interface WorkerDisplayEntry {
  id: string;
  kind: 'leaf' | 'group' | 'footer' | 'grandTotal';
  level: number;
  expanded: boolean;
  key: string;
  field: string;
  childCount: number;
  groupId: string | null;
  aggData: Record<string, unknown>;
}

export interface WorkerModelOutput {
  filteredCount: number;
  filteredSortedIds: string[];
  displayed: WorkerDisplayEntry[];
  /** Present when pivot aggregation ran; main builds pivot result columns. */
  pivotKeyPaths?: string[][];
}

export type DataWorkerPush =
  | {
      type: 'modelUpdated';
      output: WorkerModelOutput;
      /** Worker-evaluated rules delta (Phase 4); materialize on main. */
      rules?: import('@tabular/rules').RulesEvalResult;
    }
  | { type: 'aggregatesUpdated'; updates: GroupAggUpdate[] }
  // Render plane (Task 6) — pushed after update transactions; additive.
  | RenderDeltas;

// ── Viewport (W5) ────────────────────────────────────────────────────

export interface ViewportRequest {
  rowStart: number;
  rowEnd: number;
  columns: string[];
}

export interface ViewportChunk {
  rowStart: number;
  rowCount: number;
  rowIds: string[];
  rowKinds: Uint8Array;
  levels: Uint8Array;
  heights: Float32Array;
  numericCols: Record<string, Float64Array>;
  textCols: Record<string, { offsets: Uint32Array; bytes: Uint8Array }>;
  groupValue?: string[];
  groupChildCount?: Uint32Array;
  isExpanded?: Uint8Array;
  groupKey?: string[];
}

// ── Render plane (Task 6) ───────────────────────────────────────────
//
// ADDITIVE render-plane protocol: the worker materializes render-ready cells
// (formatted text + deduped style-table ids) for a viewport window and pushes
// pre-rendered tick deltas after update transactions. All messages carry
// `modelRevision` (monotonic, bumped on every model rebuild/update the render
// plane observes) so the client can drop stale responses.

/**
 * main → worker: describe how to render cells (set once per config change).
 * Shipped whenever the display columns or their formats/styles change.
 */
export interface RenderPlaneConfig {
  /** Display-order columns the renderer shows. */
  cols: Array<{
    colId: string;
    field: string;
    type?: 'number';
    /** Format DSL string (ColDef.format); compiled worker-side. */
    format?: string;
    /** Static style — participates in the style table. */
    cellStyle?: import('../types').CellStyle;
  }>;
  /** Auto-group column id: group/footer label text lands in this column. */
  groupIndentColId?: string;
}

/** main → worker: request the render-ready cells for a viewport window. */
export interface RenderWindowRequest {
  type: 'renderWindow';
  firstRow: number;
  lastRow: number;
}

/**
 * worker → main: render-ready cells for `[firstRow, lastRow]`. `text` and
 * `styleIds` are row-major (rows × cols). `styleIds.buffer` is transferred.
 * A style id of 0 means "no style"; ids are 1-based indices into the style
 * table. `styleTable` is present only when the client's known
 * `styleTableVersion` is stale.
 */
export interface RenderWindowResult {
  type: 'renderWindowResult';
  modelRevision: number;
  firstRow: number;
  rowIds: string[];
  rowKind: Uint8Array; // 0 leaf, 1 group, 2 footer
  rowLevel: Uint8Array;
  rowExpanded: Uint8Array;
  /** rows × cols, row-major. */
  text: string[];
  styleIds: Uint16Array; // transferable
  styleTableVersion: number;
  /** Present only when the client's known version is stale. */
  styleTable?: import('../types').CellStyle[];
}

/**
 * worker → main, pushed after update transactions. Each delta is a rendered
 * cell inside the last-requested window; `dir` is the tick direction
 * (1 up, -1 down, 0 flat) for flash animation.
 */
export interface RenderDeltas {
  type: 'renderDeltas';
  modelRevision: number;
  deltas: Array<{ rowIndex: number; colIndex: number; text: string; styleId: number; dir: 1 | -1 | 0 }>;
  styleTableVersion: number;
  styleTable?: import('../types').CellStyle[];
}

// ── Worker services (W6) ────────────────────────────────────────────

export interface WorkerClipboardRange {
  rowStart: number;
  rowEnd: number;
  colIds: string[];
}

export interface WorkerAutosizeColumn {
  colId: string;
  headerName: string;
  font: string;
  padding: number;
  headerPadding?: number;
  minWidth: number;
  maxWidth: number;
}

export interface WorkerCsvColumn {
  colId: string;
  field?: string;
  headerName?: string;
}

export interface WorkerCsvExportPayload {
  columns: WorkerCsvColumn[];
  columnKeys?: string[];
  columnSeparator?: string;
  skipColumnHeaders?: boolean;
  suppressQuotes?: boolean;
  withBOM?: boolean;
  onlySelected?: boolean;
  selectedIds?: string[];
  skipRowGroups?: boolean;
}

export type DataWorkerRequest =
  | { id: ReqId; type: 'setPipelineConfig'; payload: WorkerPipelineConfig }
  | { id: ReqId; type: 'setRowData'; payload: { ids: string[]; rows: unknown[] } }
  | { id: ReqId; type: 'applyTransaction'; payload: AggTransactionPayload }
  | { id: ReqId; type: 'rebuildModel'; payload: Record<string, never> }
  | {
      id: ReqId;
      type: 'setRulesConfig';
      payload: import('./passes/rulesPass').WorkerRulesConfigPayload | null;
    }
  | { id: ReqId; type: 'getViewport'; payload: ViewportRequest }
  | { id: ReqId; type: 'clipboardSerialize'; payload: { ranges: WorkerClipboardRange[]; delimiter?: string } }
  | { id: ReqId; type: 'clipboardDeserialize'; payload: { text: string; delimiter?: string } }
  | { id: ReqId; type: 'exportCsv'; payload: WorkerCsvExportPayload }
  | { id: ReqId; type: 'exportXlsx'; payload: WorkerXlsxExportPayload }
  | { id: ReqId; type: 'autosize'; payload: { columns: WorkerAutosizeColumn[]; skipHeader?: boolean; maxSampleSize?: number } }
  // Render plane (Task 6) — additive.
  | { id: ReqId; type: 'setRenderConfig'; payload: RenderPlaneConfig }
  | { id: ReqId; type: 'renderWindow'; payload: { firstRow: number; lastRow: number } };

export interface WorkerXlsxExportPayload extends WorkerCsvExportPayload {
  sheetName?: string;
}

export type DataWorkerResponse =
  | { id: ReqId; type: 'ok' }
  | { id: ReqId; type: 'error'; error: string }
  | { id: ReqId; type: 'viewport'; chunk: ViewportChunk }
  | { id: ReqId; type: 'clipboardSerializeResult'; tsv: string }
  | { id: ReqId; type: 'clipboardDeserializeResult'; rows: string[][] }
  | { id: ReqId; type: 'exportCsvResult'; bytes: Uint8Array }
  | { id: ReqId; type: 'exportXlsxResult'; bytes: Uint8Array }
  | { id: ReqId; type: 'autosizeResult'; widths: Record<string, number> }
  // Render plane (Task 6) — additive; carries the RenderWindowResult payload.
  | ({ id: ReqId } & RenderWindowResult);

/** Agg func names the worker can run (built-ins only — functions can't
 *  cross the boundary). */
export const WORKER_AGG_FUNCS: ReadonlySet<string> = new Set([
  'sum',
  'min',
  'max',
  'avg',
  'count',
  'first',
  'last',
  'weightedAverage',
]);

/** Mirror of the main-thread `groupKey` (grouping.ts). */
export function workerGroupKey(value: unknown): string {
  if (value == null) return '(Blank)';
  return String(value);
}
