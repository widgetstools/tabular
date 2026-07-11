// Post-parse AST transform: CallNode → aggregate/PREV rewrite.
//
// The calc DSL wire format for scope is a trailing string literal —
// SUM([x], 'group'). The pretty `scope: group` form is 21i editor sugar
// (`:` is the ternary token; a bare `scope:` cannot parse) — the editor
// emits the string-literal form.
//
// LOCKED design (plan Phase B preamble): aggregate call sites are REPLACED
// with synthetic FieldNode reads ['__tabularAgg', slot] and PREV sites with
// ['__tabularPrev', colId], so the rewritten per-row program compiles with
// the untouched 21b expression.compile and the worker interpreter stays a
// plain AST walker. The reserved AggregateNode/PrevNode kinds are built
// INTERNALLY for validation clarity (spec §1.1.1) but never emitted.
//
// Default scope is { kind: 'visible' } (spec §6.2); the WORKER promotes
// visible → group at evaluation when grouping is active (Stage B contract,
// kernel CalcPass — Task 10). The transform cannot know grouping.
//
// Date-free, CSP-safe, plain JSON in/out.
//
// Authoritative reference:
// docs/superpowers/specs/2026-07-02-cycle-21d-calc-design.md §1.1 + §6.2.

import type {
  AggregateNode, Ast, AstNode, CallNode, FieldNode, Loc, PrevNode, Schema,
} from '@tabular/expression';
import { expandShareAggregates, isShareAggregateName } from './aggregates/share';
import type { AggScope, AggSpec, CalcValidationError } from './types';

/** Synthetic injection root for pre-pass aggregate slot reads. */
export const AGG_ROOT = '__tabularAgg';
/** Synthetic injection root for tick-scoped PREV reads. */
export const PREV_ROOT = '__tabularPrev';

// /expression does not export AGGREGATE_NAMES from its index, and
// calc's vocabulary is a superset anyway (statistical + share families) —
// calc owns the authoritative calc-DSL lists.

/** Shippable this cycle — Task 5's registry registers exactly this set
 *  (PERCENTILE via the parameterized-name channel, see below). */
export const CALC_AGGREGATE_NAMES: ReadonlySet<string> = new Set([
  'SUM', 'AVG', 'COUNT', 'MIN', 'MAX', 'COUNT_DISTINCT',
  'MEDIAN', 'PERCENTILE', 'STDEV', 'VAR', 'MODE',
  'PCT_OF_TOTAL', 'PCT_OF_GROUP', 'PCT_OF_PARENT', 'PCT_OF_GRAND',
  'FIRST', 'LAST',
]);

/** Grammar-honest reserves (spec §1.2): per-scope ORDERED state coupled to
 *  the sort model — ships with the follow-up window-aggregates cycle. */
export const ORDER_DEPENDENT_NAMES: ReadonlySet<string> = new Set([
  'RANK', 'DENSE_RANK', 'PERCENT_RANK',
  'RUNNING_SUM', 'RUNNING_AVG', 'MOVING_AVG',
  'DELTA_FROM_PREV', 'DELTA_FROM_FIRST', 'DELTA_FROM_LAST',
]);

const SCOPE_KINDS = ['all', 'visible', 'group', 'parent'] as const;

function isScopeKind(v: string): v is AggScope['kind'] {
  return (SCOPE_KINDS as readonly string[]).includes(v);
}

class TransformFailure extends Error {
  readonly failure: CalcValidationError;
  constructor(failure: CalcValidationError) {
    super(failure.message);
    this.failure = failure;
  }
}

function fail(code: CalcValidationError['code'], message: string, loc: Loc): never {
  // colId is null at this level — CalcEngine stamps the calc column id (Task 7).
  throw new TransformFailure({ colId: null, code, message, loc });
}

interface TransformState {
  slots: Map<string, AggSpec>;
  prePass: AggSpec[];
  usesPrev: boolean;
  schema: Schema | undefined;
}

function checkField(node: FieldNode, state: TransformState): void {
  if (!state.schema) return;
  const key = node.path.join('.');
  const head = node.path[0]!;
  // Full dotted join OR its head (nested-object reads) must be known.
  if (key in state.schema.fields || head in state.schema.fields) return;
  fail('bad-shape', `unknown field '${key}'`, node.loc);
}

function internSlot(
  state: TransformState, fn: string, colId: string, scope: AggScope,
): AggSpec {
  //  (unprintable) separators guard against key collisions from
  // adversarial fn/colId strings containing plain delimiters.
  const key = `${fn}${colId}${scope.kind}`;
  const existing = state.slots.get(key);
  if (existing) return existing;
  const spec: AggSpec = { slot: state.prePass.length, fn, colId, scope };
  state.slots.set(key, spec);
  state.prePass.push(spec);
  return spec;
}

function rewritePrev(node: CallNode, state: TransformState): FieldNode {
  const first = node.args[0];
  if (node.args.length !== 1 || first === undefined || first.kind !== 'field') {
    fail('bad-shape', 'PREV expects exactly one field argument, e.g. PREV([price])', node.loc);
  }
  checkField(first, state);
  // Reserved-node construction for validation clarity (spec §1.1.1); the
  // emitted AST carries only the synthetic __tabularPrev read.
  const prevNode: PrevNode = { kind: 'prev', arg: first, loc: node.loc };
  state.usesPrev = true;
  // The dotted colId travels as ONE synthetic segment — the worker's
  // prevLookup is keyed by colId, not by path walk.
  return { kind: 'field', path: [PREV_ROOT, first.path.join('.')], loc: prevNode.loc };
}

/**
 * Returns the synthetic slot read when the call SHAPE says aggregate, or
 * null when a variadic builtin (MIN/MAX) should keep the call as-is.
 * Throws TransformFailure for malformed non-variadic aggregate calls.
 */
function rewriteAggregate(node: CallNode, state: TransformState): FieldNode | null {
  const isVariadicBuiltin = node.name === 'MIN' || node.name === 'MAX';
  const first = node.args[0];
  if (first === undefined || first.kind !== 'field') {
    if (isVariadicBuiltin) return null; // MIN(1, 2) → variadic numeric builtin
    fail('bad-shape',
      `${node.name} expects a field first argument, e.g. ${node.name}([price])`, node.loc);
  }
  let rest = node.args.slice(1);
  let fn = node.name;

  if (node.name === 'PERCENTILE') {
    // Parameterized-name channel: AggSpec is locked without a params field,
    // so the percentile rides in fn as 'PERCENTILE(<p>)' (registry parses —
    // Task 5). Dedup keys work unchanged.
    const p = rest[0];
    if (p === undefined || p.kind !== 'literal' || typeof p.value !== 'number') {
      fail('bad-shape',
        'PERCENTILE expects a numeric percentile second argument, e.g. PERCENTILE([price], 95)',
        node.loc);
    }
    // The literal IS percent points already (spec §1.1: 0–100; master doc
    // §6.4 PERCENTILE([latency], 95)) — no fraction conversion.
    if (!Number.isFinite(p.value) || p.value < 0 || p.value > 100) {
      fail('bad-shape', 'PERCENTILE expects percent points 0–100', p.loc);
    }
    fn = `PERCENTILE(${String(p.value)})`;
    rest = rest.slice(1);
  }

  // Spec §6.2 default; the worker promotes visible → group when grouping
  // is active (Stage B contract — Task 10 owns the promotion).
  let scope: AggScope = { kind: 'visible' };
  if (rest.length === 1) {
    const lit = rest[0]!;
    if (lit.kind !== 'literal' || typeof lit.value !== 'string') {
      if (isVariadicBuiltin) return null; // MIN([a], [b]) → variadic builtin
      fail('bad-shape',
        `${node.name}: second argument must be a scope string ('all' | 'visible' | 'group' | 'parent')`,
        node.loc);
    }
    if (!isScopeKind(lit.value)) {
      fail('unknown-scope',
        `unknown aggregate scope '${lit.value}' — expected 'all' | 'visible' | 'group' | 'parent'`,
        lit.loc);
    }
    scope = { kind: lit.value };
  } else if (rest.length > 1) {
    if (isVariadicBuiltin) return null; // MAX([a], [b], [c]) → variadic builtin
    fail('bad-shape', `${node.name}: too many arguments`, node.loc);
  }

  checkField(first, state);
  // Reserved-node construction for validation clarity (spec §1.1.1); the
  // emitted per-row AST replaces this site with a synthetic slot read.
  const agg: AggregateNode = { kind: 'aggregate', name: node.name, args: node.args, loc: node.loc };
  const spec = internSlot(state, fn, first.path.join('.'), scope);
  return { kind: 'field', path: [AGG_ROOT, String(spec.slot)], loc: agg.loc };
}

function rewriteNode(node: AstNode, state: TransformState): AstNode {
  switch (node.kind) {
    case 'literal':
      return node;
    case 'field':
      checkField(node, state);
      return node;
    case 'unary':
      return { ...node, arg: rewriteNode(node.arg, state) };
    case 'binary':
      return {
        ...node,
        left: rewriteNode(node.left, state),
        right: rewriteNode(node.right, state),
      };
    case 'ternary':
      return {
        ...node,
        test: rewriteNode(node.test, state),
        consequent: rewriteNode(node.consequent, state),
        alternate: rewriteNode(node.alternate, state),
      };
    case 'call': {
      if (node.name === 'PREV') return rewritePrev(node, state);
      if (ORDER_DEPENDENT_NAMES.has(node.name)) {
        fail('not-yet-implemented',
          `${node.name} is order-dependent (needs per-scope sorted-window state) and ships with the follow-up window-aggregates cycle`,
          node.loc);
      }
      if (isShareAggregateName(node.name)) {
        // Compile-time expansion (Task 6): PCT_OF_X([e]) → [e] / SUM([e],
        // 'scope'). Runs BEFORE any slot is interned for this call site —
        // the synthesized SUM CallNode is re-entered through rewriteNode
        // so it dedups against user-written SUMs via the normal
        // internSlot (fn, colId, scope) key. Share names never reach
        // AggSpec.fn.
        const expanded = expandShareAggregates(node);
        if (!expanded.ok) throw new TransformFailure(expanded.error);
        return rewriteNode(expanded.ast, state);
      }
      if (CALC_AGGREGATE_NAMES.has(node.name)) {
        const rewritten = rewriteAggregate(node, state);
        if (rewritten) return rewritten;
        // MIN/MAX whose arg shape is NOT an aggregate read fall through to
        // the variadic numeric builtin (spec §1.1.1 disambiguation).
      }
      return { ...node, args: node.args.map((a) => rewriteNode(a, state)) };
    }
    case 'aggregate':
    case 'prev':
      // 21b's parser never emits these; a hand-built input passes through
      // untouched and the downstream compile rejects with not-yet-implemented.
      return node;
  }
}

/**
 * Every FieldNode head in the ast, excluding the synthetic injection roots.
 * Run on the PRE-rewrite ast to capture aggregate + PREV sources (post-
 * rewrite those sites are synthetic reads and are excluded by design).
 */
export function collectWatchedColIds(ast: Ast): ReadonlySet<string> {
  const heads = new Set<string>();
  const visit = (node: AstNode): void => {
    switch (node.kind) {
      case 'literal':
        return;
      case 'field': {
        const head = node.path[0]!;
        if (head !== AGG_ROOT && head !== PREV_ROOT) heads.add(head);
        return;
      }
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
  return heads;
}

export function transformAggregates(
  ast: Ast,
  schema?: Schema,
): { ok: true; ast: Ast; prePass: AggSpec[]; usesPrev: boolean }
  | { ok: false; error: CalcValidationError } {
  const state: TransformState = {
    slots: new Map(), prePass: [], usesPrev: false, schema,
  };
  try {
    const rewritten = rewriteNode(ast, state);
    return { ok: true, ast: rewritten, prePass: state.prePass, usesPrev: state.usesPrev };
  } catch (e) {
    if (e instanceof TransformFailure) return { ok: false, error: e.failure };
    throw e;
  }
}
