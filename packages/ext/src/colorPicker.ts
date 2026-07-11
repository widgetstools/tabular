/**
 * Floating colour picker — SV field, hue, alpha, rgb text, muted swatches.
 * Matches the instrument-console aesthetic; opens at the pointer (clamped).
 */
import type { ResolvedTheme } from '@tabular/core';
import { applyThemeVars, injectExtStyles } from './styles';

export interface ColorPickerOptions {
  color: string;
  /** Preferred open point — mouse pointer. */
  clientX?: number;
  clientY?: number;
  /** Fallback anchor when pointer coords are missing. */
  anchor?: HTMLElement;
  theme?: ResolvedTheme;
  /** Live drag updates. */
  onInput?: (css: string) => void;
  /** Commit on pointer-up / swatch / Enter / outside close (keeps current colour). */
  onChange?: (css: string) => void;
  /**
   * Escape closes and restores the opening colour. Defaults to calling
   * onInput + onChange with that original so live previews revert.
   */
  onCancel?: (originalCss: string) => void;
}

interface Hsva {
  h: number;
  s: number;
  v: number;
  a: number;
}

const SWATCHES = [
  '#7A8FA0',
  '#8A9A78',
  '#B07A6A',
  '#C4A574',
  '#8B8AB0',
  '#A08090',
  '#5A9A9A',
  '#888888',
];

const STYLE_ID = 'tx-colorpicker-styles';
let openPanel: HTMLElement | null = null;
let openCleanup: (() => void) | null = null;

export function closeColorPicker(): void {
  openCleanup?.();
  openCleanup = null;
  openPanel = null;
}

export function openColorPicker(opts: ColorPickerOptions): () => void {
  injectExtStyles();
  injectColorPickerStyles();
  closeColorPicker();

  let hsva = parseToHsva(opts.color);
  const originalHsva: Hsva = { ...hsva };
  const originalCss = hsvaToCss(originalHsva);
  let dismissed = false;
  const panel = document.createElement('div');
  panel.className = 'tx-cp';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Colour picker');
  if (opts.theme) applyThemeVars(panel, opts.theme);
  else {
    const root = opts.anchor?.closest<HTMLElement>('.tx-root');
    if (root) {
      for (const prop of [
        '--tx-base',
        '--tx-overlay',
        '--tx-hairline',
        '--tx-fg',
        '--tx-muted',
        '--tx-accent',
        '--tx-font-mono',
      ]) {
        const v = getComputedStyle(root).getPropertyValue(prop).trim();
        if (v) panel.style.setProperty(prop, v);
      }
    } else {
      // Dark instrument defaults matching the reference screenshot
      panel.style.setProperty('--tx-overlay', '#1a1d23');
      panel.style.setProperty('--tx-base', '#14161b');
      panel.style.setProperty('--tx-hairline', '#2a2e36');
      panel.style.setProperty('--tx-fg', '#e8eaed');
      panel.style.setProperty('--tx-muted', '#9aa0a8');
      panel.style.setProperty('--tx-font-mono', "'JetBrains Mono', ui-monospace, Menlo, monospace");
    }
  }

  panel.innerHTML =
    `<div class="tx-cp-sv" tabindex="0" aria-label="Saturation and brightness">` +
      `<div class="tx-cp-sv-white"></div><div class="tx-cp-sv-black"></div>` +
      `<div class="tx-cp-sv-cursor"></div>` +
    `</div>` +
    `<div class="tx-cp-hue" tabindex="0" aria-label="Hue"><div class="tx-cp-hue-thumb"></div></div>` +
    `<div class="tx-cp-alpha" tabindex="0" aria-label="Opacity">` +
      `<div class="tx-cp-alpha-check"></div><div class="tx-cp-alpha-grad"></div>` +
      `<div class="tx-cp-alpha-thumb"></div>` +
    `</div>` +
    `<input class="tx-cp-input" type="text" spellcheck="false" aria-label="Colour value" />` +
    `<div class="tx-cp-swatches"></div>`;

  const sv = panel.querySelector<HTMLElement>('.tx-cp-sv')!;
  const svCursor = panel.querySelector<HTMLElement>('.tx-cp-sv-cursor')!;
  const hueEl = panel.querySelector<HTMLElement>('.tx-cp-hue')!;
  const hueThumb = panel.querySelector<HTMLElement>('.tx-cp-hue-thumb')!;
  const alphaEl = panel.querySelector<HTMLElement>('.tx-cp-alpha')!;
  const alphaGrad = panel.querySelector<HTMLElement>('.tx-cp-alpha-grad')!;
  const alphaThumb = panel.querySelector<HTMLElement>('.tx-cp-alpha-thumb')!;
  const input = panel.querySelector<HTMLInputElement>('.tx-cp-input')!;
  const swatchHost = panel.querySelector<HTMLElement>('.tx-cp-swatches')!;

  for (const hex of SWATCHES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tx-cp-swatch';
    b.style.background = hex;
    b.title = hex;
    b.addEventListener('click', () => {
      hsva = { ...hexToHsva(hex), a: hsva.a };
      paint(true);
      commit();
    });
    swatchHost.appendChild(b);
  }

  const cssColor = (): string => hsvaToCss(hsva);
  const emitInput = () => {
    if (!dismissed) opts.onInput?.(cssColor());
  };
  const commit = () => {
    if (!dismissed) opts.onChange?.(cssColor());
  };

  const paint = (syncInput = true) => {
    const hue = `hsl(${hsva.h}, 100%, 50%)`;
    sv.style.backgroundColor = hue;
    svCursor.style.left = `${hsva.s * 100}%`;
    svCursor.style.top = `${(1 - hsva.v) * 100}%`;
    hueThumb.style.left = `${(hsva.h / 360) * 100}%`;
    alphaThumb.style.left = `${hsva.a * 100}%`;
    const { r, g, b } = hsvaToRgb(hsva);
    alphaGrad.style.background =
      `linear-gradient(to right, rgba(${r},${g},${b},0), rgba(${r},${g},${b},1))`;
    if (syncInput) input.value = cssColor();
  };

  const bindDrag = (
    el: HTMLElement,
    read: (e: PointerEvent, rect: DOMRect) => void,
  ) => {
    const onMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      read(e, rect);
      paint();
      emitInput();
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      commit();
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture?.(e.pointerId);
      const rect = el.getBoundingClientRect();
      read(e, rect);
      paint();
      emitInput();
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  };

  bindDrag(sv, (e, rect) => {
    const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((e.clientY - rect.top) / rect.height, 0, 1);
    hsva = { ...hsva, s: x, v: 1 - y };
  });
  bindDrag(hueEl, (e, rect) => {
    const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    hsva = { ...hsva, h: x * 360 };
  });
  bindDrag(alphaEl, (e, rect) => {
    const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    hsva = { ...hsva, a: x };
  });

  input.addEventListener('change', () => {
    const next = parseToHsva(input.value);
    if (next) {
      hsva = next;
      paint(true);
      commit();
    } else {
      paint(true);
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
      input.dispatchEvent(new Event('change'));
    }
    e.stopPropagation();
  });

  paint(true);
  document.body.appendChild(panel);
  positionPanel(panel, opts);
  openPanel = panel;

  const onDoc = (e: PointerEvent) => {
    if (!panel.contains(e.target as Node) && e.target !== opts.anchor) {
      close();
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || dismissed) return;
    e.preventDefault();
    e.stopPropagation();
    // Revert to the colour from when the picker opened, then dismiss.
    dismissed = true;
    hsva = { ...originalHsva };
    if (opts.onCancel) opts.onCancel(originalCss);
    else {
      opts.onInput?.(originalCss);
      opts.onChange?.(originalCss);
    }
    close();
  };
  // Delay so the opening click doesn't immediately close.
  const t = window.setTimeout(() => {
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);

  const close = () => {
    window.clearTimeout(t);
    document.removeEventListener('pointerdown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
    panel.remove();
    if (openPanel === panel) {
      openPanel = null;
      openCleanup = null;
    }
  };
  openCleanup = close;
  return close;
}

function positionPanel(panel: HTMLElement, opts: ColorPickerOptions): void {
  const pad = 8;
  const w = panel.offsetWidth || 220;
  const h = panel.offsetHeight || 280;
  let x = opts.clientX ?? 0;
  let y = opts.clientY ?? 0;
  if (opts.clientX == null || opts.clientY == null) {
    if (opts.anchor) {
      const r = opts.anchor.getBoundingClientRect();
      x = r.left;
      y = r.bottom + 4;
    } else {
      x = pad;
      y = pad;
    }
  } else {
    // Prefer just below-right of the pointer so it doesn't cover the click target.
    x = opts.clientX + 4;
    y = opts.clientY + 4;
  }
  // Clamp inside the viewport (and prefer staying inside .tx-root if present).
  const root = opts.anchor?.closest<HTMLElement>('.tx-root');
  const bounds = root?.getBoundingClientRect() ?? {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  };
  if (x + w > bounds.right - pad) x = bounds.right - pad - w;
  if (y + h > bounds.bottom - pad) y = bounds.bottom - pad - h;
  if (x < bounds.left + pad) x = bounds.left + pad;
  if (y < bounds.top + pad) y = bounds.top + pad;
  panel.style.left = `${Math.round(x)}px`;
  panel.style.top = `${Math.round(y)}px`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function hsvaToRgb(c: Hsva): { r: number; g: number; b: number } {
  const h = ((c.h % 360) + 360) % 360;
  const s = c.s;
  const v = c.v;
  const i = Math.floor(h / 60);
  const f = h / 60 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0;
  let g = 0;
  let b = 0;
  switch (i % 6) {
    case 0:
      r = v;
      g = t;
      b = p;
      break;
    case 1:
      r = q;
      g = v;
      b = p;
      break;
    case 2:
      r = p;
      g = v;
      b = t;
      break;
    case 3:
      r = p;
      g = q;
      b = v;
      break;
    case 4:
      r = t;
      g = p;
      b = v;
      break;
    default:
      r = v;
      g = p;
      b = q;
  }
  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}

function hsvaToCss(c: Hsva): string {
  const { r, g, b } = hsvaToRgb(c);
  if (c.a >= 0.995) return `rgb(${r}, ${g}, ${b})`;
  const a = Math.round(c.a * 1000) / 1000;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function hexToHsva(hex: string): Hsva {
  const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return { h: 0, s: 0, v: 0.5, a: 1 };
  return rgbToHsva(parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16), 1);
}

function rgbToHsva(r: number, g: number, b: number, a: number): Hsva {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max, a };
}

function parseToHsva(raw: string): Hsva {
  const s = raw.trim();
  if (!s) return { h: 0, s: 0, v: 0.5, a: 1 };
  if (s.startsWith('#')) return hexToHsva(s.length === 4
    ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`
    : s);
  const rgba = s.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i,
  );
  if (rgba) {
    return rgbToHsva(
      Number(rgba[1]),
      Number(rgba[2]),
      Number(rgba[3]),
      rgba[4] != null ? Number(rgba[4]) : 1,
    );
  }
  const hsl = s.match(
    /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%(?:\s*,\s*([\d.]+))?\s*\)$/i,
  );
  if (hsl) {
    const h = Number(hsl[1]);
    const sat = Number(hsl[2]) / 100;
    const l = Number(hsl[3]) / 100;
    const a = hsl[4] != null ? Number(hsl[4]) : 1;
    // HSL → HSV
    const v = l + sat * Math.min(l, 1 - l);
    const sv = v === 0 ? 0 : 2 * (1 - l / v);
    return { h, s: sv, v, a };
  }
  // Named / unknown — keep mid gray
  return { h: 0, s: 0, v: 0.5, a: 1 };
}

function injectColorPickerStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = COLOR_PICKER_CSS;
  document.head.appendChild(style);
}

const COLOR_PICKER_CSS = `
.tx-cp {
  position: fixed;
  z-index: 10050;
  width: 220px;
  padding: 10px;
  box-sizing: border-box;
  background: var(--tx-overlay, #1a1d23);
  border: 1px solid var(--tx-hairline, #2a2e36);
  border-radius: 6px;
  box-shadow:
    0 1px 0 color-mix(in srgb, #fff 4%, transparent),
    0 16px 40px rgba(0, 0, 0, 0.55);
  color: var(--tx-fg, #e8eaed);
  user-select: none;
}
.tx-cp-sv {
  position: relative;
  width: 100%;
  height: 140px;
  border-radius: 4px;
  overflow: hidden;
  cursor: crosshair;
  touch-action: none;
}
.tx-cp-sv-white {
  position: absolute; inset: 0;
  background: linear-gradient(to right, #fff, transparent);
  pointer-events: none;
}
.tx-cp-sv-black {
  position: absolute; inset: 0;
  background: linear-gradient(to top, #000, transparent);
  pointer-events: none;
}
.tx-cp-sv-cursor {
  position: absolute;
  width: 14px; height: 14px;
  margin: -7px 0 0 -7px;
  border: 2px solid #fff;
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(0,0,0,0.25);
  pointer-events: none;
}
.tx-cp-hue,
.tx-cp-alpha {
  position: relative;
  height: 12px;
  margin-top: 10px;
  border-radius: 3px;
  cursor: pointer;
  touch-action: none;
}
.tx-cp-hue {
  background: linear-gradient(
    to right,
    #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%
  );
}
.tx-cp-alpha {
  overflow: hidden;
}
.tx-cp-alpha-check {
  position: absolute; inset: 0;
  background-color: #fff;
  background-image:
    linear-gradient(45deg, #c2c2c2 25%, transparent 25%),
    linear-gradient(-45deg, #c2c2c2 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #c2c2c2 75%),
    linear-gradient(-45deg, transparent 75%, #c2c2c2 75%);
  background-size: 8px 8px;
  background-position: 0 0, 0 4px, 4px -4px, -4px 0;
  border-radius: 3px;
  pointer-events: none;
}
.tx-cp-alpha-grad {
  position: absolute; inset: 0;
  border-radius: 3px;
  pointer-events: none;
}
.tx-cp-hue-thumb,
.tx-cp-alpha-thumb {
  position: absolute;
  top: 50%;
  width: 8px; height: 16px;
  margin: -8px 0 0 -4px;
  border: 2px solid #fff;
  border-radius: 2px;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.4);
  background: transparent;
  pointer-events: none;
  box-sizing: border-box;
}
.tx-cp-input {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin-top: 10px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--tx-hairline, #2a2e36);
  border-radius: 4px;
  background: var(--tx-base, #14161b);
  color: var(--tx-fg, #e8eaed);
  font: 12px / 1 var(--tx-font-mono, ui-monospace, Menlo, monospace);
  outline: none;
}
.tx-cp-input:focus {
  border-color: color-mix(in srgb, var(--tx-fg, #fff) 28%, var(--tx-hairline, #2a2e36));
}
.tx-cp-swatches {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  margin-top: 10px;
}
.tx-cp-swatch {
  appearance: none;
  height: 22px;
  border: 1px solid color-mix(in srgb, #fff 12%, transparent);
  border-radius: 3px;
  cursor: pointer;
  padding: 0;
}
.tx-cp-swatch:hover {
  outline: 1px solid color-mix(in srgb, #fff 45%, transparent);
  outline-offset: 1px;
}
.tx-cp-swatch:focus-visible {
  outline: 1px solid var(--tx-accent, #81A1C1);
  outline-offset: 1px;
}
@media (prefers-reduced-motion: reduce) {
  .tx-cp { transition: none; }
}
`;
