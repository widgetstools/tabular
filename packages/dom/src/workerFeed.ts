/**
 * Worker-feed config builders (Task 7). Translate the DOM grid's live column /
 * row models into the two worker-plane payloads:
 *
 *  - {@link buildWorkerConfig} → the data-plane {@link WorkerPipelineConfig}
 *    (filter/sort/group/agg) — a faithful subset of `grid.ts`'s
 *    `workerDataPlaneConfig()` (no pivot / tree / calc / external filter).
 *  - {@link buildRenderConfig} → the render-plane {@link RenderPlaneConfig}
 *    (display columns + static formats/styles) the worker materializes from.
 *
 * Either returns `null` when the current options are ineligible for the worker
 * path; the grid then stays on the main-thread materializer.
 */

import type {
  CellStyle,
  ColumnModel,
  GridOptions,
  InternalColumn,
  RenderPlaneConfig,
  RowModel,
  WorkerPipelineConfig,
} from '@tabular/core';
import { AUTO_GROUP_COL_ID, WORKER_AGG_FUNCS, tokenizeQuickFilter } from '@tabular/core';

/**
 * The worker-eligible data field for a column: its plain `field`, or `null`
 * when the column derives its value on the main thread (`valueGetter` / `calc`)
 * or has no field. Mirrors `grid.ts`'s `workerColumnField`.
 */
function workerField<TData>(col: InternalColumn<TData>): string | null {
  if (col.def.valueGetter || col.def.calc) return null;
  return col.def.field ?? null;
}

/**
 * Build the data-plane pipeline config, or `null` when ineligible. Bails on
 * tree data, external filters, active filter/sort on non-field or
 * custom-comparator columns, group columns without a plain field, and any
 * aggregation that can't cross the worker boundary (function `aggFunc`,
 * `valueGetter` agg column, or a non-built-in agg func).
 *
 * @param cols    live column model.
 * @param rows    live row model (filter model + quick filter + expand state).
 * @param options grid options (group defaults / total-row placement).
 */
export function buildWorkerConfig<TData>(
  cols: ColumnModel<TData>,
  rows: RowModel<TData>,
  options: GridOptions<TData>,
): WorkerPipelineConfig | null {
  if (options.rowDataMode === 'main') return null;
  if (typeof Worker === 'undefined') return null;
  if (options.treeData || options.getDataPath || options.treeDataChildrenField) return null;
  if (options.isExternalFilterPresent?.()) return null;

  const filterCols: WorkerPipelineConfig['filterCols'] = [];
  const sortCols: WorkerPipelineConfig['sortCols'] = [];
  const fieldByColId = new Map<string, string>();
  for (const col of cols.displayed()) {
    const field = workerField(col);
    if (!field) continue;
    fieldByColId.set(col.colId, field);
    filterCols.push({ colId: col.colId, field });
    if (col.def.comparator) continue; // sorted via main only
    const t = col.def.type;
    const type = t === 'number' ? 'number' : t === 'date' ? 'date' : 'text';
    sortCols.push({ colId: col.colId, field, type });
  }

  // Active filters / sorts on non-worker (or custom-comparator) columns → main.
  for (const colId of Object.keys(rows.filterModel)) {
    if (!fieldByColId.has(colId)) return null;
  }
  for (const s of cols.sortModel()) {
    const col = cols.getColumn(s.colId);
    if (!col || !fieldByColId.has(s.colId) || col.def.comparator) return null;
  }

  // Quick filter searches only worker field cols; any displayed col without a
  // worker field forces the main path.
  const quickTerms = tokenizeQuickFilter(rows.quickFilter);
  if (quickTerms.length > 0) {
    for (const col of cols.displayed()) {
      if (!workerField(col)) return null;
    }
  }

  const groupCols: WorkerPipelineConfig['groupCols'] = [];
  for (const c of cols.rowGroupColumns()) {
    const field = workerField(c);
    if (!field) return null;
    groupCols.push({ colId: c.colId, field });
  }

  const aggCols: WorkerPipelineConfig['aggCols'] = [];
  for (const spec of cols.getAggCols()) {
    const col = cols.getColumn(spec.colId);
    if (!spec.field || typeof spec.aggFunc !== 'string' || col?.def.valueGetter) return null;
    if (!WORKER_AGG_FUNCS.has(spec.aggFunc)) return null;
    aggCols.push({
      colId: spec.colId,
      field: spec.field,
      aggFunc: spec.aggFunc as WorkerPipelineConfig['aggCols'][number]['aggFunc'],
      weightField: spec.weightField,
    });
  }

  const groupTotalRow = options.groupTotalRow;
  return {
    filterCols,
    sortCols,
    calcCols: [],
    filterModel: rows.filterModel,
    quickFilterTerms: quickTerms,
    sortModel: cols.sortModel(),
    groupCols,
    aggCols,
    groupDefaultExpanded:
      rows.expandAllIntent === true
        ? -1
        : rows.expandAllIntent === false
          ? 0
          : (options.groupDefaultExpanded ?? 0),
    expandedState: [...rows.groupExpanded.entries()],
    groupTotalRow: typeof groupTotalRow === 'function' ? undefined : groupTotalRow,
    groupSuppressBlankHeader: options.groupSuppressBlankHeader,
    grandTotalRow:
      options.grandTotalRow === 'top' || options.grandTotalRow === 'bottom'
        ? options.grandTotalRow
        : undefined,
  };
}

/**
 * Build the render-plane config (display columns + static formats/styles), or
 * `null` when any displayed column needs main-thread rendering — a function
 * `valueFormatter`, function `cellStyle`, or `valueGetter`. Emits one dev
 * warning naming the first offending column before bailing.
 *
 * @param cols live column model (display order).
 */
export function buildRenderConfig<TData>(cols: ColumnModel<TData>): RenderPlaneConfig | null {
  const displayed = cols.displayed();
  const outCols: RenderPlaneConfig['cols'] = [];
  let groupIndentColId: string | undefined;

  for (const col of displayed) {
    if (col.colId === AUTO_GROUP_COL_ID) {
      groupIndentColId = col.colId;
      outCols.push({ colId: col.colId, field: col.def.field ?? '' });
      continue;
    }
    if (col.def.valueGetter) {
      warnIneligible(col.colId, 'valueGetter');
      return null;
    }
    if (typeof col.def.valueFormatter === 'function') {
      warnIneligible(col.colId, 'valueFormatter');
      return null;
    }
    if (typeof col.def.cellStyle === 'function') {
      warnIneligible(col.colId, 'cellStyle');
      return null;
    }
    outCols.push({
      colId: col.colId,
      field: col.def.field ?? '',
      type: col.def.type === 'number' ? 'number' : undefined,
      format: col.def.format,
      // Only static (object) cellStyle reaches here (function bailed above).
      cellStyle: col.def.cellStyle as CellStyle | undefined,
    });
  }

  return { cols: outCols, ...(groupIndentColId ? { groupIndentColId } : {}) };
}

function warnIneligible(colId: string, reason: string): void {
  console.warn(
    `[tabular-dom] worker render plane disabled: column "${colId}" has a function ${reason}; using main-thread rendering`,
  );
}
