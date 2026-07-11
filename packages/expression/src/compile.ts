import type {
  Ast, AstNode, BinaryNode, BinaryOp, CallNode,
  CompileError, CompileOptions, CompileResult, EvalContext, FieldNode, Loc,
  TernaryNode, UnaryNode,
} from './types';
import { EvalError } from './types';
import { AGGREGATE_NAMES, BUILTINS } from './builtins';

type Runner = (ctx: EvalContext) => unknown;

export function compile(ast: Ast, opts?: CompileOptions): CompileResult {
  const builtins = { ...BUILTINS, ...(opts?.builtins ?? {}) };
  try {
    const run = compileNode(ast, builtins);
    return { ok: true, compiled: { ast, run } };
  } catch (e) {
    if (isCompileError(e)) return { ok: false, error: e };
    throw e;
  }
}

class CompileErrorThrowable extends Error implements CompileError {
  kind = 'compile' as const;
  code: CompileError['code'];
  loc: Loc;
  constructor(code: CompileError['code'], message: string, loc: Loc) {
    super(message);
    this.code = code;
    this.loc = loc;
  }
}

function isCompileError(e: unknown): e is CompileError {
  return typeof e === 'object' && e !== null && (e as { kind?: unknown }).kind === 'compile';
}

function throwCompile(code: CompileError['code'], message: string, loc: Loc): never {
  throw new CompileErrorThrowable(code, message, loc);
}

function compileNode(node: AstNode, builtins: Record<string, import('./types').BuiltinDef>): Runner {
  switch (node.kind) {
    case 'literal': {
      const v = node.value;
      return () => v;
    }
    case 'field': return compileField(node);
    case 'unary': return compileUnary(node, builtins);
    case 'binary': return compileBinary(node, builtins);
    case 'ternary': return compileTernary(node, builtins);
    case 'call': return compileCall(node, builtins);
    case 'aggregate':
    case 'prev':
      throwCompile(
        'not-yet-implemented',
        `${node.kind} nodes ship in Cycle 21d`,
        node.loc,
      );
  }
}

function compileField(node: FieldNode): Runner {
  const path = node.path;
  return (ctx) => {
    let cur: unknown = ctx.row;
    for (const seg of path) {
      if (cur === null || cur === undefined) return null;
      if (typeof cur !== 'object') return null;
      cur = (cur as Record<string, unknown>)[seg];
    }
    return cur ?? null;
  };
}

function compileUnary(
  node: UnaryNode,
  builtins: Record<string, import('./types').BuiltinDef>,
): Runner {
  const inner = compileNode(node.arg, builtins);
  const loc = node.loc;
  if (node.op === '!') return (ctx) => !truthy(inner(ctx));
  // op === '-'
  return (ctx) => {
    const v = inner(ctx);
    return -asNum(v, loc);
  };
}

function compileBinary(
  node: BinaryNode,
  builtins: Record<string, import('./types').BuiltinDef>,
): Runner {
  const l = compileNode(node.left, builtins);
  const r = compileNode(node.right, builtins);
  const op = node.op;
  const loc = node.loc;

  switch (op) {
    case '+': return (ctx) => {
      const lv = l(ctx); const rv = r(ctx);
      if (typeof lv === 'string' && typeof rv === 'string') return lv + rv;
      const ln = asNum(lv, loc); const rn = asNum(rv, loc);
      return ln + rn;
    };
    case '-': return (ctx) => asNum(l(ctx), loc) - asNum(r(ctx), loc);
    case '*': return (ctx) => asNum(l(ctx), loc) * asNum(r(ctx), loc);
    case '/': return (ctx) => {
      const ln = asNum(l(ctx), loc); const rn = asNum(r(ctx), loc);
      if (rn === 0) throw new EvalError('div-by-zero', 'division by zero', loc);
      return ln / rn;
    };
    case '%': return (ctx) => {
      const ln = asNum(l(ctx), loc); const rn = asNum(r(ctx), loc);
      if (rn === 0) throw new EvalError('div-by-zero', 'modulo by zero', loc);
      return ln % rn;
    };
    case '<': return (ctx) => cmp(l(ctx), r(ctx), loc) < 0;
    case '<=': return (ctx) => cmp(l(ctx), r(ctx), loc) <= 0;
    case '>': return (ctx) => cmp(l(ctx), r(ctx), loc) > 0;
    case '>=': return (ctx) => cmp(l(ctx), r(ctx), loc) >= 0;
    case '==': return (ctx) => eq(l(ctx), r(ctx));
    case '!=': return (ctx) => !eq(l(ctx), r(ctx));
    case '&&': return (ctx) => {
      const lv = l(ctx);
      if (!truthy(lv)) return lv;
      return r(ctx);
    };
    case '||': return (ctx) => {
      const lv = l(ctx);
      if (truthy(lv)) return lv;
      return r(ctx);
    };
  }
  // exhaustiveness — never reached
  throwCompile('unknown-fn', `unknown binary op ${String(op as BinaryOp)}`, loc);
}

function compileTernary(
  node: TernaryNode,
  builtins: Record<string, import('./types').BuiltinDef>,
): Runner {
  const test = compileNode(node.test, builtins);
  const cons = compileNode(node.consequent, builtins);
  const alt = compileNode(node.alternate, builtins);
  return (ctx) => (truthy(test(ctx)) ? cons(ctx) : alt(ctx));
}

function compileCall(
  node: CallNode,
  builtins: Record<string, import('./types').BuiltinDef>,
): Runner {
  const name = node.name;
  const loc = node.loc;

  const def = builtins[name];
  if (!def) {
    if (AGGREGATE_NAMES.has(name) || name === 'PREV') {
      throwCompile('not-yet-implemented',
        `${name} ships in Cycle 21d`, loc);
    }
    throwCompile('unknown-fn', `unknown function '${name}'`, loc);
  }

  const argCount = node.args.length;
  if (!checkArity(def.arity, argCount)) {
    throwCompile('arity',
      `${name} expects ${describeArity(def.arity)}, got ${argCount}`, loc);
  }

  const compiledArgs = node.args.map((a) => compileNode(a, builtins));
  const impl = def.impl;
  return (ctx) => {
    const values = compiledArgs.map((c) => c(ctx));
    try {
      return impl(values);
    } catch (e) {
      if (e instanceof EvalError) throw e;
      throw new EvalError('runtime',
        `${name}: ${(e as Error).message ?? 'runtime error'}`, loc);
    }
  };
}

function checkArity(arity: number | [number, number], n: number): boolean {
  if (typeof arity === 'number') return arity === n;
  return n >= arity[0] && n <= arity[1];
}

function describeArity(arity: number | [number, number]): string {
  if (typeof arity === 'number') return `${arity} arg${arity === 1 ? '' : 's'}`;
  return `${arity[0]}..${arity[1]} args`;
}

// ─── Runtime helpers ──────────────────────────────────────────────────

function truthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'number' && Number.isNaN(v)) return false;
  return Boolean(v);
}

function asNum(v: unknown, loc: Loc): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) {
    throw new EvalError('null-field', 'expected number, got null', loc);
  }
  const n = Number(v);
  if (Number.isNaN(n)) throw new EvalError('type-error', `expected number, got ${describe(v)}`, loc);
  return n;
}

function cmp(l: unknown, r: unknown, loc: Loc): number {
  if (typeof l === 'number' && typeof r === 'number') return l - r;
  if (typeof l === 'string' && typeof r === 'string') return l < r ? -1 : l > r ? 1 : 0;
  throw new EvalError('type-error',
    `cannot compare ${describe(l)} and ${describe(r)}`, loc);
}

function eq(l: unknown, r: unknown): boolean {
  // strict — no coercion, but null == undefined
  if (l === null || l === undefined) return r === null || r === undefined;
  return l === r;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  return typeof v;
}
