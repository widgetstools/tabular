import { compile } from './compile';
import { parse } from './parse';
import type {
  AstNode, BinaryNode, FieldNode, Schema, ValidationError,
  ValidationResult, FieldType,
} from './types';

export function validate(source: string, schema: Schema): ValidationResult {
  const errors: ValidationError[] = [];

  const parsed = parse(source);
  if (!parsed.ok) {
    errors.push({
      kind: 'validate', code: 'parse',
      message: parsed.error.message, loc: parsed.error.loc,
    });
    return { ok: false, errors };
  }

  const compiled = compile(parsed.ast);
  if (!compiled.ok) {
    errors.push({
      kind: 'validate', code: 'compile',
      message: compiled.error.message, loc: compiled.error.loc,
    });
    return { ok: false, errors };
  }

  walk(parsed.ast, schema, errors);

  return { ok: errors.length === 0, errors };
}

function walk(node: AstNode, schema: Schema, errors: ValidationError[]): void {
  switch (node.kind) {
    case 'literal': return;
    case 'field': return checkField(node, schema, errors);
    case 'unary': return walk(node.arg, schema, errors);
    case 'binary': {
      walk(node.left, schema, errors);
      walk(node.right, schema, errors);
      checkBinaryTypes(node, schema, errors);
      return;
    }
    case 'ternary': {
      walk(node.test, schema, errors);
      walk(node.consequent, schema, errors);
      walk(node.alternate, schema, errors);
      return;
    }
    case 'call': {
      for (const a of node.args) walk(a, schema, errors);
      return;
    }
    case 'aggregate':
    case 'prev':
      // reserved; compile already rejected in this pass
      return;
  }
}

function checkField(node: FieldNode, schema: Schema, errors: ValidationError[]): void {
  const key = node.path.join('.');
  if (!(key in schema.fields)) {
    errors.push({
      kind: 'validate', code: 'unknown-field',
      message: `unknown field '${key}'`, loc: node.loc,
    });
  }
}

function checkBinaryTypes(node: BinaryNode, schema: Schema, errors: ValidationError[]): void {
  const op = node.op;
  if (op !== '<' && op !== '<=' && op !== '>' && op !== '>=') return;
  const lt = staticType(node.left, schema);
  const rt = staticType(node.right, schema);
  if (lt === 'unknown' || rt === 'unknown') return;
  const compatible = (
    (lt === 'number' && rt === 'number') ||
    (lt === 'string' && rt === 'string') ||
    (lt === 'date' && rt === 'date')
  );
  if (!compatible) {
    errors.push({
      kind: 'validate', code: 'type-mismatch',
      message: `cannot compare ${lt} and ${rt}`, loc: node.loc,
    });
  }
}

function staticType(node: AstNode, schema: Schema): FieldType {
  switch (node.kind) {
    case 'literal':
      if (typeof node.value === 'number') return 'number';
      if (typeof node.value === 'string') return 'string';
      if (typeof node.value === 'boolean') return 'boolean';
      return 'unknown';
    case 'field': {
      const key = node.path.join('.');
      return schema.fields[key] ?? 'unknown';
    }
    case 'unary':
      return node.op === '!' ? 'boolean' : 'number';
    case 'binary':
      if (node.op === '&&' || node.op === '||' ||
          node.op === '<' || node.op === '<=' || node.op === '>' || node.op === '>=' ||
          node.op === '==' || node.op === '!=') return 'boolean';
      return 'number';
    case 'ternary':
      return 'unknown';
    case 'call':
    case 'aggregate':
    case 'prev':
      return 'unknown';
  }
}
