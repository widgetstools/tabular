/**
 * Tick flash (§7.2 — the signature). A flash is a background pulse: hold at
 * peak alpha ~90ms, then decay to zero by `duration`. Decay is a pure
 * function of (now − lastTickAt) — no per-cell timers, no animation queue.
 * Re-ticks coalesce (reset the clock, never stack). The direction hue
 * PERSISTS after the alpha decays: direction is state, flash is event.
 *
 * Rule flash modes (`fade`, `pulse`, `glow`) share the same decay clock with
 * per-entry curve + duration overrides.
 */
export type FlashCurve = 'tick' | 'fade' | 'pulse' | 'glow';

export interface FlashSample {
  alpha: number;
  dir: 1 | -1 | 0;
  curve?: FlashCurve;
}

interface Entry {
  t: number;
  dir: 1 | -1 | 0;
  curve: FlashCurve;
  duration: number;
}

const HOLD_MS = 90;
const PEAK_ALPHA = 0.22;

export class FlashManager {
  private entries = new Map<string, Entry>();
  duration = 500;
  reducedMotion = false;

  constructor() {
    if (typeof matchMedia === 'function') {
      const mq = matchMedia('(prefers-reduced-motion: reduce)');
      this.reducedMotion = mq.matches;
      mq.addEventListener?.('change', (e) => (this.reducedMotion = e.matches));
    }
  }

  flash(key: string, dir: 1 | -1 | 0): void {
    this.entries.set(key, { t: performance.now(), dir, curve: 'tick', duration: this.duration });
  }

  /** Per-rule flash with custom curve and duration. */
  ruleFlash(
    key: string,
    opts: { mode: 'fade' | 'pulse' | 'glow'; durationMs: number; dir?: 1 | -1 | 0 },
  ): void {
    this.entries.set(key, {
      t: performance.now(),
      dir: opts.dir ?? 0,
      curve: opts.mode,
      duration: Math.max(50, opts.durationMs),
    });
  }

  /** null → cell has never ticked. alpha 0 with a dir → hue persistence only. */
  sample(key: string, now: number): FlashSample | null {
    const e = this.entries.get(key);
    if (!e) return null;
    const dt = now - e.t;
    const duration = e.curve === 'tick' ? this.duration : e.duration;
    let alpha = 0;
    if (this.reducedMotion) {
      alpha = dt <= HOLD_MS ? PEAK_ALPHA : 0;
    } else {
      alpha = sampleAlpha(e.curve, dt, duration);
    }
    return { alpha, dir: e.dir, curve: e.curve };
  }

  hasActive(now: number): boolean {
    for (const e of this.entries.values()) {
      const duration = e.curve === 'tick' ? this.duration : e.duration;
      if (now - e.t < duration) return true;
    }
    return false;
  }

  clear(): void {
    this.entries.clear();
  }
}

function sampleAlpha(curve: FlashCurve, dt: number, duration: number): number {
  switch (curve) {
    case 'tick':
      if (dt <= HOLD_MS) return PEAK_ALPHA;
      if (dt < duration) {
        const p = (dt - HOLD_MS) / (duration - HOLD_MS);
        return PEAK_ALPHA * (1 - p) * (1 - p * 0.4);
      }
      return 0;
    case 'fade':
      if (dt >= duration) return 0;
      return PEAK_ALPHA * (1 - dt / duration);
    case 'pulse': {
      if (dt >= duration) return 0;
      const phase = (dt / duration) * Math.PI * 2;
      return PEAK_ALPHA * (0.55 + 0.45 * Math.sin(phase));
    }
    case 'glow': {
      if (dt >= duration) return 0;
      const p = dt / duration;
      return PEAK_ALPHA * 1.35 * (1 - p) * (1 - p);
    }
  }
}
