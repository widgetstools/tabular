/**
 * Incremental per-column stats maintained on the RowDelta feed.
 * Typed-array friendly; transferable when shipped from a worker later.
 */
export interface ColumnStatSnapshot {
  count: number;
  min: number;
  max: number;
  sum: number;
}

export class ColumnStats {
  private readonly stats = new Map<string, ColumnStatSnapshot>();
  private readonly watched: ReadonlySet<string>;

  constructor(watchedColIds: Iterable<string>) {
    this.watched = new Set(watchedColIds);
    for (const id of this.watched) {
      this.stats.set(id, { count: 0, min: Infinity, max: -Infinity, sum: 0 });
    }
  }

  get(colId: string): ColumnStatSnapshot | undefined {
    return this.stats.get(colId);
  }

  /** Full recompute from a value iterator (initial load / filter change). */
  recompute(colId: string, values: Iterable<unknown>): void {
    if (!this.watched.has(colId)) return;
    let count = 0;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const v of values) {
      const n = asFinite(v);
      if (n == null) continue;
      count++;
      if (n < min) min = n;
      if (n > max) max = n;
      sum += n;
    }
    this.stats.set(colId, {
      count,
      min: count ? min : 0,
      max: count ? max : 0,
      sum,
    });
  }

  /**
   * Best-effort delta update. When old/new are both numeric, adjust sum/count;
   * min/max may require a full recompute (flagged via `needsRecompute`).
   */
  applyChange(
    colId: string,
    oldValue: unknown,
    newValue: unknown,
  ): { needsRecompute: boolean } {
    if (!this.watched.has(colId)) return { needsRecompute: false };
    const s = this.stats.get(colId) ?? { count: 0, min: Infinity, max: -Infinity, sum: 0 };
    const o = asFinite(oldValue);
    const n = asFinite(newValue);
    let needsRecompute = false;

    if (o != null && n == null) {
      s.count = Math.max(0, s.count - 1);
      s.sum -= o;
      needsRecompute = o <= s.min || o >= s.max;
    } else if (o == null && n != null) {
      s.count += 1;
      s.sum += n;
      if (n < s.min) s.min = n;
      if (n > s.max) s.max = n;
    } else if (o != null && n != null) {
      s.sum += n - o;
      if (n < s.min) s.min = n;
      else if (o <= s.min) needsRecompute = true;
      if (n > s.max) s.max = n;
      else if (o >= s.max) needsRecompute = true;
    }

    this.stats.set(colId, s);
    return { needsRecompute };
  }
}

function asFinite(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
