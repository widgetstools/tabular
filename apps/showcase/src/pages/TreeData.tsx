import { useMemo, useRef, useState } from 'react';
import { TabularGrid, type TabularGridHandle } from '@tabular/react';
import type { ColDef } from '@tabular/core';
import { makeTreeRows, type TreeRow } from '../data';

const money = (v: unknown): string =>
  v == null || v === '' ? '' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });

export function TreeDataPage() {
  const rowData = useMemo(() => makeTreeRows(), []);
  const gridRef = useRef<TabularGridHandle<TreeRow>>(null);
  const [quick, setQuick] = useState('');
  const [excludeChildren, setExcludeChildren] = useState(false);

  const columnDefs = useMemo<ColDef<TreeRow>[]>(
    () => [
      { field: 'instrument', headerName: 'Sector', width: 130 },
      { field: 'trader', headerName: 'Trader', width: 110 },
      {
        field: 'notional',
        headerName: 'Notional',
        type: 'number',
        width: 140,
        aggFunc: 'sum',
        valueFormatter: (p) => money(p.value),
      },
      {
        field: 'dv01',
        headerName: 'DV01',
        type: 'number',
        width: 120,
        aggFunc: 'sum',
        valueFormatter: (p) => money(p.value),
      },
      {
        field: 'pnl',
        headerName: 'P&L',
        type: 'number',
        width: 130,
        aggFunc: 'sum',
        valueFormatter: (p) => money(p.value),
        cellStyle: (p) =>
          typeof p.value === 'number' && p.value !== 0
            ? { color: p.value > 0 ? '#3fb68b' : '#e5484d' }
            : null,
      },
    ],
    [],
  );

  return (
    <main className="page">
      <div className="page-head">
        <h2>Tree data</h2>
        <p>
          Hierarchical rows via <code>treeData</code> + <code>getDataPath</code>: desk → book →
          position. Desk rows are real records; book levels have no supplied row, so the grid
          synthesizes filler nodes. Aggregates (sum) roll up over leaves only. Filtering keeps
          matching branches reachable — toggle “exclude children” to drop non-matching descendants.
        </p>
      </div>
      <div className="controls">
        <input
          type="text"
          placeholder="Quick filter…"
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
        />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={excludeChildren}
            onChange={(e) => setExcludeChildren(e.target.checked)}
          />
          exclude children when filtering
        </label>
        <button onClick={() => gridRef.current?.api?.expandAll()}>Expand all</button>
        <button onClick={() => gridRef.current?.api?.collapseAll()}>Collapse all</button>
      </div>
      <div className="grid-wrap">
        <TabularGrid<TreeRow>
          key={excludeChildren ? 'ex' : 'inc'}
          ref={gridRef}
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
          treeData
          getDataPath={(d) => d.path}
          excludeChildrenWhenTreeDataFiltering={excludeChildren}
          autoGroupColumnDef={{ headerName: 'Desk / Book / Position', width: 300 }}
          groupDefaultExpanded={1}
          quickFilterText={quick}
          cellSelection
          statusBar
          density="compact"
        />
      </div>
    </main>
  );
}
