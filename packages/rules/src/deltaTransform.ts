/**
 * Rewrite `[field.old]` / `[field.new]` refs to read from the delta bag
 * injected at evaluation time (`__tabularDelta.field.old|new`).
 */
import type { Ast, AstNode } from '@tabular/expression';

export const DELTA_ROOT = '__tabularDelta';

export function transformDeltaRefs(ast: Ast): { ast: Ast; usesDelta: boolean } {
  let usesDelta = false;
  const visit = (node: AstNode): AstNode => {
    switch (node.kind) {
      case 'literal':
        return node;
      case 'field': {
        const last = node.path[node.path.length - 1];
        if (last === 'old' || last === 'new') {
          usesDelta = true;
          return {
            ...node,
            path: [DELTA_ROOT, ...node.path],
          };
        }
        return node;
      }
      case 'unary':
        return { ...node, arg: visit(node.arg) };
      case 'binary':
        return { ...node, left: visit(node.left), right: visit(node.right) };
      case 'ternary':
        return {
          ...node,
          test: visit(node.test),
          consequent: visit(node.consequent),
          alternate: visit(node.alternate),
        };
      case 'call':
      case 'aggregate':
        return { ...node, args: node.args.map(visit) };
      case 'prev':
        return { ...node, arg: visit(node.arg) };
    }
  };
  return { ast: visit(ast), usesDelta };
}

/** Field heads referenced by a condition (strips `.old`/`.new` tails). */
export function watchedFieldHeads(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const parts = p.split('.');
    const last = parts[parts.length - 1];
    if (last === 'old' || last === 'new') parts.pop();
    if (parts[0] && parts[0] !== DELTA_ROOT) out.add(parts[0]);
  }
  return [...out];
}

/** Build the evaluation row for a delta update. */
export function buildDeltaRow(
  data: Record<string, unknown>,
  changes: ReadonlyArray<{ key: string; oldValue: unknown; newValue: unknown }>,
): Record<string, unknown> {
  const delta: Record<string, { old: unknown; new: unknown }> = {};
  for (const c of changes) {
    delta[c.key] = { old: c.oldValue, new: c.newValue };
  }
  return { ...data, [DELTA_ROOT]: delta };
}
