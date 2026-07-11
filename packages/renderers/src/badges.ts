/**
 * Badge / status painters — pills, dots, traffic lights, side chips.
 * Colors from theme tokens only.
 */
import type { CellRenderParams, CellRendererComp } from '@tabular/core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyParams = CellRenderParams<any>;

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Rounded pill with text from value. */
export const statusPillRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const t = params.theme;
      const text = params.formatted || (params.value == null ? '' : String(params.value));
      if (!text) return true;
      ctx.font = `600 ${t.fontSize - 1}px ${t.fontSans}`;
      const tw = ctx.measureText(text).width;
      const padX = 6;
      const h = Math.min(params.height - 6, t.fontSize + 8);
      const w = Math.min(params.width - 8, tw + padX * 2);
      const x = params.x + (params.width - w) / 2;
      const y = params.y + (params.height - h) / 2;
      ctx.save();
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = t.accent;
      roundRect(ctx, x, y, w, h, h / 2);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = t.accent;
      roundRect(ctx, x, y, w, h, h / 2);
      ctx.strokeStyle = t.accent;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = t.textPrimary;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x + w / 2, y + h / 2);
      return true;
    } catch {
      return true;
    }
  },
};

/** Credit-style rating pill (AAA / BBB / …). */
export const ratingBadgeRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const t = params.theme;
      const text = (params.formatted || (params.value == null ? '' : String(params.value))).trim();
      if (!text) return true;
      const upper = text.toUpperCase();
      // Investment-grade-ish → accent; speculative → down; else secondary
      let fill = t.textSecondary;
      if (/^A|^AAA|^AA|^A[+-]?$/.test(upper) || upper.startsWith('A')) fill = t.up;
      else if (upper.startsWith('BBB') || upper.startsWith('BB') || upper.startsWith('B'))
        fill = upper.startsWith('BBB') ? t.accent : t.down;
      else if (upper.startsWith('C') || upper.startsWith('D')) fill = t.down;

      ctx.font = `700 ${t.fontSize - 1}px ${t.fontMono}`;
      const tw = ctx.measureText(upper).width;
      const padX = 6;
      const h = Math.min(params.height - 6, t.fontSize + 8);
      const w = Math.min(params.width - 8, tw + padX * 2);
      const x = params.x + (params.width - w) / 2;
      const y = params.y + (params.height - h) / 2;
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = fill;
      roundRect(ctx, x, y, w, h, 3);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = fill;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(upper, x + w / 2, y + h / 2);
      return true;
    } catch {
      return true;
    }
  },
};

/** Colored status dot + label text. */
export const statusDotRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const t = params.theme;
      const text = params.formatted || (params.value == null ? '' : String(params.value));
      const color = trafficColor(params.value, t) ?? t.accent;
      const cx = params.x + t.paddingX + 4;
      const cy = params.y + params.height / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.font = `500 ${t.fontSize}px ${t.fontSans}`;
      ctx.fillStyle = t.textPrimary;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, cx + 10, cy);
      return true;
    } catch {
      return true;
    }
  },
};

function trafficColor(
  value: unknown,
  t: { up: string; down: string; accent: string },
): string | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return t.down;
    if (value === 1) return t.accent;
    return t.up;
  }
  const s = String(value).trim().toLowerCase();
  if (s === 'fail' || s === 'down' || s === '0' || s === 'red' || s === 'sell') return t.down;
  if (s === 'warn' || s === 'flat' || s === '1' || s === 'amber' || s === 'yellow') return t.accent;
  if (s === 'ok' || s === 'up' || s === '2' || s === 'green' || s === 'pass' || s === 'buy')
    return t.up;
  // Rating-ish heuristics for showcase
  if (s.startsWith('aaa') || s.startsWith('aa') || (s.startsWith('a') && !s.startsWith('a-')))
    return t.up;
  if (s.startsWith('bbb')) return t.accent;
  if (s.startsWith('bb') || s.startsWith('b') || s.startsWith('c')) return t.down;
  return null;
}

/** Red / amber / green traffic light from value mapping. */
export const trafficLightRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const t = params.theme;
      const active = trafficColor(params.value, t) ?? t.textSecondary;
      const cx = params.x + params.width / 2;
      const cy = params.y + params.height / 2;
      const gap = 11;
      const r = 4;
      const colors = [t.down, t.accent, t.up];
      for (let i = 0; i < 3; i++) {
        const x = cx + (i - 1) * gap;
        ctx.beginPath();
        ctx.arc(x, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = colors[i] === active ? colors[i]! : t.headerBg;
        ctx.fill();
        if (colors[i] === active) {
          ctx.strokeStyle = colors[i]!;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
      return true;
    } catch {
      return true;
    }
  },
};

/** BUY / SELL chip colored with up / down. */
export const sideChipRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const t = params.theme;
      let side = '';
      const v = params.value;
      if (typeof v === 'number') side = v >= 0 ? 'BUY' : 'SELL';
      else {
        const s = String(v ?? params.formatted ?? '')
          .trim()
          .toUpperCase();
        if (s === 'B' || s === 'BUY' || s === 'LONG' || s === 'UP') side = 'BUY';
        else if (s === 'S' || s === 'SELL' || s === 'SHORT' || s === 'DOWN') side = 'SELL';
        else if (s) side = s.slice(0, 4);
      }
      if (!side) return true;
      const isBuy = side === 'BUY';
      const fill = isBuy ? t.up : side === 'SELL' ? t.down : t.accent;
      ctx.font = `700 ${t.fontSize - 1}px ${t.fontSans}`;
      const tw = ctx.measureText(side).width;
      const padX = 7;
      const h = Math.min(params.height - 6, t.fontSize + 8);
      const w = Math.min(params.width - 8, tw + padX * 2);
      const x = params.x + (params.width - w) / 2;
      const y = params.y + (params.height - h) / 2;
      ctx.save();
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = fill;
      roundRect(ctx, x, y, w, h, 3);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = fill;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(side, x + w / 2, y + h / 2);
      return true;
    } catch {
      return true;
    }
  },
};

export function registerBadgeRenderers(
  register: (name: string, def: CellRendererComp) => void,
): void {
  register('statusPill', statusPillRenderer);
  register('ratingBadge', ratingBadgeRenderer);
  register('statusDot', statusDotRenderer);
  register('trafficLight', trafficLightRenderer);
  register('sideChip', sideChipRenderer);
}
