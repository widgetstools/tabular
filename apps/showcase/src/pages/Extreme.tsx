import { useMemo, useState } from 'react';
import type { ColDef } from '@tabular/core';
import { TabularGrid } from '@tabular/react';

const mainMode =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('main') === '1';

const compareMode =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('compare') === '1';

const ROWS = 1_000_000;
const METRICS = 496;

const GROUPS = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta'];
const REGIONS = ['AMER', 'EMEA', 'APAC', 'LATAM'];

export interface ExtremeRow {
  id: number;
  name: string;
  group: string;
  region: string;
}

declare global {
  interface Window {
    __benchApi?: unknown;
    __bench?: Record<string, number>;
  }
}

export function ExtremePage() {
  const [genMs, setGenMs] = useState(0);
  const [readyMs, setReadyMs] = useState<number | null>(null);

  const t0 = useMemo(() => performance.now(), []);
  const rowData = useMemo(() => {
    const start = performance.now();
    const rows: ExtremeRow[] = new Array(ROWS);
    for (let i = 0; i < ROWS; i++) {
      rows[i] = {
        id: i,
        name: `R${i}`,
        group: GROUPS[i & 7]!,
        region: REGIONS[(i >> 3) & 3]!,
      };
    }
    setGenMs(Math.round(performance.now() - start));
    return rows;
  }, []);

  const columnDefs = useMemo<ColDef<ExtremeRow>[]>(() => {
    const defs: ColDef<ExtremeRow>[] = [
      { field: 'id', headerName: 'Id', pinned: 'left', width: 90, type: 'number' },
      { field: 'name', headerName: 'Name', pinned: 'left', width: 120 },
      {
        field: 'group',
        headerName: 'Group',
        width: 90,
        enableRowGroup: true,
        enablePivot: true,
      },
      {
        field: 'region',
        headerName: 'Region',
        width: 90,
        enableRowGroup: true,
        enablePivot: true,
      },
    ];
    for (let m = 0; m < METRICS; m++) {
      defs.push({
        colId: `m${m}`,
        headerName: `Metric ${m}`,
        type: 'number',
        width: 104,
        enableValue: true,
        calc: `ROUND(HASH([id], ${m}) * 1000000) / 100`,
      });
    }
    return defs;
  }, []);

  return (
    <main className="page">
      <div className="page-head">
        <h2>1,000,000 rows × 500 columns</h2>
        <p>
          Half a billion logical cells. Row stubs carry id/name/group/region; 496 metric columns use{' '}
          <code>calc</code> expressions (HASH) instead of valueGetters so the worker data plane can own
          filter/sort/viewport. Worker is the default — append <code>?main=1</code> to force the UI
          thread, or <code>?compare=1</code> for differential main vs worker checks.
        </p>
      </div>
      <div className="grid-wrap">
        <TabularGrid<ExtremeRow>
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => String(p.data.id)}
          rowDataMode={mainMode ? 'main' : 'worker'}
          workerCompareMode={compareMode && !mainMode}
          density="dense"
          cellSelection
          sideBar
          rowGroupPanelShow="onlyWhenGrouping"
          pivotPanelShow="onlyWhenPivoting"
          onReady={(api) => {
            window.__benchApi = api;
            requestAnimationFrame(() => {
              const ms = Math.round(performance.now() - t0);
              setReadyMs(ms);
              window.__bench = { ...window.__bench, readyMs: ms };
            });
          }}
        />
      </div>
      <div className="status">
        <span>
          Mode <b>{mainMode ? 'main' : 'worker'}</b>
        </span>
        <span>
          Rows <b>{ROWS.toLocaleString()}</b>
        </span>
        <span>
          Columns <b>{(METRICS + 4).toLocaleString()}</b>
        </span>
        <span>
          Row stubs built in <b>{genMs}ms</b>
        </span>
        {readyMs != null && (
          <span>
            First frame in <b>{readyMs}ms</b>
          </span>
        )}
      </div>
    </main>
  );
}
