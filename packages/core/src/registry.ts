/**
 * Component registries (Phase 0 seam). Satellite packages register canvas
 * cell renderers, DOM cell editors, delta aggregates, and custom tool panels
 * by name; the engine resolves names once per column per model refresh (or
 * once per grid), never per cell paint.
 *
 * Two scopes: a global registry for app-wide registration (mirrors
 * `registerIcons`) and a per-grid registry that shadows it. A grid with
 * nothing registered pays a single null check on each seam.
 */
import type { CellParams, CellRenderParams } from './types';
import type { AggFunc } from './aggregation';
import type { Tabular } from './grid';

/** Interactive region reported by a renderer's `hitTest` (canvas hit regions). */
export interface HitRegion {
  /** Consumer-defined region id (e.g. an action name). */
  id: string;
  /** Cursor to show while hovering the region. Default `'pointer'`. */
  cursor?: string;
}

/** Canvas cell renderer, function form: paint; return `false` to fall through. */
export type CellRendererFn<TData = unknown> = (
  ctx: CanvasRenderingContext2D,
  params: CellRenderParams<TData>,
) => void | boolean;

/** Canvas cell renderer, object form — adds interaction/measurement hooks. */
export interface CellRendererComp<TData = unknown> {
  /** Paint the cell. Return `false` to fall through to the default text paint. */
  paint: CellRendererFn<TData>;
  /**
   * Cell-local hit test for interactive painters (action clusters, links).
   * Coordinates are relative to the cell's top-left corner.
   */
  hitTest?(localX: number, localY: number, params: CellRenderParams<TData>): HitRegion | null;
  /** Opt-in autosize participation: content width in px for this cell. */
  measure?(ctx: CanvasRenderingContext2D, params: CellRenderParams<TData>): number | undefined;
}

export type CellRendererDef<TData = unknown> = CellRendererFn<TData> | CellRendererComp<TData>;

/** Normalize function-form renderers to the object contract (one-time, cached). */
export function normalizeCellRenderer<TData>(
  def: CellRendererDef<TData>,
): CellRendererComp<TData> {
  return typeof def === 'function' ? { paint: def } : def;
}

/** Params handed to a cell editor factory (AG `ICellEditorParams` subset). */
export interface CellEditorParams<TData = unknown> extends CellParams<TData> {
  /**
   * Key that started the edit — a printable character for type-to-replace,
   * `'Enter'` / `'F2'`, or null for mouse-initiated edits (AG `eventKey`).
   */
  eventKey: string | null;
  /** Editor-specific params from `colDef.cellEditorParams`. */
  cellEditorParams?: unknown;
  /** Commit (or cancel with `true`) and close the editor from inside the component. */
  stopEditing(cancel?: boolean): void;
  /** Parse a string with the column's `valueParser` / number coercion (AG util). */
  parseValue(value: string): unknown;
  /** Format a value with the column's `valueFormatter` (AG util). */
  formatValue(value: unknown): string;
  /** Resolved theme for token-driven editor styling. */
  theme: import('./theme').ResolvedTheme;
}

/** DOM cell editor component (AG `ICellEditor` subset). */
export interface CellEditorComp {
  /** The editor element, mounted pixel-registered over the cell rect. */
  getGui(): HTMLElement;
  /** Final value to commit (already typed — bypasses the default string parse). */
  getValue(): unknown;
  /** Called after the gui is attached; focus the input here. */
  afterGuiAttached?(): void;
  /** Return true to abort the edit before it starts. */
  isCancelBeforeStart?(): boolean;
  /** Return true to discard the edit after it ends (validation veto). */
  isCancelAfterEnd?(): boolean;
  /** Popup editors size themselves and anchor below/over the cell. */
  isPopup?(): boolean;
  /** Popup anchor: cover the cell (`'over'`, default) or sit below (`'under'`). */
  getPopupPosition?(): 'over' | 'under' | undefined;
  destroy?(): void;
}

export type CellEditorFactory<TData = unknown> = (
  params: CellEditorParams<TData>,
) => CellEditorComp;

/**
 * Incremental (delta) aggregate: per-group accumulator with add/remove hooks
 * so both the main-thread pipeline and the aggregation worker can maintain
 * it without rescanning members. When `remove` is absent, removals force a
 * rescan of the affected group (min/max-style aggregates).
 */
export interface DeltaAggregate<Acc = unknown> {
  init(): Acc;
  add(acc: Acc, value: unknown, weight?: unknown): void;
  remove?(acc: Acc, value: unknown, weight?: unknown): void;
  finalize(acc: Acc): unknown;
}

/** Adapt a delta aggregate to the values-array `AggFunc` shape (main-thread grouping). */
export function aggFuncFromDelta(agg: DeltaAggregate): AggFunc {
  return (values, weights) => {
    const acc = agg.init();
    for (let i = 0; i < values.length; i++) agg.add(acc, values[i], weights?.[i]);
    return agg.finalize(acc);
  };
}

/** Params handed to a custom tool panel factory. */
export interface ToolPanelParams<TData = unknown> {
  api: Tabular<TData>;
  /** Panel body element — the factory owns its contents. */
  container: HTMLElement;
  /** Params from the panel's `toolPanelParams`. */
  toolPanelParams?: unknown;
}

export interface ToolPanelComp {
  /** Called on `api.refreshToolPanel()` and model refreshes. */
  refresh?(): void;
  destroy?(): void;
}

export type ToolPanelFactory<TData = unknown> = (
  params: ToolPanelParams<TData>,
) => ToolPanelComp | void;

/* eslint-disable @typescript-eslint/no-explicit-any -- registries erase TData; grids re-apply it at resolution */
export class ComponentRegistry {
  private renderers = new Map<string, CellRendererDef<any>>();
  private editors = new Map<string, CellEditorFactory<any>>();
  private aggregates = new Map<string, DeltaAggregate>();
  private toolPanels = new Map<string, ToolPanelFactory<any>>();

  constructor(private readonly parent?: ComponentRegistry) {}

  setCellRenderer(name: string, def: CellRendererDef<any>): void {
    this.renderers.set(name, def);
  }
  getCellRenderer(name: string): CellRendererDef<any> | undefined {
    return this.renderers.get(name) ?? this.parent?.getCellRenderer(name);
  }

  setCellEditor(name: string, factory: CellEditorFactory<any>): void {
    this.editors.set(name, factory);
  }
  getCellEditor(name: string): CellEditorFactory<any> | undefined {
    return this.editors.get(name) ?? this.parent?.getCellEditor(name);
  }

  setAggregate(name: string, agg: DeltaAggregate): void {
    this.aggregates.set(name, agg);
  }
  getAggregate(name: string): DeltaAggregate | undefined {
    return this.aggregates.get(name) ?? this.parent?.getAggregate(name);
  }
  /** Own + inherited aggregate names (for merging into the agg-func map). */
  aggregateNames(): string[] {
    const names = new Set<string>(this.parent?.aggregateNames() ?? []);
    for (const n of this.aggregates.keys()) names.add(n);
    return [...names];
  }

  setToolPanel(name: string, factory: ToolPanelFactory<any>): void {
    this.toolPanels.set(name, factory);
  }
  getToolPanel(name: string): ToolPanelFactory<any> | undefined {
    return this.toolPanels.get(name) ?? this.parent?.getToolPanel(name);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** App-wide registry; per-grid registries shadow it. */
export const globalRegistry = new ComponentRegistry();

export function registerCellRenderer<TData = unknown>(
  name: string,
  def: CellRendererDef<TData>,
): void {
  globalRegistry.setCellRenderer(name, def);
}

export function registerCellEditor<TData = unknown>(
  name: string,
  factory: CellEditorFactory<TData>,
): void {
  globalRegistry.setCellEditor(name, factory);
}

export function registerAggregate(name: string, agg: DeltaAggregate): void {
  globalRegistry.setAggregate(name, agg);
}

export function registerToolPanel<TData = unknown>(
  name: string,
  factory: ToolPanelFactory<TData>,
): void {
  globalRegistry.setToolPanel(name, factory);
}
