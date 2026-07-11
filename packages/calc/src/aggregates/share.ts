// Ratio/share aggregates — DERIVED, not standalone Aggregate impls.
//
//   PCT_OF_X([e])  ⇒  [e] / SUM([e], 'X's fixed scope literal')
//
//   PCT_OF_TOTAL  → visible   (share of what the user currently sees)
//   PCT_OF_GRAND  → all       (share of the unfiltered dataset)
//   PCT_OF_GROUP  → group
//   PCT_OF_PARENT → parent
//
// The result is a RAW FRACTION (0..1) — percent display is a formatting
// concern (cellDataType 'percent'). A null or zero denominator yields
// null per the interpreter's errors→null rule (spec §5).
//
// ADAPTED TO LANDED PHASE B: aggTransform.ts's rewriteNode is a SINGLE
// PASS that walks the parsed ast top-down and interns prePass slots as
// it goes (aggregate call sites are rewritten in place, not in a
// separate post-transform sweep). The 21b parser never emits
// AggregateNode — PCT_OF_* arrives from parse() as an ordinary CallNode
// (kind:'call'), same as SUM/AVG/etc. So expandShareAggregates is invoked
// from rewriteNode's 'call' case BEFORE the CALC_AGGREGATE_NAMES dispatch
// to rewriteAggregate — the synthesized SUM CallNode is then run back
// through rewriteNode so it dedups against user-written SUMs via the
// normal internSlot path (same (fn, colId, scope) key). This satisfies
// the cross-task contract's invariant (transform → expand → slot-assign/
// dedup) even though the landed code interleaves transform and
// slot-assignment in one pass: expansion still happens strictly before
// ANY slot is interned for a share call site.
//
// expandShareAggregates also accepts a hand-built AggregateNode (the
// {kind:'aggregate', name, args, loc} reserved shape) for direct
// unit-testing of this module in isolation — the rewrite is name/args/loc
// driven and agnostic to which of the two node kinds carries them; the
// OUTPUT mirrors the input kind for the synthesized SUM (CallNode in →
// CallNode out; AggregateNode in → AggregateNode out) so callers never
// see a kind they didn't hand in.

import type { AstNode, BinaryNode } from '@tabular/expression';
import type { CalcValidationError } from '../types';

export const SHARE_AGGREGATE_NAMES: readonly string[] = [
  'PCT_OF_TOTAL', 'PCT_OF_GROUP', 'PCT_OF_PARENT', 'PCT_OF_GRAND',
];

const SHARE_SCOPE_LITERAL: Record<string, string> = {
  PCT_OF_TOTAL: 'visible',
  PCT_OF_GRAND: 'all',
  PCT_OF_GROUP: 'group',
  PCT_OF_PARENT: 'parent',
};

export type ShareExpandResult =
  | { ok: true; ast: AstNode }
  | { ok: false; error: CalcValidationError };

class ShareShapeError extends Error {
  constructor(readonly validation: CalcValidationError) {
    super(validation.message);
    this.name = 'ShareShapeError';
  }
}

/** True iff `name` is one of the four share aggregate names. */
export function isShareAggregateName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(SHARE_SCOPE_LITERAL, name);
}

/**
 * Expand a single PCT_OF_X call/aggregate node (`{name, args, loc}`) into
 * `value / SUM(value, scopeLit)`, where the synthesized SUM's kind
 * mirrors `sumKind` ('call' for the landed single-pass transform;
 * 'aggregate' for a hand-built AggregateNode caller). Does NOT recurse
 * into `value` — the caller (rewriteNode / expand below) owns recursion
 * so a synthesized SUM re-enters the normal aggregate/slot machinery.
 */
function expandOne(
  node: { name: string; args: AstNode[]; loc: AstNode['loc'] },
  sumKind: 'call' | 'aggregate',
): BinaryNode {
  const scopeLiteral = SHARE_SCOPE_LITERAL[node.name];
  if (scopeLiteral === undefined) {
    // Unreachable via the public expand() dispatch — defensive.
    throw new ShareShapeError({
      colId: null, code: 'bad-shape', message: `${node.name} is not a share aggregate`, loc: node.loc,
    });
  }
  const [valueArg, scopeArg] = node.args;
  if (valueArg === undefined || node.args.length > 2) {
    throw new ShareShapeError({
      colId: null,
      code: 'bad-shape',
      message: `${node.name} expects a field first argument, e.g. ${node.name}([qty])`,
      loc: node.loc,
    });
  }
  // Tolerate a user-supplied scope literal iff it matches this share's
  // fixed scope; anything else (including a DIFFERENT scope) is rejected —
  // share aggregates fix their own scope.
  if (scopeArg !== undefined) {
    const matches = scopeArg.kind === 'literal' && scopeArg.value === scopeLiteral;
    if (!matches) {
      throw new ShareShapeError({
        colId: null,
        code: 'bad-shape',
        message: `${node.name} fixes its own scope ('${scopeLiteral}') — drop the scope: argument`,
        loc: node.loc,
      });
    }
  }
  const sumArgs: AstNode[] = [valueArg, { kind: 'literal', value: scopeLiteral, loc: node.loc }];
  return {
    kind: 'binary',
    op: '/',
    loc: node.loc,
    left: valueArg,
    right: sumKind === 'call'
      ? { kind: 'call', name: 'SUM', args: sumArgs, loc: node.loc }
      : { kind: 'aggregate', name: 'SUM', args: sumArgs, loc: node.loc },
  };
}

function expand(node: AstNode): AstNode {
  switch (node.kind) {
    case 'literal':
    case 'field':
      return node;
    case 'unary':
      return { ...node, arg: expand(node.arg) };
    case 'binary':
      return { ...node, left: expand(node.left), right: expand(node.right) };
    case 'ternary':
      return {
        ...node,
        test: expand(node.test),
        consequent: expand(node.consequent),
        alternate: expand(node.alternate),
      };
    case 'call': {
      if (isShareAggregateName(node.name)) {
        const rewritten = expandOne(node, 'call');
        return { ...rewritten, left: expand(rewritten.left) };
      }
      return { ...node, args: node.args.map(expand) };
    }
    case 'aggregate': {
      if (isShareAggregateName(node.name)) {
        const rewritten = expandOne(node, 'aggregate');
        return { ...rewritten, left: expand(rewritten.left) };
      }
      return { ...node, args: node.args.map(expand) };
    }
    case 'prev':
      return { ...node, arg: expand(node.arg) };
  }
}

/**
 * Pure structural rewrite: PCT_OF_X([e]) → [e] / SUM([e], 'scope').
 * Input AST is untouched (every node on the rewritten path is a fresh
 * shallow copy). Accepts either the parser's CallNode form (the shape
 * that actually reaches this function via aggTransform.ts) or a
 * hand-built AggregateNode (unit-test convenience) for the same share
 * names — see the module doc for the kind-mirroring rule.
 */
export function expandShareAggregates(ast: AstNode): ShareExpandResult {
  try {
    return { ok: true, ast: expand(ast) };
  } catch (e) {
    if (e instanceof ShareShapeError) return { ok: false, error: e.validation };
    throw e;
  }
}
