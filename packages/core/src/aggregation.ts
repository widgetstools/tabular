/**
 * Aggregation functions for group rollups (plan §4.7).
 * Weighted-average weights by a sibling field (typically notional).
 */
export type AggFuncName =
  | 'sum'
  | 'min'
  | 'max'
  | 'avg'
  | 'count'
  | 'first'
  | 'last'
  | 'weightedAverage';

export type AggFunc = (values: unknown[], weights?: unknown[]) => unknown;

export const AGG_FUNCS: Record<AggFuncName, AggFunc> = {
  sum: (values) => {
    let s = 0;
    let any = false;
    for (const v of values) {
      if (typeof v === 'number' && !Number.isNaN(v)) {
        s += v;
        any = true;
      }
    }
    return any ? s : null;
  },
  min: (values) => {
    let m = Number.POSITIVE_INFINITY;
    let any = false;
    for (const v of values) {
      if (typeof v === 'number' && !Number.isNaN(v)) {
        m = Math.min(m, v);
        any = true;
      }
    }
    return any ? m : null;
  },
  max: (values) => {
    let m = Number.NEGATIVE_INFINITY;
    let any = false;
    for (const v of values) {
      if (typeof v === 'number' && !Number.isNaN(v)) {
        m = Math.max(m, v);
        any = true;
      }
    }
    return any ? m : null;
  },
  avg: (values) => {
    let s = 0;
    let n = 0;
    for (const v of values) {
      if (typeof v === 'number' && !Number.isNaN(v)) {
        s += v;
        n++;
      }
    }
    return n ? s / n : null;
  },
  count: (values) => values.length,
  first: (values) => (values.length ? values[0] : null),
  last: (values) => (values.length ? values[values.length - 1] : null),
  weightedAverage: (values, weights) => {
    if (!weights?.length) return AGG_FUNCS.avg(values);
    let num = 0;
    let den = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      const w = weights[i];
      if (typeof v === 'number' && typeof w === 'number' && !Number.isNaN(v) && !Number.isNaN(w)) {
        num += v * w;
        den += w;
      }
    }
    return den ? num / den : null;
  },
};

export function resolveAggFunc(
  name: AggFuncName | AggFunc | undefined,
  custom?: Record<string, AggFunc>,
): AggFunc | null {
  if (!name) return null;
  if (typeof name === 'function') return name;
  if (custom?.[name]) return custom[name];
  return AGG_FUNCS[name] ?? null;
}
