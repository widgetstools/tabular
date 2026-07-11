/**
 * Sparkline variants — column, area, win/loss from tickSamples.
 */
import type { CellRenderParams, CellRendererComp } from '@tabular/core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyParams = CellRenderParams<any>;

type TickExt = { tickSamples?: ArrayLike<number> };

function readSamples(params: AnyParams): ArrayLike<number> {
  return (params as AnyParams & TickExt).tickSamples ?? [];
}

function emptyDash(ctx: CanvasRenderingContext2D, params: AnyParams): void {
  const t = params.theme;
  ctx.font = `500 ${t.fontSize}px ${t.fontMono}`;
  ctx.fillStyle = t.textSecondary;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('—', params.x + params.width / 2, params.y + params.height / 2);
}

function sampleBounds(samples: ArrayLike<number>, n: number): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = samples[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/** Column (bar) sparkline from tickSamples. */
export const sparklineColumnRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const samples = readSamples(params);
      const t = params.theme;
      const n = samples.length;
      if (n < 1) {
        emptyDash(ctx, params);
        return true;
      }
      const { min, max } = sampleBounds(samples, n);
      const span = max - min || 1;
      const padX = 3;
      const padY = 3;
      const w = params.width - padX * 2;
      const h = params.height - padY * 2;
      const gap = 1;
      const barW = Math.max(1, (w - gap * (n - 1)) / n);
      const last = samples[n - 1]!;
      const first = samples[0]!;
      const color = last >= first ? t.up : t.down;
      for (let i = 0; i < n; i++) {
        const ratio = (samples[i]! - min) / span;
        const bh = Math.max(1, ratio * h);
        const x = params.x + padX + i * (barW + gap);
        const y = params.y + padY + h - bh;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, barW, bh);
      }
      return true;
    } catch {
      return true;
    }
  },
};

/** Filled area under a line sparkline. */
export const sparklineAreaRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const samples = readSamples(params);
      const t = params.theme;
      const n = samples.length;
      if (n < 2) {
        emptyDash(ctx, params);
        return true;
      }
      const { min, max } = sampleBounds(samples, n);
      const span = max - min || 1;
      const padX = 4;
      const padY = 4;
      const w = params.width - padX * 2;
      const h = params.height - padY * 2;
      const last = samples[n - 1]!;
      const first = samples[0]!;
      const color = last >= first ? t.up : t.down;
      const baseY = params.y + padY + h;

      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = params.x + padX + (i / (n - 1)) * w;
        const y = params.y + padY + (1 - (samples[i]! - min) / span) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineTo(params.x + padX + w, baseY);
      ctx.lineTo(params.x + padX, baseY);
      ctx.closePath();
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = params.x + padX + (i / (n - 1)) * w;
        const y = params.y + padY + (1 - (samples[i]! - min) / span) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      ctx.stroke();
      return true;
    } catch {
      return true;
    }
  },
};

/** Win/loss bars — up for positive, down for negative samples. */
export const sparklineWinLossRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const samples = readSamples(params);
      const t = params.theme;
      const n = samples.length;
      if (n < 1) {
        emptyDash(ctx, params);
        return true;
      }
      const padX = 3;
      const padY = 3;
      const w = params.width - padX * 2;
      const h = params.height - padY * 2;
      const mid = params.y + padY + h / 2;
      const gap = 1;
      const barW = Math.max(1, (w - gap * (n - 1)) / n);
      let maxAbs = 0;
      for (let i = 0; i < n; i++) {
        const a = Math.abs(samples[i]!);
        if (a > maxAbs) maxAbs = a;
      }
      const scale = maxAbs || 1;
      const half = h / 2;
      for (let i = 0; i < n; i++) {
        const v = samples[i]!;
        const bh = Math.max(1, (Math.abs(v) / scale) * half);
        const x = params.x + padX + i * (barW + gap);
        ctx.fillStyle = v >= 0 ? t.up : t.down;
        if (v >= 0) ctx.fillRect(x, mid - bh, barW, bh);
        else ctx.fillRect(x, mid, barW, bh);
      }
      ctx.strokeStyle = t.headerBg;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(params.x + padX, mid);
      ctx.lineTo(params.x + padX + w, mid);
      ctx.stroke();
      return true;
    } catch {
      return true;
    }
  },
};

export function registerSparklineRenderers(
  register: (name: string, def: CellRendererComp) => void,
): void {
  register('sparklineColumn', sparklineColumnRenderer);
  register('sparklineArea', sparklineAreaRenderer);
  register('sparklineWinLoss', sparklineWinLossRenderer);
}
