/**
 * Grid-facing types. This module MUST NOT import from `@finos/perspective` —
 * all engine types stay behind engine.ts / viewHost.ts (the P4 engine-swap seam).
 */

export type ColType = 'string' | 'float' | 'integer' | 'boolean' | 'datetime' | 'date';

/** ag-grid-style column definition. */
export interface ColDef {
  field: string;
  headerName?: string;
  type?: ColType;
  width?: number;
  /** Intl-style pattern: '#,##0.00' subset (see materializer). */
  format?: string;
  aggFunc?: 'sum' | 'avg' | 'min' | 'max' | 'count' | null;
  rowGroup?: boolean;
  rowGroupIndex?: number;
  pivot?: boolean;
  pivotIndex?: number;
  enableRowGroup?: boolean;
  enablePivot?: boolean;
  enableValue?: boolean;
  pinned?: 'left' | 'right' | null;
}

/** Complete, serializable grid state; compiles to a single Perspective view config. */
export interface GridState {
  columnDefs: ColDef[];
  rowGroupCols: string[];
  pivotCols: string[];
  valueCols: { field: string; aggFunc: string }[];
  sortModel: { colId: string; sort: 'asc' | 'desc' }[];
  filterModel: Record<string, { op: string; value: unknown }>;
  pivotMode: boolean;
}

/** Identity + tree position of one view row. */
export interface RowMeta {
  id: string;
  kind: 'leaf' | 'group';
  level: number;
  path: string[];
  expanded: boolean;
}

/** One cell ready to stamp: text + class + one-frame flash direction. */
export interface CellRender {
  text: string;
  styleClass: string;
  flash: 1 | -1 | 0;
}

/** A materialized viewport slice; values are column-major, window-relative. */
export interface WindowSlice {
  firstRow: number;
  rowCount: number;
  /** window-relative */
  metas: RowMeta[];
  /** visible column paths (meta-filtered) */
  cols: string[];
  /** [colIdx][rowIdx-window-relative] */
  values: unknown[][];
}
