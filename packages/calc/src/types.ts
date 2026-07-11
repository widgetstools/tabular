// /calc — public types.
// Authoritative reference: docs/superpowers/specs/2026-07-02-cycle-21d-calc-design.md §3.

import type { Loc, Schema, Ast } from '@tabular/expression';

export type CellDataType = 'number' | 'currency' | 'percent' | 'date' | 'datetime' | 'string' | 'boolean';

export interface CalculatedColumnDef {
  colId: string;                    // must not collide with data fields or other calc cols
  headerName: string;
  expression: string;               // calc DSL: [col], builtins, aggregates, PREV
  /** Format-DSL string (any tier the registered compiler accepts). */
  format?: string;
  cellDataType?: CellDataType;      // default 'number'
  position?: number;                // insertion hint into the column order
  initialWidth?: number;
  initialHide?: boolean;
  initialPinned?: 'left' | 'right';
}

export type AggScope =
  | { kind: 'all' } | { kind: 'visible' } | { kind: 'group' } | { kind: 'parent' };

export interface AggSpec {
  slot: number;                     // pre-pass slot index the per-row program reads
  fn: string;                       // registered aggregate name
  colId: string;                    // source column (field path head)
  scope: AggScope;
}

export interface CompiledCalc {
  ast: Ast;                         // transformed (AggregateNode/PrevNode present)
  prePass: AggSpec[];
  watchedColIds: ReadonlySet<string>;
  usesPrev: boolean;
  cellDataType: CellDataType;
}

export interface CalcValidationError {
  colId: string | null;
  code: 'parse' | 'unknown-fn' | 'arity' | 'not-yet-implemented' | 'bad-shape'
      | 'duplicate-colId' | 'unknown-scope' | 'format-compile';
  message: string;
  loc: Loc | null;
}

export interface Aggregate<S = unknown> {
  init(): S;
  addRow(state: S, value: unknown): S;
  removeRow(state: S, value: unknown): S;
  updateRow(state: S, oldValue: unknown, newValue: unknown): S;
  finalize(state: S): number | null;
}

/** Static icon reference for cellIcon/headerIcon overrides — structural
 *  twin of /format's IconRef (calc holds data, never draws). */
export interface IconOverride {
  name?: string;
  emoji?: string;
  color?: string;
  position?: 'leading' | 'trailing';
}

export interface ColumnOverride {
  colId: string;
  headerName?: string;
  format?: string;                  // format-DSL string → kernel compiler
  cellStyle?: Record<string, unknown>;
  headerStyle?: Record<string, unknown>;  // ColCellOverrides vocabulary, same as cellStyle
  cellRenderer?: string;
  editable?: boolean;
  hide?: boolean;
  width?: number;
  cellIcon?: IconOverride;          // static prefix/suffix icon on data cells
  headerIcon?: IconOverride;        // static prefix/suffix icon on the leaf header
  templateIds?: string[];           // template chain refs; undefined → typeDefault; [] → opt out
  /** Column-config def flags (ribbon quick column configuration). Stored
   *  values only — `filter` never holds null in a template. */
  floatingFilter?: boolean;
  filter?: 'text' | 'number' | 'date' | 'set';
  enableRowGroup?: boolean;
  enablePivot?: boolean;
  sortable?: boolean;
  resizable?: boolean;
  suppressAggFuncInHeader?: boolean;
}

export interface ColumnTemplate {
  id: string;
  name: string;
  description?: string;
  overrides: Omit<ColumnOverride, 'colId' | 'templateIds'>;
  createdAt: number;                // host-stamped; engine never calls Date.now
  updatedAt: number;
}

export interface TypeDefaults { numeric?: string; date?: string; string?: string; boolean?: string; }

export interface WireCalcOptions {
  calculatedColumns?: CalculatedColumnDef[];
  overrides?: ColumnOverride[];
  templates?: ColumnTemplate[];
  typeDefaults?: TypeDefaults;
  schema?: Schema;
}

export type Unsubscribe = () => void;
