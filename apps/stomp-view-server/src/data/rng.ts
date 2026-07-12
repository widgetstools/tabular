/** Deterministic PRNG for reproducible “real-world-like” datasets. */
export function createRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

export function randBetween(
  rng: () => number,
  min: number,
  max: number,
  decimals: number | null = 2,
): number {
  const v = rng() * (max - min) + min;
  if (decimals === null) return v;
  return Number(v.toFixed(decimals));
}

export function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}
