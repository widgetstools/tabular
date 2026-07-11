/**
 * Fixed-size ring buffer of recent numeric ticks per cell (rowId\0colId).
 * Opt-in per column; feeds sparklines / price-direction painters.
 */
export class TickHistory {
  private readonly rings = new Map<string, Float64Array>();
  private readonly heads = new Map<string, number>();
  private readonly sizes = new Map<string, number>();
  private readonly capacity: number;
  private readonly watched: ReadonlySet<string>;

  constructor(watchedColIds: Iterable<string>, capacity = 32) {
    this.watched = new Set(watchedColIds);
    this.capacity = Math.max(4, capacity);
  }

  push(rowId: string, colId: string, value: unknown): void {
    if (!this.watched.has(colId)) return;
    const n =
      typeof value === 'number' && Number.isFinite(value)
        ? value
        : typeof value === 'string'
          ? Number(value)
          : NaN;
    if (!Number.isFinite(n)) return;
    const key = `${rowId}\u0000${colId}`;
    let ring = this.rings.get(key);
    if (!ring) {
      ring = new Float64Array(this.capacity);
      this.rings.set(key, ring);
      this.heads.set(key, 0);
      this.sizes.set(key, 0);
    }
    const head = this.heads.get(key)!;
    ring[head] = n;
    this.heads.set(key, (head + 1) % this.capacity);
    this.sizes.set(key, Math.min(this.capacity, (this.sizes.get(key) ?? 0) + 1));
  }

  /** Chronological samples (oldest → newest). */
  samples(rowId: string, colId: string): Float64Array {
    const key = `${rowId}\u0000${colId}`;
    const ring = this.rings.get(key);
    const size = this.sizes.get(key) ?? 0;
    if (!ring || !size) return new Float64Array(0);
    const out = new Float64Array(size);
    const head = this.heads.get(key)!;
    const start = (head - size + this.capacity) % this.capacity;
    for (let i = 0; i < size; i++) {
      out[i] = ring[(start + i) % this.capacity]!;
    }
    return out;
  }

  clear(): void {
    this.rings.clear();
    this.heads.clear();
    this.sizes.clear();
  }
}
