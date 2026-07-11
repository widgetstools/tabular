/**
 * Wire @tabular/rules into the grid: delta feed, style resolver chain,
 * state module, alerts, and rule flash.
 */
import { RulesEngine, type AlertEvent, type RulesConfig } from '@tabular/rules';
import type { FlashManager } from './flash';
import type { CellStyle, GridOptions, GridStateModule } from './types';

export interface RulesHost<TData> {
  addCellStyleResolver: (
    fn: (
      params: { colId: string; data: TData | undefined; rowId?: string },
      style: CellStyle,
    ) => void,
    priority?: number,
  ) => () => void;
  onTransactionApplied: (
    handler: (e: {
      updates: ReadonlyArray<{
        rowId: string;
        data: TData;
        changes: ReadonlyArray<{ key: string; oldValue: unknown; newValue: unknown }>;
      }>;
      addedIds: string[];
      removedIds: string[];
    }) => void,
  ) => () => void;
  onModelUpdated: (handler: () => void) => () => void;
  registerStateModule: (module: GridStateModule) => () => void;
  getColIdForField: (field: string) => string | undefined;
  getFieldForColId: (colId: string) => string | undefined;
  forEachDisplayedRow: (fn: (rowId: string, data: TData) => void) => void;
  getRowById: (id: string) => TData | undefined;
  getRowId: (data: TData) => string;
  ruleFlash: FlashManager['ruleFlash'];
  requestPaint: () => void;
  /** When true, skip main-thread eval (worker ships results). */
  isWorkerRulesActive?: () => boolean;
}

export function attachRules<TData>(
  host: RulesHost<TData>,
  options: Pick<GridOptions<TData>, 'rules' | 'onAlert'>,
): { engine: RulesEngine<TData>; detach: () => void } | null {
  if (!options.rules) return null;

  const engine = new RulesEngine(options.rules, {
    getColIdForField: host.getColIdForField,
    getFieldForColId: host.getFieldForColId,
    forEachDisplayedRow: host.forEachDisplayedRow,
    onAlert: options.onAlert,
    ruleFlash: host.ruleFlash,
    requestPaint: host.requestPaint,
  });

  const syncWorkerFlag = (): void => {
    engine.workerEval = host.isWorkerRulesActive?.() === true;
  };
  syncWorkerFlag();

  const cleanups: Array<() => void> = [];

  cleanups.push(
    host.addCellStyleResolver((params, style) => {
      const rowId =
        params.rowId ?? (params.data != null ? host.getRowId(params.data) : undefined);
      if (!rowId) return;
      engine.styleResolver({ colId: params.colId, rowId }, style);
    }, 50),
  );

  cleanups.push(
    host.onTransactionApplied((e) => {
      syncWorkerFlag();
      engine.applyTransactionDelta(e.updates, e.addedIds, e.removedIds, host.getRowById);
    }),
  );

  cleanups.push(
    host.onModelUpdated(() => {
      syncWorkerFlag();
      engine.refreshStaticRules();
    }),
  );

  cleanups.push(
    host.registerStateModule({
      id: 'rules',
      version: 1,
      get: () => engine.getState(),
      set: (data) => engine.restoreState(data as import('@tabular/rules').RulesStateData),
    }),
  );

  return {
    engine,
    detach: () => {
      for (const fn of cleanups) fn();
    },
  };
}

export type { AlertEvent, RulesConfig };
