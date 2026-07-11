/**
 * Magnitude suffix parsing for number editors / nudges: `1.5k`, `2M`, `1B`.
 */
const SUFFIX: Record<string, number> = {
  k: 1e3,
  K: 1e3,
  m: 1e6,
  M: 1e6,
  b: 1e9,
  B: 1e9,
  t: 1e12,
  T: 1e12,
};

/** Parse a numeric string with optional k/M/B/T suffix. Returns NaN on failure. */
export function parseMagnitude(input: string): number {
  const s = input.trim().replace(/,/g, '');
  if (!s) return NaN;
  const m = s.match(/^([+-]?\d*\.?\d+)\s*([kKmMbBtT])?$/);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return NaN;
  const suf = m[2];
  return suf ? base * (SUFFIX[suf] ?? 1) : base;
}

/** Nudge a numeric value by ±step (supports magnitude strings for step). */
export function nudgeValue(value: unknown, delta: number | string): number | unknown {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return value;
  const d = typeof delta === 'number' ? delta : parseMagnitude(String(delta));
  if (!Number.isFinite(d)) return value;
  return n + d;
}
