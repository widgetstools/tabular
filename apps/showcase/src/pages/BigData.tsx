import { useMemo, useState } from 'react';
import type { ColDef } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeWide, type WideRow } from '../data';

const ROWS = 100_000;
const METRICS = 40;

export function BigDataPage() {
  const [genMs, setGenMs] = useState(0);
  const rowData = useMemo(() => {
    const t0 = performance.now();
    const rows = makeWide(ROWS, METRICS);
    setGenMs(Math.round(performance.now() - t0));
    return rows;
  }, []);

  const columnDefs = useMemo<ColDef<WideRow>[]>(() => {
    const defs: ColDef<WideRow>[] = [
      { field: 'id', headerName: 'Id', pinned: 'left', width: 80 },
      { field: 'name', headerName: 'Name', pinned: 'left', width: 140 },
      { field: 'group', headerName: 'Group', width: 80 },
    ];
    for (let m = 0; m < METRICS; m++) {
      defs.push({ field: `m${m}`, headerName: `Metric ${m}`, type: 'number', width: 104 });
    }
    return defs;
  }, []);

  return (
    <main className="page">
      <div className="page-head">
        <h2>100,000 rows × {METRICS + 3} columns</h2>
        <p>
          Virtualization in both axes: only the visible window is painted, addressed through
          prefix-sum offsets. Scroll with the wheel, drag the scrollbar end to end, or hold{' '}
          <span className="kbd">PageDown</span> — the frame stays flat because scrolling never
          touches the DOM.
        </p>
      </div>
      <div className="grid-wrap">
        <TabularGrid<WideRow>
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
          density="dense"
          rowSelection="single"
        />
      </div>
      <div className="status">
        <span>
          Rows <b>{ROWS.toLocaleString()}</b>
        </span>
        <span>
          Cells <b>{(ROWS * (METRICS + 3)).toLocaleString()}</b>
        </span>
        <span>
          Data generated in <b>{genMs}ms</b>
        </span>
      </div>
    </main>
  );
}
