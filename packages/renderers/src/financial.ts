/**
 * Financial numeric painters — register via registerCellRenderer.
 * Colors come from theme tokens (up/down/accent).
 */
import type { CellRenderParams, CellRendererComp } from '@tabular/core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyParams = CellRenderParams<any>;

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** PnL: signed color + optional +/− prefix. */
export const pnlRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const n = asNumber(params.value);
      const t = params.theme;
      const text =
        n == null
          ? params.formatted
          : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(Math.round(n)).toLocaleString()}`;
      ctx.font = `600 ${t.fontSize}px ${t.fontMono}`;
      ctx.fillStyle = n == null ? t.textPrimary : n > 0 ? t.up : n < 0 ? t.down : t.textPrimary;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, params.x + params.width - t.paddingX, params.y + params.height / 2);
      return true;
    } catch {
      return true;
    }
  },
};

/** Price with direction hue from flash sample when available. */
export const priceDirectionRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const t = params.theme;
      const text = params.formatted || (params.value == null ? '' : String(params.value));
      ctx.font = `500 ${t.fontSize}px ${t.fontMono}`;
      ctx.fillStyle = t.textPrimary;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, params.x + params.width - t.paddingX, params.y + params.height / 2);
      return true;
    } catch {
      return true;
    }
  },
};

/** Bidirectional heat bar using ColumnStats min/max when provided via context. */
export const heatBarRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const n = asNumber(params.value);
      const t = params.theme;
      const stats = (params as AnyParams & { columnStats?: { min: number; max: number } }).columnStats;
      const min = stats?.min ?? -1;
      const max = stats?.max ?? 1;
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

/** Simple sparkline from TickHistory samples passed on params. */
export const sparklineRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const samples =
        (params as AnyParams & { tickSamples?: ArrayLike<number> }).tickSamples ?? [];
      const t = params.theme;
      const n = samples.length;
      if (n < 2) {
        ctx.font = `500 ${t.fontSize}px ${t.fontMono}`;
        ctx.fillStyle = t.textSecondary;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('—', params.x + params.width / 2, params.y + params.height / 2);
        return true;
      }
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < n; i++) {
        const v = samples[i]!;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const span = max - min || 1;
      const padX = 4;
      const padY = 4;
      const w = params.width - padX * 2;
      const h = params.height - padY * 2;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = params.x + padX + (i / (n - 1)) * w;
        const y = params.y + padY + (1 - (samples[i]! - min) / span) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      const last = samples[n - 1]!;
      const first = samples[0]!;
      ctx.strokeStyle = last >= first ? t.up : t.down;
      ctx.lineWidth = 1.25;
      ctx.stroke();
      return true;
    } catch {
      return true;
    }
  },
};

/** Signed delta with +/− prefix and up/down color. */
export const deltaRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const n = asNumber(params.value);
      const t = params.theme;
      const text =
        n == null
          ? params.formatted || ''
          : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString(undefined, {
              maximumFractionDigits: 4,
            })}`;
      ctx.font = `600 ${t.fontSize}px ${t.fontMono}`;
      ctx.fillStyle = n == null ? t.textPrimary : n > 0 ? t.up : n < 0 ? t.down : t.textPrimary;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, params.x + params.width - t.paddingX, params.y + params.height / 2);
      return true;
    } catch {
      return true;
    }
  },
};

/** Basis points: value * 10000 with "bp" suffix. */
export const bpsRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const n = asNumber(params.value);
      const t = params.theme;
      const text =
        n == null
          ? params.formatted || ''
          : `${(n * 10000).toLocaleString(undefined, { maximumFractionDigits: 1 })} bp`;
      ctx.font = `500 ${t.fontSize}px ${t.fontMono}`;
      ctx.fillStyle = n == null ? t.textSecondary : n > 0 ? t.up : n < 0 ? t.down : t.textPrimary;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, params.x + params.width - t.paddingX, params.y + params.height / 2);
      return true;
    } catch {
      return true;
    }
  },
};

/** Percent change display (value as fraction or already-percent). */
export const pctChangeRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const n = asNumber(params.value);
      const t = params.theme;
      let text = params.formatted || '';
      if (n != null) {
        // Treat |n| <= 1 as a fraction (0.012 → 1.20%), else already percent.
        const pct = Math.abs(n) <= 1 ? n * 100 : n;
        text = `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct).toFixed(2)}%`;
      }
      ctx.font = `600 ${t.fontSize}px ${t.fontMono}`;
      ctx.fillStyle = n == null ? t.textPrimary : n > 0 ? t.up : n < 0 ? t.down : t.textPrimary;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, params.x + params.width - t.paddingX, params.y + params.height / 2);
      return true;
    } catch {
      return true;
    }
  },
};

/** Compact K / M / B abbreviation. */
export const abbrevNumberRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const n = asNumber(params.value);
      const t = params.theme;
      let text = params.formatted || '';
      if (n != null) {
        const sign = n < 0 ? '−' : '';
        const a = Math.abs(n);
        if (a >= 1e9) text = `${sign}${(a / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`;
        else if (a >= 1e6) text = `${sign}${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
        else if (a >= 1e3) text = `${sign}${(a / 1e3).toFixed(a >= 1e4 ? 1 : 2)}K`;
        else text = `${sign}${a.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
      }
      ctx.font = `500 ${t.fontSize}px ${t.fontMono}`;
      ctx.fillStyle = t.textPrimary;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, params.x + params.width - t.paddingX, params.y + params.height / 2);
      return true;
    } catch {
      return true;
    }
  },
};

/** Bond price in 32nds (e.g. 99-16 for 99 + 16/32). */
export const fractional32ndsRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const n = asNumber(params.value);
      const t = params.theme;
      let text = params.formatted || '';
      if (n != null) {
        const whole = Math.trunc(n);
        const frac = Math.abs(n - whole);
        let thirtySeconds = Math.round(frac * 32);
        let handle = whole;
        if (thirtySeconds === 32) {
          thirtySeconds = 0;
          handle += n >= 0 ? 1 : -1;
        }
        text = `${handle}-${String(thirtySeconds).padStart(2, '0')}`;
      }
      ctx.font = `500 ${t.fontSize}px ${t.fontMono}`;
      ctx.fillStyle = t.textPrimary;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, params.x + params.width - t.paddingX, params.y + params.height / 2);
      return true;
    } catch {
      return true;
    }
  },
};

/** Register the Phase 6 starter catalog on a grid (or global registry). */
export function registerFinancialRenderers(
  register: (name: string, def: CellRendererComp) => void,
): void {
  register('pnl', pnlRenderer);
  register('priceDirection', priceDirectionRenderer);
  register('heatBar', heatBarRenderer);
  register('sparkline', sparklineRenderer);
  register('delta', deltaRenderer);
  register('bps', bpsRenderer);
  register('pctChange', pctChangeRenderer);
  register('abbrevNumber', abbrevNumberRenderer);
  register('fractional32nds', fractional32ndsRenderer);
}
