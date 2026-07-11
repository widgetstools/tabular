/**
 * Worker data pipeline (W2–W4): calc overlay → filter → sort → group/aggregate/flatten.
 */
import { compileCalcColumn } from '@tabular/calc';
import { tokenizeQuickFilter } from '../filters';
import type { AggSpec } from '@tabular/calc';
import type {
  AggModel,
  AggTransactionPayload,
  GroupAggUpdate,
  WorkerModelOutput,
  WorkerPipelineConfig,
  WorkerSortCol,
} from './protocol';
import type { ViewportChunk, ViewportRequest } from './protocol';
import { RowStore } from './rowStore';
import { CalcPass } from './passes/calcPass';
import { FilterPass } from './passes/filterPass';
import { SortPass } from './passes/sortPass';
import { GroupPass } from './passes/groupPass';
import { PivotPass } from './passes/pivotPass';
import { AggScopeResolver, buildGroupRowIndex } from './passes/aggScopePass';
import { sliceViewport, type ViewportColSpec } from './viewportSlicer';
import { AggEngine } from './incrementalAgg';

export type ApplyAndResolveResult =
  | { kind: 'aggregates'; updates: GroupAggUpdate[] }
  | { kind: 'dataOnly' }
  | { kind: 'model'; output: WorkerModelOutput };

export class DataPipeline {
  private store = new RowStore();
  private calcPass = new CalcPass();
  private aggEngine = new AggEngine();
  private pivotPass = new PivotPass();
  private aggSpecs: AggSpec[] = [];
  private config: WorkerPipelineConfig | null = null;
  private lastOutput: WorkerModelOutput | null = null;
  /** Fields that invalidate filter/sort/calc when changed on an update. */
  private pipelineFields = new Set<string>();
  /** Fields allowed to change on the incremental agg fast path. */
  private aggInputFields = new Set<string>();

  get displayed(): WorkerModelOutput['displayed'] {
    return this.lastOutput?.displayed ?? [];
  }

  getRow(id: string): Record<string, unknown> | undefined {
    const row = this.store.getRow(id);
    if (!row) return undefined;
    if (!this.calcPass.hasColumns()) return row;
    return this.calcPass.mergedRow(id, row);
  }

  getPrevValue(rowId: string, field: string): unknown {
    return this.store.prev.get(rowId, field);
  }

  setConfig(config: WorkerPipelineConfig): void {
    this.config = config;
    this.aggSpecs = [];
    const slotSeen = new Set<number>();
    for (const c of config.calcCols ?? []) {
      for (const spec of c.prePass ?? []) {
        if (slotSeen.has(spec.slot)) continue;
        slotSeen.add(spec.slot);
        this.aggSpecs.push(spec);
      }
    }
    this.calcPass.setColumns(config.calcCols ?? []);
    this.calcPass.setPrevStore(this.store.prev);
    this.rebuildFieldSets(config);
  }

  setRowData(ids: string[], rows: Record<string, unknown>[]): void {
    this.store.setAll(ids, rows);
  }

  applyTransaction(tx: {
    addIds?: string[];
    add?: unknown[];
    updateIds?: string[];
    update?: unknown[];
    removeIds?: string[];
  }): boolean {
    return this.store.applyTransaction(tx);
  }

  /**
   * After applyTransaction on the store:
   * - If only agg-input fields changed AND group keys unchanged AND grouping
   *   active AND no filter/sort/calc invalidation → incremental AggEngine path,
   *   return { kind: 'aggregates', updates }
   * - Else if update-only with no pipeline-field changes → store update only
   *   ({ kind: 'dataOnly' }) — main refreshes the viewport chunk
   * - Else full rebuild → { kind: 'model', output }
   */
  applyAndResolve(tx: AggTransactionPayload): ApplyAndResolveResult {
    const incremental = this.canUseIncrementalAgg(tx);
    const dataOnly = !incremental && this.canSkipModelRebuild(tx);
    this.store.applyTransaction(tx);
    if (incremental) {
      const updates = this.aggEngine.applyTransaction(tx);
      this.patchDisplayedAggData(updates);
      return { kind: 'aggregates', updates };
    }
    if (dataOnly) return { kind: 'dataOnly' };
    return { kind: 'model', output: this.rebuild() };
  }

  getColumnFields(): Map<string, ViewportColSpec> {
    const map = new Map<string, ViewportColSpec>();
    const cfg = this.config;
    if (cfg) {
      for (const c of cfg.sortCols) {
        map.set(c.colId, { colId: c.colId, field: c.field, type: c.type });
      }
    }
    return map;
  }

  getViewport(req: ViewportRequest): ViewportChunk {
    const displayed = this.lastOutput?.displayed ?? [];
    return sliceViewport((id) => this.getRow(id), displayed, this.getColumnFields(), req);
  }

  rebuild(): WorkerModelOutput {
    const cfg = this.config;
    if (!cfg) {
      const ids = this.store.ids();
      return this.finishRebuild({
        filteredCount: ids.length,
        filteredSortedIds: ids,
        displayed: ids.map((id) => ({
          id,
          kind: 'leaf' as const,
          level: 0,
          expanded: false,
          key: '',
          field: '',
          childCount: 0,
          groupId: null,
          aggData: {},
        })),
      });
    }

    const allIds = this.store.ids();
    const groupingActive = cfg.groupCols.length > 0;
    const readRaw = (id: string): Record<string, unknown> => this.store.getRow(id) ?? {};

    const readMerged = (): ((id: string) => Record<string, unknown>) => {
      return (id) => this.calcPass.mergedRow(id, readRaw(id));
    };

    // Filter pass — visible scope = full store.
    this.calcPass.setAggResolver(
      AggScopeResolver.forPhase(this.aggSpecs, allIds, allIds, readRaw, null, groupingActive),
    );
    const readForFilter = readMerged();
    const filterPass = new FilterPass(cfg.filterCols, cfg.quickFilterTerms);
    let ids = filterPass.apply(this.store, cfg.filterModel, readForFilter);

    // Sort pass — visible scope = filtered ids.
    this.calcPass.setAggResolver(
      AggScopeResolver.forPhase(this.aggSpecs, allIds, ids, readForFilter, null, groupingActive),
    );
    const readForSort = readMerged();
    const sortColMap = new Map<string, WorkerSortCol>();
    for (const c of cfg.sortCols) sortColMap.set(c.colId, c);
    const sortPass = new SortPass(sortColMap);
    ids = sortPass.apply(this.store, ids, cfg.sortModel, readForSort);

    this.syncAggEngine(ids, readForSort);

    // Group pass — group/parent scopes resolved from group index.
    const groupIndex = buildGroupRowIndex(ids, cfg.groupCols, readForSort);
    this.calcPass.setAggResolver(
      AggScopeResolver.forPhase(this.aggSpecs, allIds, ids, readForSort, groupIndex, groupingActive),
    );
    const readForGroup = readMerged();

    const groupPass = new GroupPass();
    const pivotActive =
      cfg.pivotMode === true &&
      (cfg.pivotCols?.length ?? 0) > 0 &&
      (cfg.valueCols?.length ?? 0) > 0;

    const groupOpts = {
      groupCols: cfg.groupCols,
      aggCols: pivotActive ? [] : cfg.aggCols,
      groupDefaultExpanded: cfg.groupDefaultExpanded,
      expandedState: cfg.expandedState,
      groupTotalRow: cfg.groupTotalRow,
      groupSuppressBlankHeader: cfg.groupSuppressBlankHeader,
      grandTotalRow: cfg.grandTotalRow,
      suppressLeafRows: cfg.suppressLeafRows,
    };

    let pivotKeyPaths: string[][] | undefined;
    let displayed: WorkerModelOutput['displayed'];

    if (pivotActive) {
      const roots = groupPass.buildTreeOnly(
        this.store,
        ids,
        {
          groupCols: cfg.groupCols,
          groupDefaultExpanded: cfg.groupDefaultExpanded,
          expandedState: cfg.expandedState,
        },
        readForGroup,
      );
      pivotKeyPaths = this.pivotPass.collectKeyPaths(ids, cfg.pivotCols!, readForGroup);
      if (pivotKeyPaths.length) {
        this.pivotPass.apply(roots, cfg.pivotCols!, cfg.valueCols!, pivotKeyPaths, readForGroup);
      }
      displayed = groupPass.flattenRoots(roots, groupOpts);
      if (cfg.grandTotalRow && roots.length) {
        const grandAgg = pivotKeyPaths.length
          ? this.pivotPass.grandTotalAggData(
              roots,
              cfg.pivotCols!,
              cfg.valueCols!,
              pivotKeyPaths,
              readForGroup,
            )
          : {};
        const leafCount = roots.reduce((n, r) => n + r.childCount, 0);
        const grand = {
          id: 'grand-total',
          kind: 'grandTotal' as const,
          level: 0,
          expanded: false,
          key: 'Grand Total',
          field: '',
          childCount: leafCount,
          groupId: null,
          aggData: grandAgg,
        };
        if (cfg.grandTotalRow === 'top') displayed.unshift(grand);
        else displayed.push(grand);
      }
    } else {
      displayed = groupPass.apply(this.store, ids, groupOpts, readForGroup);
    }

    return this.finishRebuild({
      filteredCount: ids.length,
      filteredSortedIds: ids,
      displayed,
      pivotKeyPaths,
    });
  }

  private rebuildFieldSets(config: WorkerPipelineConfig): void {
    const pipelineFields = new Set<string>();
    const aggInputFields = new Set<string>();

    // Structural keys only — not every displayed column. Including all
    // sortCols/filterCols here forced a full model rebuild on every tick
    // (price/pnl live in those maps) and blanked the viewport.
    for (const c of config.groupCols) pipelineFields.add(c.field);
    for (const c of config.pivotCols ?? []) pipelineFields.add(c.field);

    const filterByColId = new Map(config.filterCols.map((c) => [c.colId, c.field]));
    for (const colId of Object.keys(config.filterModel ?? {})) {
      const field = filterByColId.get(colId);
      if (field) pipelineFields.add(field);
    }
    if (config.quickFilterTerms.length > 0) {
      for (const c of config.filterCols) pipelineFields.add(c.field);
    }

    const sortByColId = new Map(config.sortCols.map((c) => [c.colId, c.field]));
    for (const s of config.sortModel ?? []) {
      const field = sortByColId.get(s.colId);
      if (field) pipelineFields.add(field);
    }

    for (const a of config.aggCols) {
      aggInputFields.add(a.field);
      if (a.weightField) aggInputFields.add(a.weightField);
    }
    for (const v of config.valueCols ?? []) {
      aggInputFields.add(v.field);
      if (v.weightField) aggInputFields.add(v.weightField);
    }

    const filterFields = new Set(
      Object.keys(config.filterModel ?? {})
        .map((id) => filterByColId.get(id))
        .filter((f): f is string => !!f),
    );
    if (config.quickFilterTerms.length > 0) {
      for (const c of config.filterCols) filterFields.add(c.field);
    }
    const sortFields = new Set(
      (config.sortModel ?? [])
        .map((s) => sortByColId.get(s.colId))
        .filter((f): f is string => !!f),
    );
    for (const calc of config.calcCols ?? []) {
      const handle = compileCalcColumn(calc.colId, calc.source);
      const affectsPipeline =
        filterFields.has(calc.field) ||
        sortFields.has(calc.field) ||
        (handle.usesPrev ?? false);
      if (!affectsPipeline) continue;
      for (const dep of handle.watchedColIds) pipelineFields.add(dep);
    }

    this.pipelineFields = pipelineFields;
    this.aggInputFields = aggInputFields;
  }

  private canUseIncrementalAgg(tx: AggTransactionPayload): boolean {
    const cfg = this.config;
    if (!cfg?.groupCols.length || !cfg.aggCols.length) return false;
    // v1: pivot ticks always full-rebuild on worker (TODO: incremental pivot accumulators).
    if (
      cfg.pivotMode === true &&
      (cfg.pivotCols?.length ?? 0) > 0 &&
      (cfg.valueCols?.length ?? 0) > 0
    ) {
      return false;
    }
    if (tx.addIds?.length || tx.add?.length || tx.removeIds?.length) return false;
    if (!tx.update?.length || !tx.updateIds?.length) return false;

    for (let i = 0; i < tx.update.length; i++) {
      const id = tx.updateIds[i]!;
      const oldRow = this.store.getRow(id);
      if (!oldRow) return false;
      const newRow = tx.update[i] as Record<string, unknown>;
      for (const key of this.changedKeys(oldRow, newRow)) {
        if (this.pipelineFields.has(key)) return false;
        if (!this.aggInputFields.has(key)) return false;
      }
    }
    return true;
  }

  /** Update-only, no filter/sort/group key changes — store write without rebuild. */
  private canSkipModelRebuild(tx: AggTransactionPayload): boolean {
    if (tx.addIds?.length || tx.add?.length || tx.removeIds?.length) return false;
    if (!tx.update?.length || !tx.updateIds?.length) return false;
    for (let i = 0; i < tx.update.length; i++) {
      const id = tx.updateIds[i]!;
      const oldRow = this.store.getRow(id);
      if (!oldRow) return false;
      const newRow = tx.update[i] as Record<string, unknown>;
      for (const key of this.changedKeys(oldRow, newRow)) {
        if (this.pipelineFields.has(key)) return false;
      }
    }
    return true;
  }

  private changedKeys(
    oldRow: Record<string, unknown>,
    newRow: Record<string, unknown>,
  ): Set<string> {
    const keys = new Set<string>();
    for (const key of new Set([...Object.keys(oldRow), ...Object.keys(newRow)])) {
      if (oldRow[key] !== newRow[key]) keys.add(key);
    }
    return keys;
  }

  private syncAggEngine(
    filteredIds: string[],
    readRow: (id: string) => Record<string, unknown>,
  ): void {
    const cfg = this.config;
    if (!cfg?.groupCols.length || !cfg.aggCols.length) return;

    const model: AggModel = {
      groupCols: cfg.groupCols.map((c) => ({ colId: c.colId, field: c.field })),
      aggCols: cfg.aggCols,
      grandTotal: cfg.grandTotalRow != null,
    };
    const rows = filteredIds.map((id) => readRow(id));
    this.aggEngine.setAggModel(model);
    this.aggEngine.setRowData(filteredIds, rows);
  }

  private patchDisplayedAggData(updates: GroupAggUpdate[]): void {
    if (!this.lastOutput?.displayed.length || !updates.length) return;
    const byId = new Map(this.lastOutput.displayed.map((d) => [d.id, d]));
    for (const u of updates) {
      const entry = byId.get(u.groupId);
      if (entry && entry.kind !== 'leaf') Object.assign(entry.aggData, u.agg);
      const footer = byId.get(`${u.groupId}:footer`);
      if (footer) Object.assign(footer.aggData, u.agg);
    }
  }

  private finishRebuild(output: WorkerModelOutput): WorkerModelOutput {
    this.lastOutput = output;
    return output;
  }
}

export function quickFilterTerms(text: string): string[] {
  return tokenizeQuickFilter(text);
}
