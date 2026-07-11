import type { Compiled, EvalContext } from './types';
import { EvalError } from './types';

/**
 * Execute a Compiled expression against a row context.
 * Compiled.run may throw EvalError; unexpected non-EvalError throws
 * become EvalError { code: 'runtime' } anchored at the AST root loc.
 */
export function evaluate(compiled: Compiled, ctx: EvalContext): unknown {
  try {
    return compiled.run(ctx);
  } catch (e) {
    if (e instanceof EvalError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new EvalError('runtime', `unexpected runtime error: ${msg}`, compiled.ast.loc);
  }
}
