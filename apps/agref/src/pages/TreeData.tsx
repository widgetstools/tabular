import { useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { gridTheme } from '../theme';
import { makeTreeRows, type TreeRow } from '../data';

const money = (v: unknown): string =>
  v == null || v === '' ? '' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });

export function TreeDataPage() {
  const rowData = useMemo(() => makeTreeRows(), []);
  const gridRef = useRef<AgGridReact<TreeRow>>(null);
  const [quick, setQuick] = useState('');
  const [excludeChildren, setExcludeChildren] = useState(false);

  const columnDefs = useMemo<ColDef<TreeRow>[]>(
    () => [
      { field: 'instrument', headerName: 'Sector', width: 130 },
      { field: 'trader', headerName: 'Trader', width: 110 },
      {
        field: 'notional',
        headerName: 'Notional',
        type: 'numericColumn',
        width: 140,
        aggFunc: 'sum',
        valueFormatter: (p) => money(p.value),
      },
      {
        field: 'dv01',
        headerName: 'DV01',
        type: 'numericColumn',
        width: 120,
        aggFunc: 'sum',
        valueFormatter: (p) => money(p.value),
      },
      {
        field: 'pnl',
        headerName: 'P&L',
        type: 'numericColumn',
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
          AG Grid <code>treeData</code> + <code>getDataPath</code>: desk → book → position, filler
          nodes for the book level, leaf-only sum aggregation, quick filter with{' '}
          <code>excludeChildrenWhenTreeDataFiltering</code>.
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
        <AgGridReact<TreeRow>
          key={excludeChildren ? 'ex' : 'inc'}
          ref={gridRef}
          theme={gridTheme}
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
          statusBar={{
            statusPanels: [
              { statusPanel: 'agTotalAndFilteredRowCountComponent', align: 'left' },
              { statusPanel: 'agSelectedRowCountComponent', align: 'left' },
              { statusPanel: 'agAggregationComponent', align: 'right' },
            ],
          }}
        />
      </div>
    </main>
  );
}
