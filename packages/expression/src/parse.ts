import type {
  Ast, AstNode, BinaryOp, CallNode, FieldNode, LiteralNode,
  Loc, ParseError, ParseResult, TernaryNode, UnaryNode, UnaryOp, BinaryNode,
} from './types';

// ─── Tokens ───────────────────────────────────────────────────────────

type TokenKind =
  | 'number' | 'string' | 'bool' | 'null' | 'ident' | 'field'
  | 'lparen' | 'rparen' | 'comma' | 'question' | 'colon'
  | 'op'
  | 'eof';

interface Token {
  kind: TokenKind;
  /** Verbatim source slice; for 'field' this is the raw `[…]` including brackets. */
  text: string;
  /** For 'op', the exact operator (`&&`, `<=`, …); for 'field', the interior joined by '.'. */
  value?: string;
  start: number;
  end: number;
}

const OPS_MULTI = ['<=', '>=', '==', '!=', '&&', '||'] as const;
const OPS_SINGLE = ['*', '/', '%', '+', '-', '<', '>', '!'] as const;

function tokenize(src: string): { ok: true; tokens: Token[] } | { ok: false; error: ParseError } {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;

    // whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    const start = i;

    // field access [path.with.dots.0]
    if (c === '[') {
      let j = i + 1;
      while (j < n && src[j] !== ']') j++;
      if (j >= n) {
        return { ok: false, error: {
          kind: 'parse',
          message: 'Unterminated field reference: expected `]`',
          loc: { start, end: n },
        } };
      }
      const interior = src.slice(i + 1, j);
      if (interior.length === 0) {
        return { ok: false, error: {
          kind: 'parse',
          message: 'Empty field reference `[]`',
          loc: { start, end: j + 1 },
        } };
      }
      // basic validation — path segments are non-empty
      const segs = interior.split('.');
      if (segs.some((s) => s.length === 0)) {
        return { ok: false, error: {
          kind: 'parse',
          message: 'Empty path segment in field reference',
          loc: { start, end: j + 1 },
        } };
      }
      tokens.push({
        kind: 'field', text: src.slice(start, j + 1), value: interior,
        start, end: j + 1,
      });
      i = j + 1;
      continue;
    }

    // string literal
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\' && j + 1 < n) {
          const esc = src[j + 1]!;
          switch (esc) {
            case 'n': out += '\n'; break;
            case 't': out += '\t'; break;
            case 'r': out += '\r'; break;
            case '\\': out += '\\'; break;
            case '"': out += '"'; break;
            case "'": out += "'"; break;
            default: out += esc;
          }
          j += 2;
          continue;
        }
        out += src[j];
        j++;
      }
      if (j >= n) {
        return { ok: false, error: {
          kind: 'parse',
          message: `Unterminated string literal (missing ${quote})`,
          loc: { start, end: n },
        } };
      }
      tokens.push({
        kind: 'string', text: src.slice(start, j + 1), value: out,
        start, end: j + 1,
      });
      i = j + 1;
      continue;
    }

    // number literal — integer or decimal, optional scientific
    if (c >= '0' && c <= '9') {
      let j = i;
      while (j < n && src[j]! >= '0' && src[j]! <= '9') j++;
      if (j < n && src[j] === '.') {
        j++;
        while (j < n && src[j]! >= '0' && src[j]! <= '9') j++;
      }
      if (j < n && (src[j] === 'e' || src[j] === 'E')) {
        j++;
        if (j < n && (src[j] === '+' || src[j] === '-')) j++;
        const expStart = j;
        while (j < n && src[j]! >= '0' && src[j]! <= '9') j++;
        if (j === expStart) {
          return { ok: false, error: {
            kind: 'parse',
            message: 'Invalid number: missing exponent digits',
            loc: { start, end: j },
          } };
        }
      }
      tokens.push({
        kind: 'number', text: src.slice(start, j), value: src.slice(start, j),
        start, end: j,
      });
      i = j;
      continue;
    }

    // identifier: keyword (true/false/null) or function name
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
      let j = i;
      while (
        j < n && (
          (src[j]! >= 'A' && src[j]! <= 'Z') ||
          (src[j]! >= 'a' && src[j]! <= 'z') ||
          (src[j]! >= '0' && src[j]! <= '9') ||
          src[j] === '_'
        )
      ) j++;
      const word = src.slice(start, j);
      if (word === 'true' || word === 'false') {
        tokens.push({ kind: 'bool', text: word, value: word, start, end: j });
      } else if (word === 'null') {
        tokens.push({ kind: 'null', text: word, value: word, start, end: j });
      } else {
        tokens.push({ kind: 'ident', text: word, value: word, start, end: j });
      }
      i = j;
      continue;
    }

    // structural single chars
    if (c === '(') { tokens.push({ kind: 'lparen', text: '(', start, end: i + 1 }); i++; continue; }
    if (c === ')') { tokens.push({ kind: 'rparen', text: ')', start, end: i + 1 }); i++; continue; }
    if (c === ',') { tokens.push({ kind: 'comma', text: ',', start, end: i + 1 }); i++; continue; }
    if (c === '?') { tokens.push({ kind: 'question', text: '?', start, end: i + 1 }); i++; continue; }
    if (c === ':') { tokens.push({ kind: 'colon', text: ':', start, end: i + 1 }); i++; continue; }

    // multi-char operators first
    let matched = false;
    for (const op of OPS_MULTI) {
      if (src.slice(i, i + op.length) === op) {
        tokens.push({ kind: 'op', text: op, value: op, start, end: i + op.length });
        i += op.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // single-char operators
    for (const op of OPS_SINGLE) {
      if (c === op) {
        tokens.push({ kind: 'op', text: op, value: op, start, end: i + 1 });
        i++;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    return { ok: false, error: {
      kind: 'parse',
      message: `Unexpected character '${c}'`,
      loc: { start, end: i + 1 },
    } };
  }

  tokens.push({ kind: 'eof', text: '', start: n, end: n });
  return { ok: true, tokens };
}

// ─── Pratt parser ────────────────────────────────────────────────────

interface Cursor {
  toks: Token[];
  i: number;
}

function peek(c: Cursor): Token { return c.toks[c.i]!; }
function eat(c: Cursor): Token { return c.toks[c.i++]!; }

/** Binary operator precedence — higher binds tighter. */
const BIN_PREC: Record<BinaryOp, number> = {
  '||': 1, '&&': 2,
  '==': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
};

const BINARY_OPS: ReadonlySet<string> = new Set(Object.keys(BIN_PREC));

function parseExpr(c: Cursor, minPrec: number): AstNode | ParseError {
  let left = parseUnary(c);
  if (isParseError(left)) return left;

  while (true) {
    const tok = peek(c);

    // ternary
    if (tok.kind === 'question' && minPrec <= 0) {
      eat(c);
      const consequent = parseExpr(c, 0);
      if (isParseError(consequent)) return consequent;
      const colon = peek(c);
      if (colon.kind !== 'colon') {
        return { kind: 'parse', message: "Expected ':' in ternary", loc: locFrom(colon) };
      }
      eat(c);
      const alternate = parseExpr(c, 0);
      if (isParseError(alternate)) return alternate;
      const node: TernaryNode = {
        kind: 'ternary', test: left, consequent, alternate,
        loc: { start: (left as AstNode).loc.start, end: alternate.loc.end },
      };
      left = node;
      continue;
    }

    if (tok.kind !== 'op') break;
    const op = tok.value as BinaryOp;
    if (!BINARY_OPS.has(op)) break;
    const prec = BIN_PREC[op];
    if (prec < minPrec) break;

    eat(c);
    const right = parseExpr(c, prec + 1);
    if (isParseError(right)) return right;

    const node: BinaryNode = {
      kind: 'binary', op, left, right,
      loc: { start: (left as AstNode).loc.start, end: right.loc.end },
    };
    left = node;
  }

  return left;
}

function parseUnary(c: Cursor): AstNode | ParseError {
  const tok = peek(c);
  if (tok.kind === 'op' && (tok.value === '!' || tok.value === '-')) {
    const op = tok.value as UnaryOp;
    const start = tok.start;
    eat(c);
    const arg = parseUnary(c);
    if (isParseError(arg)) return arg;
    // Use the last consumed token's end so that `!(expr)` spans to the `)`.
    const end = c.toks[c.i - 1]!.end;
    const node: UnaryNode = {
      kind: 'unary', op, arg,
      loc: { start, end },
    };
    return node;
  }
  return parsePrimary(c);
}

function parsePrimary(c: Cursor): AstNode | ParseError {
  const tok = peek(c);

  if (tok.kind === 'number') {
    eat(c);
    const num = Number(tok.value);
    const node: LiteralNode = {
      kind: 'literal', value: num,
      loc: { start: tok.start, end: tok.end },
    };
    return node;
  }

  if (tok.kind === 'string') {
    eat(c);
    const node: LiteralNode = {
      kind: 'literal', value: tok.value!,
      loc: { start: tok.start, end: tok.end },
    };
    return node;
  }

  if (tok.kind === 'bool') {
    eat(c);
    const node: LiteralNode = {
      kind: 'literal', value: tok.value === 'true',
      loc: { start: tok.start, end: tok.end },
    };
    return node;
  }

  if (tok.kind === 'null') {
    eat(c);
    const node: LiteralNode = {
      kind: 'literal', value: null,
      loc: { start: tok.start, end: tok.end },
    };
    return node;
  }

  if (tok.kind === 'field') {
    eat(c);
    const path = tok.value!.split('.');
    const node: FieldNode = {
      kind: 'field', path,
      loc: { start: tok.start, end: tok.end },
    };
    return node;
  }

  if (tok.kind === 'lparen') {
    eat(c);
    const inner = parseExpr(c, 0);
    if (isParseError(inner)) return inner;
    const rp = peek(c);
    if (rp.kind !== 'rparen') {
      return { kind: 'parse', message: "Expected ')'", loc: locFrom(rp) };
    }
    eat(c);
    return inner;
  }

  if (tok.kind === 'ident') {
    const name = tok.value!;
    const start = tok.start;
    eat(c);
    const lp = peek(c);
    if (lp.kind !== 'lparen') {
      return { kind: 'parse',
        message: `Bare identifier '${name}' — did you mean '[${name}]' for field access, or '${name}(...)' for a function call?`,
        loc: { start: tok.start, end: tok.end } };
    }
    eat(c);
    const args: AstNode[] = [];
    if (peek(c).kind !== 'rparen') {
      while (true) {
        const arg = parseExpr(c, 0);
        if (isParseError(arg)) return arg;
        args.push(arg);
        const next = peek(c);
        if (next.kind === 'comma') { eat(c); continue; }
        if (next.kind === 'rparen') break;
        return { kind: 'parse', message: "Expected ',' or ')' in argument list", loc: locFrom(next) };
      }
    }
    const rp = eat(c); // rparen
    const node: CallNode = {
      kind: 'call', name, args,
      loc: { start, end: rp.end },
    };
    return node;
  }

  return { kind: 'parse', message: `Unexpected token '${tok.text}'`, loc: locFrom(tok) };
}

function locFrom(tok: Token): Loc { return { start: tok.start, end: tok.end }; }

function isParseError(x: AstNode | ParseError): x is ParseError {
  return (x as ParseError).kind === 'parse';
}

// ─── Public entry ─────────────────────────────────────────────────────

export function parse(source: string): ParseResult {
  const lex = tokenize(source);
  if (!lex.ok) return { ok: false, error: lex.error };

  const c: Cursor = { toks: lex.tokens, i: 0 };
  const ast = parseExpr(c, 0);
  if (isParseError(ast)) return { ok: false, error: ast };

  const last = peek(c);
  if (last.kind !== 'eof') {
    return { ok: false, error: {
      kind: 'parse',
      message: `Unexpected trailing token '${last.text}'`,
      loc: locFrom(last),
    } };
  }
  return { ok: true, ast: ast as Ast };
}
