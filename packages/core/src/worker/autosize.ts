/**
 * Worker-side column autosize (W6). Samples visible rows with a cap.
 */
import { measureKey, type MeasureCache } from './measureText';

export interface AutosizeColumnSpec {
  colId: string;
  headerName: string;
  font: string;
  padding: number;
  headerPadding?: number;
  minWidth: number;
  maxWidth: number;
  textOf: (rowIndex: number) => string;
}

export interface AutosizeOptions {
  cols: AutosizeColumnSpec[];
  rowCount: number;
  skipHeader?: boolean;
  measureFor: (font: string) => (text: string) => number;
  cache: MeasureCache;
  maxSampleSize?: number;
}

export function measureColumnWidths(opts: AutosizeOptions): Map<string, number> {
  const cap = opts.maxSampleSize ?? 5_000;
  const half = Math.max(0, Math.floor(cap / 2));
  const sampleHead = Math.min(opts.rowCount, half);
  const sampleTailStart = Math.max(sampleHead, opts.rowCount - half);
  const out = new Map<string, number>();

  for (const col of opts.cols) {
    const measure = opts.measureFor(col.font);
    const headerPad = col.headerPadding ?? col.padding;
    let max = col.minWidth;

    const measureText = (text: string): number => {
      if (!text) return 0;
      const key = measureKey(col.font, text);
      const cached = opts.cache.get(key);
      const w = cached ?? measure(text);
      if (cached === undefined) opts.cache.set(key, w);
      return w;
    };

    if (!opts.skipHeader) {
      max = Math.max(max, measureText(col.headerName) + headerPad);
    }

    const sample = (rowIndex: number): void => {
      const text = col.textOf(rowIndex);
      max = Math.max(max, measureText(text) + col.padding);
    };

    for (let i = 0; i < sampleHead; i++) sample(i);
    for (let i = sampleTailStart; i < opts.rowCount; i++) sample(i);

    out.set(col.colId, Math.min(col.maxWidth, Math.max(col.minWidth, Math.ceil(max))));
  }

  return out;
}
