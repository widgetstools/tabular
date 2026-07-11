/**
 * Bar / gauge painters — progress, bidirectional, gauge, volume, rangeBar.
 * Colors from theme tokens only.
 */
import type { CellRenderParams, CellRendererComp } from '@tabular/core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyParams = CellRenderParams<any>;

type RangeExt = {
  columnStats?: { min: number; max: number };
  range?: { min: number; max: number };
};

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Normalize 0..1 or 0..100 into a clamped 0..1 ratio. */
function toUnit(n: number): number {
  if (n > 1) return Math.min(1, Math.max(0, n / 100));
  return Math.min(1, Math.max(0, n));
}

/** Horizontal progress fill (0..1 or 0..100) with accent. */
export const progressRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const n = asNumber(params.value);
      const t = params.theme;
      const pad = 4;
      const barH = Math.max(4, Math.min(10, params.height - 8));
      const barY = params.y + (params.height - barH) / 2;
      const barW = params.width - pad * 2;
      ctx.fillStyle = t.headerBg;
      ctx.fillRect(params.x + pad, barY, barW, barH);
      if (n != null) {
        const fill = toUnit(n) * barW;
        ctx.fillStyle = t.accent;
        ctx.fillRect(params.x + pad, barY, fill, barH);
      }
      return true;
    } catch {
      return true;
    }
  },
};

/** Centered bidirectional bar (same visual idea as heatBar, separate name). */
export const bidirectionalRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const n = asNumber(params.value);
      const t = params.theme;
      const ext = params as AnyParams & RangeExt;
      const min = ext.columnStats?.min ?? ext.range?.min ?? -1;
      const max = ext.columnStats?.max ?? ext.range?.max ?? 1;
      const span = max - min || 1;
      const ratio = n == null ? 0.5 : Math.min(1, Math.max(0, (n - min) / span));
      const pad = 4;
      const barH = Math.max(4, Math.min(10, params.height - 8));
      const barY = params.y + (params.height - barH) / 2;
      const barW = params.width - pad * 2;
      ctx.fillStyle = t.headerBg;
      ctx.fillRect(params.x + pad, barY, barW, barH);
      const mid = params.x + pad + barW / 2;
      const fillW = (ratio - 0.5) * barW;
      ctx.fillStyle = fillW >= 0 ? t.up : t.down;
      if (fillW >= 0) ctx.fillRect(mid, barY, fillW, barH);
      else ctx.fillRect(mid + fillW, barY, -fillW, barH);
      return true;
    } catch {
      return true;
    }
  },
};

/** Semicircle arc gauge for 0..1 (or 0..100). */
export const gaugeRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const n = asNumber(params.value);
      const t = params.theme;
      const ratio = n == null ? 0 : toUnit(n);
      const cx = params.x + params.width / 2;
      const cy = params.y + params.height - 3;
      const r = Math.max(4, Math.min(params.width / 2 - 4, params.height - 6));
      const start = Math.PI;
      const end = 2 * Math.PI;
      ctx.beginPath();
      ctx.arc(cx, cy, r, start, end);
      ctx.strokeStyle = t.headerBg;
      ctx.lineWidth = Math.max(2, Math.min(4, r / 4));
      ctx.lineCap = 'round';
      ctx.stroke();
      if (ratio > 0) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, start, start + Math.PI * ratio);
        ctx.strokeStyle = t.accent;
        ctx.stroke();
      }
      return true;
    } catch {
      return true;
    }
  },
};

/** Vertical volume bar growing from the bottom (0..1 or 0..100). */
export const volumeRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const n = asNumber(params.value);
      const t = params.theme;
      const padX = Math.max(2, params.width * 0.3);
      const padY = 3;
      const barW = Math.max(3, params.width - padX * 2);
      const maxH = params.height - padY * 2;
      const fillH = n == null ? 0 : toUnit(n) * maxH;
      ctx.fillStyle = t.headerBg;
      ctx.fillRect(params.x + padX, params.y + padY, barW, maxH);
      if (fillH > 0) {
        ctx.fillStyle = t.accent;
        ctx.fillRect(params.x + padX, params.y + padY + maxH - fillH, barW, fillH);
      }
      return true;
    } catch {
      return true;
    }
  },
};

/** Value position within min/max from columnStats or params.range. */
export const rangeBarRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const n = asNumber(params.value);
      const t = params.theme;
      const ext = params as AnyParams & RangeExt;
      const min = ext.columnStats?.min ?? ext.range?.min ?? 0;
      const max = ext.columnStats?.max ?? ext.range?.max ?? 1;
      const span = max - min || 1;
      const ratio = n == null ? 0 : Math.min(1, Math.max(0, (n - min) / span));
      const pad = 4;
      const barH = Math.max(4, Math.min(10, params.height - 8));
      const barY = params.y + (params.height - barH) / 2;
      const barW = params.width - pad * 2;
      ctx.fillStyle = t.headerBg;
      ctx.fillRect(params.x + pad, barY, barW, barH);
      ctx.fillStyle = t.accent;
      ctx.fillRect(params.x + pad, barY, ratio * barW, barH);
      // Marker tick at value
      const mx = params.x + pad + ratio * barW;
      ctx.fillStyle = t.textPrimary;
      ctx.fillRect(mx - 1, barY - 1, 2, barH + 2);
      return true;
    } catch {
      return true;
    }
  },
};

export function registerBarRenderers(
  register: (name: string, def: CellRendererComp) => void,
): void {
  register('progress', progressRenderer);
  register('bidirectional', bidirectionalRenderer);
  register('gauge', gaugeRenderer);
  register('volume', volumeRenderer);
  register('rangeBar', rangeBarRenderer);
}
