// compileCalc: expression.parse → transformAggregates → expression.compile
// on the REWRITTEN ast. Aggregate/PREV sites are plain synthetic FieldNodes
// by then, so 21b's untouched compiler accepts the per-row program; the
// pre-pass AggSpec[] travels alongside (two-pass split, spec §1.1.2).
//
// evaluatePerRow is the MAIN-SIDE REFERENCE evaluator (CalcEngine preview +
// tests). The worker hot path is Task 4's self-contained interpreter; the
// parity property test there pins both to the same semantics.
//
// Date-free, CSP-safe (closure composition only), plain JSON discipline.
//
// Authoritative reference:
// docs/superpowers/specs/2026-07-02-cycle-21d-calc-design.md §1.1.2 + §5.

import { compile as compileExpression, evaluate, parse, EvalError } from '@tabular/expression';
import type { Ast, AstNode, Compiled, Schema } from '@tabular/expression';
import { AGG_ROOT, PREV_ROOT, collectWatchedColIds, transformAggregates } from './aggTransform';
import type { CalcValidationError, CompiledCalc } from './types';

// The Compiled runner is NOT part of the locked CompiledCalc shape — cache
// it per CompiledCalc object; a foreign (structuredCloned) CompiledCalc
// recompiles once, lazily, in evaluatePerRow.
const RUNNER_CACHE = new WeakMap<CompiledCalc, Compiled>();

export function compileCalc(
  source: string,
  schema?: Schema,
): { ok: true; compiled: CompiledCalc } | { ok: false; error: CalcValidationError } {
  const parsed = parse(source);
  if (!parsed.ok) {
    return {
      ok: false,
      error: { colId: null, code: 'parse', message: parsed.error.message, loc: parsed.error.loc },
    };
  }
  const transformed = transformAggregates(parsed.ast, schema);
  if (!transformed.ok) return transformed;
  const compiled = compileExpression(transformed.ast);
  if (!compiled.ok) {
    // Compile codes pass through verbatim: 'unknown-fn' | 'arity' |
    // 'not-yet-implemented' (the latter only for hand-built reserved nodes —
    // the transform already consumed every parseable aggregate/PREV site).
    return {
      ok: false,
      error: {
        colId: null,
        code: compiled.error.code,
        message: compiled.error.message,
        loc: compiled.error.loc,
      },
    };
  }
  const result: CompiledCalc = {
    ast: transformed.ast,
    prePass: transformed.prePass,
    // Pre-rewrite heads — captures aggregate + PREV sources (Task 2 contract).
    watchedColIds: collectWatchedColIds(parsed.ast),
    usesPrev: transformed.usesPrev,
    // compileCalc has no def context; CalcEngine overrides from
    // CalculatedColumnDef.cellDataType (Task 7).
    cellDataType: 'number',
  };
  RUNNER_CACHE.set(result, compiled.compiled);
  return { ok: true, compiled: result };
}

/** The __tabularPrev colIds the rewritten program actually reads. */
function collectPrevColIds(ast: Ast): string[] {
  const out: string[] = [];
  const visit = (node: AstNode): void => {
    switch (node.kind) {
      case 'literal':
        return;
      case 'field':
        if (node.path[0] === PREV_ROOT && node.path[1] !== undefined) out.push(node.path[1]);
        return;
      case 'unary':
        return visit(node.arg);
      case 'binary':
        visit(node.left);
        visit(node.right);
        return;
      case 'ternary':
        visit(node.test);
        visit(node.consequent);
        visit(node.alternate);
        return;
      case 'call':
      case 'aggregate':
        node.args.forEach((a) => visit(a));
        return;
      case 'prev':
        return visit(node.arg);
    }
  };
  visit(ast);
  return out;
}

/**
 * Main-side reference evaluator. Builds the eval row with the synthetic
 * __tabularAgg / __tabularPrev injections and runs expression.evaluate;
 * EvalError → null (StarUI: runtime errors → null cell).
 */
export function evaluatePerRow(
  compiled: CompiledCalc,
  row: Record<string, unknown>,
  aggValues: ReadonlyArray<number | null>,
  prev: ((colId: string) => unknown) | null,
): unknown {
  let runner = RUNNER_CACHE.get(compiled);
  if (!runner) {
    const res = compileExpression(compiled.ast);
    if (!res.ok) return null; // foreign CompiledCalc that no longer compiles → null cell
    runner = res.compiled;
    RUNNER_CACHE.set(compiled, runner);
  }
  const aggObj: Record<string, number | null> = {};
  for (const spec of compiled.prePass) {
    const v = aggValues[spec.slot];
    aggObj[String(spec.slot)] = v === undefined ? null : v;
  }
  const prevObj: Record<string, unknown> = {};
  if (compiled.usesPrev && prev) {
    for (const colId of collectPrevColIds(compiled.ast)) {
      const v = prev(colId);
      prevObj[colId] = v === undefined ? null : v;
    }
  }
  const evalRow: Record<string, unknown> = {
    ...row,
    [AGG_ROOT]: aggObj,
    [PREV_ROOT]: prevObj,
  };
  try {
    return evaluate(runner, { row: evalRow });
  } catch (e) {
    if (e instanceof EvalError) return null;
    throw e; // programmer error — evaluate wraps all data errors in EvalError
  }
}
