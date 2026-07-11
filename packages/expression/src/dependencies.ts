/**
 * Extract field dependencies from an expression source string.
 * Returns dotted field path heads (first segment of [field] refs).
 * Defensive: parse failures return an empty array.
 */
import { parse } from './parse';
import type { Ast, AstNode } from './types';

export function dependencies(source: string): string[] {
  const parsed = parse(source);
  if (!parsed.ok) return [];
  const heads = new Set<string>();
  const visit = (node: AstNode): void => {
    switch (node.kind) {
      case 'literal':
        return;
      case 'field':
        if (node.path[0]) heads.add(node.path[0]);
        return;
      case 'unary':
        visit(node.arg);
        return;
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
        for (const a of node.args) visit(a);
        return;
      case 'prev':
        visit(node.arg);
        return;
    }
  };
  visit(parsed.ast);
  return [...heads];
}

/** Collect all dotted field keys referenced in a parsed AST. */
export function dependenciesFromAst(ast: Ast): string[] {
  const keys = new Set<string>();
  const visit = (node: AstNode): void => {
    switch (node.kind) {
      case 'literal':
        return;
      case 'field':
        keys.add(node.path.join('.'));
        return;
      case 'unary':
        visit(node.arg);
        return;
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
        for (const a of node.args) visit(a);
        return;
      case 'prev':
        visit(node.arg);
        return;
    }
  };
  visit(ast);
  return [...keys];
}
