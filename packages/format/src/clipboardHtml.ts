/**
 * Styled clipboard: build a minimal HTML table preserving Tier 0/1 text +
 * color/weight so paste into Excel/Sheets keeps formatting alongside TSV.
 */
import type { FormatCellStyle } from './types';

export interface HtmlClipboardCell {
  text: string;
  style?: FormatCellStyle;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function styleAttr(style?: FormatCellStyle): string {
  if (!style) return '';
  const parts: string[] = [];
  if (style.color) parts.push(`color:${style.color}`);
  if (style.backgroundColor || style.background) {
    parts.push(`background-color:${style.backgroundColor ?? style.background}`);
  }
  if (style.fontWeight != null) parts.push(`font-weight:${style.fontWeight}`);
  if (style.fontStyle) parts.push(`font-style:${style.fontStyle}`);
  return parts.length ? ` style="${parts.join(';')}"` : '';
}

/** Build an HTML table string for clipboard `text/html`. */
export function buildHtmlClipboardTable(
  rows: HtmlClipboardCell[][],
  headers?: string[],
): string {
  const parts: string[] = [
    '<table xmlns="http://www.w3.org/1999/xhtml">',
  ];
  if (headers?.length) {
    parts.push('<thead><tr>');
    for (const h of headers) parts.push(`<th>${esc(h)}</th>`);
    parts.push('</tr></thead>');
  }
  parts.push('<tbody>');
  for (const row of rows) {
    parts.push('<tr>');
    for (const cell of row) {
      parts.push(`<td${styleAttr(cell.style)}>${esc(cell.text)}</td>`);
    }
    parts.push('</tr>');
  }
  parts.push('</tbody></table>');
  return parts.join('');
}

/** Write TSV + HTML to the system clipboard when supported. */
export async function writeClipboardTsvAndHtml(tsv: string, html: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return;
  try {
    if (typeof ClipboardItem !== 'undefined') {
      const item = new ClipboardItem({
        'text/plain': new Blob([tsv], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      });
      await navigator.clipboard.write([item]);
      return;
    }
  } catch {
    // fall through
  }
  await navigator.clipboard.writeText(tsv);
}
