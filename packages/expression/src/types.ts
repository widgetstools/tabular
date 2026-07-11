// /expression — public type surface.
//
// All types are plain TypeScript: discriminated unions for the AST,
// plain interfaces for results/errors. Nothing here is runtime; this
// file compiles to no JS output. See tests/postmessage-transferability
// for the AST's structuredClone contract.

// ─── Position ─────────────────────────────────────────────────────────

export interface Loc {
  /** Inclusive char offset into original source. */
  start: number;
  /** Exclusive char offset into original source. */
  end: number;
}

// ─── AST ──────────────────────────────────────────────────────────────

export type BinaryOp =
  | '*' | '/' | '%' | '+' | '-'
  | '<' | '<=' | '>' | '>='
  | '==' | '!='
  | '&&' | '||';

export type UnaryOp = '!' | '-';

export interface LiteralNode {
  kind: 'literal';
  value: string | number | boolean | null;
  loc: Loc;
}

export interface FieldNode {
  kind: 'field';
  /** Dotted segments; e.g. ['trade', 'price'] for `[trade.price]`. */
  path: string[];
  loc: Loc;
}

export interface UnaryNode {
  kind: 'unary';
  op: UnaryOp;
  arg: AstNode;
  loc: Loc;
}

export interface BinaryNode {
  kind: 'binary';
  op: BinaryOp;
  left: AstNode;
  right: AstNode;
  loc: Loc;
}

export interface TernaryNode {
  kind: 'ternary';
  test: AstNode;
  consequent: AstNode;
  alternate: AstNode;
  loc: Loc;
}

export interface CallNode {
  kind: 'call';
  /** Function name as written; case-preserving. */
  name: string;
  args: AstNode[];
  loc: Loc;
}

/**
 * Reserved for Cycle 21d's post-compile AST transformation.
 * Cycle 21b's parser never emits AggregateNode; its compiler never accepts it.
 */
export interface AggregateNode {
  kind: 'aggregate';
  name: string;
  args: AstNode[];
  loc: Loc;
}

/** Reserved for Cycle 21d. Same status as AggregateNode. */
export interface PrevNode {
  kind: 'prev';
  arg: AstNode;
  loc: Loc;
}

export type AstNode =
  | LiteralNode
  | FieldNode
  | UnaryNode
  | BinaryNode
  | TernaryNode
  | CallNode
  | AggregateNode
  | PrevNode;

export type Ast = AstNode;

// ─── Parse ────────────────────────────────────────────────────────────

export interface ParseError {
  kind: 'parse';
  message: string;
  loc: Loc;
  hint?: string;
}

export type ParseResult =
  | { ok: true; ast: Ast }
  | { ok: false; error: ParseError };

// ─── Compile ──────────────────────────────────────────────────────────

export interface BuiltinDef {
  /** Exact arity, or [min, max] inclusive range. */
  arity: number | [min: number, max: number];
  impl: (args: unknown[]) => unknown;
}

export interface CompileOptions {
  builtins?: Record<string, BuiltinDef>;
}

export interface CompileError {
  kind: 'compile';
  code: 'unknown-fn' | 'arity' | 'not-yet-implemented';
  message: string;
  loc: Loc;
}

export interface Compiled {
  ast: Ast;
  run: (ctx: EvalContext) => unknown;
}

export type CompileResult =
  | { ok: true; compiled: Compiled }
  | { ok: false; error: CompileError };

// ─── Evaluate ─────────────────────────────────────────────────────────

export interface EvalContext {
  row: Record<string, unknown>;
}

export class EvalError extends Error {
  code: 'type-error' | 'null-field' | 'div-by-zero' | 'runtime';
  loc: Loc;

  constructor(
    code: 'type-error' | 'null-field' | 'div-by-zero' | 'runtime',
    message: string,
    loc: Loc,
  ) {
    super(message);
    this.name = 'EvalError';
    this.code = code;
    this.loc = loc;
  }
}

// ─── Validate ─────────────────────────────────────────────────────────

export type FieldType = 'number' | 'string' | 'boolean' | 'date' | 'unknown';

export interface Schema {
  fields: Record<string, FieldType>;
}

export interface ValidationError {
  kind: 'validate';
  code: 'parse' | 'compile' | 'unknown-field' | 'type-mismatch';
  message: string;
  loc: Loc;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}
