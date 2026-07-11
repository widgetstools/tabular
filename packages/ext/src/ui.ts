/**
 * Shared DOM primitives for TabularExt chrome.
 */
import { applyThemeVars } from './styles';
import type { ResolvedTheme } from '@tabular/core';

export function svg(path: string, size = 16): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
}

export function iconButton(icon: string, label: string, className = 'tx-iconbtn'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = svg(icon);
  return b;
}

/** Mirror theme CSS vars onto a body-mounted popup. */
export function themePopup(anchor: HTMLElement, el: HTMLElement, theme: ResolvedTheme): void {
  applyThemeVars(el, theme);
  el.dataset.txTheme = theme.name;
  // Prefer vars from nearest shell root if present
  const root = anchor.closest<HTMLElement>('.tx-root');
  if (root) {
    for (const prop of [
      '--tx-base',
      '--tx-raised',
      '--tx-header',
      '--tx-overlay',
      '--tx-sunken',
      '--tx-hairline',
      '--tx-structural',
      '--tx-fg',
      '--tx-muted',
      '--tx-faint',
      '--tx-accent',
      '--tx-accent-dim',
      '--tx-up',
      '--tx-down',
      '--tx-font-sans',
      '--tx-font-mono',
      '--tx-fs',
      '--tx-fs-sm',
      '--tx-fs-xs',
    ]) {
      const v = getComputedStyle(root).getPropertyValue(prop);
      if (v) el.style.setProperty(prop, v.trim());
    }
  }
}

export function menu(
  anchor: HTMLElement,
  theme: ResolvedTheme,
  build: (close: () => void) => HTMLElement,
  opts?: { align?: 'left' | 'right'; className?: string },
): { toggle: () => void; destroy: () => void; isOpen: () => boolean } {
  let panel: HTMLElement | null = null;
  const close = () => {
    if (!panel) return;
    panel.remove();
    panel = null;
    document.removeEventListener('pointerdown', onDoc, true);
  };
  const onDoc = (e: PointerEvent) => {
    if (panel && !panel.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const open = () => {
    panel = build(close);
    panel.classList.add('tx-menu');
    if (opts?.className) panel.classList.add(opts.className);
    themePopup(anchor, panel, theme);
    document.body.appendChild(panel);
    const r = anchor.getBoundingClientRect();
    panel.style.top = `${Math.round(r.bottom + 4)}px`;
    const left =
      opts?.align === 'left'
        ? Math.max(8, Math.min(r.left, window.innerWidth - panel.offsetWidth - 8))
        : Math.max(8, r.right - panel.offsetWidth);
    panel.style.left = `${Math.round(left)}px`;
    document.addEventListener('pointerdown', onDoc, true);
  };
  return {
    toggle: () => (panel ? close() : open()),
    destroy: close,
    isOpen: () => !!panel,
  };
}

export const ICON = {
  search: 'M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM21 21l-4.3-4.3',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  layouts: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 14H4.5a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 6 8a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 11 4.6h.09A1.65 1.65 0 0 0 12 3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 19 4.6l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 20.4 11h.1a2 2 0 1 1 0 4h-.1a1.65 1.65 0 0 0-1.6 1z',
  more: 'M12 12h.01M12 5h.01M12 19h.01',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  chevronDown: 'M6 9l6 6 6-6',
  chevronUp: 'M18 15l-6-6-6 6',
  columns: 'M3 3h18v18H3zM9 3v18M15 3v18',
  wand: 'M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  brush: 'M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z',
  pencil: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
  undo: 'M3 7v6h6M3 13a9 9 0 1 0 3-7.7L3 8',
  redo: 'M21 7v6h-6M21 13a9 9 0 1 1-3-7.7L21 8',
  filter: 'M22 3H2l8 9.46V19l4 2v-8.54z',
  dollar: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  percent: 'M19 5L5 19M6.5 6.5m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M17.5 17.5m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0',
  hash: 'M4 9h16M4 15h16M10 3L8 21M16 3l-2 18',
  bold: 'M6 4h8a4 4 0 0 1 0 8H6zM6 12h9a4 4 0 0 1 0 8H6z',
  italic: 'M19 4h-9M14 20H5M15 4L9 20',
  underline: 'M6 4v6a6 6 0 0 0 12 0V4M4 21h16',
  alignLeft: 'M17 10H3M21 6H3M21 14H3M17 18H3',
  alignCenter: 'M18 10H6M21 6H3M21 14H3M18 18H6',
  alignRight: 'M21 10H7M21 6H3M21 14H3M21 18H7',
  fill: 'M19 11l-8-8-8.5 8.5a2 2 0 0 0 0 3L8 20a2 2 0 0 0 3 0l8-8zM2 20h20',
  paintText: 'M4 20h16M6 16l4-11 4 11M7.5 13h5',
  swap: 'M16 3l4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16',
  grid: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18',
  range: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  rows: 'M3 3h18v18H3zM3 9h18M3 15h18',
  edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
  close: 'M18 6L6 18M6 6l12 12',
  check: 'M20 6L9 17l-5-5',
} as const;
