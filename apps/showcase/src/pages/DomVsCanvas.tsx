import { useEffect, useMemo, useRef } from 'react';
import type { ColDef, GridOptions } from '@tabular/core';
import { TabularDom } from '@tabular/dom';
import { makeWide, type WideRow } from '../data';

const ROWS = 60_000;
const METRICS = 8;

/**
 * Task 5 smoke page: a single `TabularDom` in main (fallback) mode over 60k
 * rows. Fleshed out into a side-by-side DOM-vs-canvas comparison in Task 8.
 */
export function DomVsCanvasPage() {
  const hostRef = useRef<HTMLDivElement>(null);

  const rowData = useMemo(() => makeWide(ROWS, METRICS), []);
  const columnDefs = useMemo<ColDef<WideRow>[]>(() => {
    const defs: ColDef<WideRow>[] = [
      { field: 'id', headerName: 'Id', width: 90 },
      { field: 'name', headerName: 'Name', width: 180 },
      { field: 'group', headerName: 'Group', width: 90 },
    ];
    for (let m = 0; m < METRICS; m++) {
      defs.push({
        field: `m${m}`,
        headerName: `Metric ${m}`,
        type: 'number',
        width: 120,
        format: '#,##0.00',
        aggFunc: 'sum',
      });
    }
    return defs;
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const options: GridOptions<WideRow> = {
      columnDefs,
      getRowId: (p) => p.data.id,
      density: 'compact',
      rowDataMode: 'main',
    };
    const grid = new TabularDom<WideRow>(host, options);
    grid.setRowData(rowData);
    return () => grid.destroy();
  }, [columnDefs, rowData]);

  return (
    <main className="page">
      <div className="page-head">
        <h2>DOM renderer — {ROWS.toLocaleString()} rows (main mode)</h2>
        <p>
          A pure-DOM `TabularDom` running the main-thread materializer fallback. Scroll end to end,
          click a header to sort, and (when grouped) click a group row to expand or collapse.
        </p>
      </div>
      <div className="grid-wrap">
        <div ref={hostRef} style={{ height: '100%', width: '100%' }} />
      </div>
    </main>
  );
}
