/**
 * Icon set — Lucide (https://lucide.dev, ISC license) path data embedded as
 * plain SVG path strings so the core keeps zero runtime dependencies and
 * stays framework-agnostic: canvas painting strokes them via Path2D, DOM
 * overlays (buttons, menus, chips) render them as inline <svg>.
 *
 * Hosts can swap in another set (e.g. Phosphor) at runtime with
 * `registerIcons({ 'chevron-down': ['<path d>', …] })` — the same names are
 * used everywhere in the grid.
 */
export type IconName =
  | 'chevron-right'
  | 'chevron-left'
  | 'chevron-down'
  | 'arrow-up'
  | 'arrow-down'
  | 'arrow-left'
  | 'arrow-right'
  | 'x'
  | 'check'
  | 'filter'
  | 'group'
  | 'pivot'
  | 'kebab'
  | 'pin'
  | 'columns'
  | 'alert-triangle'
  | 'trending-down'
  | 'trending-up'
  | 'star'
  | 'heart'
  | 'info'
  | 'plus'
  | 'minus'
  | 'circle'
  | 'triangle'
  | 'zap'
  | 'bell'
  | 'flag'
  | 'tag'
  | 'link'
  | 'lock'
  | 'unlock'
  | 'eye'
  | 'search'
  | 'settings'
  | 'user'
  | 'users'
  | 'calendar'
  | 'clock'
  | 'dollar-sign'
  | 'percent'
  | 'hash'
  | 'activity';

/** 24×24 viewBox, stroke-based (Lucide: strokeWidth 2, round caps/joins). */
const PATHS: Record<string, string[]> = {
  'chevron-right': ['m9 18 6-6-6-6'],
  'chevron-left': ['m15 18-6-6 6-6'],
  'chevron-down': ['m6 9 6 6 6-6'],
  'arrow-up': ['m5 12 7-7 7 7', 'M12 19V5'],
  'arrow-down': ['M12 5v14', 'm19 12-7 7-7-7'],
  'arrow-left': ['m12 19-7-7 7-7', 'M19 12H5'],
  'arrow-right': ['m12 5 7 7-7 7', 'M5 12h14'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  check: ['M20 6 9 17l-5-5'],
  filter: ['M22 3H2l8 9.46V19l4 2v-8.54L22 3z'],
  group: ['M21 12h-8', 'M21 6H8', 'M21 18h-8', 'M3 6v4c0 1.1.9 2 2 2h3', 'M3 10v6c0 1.1.9 2 2 2h3'],
  pivot: [
    'M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18',
  ],
  kebab: ['M12 4.4v1.2', 'M12 11.4v1.2', 'M12 18.4v1.2'],
  pin: [
    'M12 17v5',
    'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z',
  ],
  columns: ['M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M9 3v18', 'M15 3v18'],
  'alert-triangle': [
    'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3',
    'M12 9v4',
    'M12 17h.01',
  ],
  'trending-down': ['m22 17-8.5 8.5-5-5L2 17', 'M16 17h6v6'],
  'trending-up': ['m22 7-8.5 8.5-5-5L2 17', 'M16 7h6v6'],
  star: [
    'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
  ],
  heart: [
    'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z',
  ],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 16v-4', 'M12 8h.01'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  circle: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z'],
  triangle: ['m12 3 10 18H2L12 3z'],
  zap: ['M13 2 3 14h9l-1 8 10-12h-9l1-8z'],
  bell: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
  flag: ['M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z', 'M4 22v-7'],
  tag: [
    'M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2z',
    'M7 7h.01',
  ],
  link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
  lock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  unlock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  search: ['M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z', 'M21 21l-4.3-4.3'],
  settings: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 14H4.5a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 6 8a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 11 4.6h.09A1.65 1.65 0 0 0 12 3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 19 4.6l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 20.4 11h.1a2 2 0 1 1 0 4h-.1a1.65 1.65 0 0 0-1.6 1z',
  ],
  user: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  users: [
    'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2',
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    'M23 21v-2a4 4 0 0 0-3-3.87',
    'M16 3.13a4 4 0 0 1 0 7.75',
  ],
  calendar: [
    'M8 2v4',
    'M16 2v4',
    'M3 10h18',
    'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  ],
  clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 6v6l4 2'],
  'dollar-sign': ['M12 1v22', 'M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6'],
  percent: ['M19 5 5 19', 'M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'],
  hash: ['M4 9h16', 'M4 15h16', 'M10 3 8 21', 'M16 3l-2 18'],
  activity: ['M22 12h-4l-3 9L9 3l-3 9H2'],
};

const path2dCache = new Map<string, Path2D>();

function getPath2D(d: string): Path2D {
  let p = path2dCache.get(d);
  if (!p) {
    p = new Path2D(d);
    path2dCache.set(d, p);
  }
  return p;
}

/** Replace built-in icons with custom 24×24 stroke path data. */
export function registerIcons(overrides: Partial<Record<string, string[]>>): void {
  for (const [name, paths] of Object.entries(overrides)) {
    if (paths) PATHS[name] = paths;
  }
}

/** Known icon names (for pickers). */
export function listIconNames(): string[] {
  return Object.keys(PATHS).sort();
}

/** Stroke an icon on canvas with its top-left at (x, y), scaled to `size`. */
export function drawIcon(
  ctx: CanvasRenderingContext2D,
  name: string,
  x: number,
  y: number,
  size: number,
  color: string,
  strokeWidth = 2,
): void {
  const paths = PATHS[name];
  if (!paths) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const d of paths) ctx.stroke(getPath2D(d));
  ctx.restore();
}

/**
 * Inline SVG markup for DOM overlays. Uses `currentColor` by default so the
 * icon follows the host element's `color` (hover states keep working).
 */
export function iconSvg(
  name: string,
  size: number,
  color = 'currentColor',
  strokeWidth = 2,
): string {
  const segs = PATHS[name];
  if (!segs) return '';
  const paths = segs.map((d) => `<path d="${d}"/>`).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ` +
    `style="display:block">${paths}</svg>`
  );
}
