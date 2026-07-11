/**
 * OffscreenCanvas text measurement for worker autosize (W6).
 */
export class MeasureCache {
  private map = new Map<string, number>();

  constructor(private capacity = 1024) {}

  get(key: string): number | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: number): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

let cachedSupport: boolean | null = null;

export function workerCanMeasure(): boolean {
  if (cachedSupport !== null) return cachedSupport;
  try {
    if (typeof OffscreenCanvas === 'undefined') return (cachedSupport = false);
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('2d');
    return (cachedSupport = !!(ctx && typeof ctx.measureText === 'function'));
  } catch {
    return (cachedSupport = false);
  }
}

export function offscreenMeasurer(font: string): ((text: string) => number) | null {
  if (!workerCanMeasure()) return null;
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.font = font;
  return (text: string) => ctx.measureText(text).width;
}

export function measureKey(font: string, text: string): string {
  return `${font}\0${text}`;
}
