/**
 * @tabular/calc — calculated column compilation and evaluation.
 */
export { compileCalc, evaluatePerRow } from './compile';
export { transformAggregates, collectWatchedColIds, AGG_ROOT, PREV_ROOT } from './aggTransform';
export type {
  AggScope,
  AggSpec,
  CompiledCalc,
  CalcValidationError,
  CellDataType,
} from './types';
export { compileCalcColumn, safeEvaluateCalc, type CalcColumnHandle } from './column';
