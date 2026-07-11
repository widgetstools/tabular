/**
 * Safe calc column compiler with per-expression caching and defensive
 * error handling — invalid expressions compile to a null-returning stub
 * and log once in dev.
 */
import { compileCalc, evaluatePerRow } from './compile';
import type { CompiledCalc } from './types';
import type { Schema } from '@tabular/expression';

export interface CalcColumnHandle {
  colId: string;
  source: string;
  compiled: CompiledCalc | null;
  watchedColIds: ReadonlySet<string>;
  usesPrev: boolean;
  error: string | null;
}

const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[tabular calc] ${message}`);
}

export function compileCalcColumn(
  colId: string,
  expression: string,
  schema?: Schema,
): CalcColumnHandle {
  if (!expression || typeof expression !== 'string') {
    return {
      colId,
      source: expression ?? '',
      compiled: null,
      watchedColIds: new Set(),
      usesPrev: false,
      error: 'empty expression',
    };
  }
  try {
    const result = compileCalc(expression.trim(), schema);
    if (!result.ok) {
      warnOnce(`${colId}:${result.error.message}`, `column ${colId}: ${result.error.message}`);
      return {
        colId,
        source: expression,
        compiled: null,
        watchedColIds: new Set(),
        usesPrev: false,
        error: result.error.message,
      };
    }
    return {
      colId,
      source: expression,
      compiled: result.compiled,
      watchedColIds: result.compiled.watchedColIds,
      usesPrev: result.compiled.usesPrev,
      error: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warnOnce(`${colId}:${msg}`, `column ${colId}: ${msg}`);
    return {
      colId,
      source: expression,
      compiled: null,
      watchedColIds: new Set(),
      usesPrev: false,
      error: msg,
    };
  }
}

/** Evaluate a compiled calc for one row; never throws — returns null on error. */
export function safeEvaluateCalc(
  handle: CalcColumnHandle,
  row: Record<string, unknown>,
  aggValues?: ReadonlyArray<number | null>,
  prev?: ((colId: string) => unknown) | null,
): unknown {
  if (!handle.compiled) return null;
  try {
    return evaluatePerRow(handle.compiled, row, aggValues ?? [], prev ?? null);
  } catch {
    return null;
  }
}
