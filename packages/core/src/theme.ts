/**
 * Design tokens — Cursor Dark / Cursor Light (from the installed Cursor IDE
 * color themes), three densities, resolved into one flat object consumed
 * directly by paint().
 *
 * Source: Cursor.app/.../theme-cursor/themes/cursor-{dark,light}-color-theme.json
 */
import type { Density, ThemeName, GridlineMode } from './types';

export interface ThemeTokens {
  base: string;
  raised: string;
  /** Column header row — distinct from zebra (`raised`). */
  headerBg: string;
  overlay: string;
  sunken: string;
  hairline: string;
  /** Cell grid borders — stronger than incidental chrome hairlines. */
  gridline: string;
  structural: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  accent: string;
  accentDim: string;
  up: string;
  down: string;
}

/** Cursor Dark Anysphere — editor.background #181818, chrome #141414 */
export const DARK_TOKENS: ThemeTokens = {
  base: '#181818',
  raised: '#1B1B1B',
  headerBg: '#141414',
  overlay: '#141414',
  sunken: '#141414',
  hairline: '#2A2A2A',
  gridline: '#454545',
  structural: '#353535',
  textPrimary: '#F0F0F0',
  textSecondary: '#A8A8A8',
  textTertiary: '#6B6B6B',
  accent: '#81A1C1',
  accentDim: '#4A6278',
  up: '#3FA266',
  down: '#E34671',
};

/** Cursor Light — editor.background #FCFCFC, chrome #F3F3F3 */
export const LIGHT_TOKENS: ThemeTokens = {
  base: '#FCFCFC',
  raised: '#F7F7F7',
  headerBg: '#F3F3F3',
  overlay: '#F3F3F3',
  sunken: '#F3F3F3',
  hairline: '#E5E5E5',
  gridline: '#C2C2C2',
  structural: '#D4D4D4',
  textPrimary: '#141414',
  textSecondary: '#6E6E6E',
  textTertiary: '#8E8E8E',
  accent: '#3C7CAB',
  accentDim: '#6F9BA6',
  up: '#1F8A65',
  down: '#CF2D56',
};

interface DensitySpec {
  rowHeight: number;
  fontSize: number;
  paddingX: number;
  headerHeight: number;
  /** Floating filter row height (plan §1.5.5). */
  floatingFilterHeight: number;
  /** Gridlines per density; default is both axes. Override via GridOptions.gridlines. */
  gridlines: GridlineMode;
}

export const DENSITIES: Record<Density, DensitySpec> = {
  comfortable: {
    rowHeight: 32,
    fontSize: 13,
    paddingX: 8,
    headerHeight: 40,
    floatingFilterHeight: 32,
    gridlines: 'both',
  },
  compact: {
    rowHeight: 26,
    fontSize: 12,
    paddingX: 6,
    headerHeight: 34,
    floatingFilterHeight: 26,
    gridlines: 'both',
  },
  dense: {
    rowHeight: 20,
    fontSize: 11,
    paddingX: 4,
    headerHeight: 28,
    floatingFilterHeight: 20,
    gridlines: 'both',
  },
};

const FONT_MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace";
const FONT_SANS = "'IBM Plex Sans', 'Inter', system-ui, -apple-system, sans-serif";

export interface ResolvedTheme extends ThemeTokens, DensitySpec {
  name: ThemeName;
  density: Density;
  fontMono: string;
  fontSans: string;
  headerFontSize: number;
}

export function resolveTheme(
  name: ThemeName,
  density: Density,
  overrides?: Partial<ThemeTokens> & { gridlines?: GridlineMode },
): ResolvedTheme {
  const tokens = name === 'dark' ? DARK_TOKENS : LIGHT_TOKENS;
  const d = DENSITIES[density];
  const { gridlines, ...tokenOverrides } = overrides ?? {};
  return {
    ...tokens,
    ...tokenOverrides,
    ...d,
    gridlines: gridlines ?? d.gridlines,
    name,
    density,
    fontMono: FONT_MONO,
    fontSans: FONT_SANS,
    headerFontSize: Math.max(11, d.fontSize - 1),
  };
}

/** Hex color + alpha → rgba() string, cached. */
const alphaCache = new Map<string, string>();
export function withAlpha(hex: string, alpha: number): string {
  const key = `${hex}:${alpha}`;
  let out = alphaCache.get(key);
  if (!out) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    out = `rgba(${r},${g},${b},${alpha})`;
    alphaCache.set(key, out);
  }
  return out;
}
