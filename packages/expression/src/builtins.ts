import type { BuiltinDef } from './types';

/**
 * 14 built-in functions shipped in Cycle 21b.
 * All are pure row-local — no aggregates, no stateful helpers.
 */
export const BUILTINS: Record<string, BuiltinDef> = {
  // ─── Control ─────────────────────────────────────────────────────
  IF: {
    arity: 3,
    impl: (args) => (isTruthy(args[0]) ? args[1] : args[2]),
  },
  COALESCE: {
    arity: [1, 32],
    impl: (args) => {
      for (const v of args) if (v !== null && v !== undefined) return v;
      return null;
    },
  },

  // ─── Logical ─────────────────────────────────────────────────────
  NOT: { arity: 1, impl: (args) => !isTruthy(args[0]) },
  AND: {
    arity: [1, 32],
    impl: (args) => args.every(isTruthy),
  },
  OR: {
    arity: [1, 32],
    impl: (args) => args.some(isTruthy),
  },

  // ─── Numeric ─────────────────────────────────────────────────────
  ABS: { arity: 1, impl: (args) => Math.abs(asNumber(args[0])) },
  ROUND: {
    arity: [1, 2],
    impl: (args) => {
      const n = asNumber(args[0]);
      const digits = args.length === 2 ? asNumber(args[1]) : 0;
      const p = Math.pow(10, digits);
      return Math.round(n * p) / p;
    },
  },
  MIN: {
    arity: [1, 32],
    impl: (args) => Math.min(...args.map(asNumber)),
  },
  MAX: {
    arity: [1, 32],
    impl: (args) => Math.max(...args.map(asNumber)),
  },
  FLOOR: { arity: 1, impl: (args) => Math.floor(asNumber(args[0])) },
  CEIL: { arity: 1, impl: (args) => Math.ceil(asNumber(args[0])) },

  // ─── String ──────────────────────────────────────────────────────
  LOWER: { arity: 1, impl: (args) => asString(args[0]).toLowerCase() },
  UPPER: { arity: 1, impl: (args) => asString(args[0]).toUpperCase() },
  LEN: { arity: 1, impl: (args) => asString(args[0]).length },
  TRIM: { arity: 1, impl: (args) => (args[0] == null ? '' : String(args[0]).trim()) },
  TITLE: {
    arity: 1,
    impl: (args) =>
      args[0] == null
        ? ''
        : String(args[0])
            .toLowerCase()
            .replace(/(^|[\s\-_])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase()),
  },
  CAMEL: {
    arity: 1,
    impl: (args) => {
      if (args[0] == null) return '';
      const parts = String(args[0]).trim().split(/[\s\-_]+/).filter(Boolean);
      return parts
        .map((p, i) => (i === 0 ? p.toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()))
        .join('');
    },
  },
  CAP: {
    arity: 1,
    impl: (args) => {
      if (args[0] == null) return '';
      const s = String(args[0]);
      return s === '' ? '' : s.charAt(0).toUpperCase() + s.slice(1);
    },
  },
  FIXED: {
    arity: 2,
    impl: (args) => {
      if (args[0] == null || args[1] == null) return '';
      const n = typeof args[0] === 'number' ? args[0] : Number(args[0]);
      const dp = typeof args[1] === 'number' ? args[1] : Number(args[1]);
      if (!Number.isFinite(n) || !Number.isFinite(dp)) return '';
      return n.toFixed(Math.max(0, Math.min(20, Math.trunc(dp))));
    },
  },
  HASH: {
    arity: 2,
    impl: (args) => {
      const row = Math.trunc(asNumber(args[0]));
      const col = Math.trunc(asNumber(args[1]));
      let x = (row * 2654435761 + col * 40503 + 0x9e3779b9) >>> 0;
      x ^= x >>> 16;
      x = (x * 2246822519) >>> 0;
      x ^= x >>> 13;
      return x / 0xffffffff;
    },
  },
  MOD: {
    arity: 2,
    impl: (args) => {
      const a = Math.trunc(asNumber(args[0]));
      const b = Math.trunc(asNumber(args[1]));
      if (b === 0) return null;
      return ((a % b) + b) % b;
    },
  },
};

// ─── Coercion helpers (throw plain Error; compile.ts wraps into EvalError) ──

function isTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'number' && Number.isNaN(v)) return false;
  return Boolean(v);
}

function asNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) throw new TypeError('expected number, got null');
  const n = Number(v);
  if (Number.isNaN(n)) throw new TypeError(`expected number, got ${typeof v}`);
  return n;
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) throw new TypeError('expected string, got null');
  return String(v);
}

/**
 * The compile-time reserved list. Cycle 21b's compiler emits
 * `CompileError { code: 'not-yet-implemented' }` for any of these
 * plus `PREV`.
 */
export const AGGREGATE_NAMES: ReadonlySet<string> = new Set([
  'SUM', 'AVG', 'COUNT', 'MIN', 'MAX',
  'RUNNING_SUM', 'RUNNING_AVG', 'MOVING_AVG',
  'FIRST', 'LAST',
  'DELTA_FROM_PREV', 'DELTA_FROM_FIRST', 'DELTA_FROM_LAST',
]);
