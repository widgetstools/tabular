/**
 * React wrapper — the `pgrid/react` subpath export (spec §3). React is an
 * optional peer dependency: this file is only pulled in by consumers of the
 * subpath, never by the core entry.
 */
import { useEffect, useRef } from 'react';
import { PspGrid } from './grid';
import type { GridOptions } from './types';

export interface PspGridReactProps {
  options: GridOptions;
  /** When provided, the wrapper calls setSchema and fires onReady after it resolves. */
  schema?: Record<string, string>;
  /** The grid is live (schema applied when given); load/update/state calls go here. */
  onReady?(grid: PspGrid): void;
  className?: string;
}

/**
 * Creates a PspGrid on a host div; destroys it on unmount and re-creates it
 * when `options`/`schema` identity changes — memoize both in the caller.
 * StrictMode-safe: the doubled mount destroys the first instance cleanly and
 * `onReady` never fires for a cancelled one.
 */
export function PspGridReact({ options, schema, onReady, className }: PspGridReactProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const grid = new PspGrid(el, options);
    if (schema) {
      grid
        .setSchema(schema)
        .then(() => {
          if (!cancelled) onReadyRef.current?.(grid);
        })
        .catch((err) => console.error('[pgrid] setSchema failed', err));
    } else {
      onReadyRef.current?.(grid);
    }
    return () => {
      cancelled = true;
      void grid.destroy();
    };
  }, [options, schema]);
  return <div ref={ref} className={className} style={{ height: '100%' }} />;
}
