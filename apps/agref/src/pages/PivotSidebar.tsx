import { useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { AgGridReact as AgGridReactType } from 'ag-grid-react';
import type { ColDef, ColGroupDef } from 'ag-grid-community';
import { makeBonds, type Bond } from '../data';
import { gridTheme } from '../theme';

/**
 * AG Grid reference for the showcase "Misc" page pivot/sidebar scenario:
 * pivot mode ON, Desk as row group, Sector as column labels, Notional as
 * values — same seeded dataset, same column defs.
 */
export function PivotSidebarPage() {
  const rowData = useMemo(() => makeBonds(300), []);
  const columnDefs = useMemo<(ColDef<Bond> | ColGroupDef<Bond>)[]>(
    () => [
      { field: 'cusip', headerName: 'CUSIP', pinned: 'left', width: 110 },
      {
        headerName: 'Instrument',
        children: [
          { field: 'issuer', headerName: 'Issuer', width: 160, filter: 'agTextColumnFilter' },
          {
            field: 'sector',
            headerName: 'Sector',
            width: 110,
            enableRowGroup: true,
            enablePivot: true,
            pivot: true,
            filter: 'agTextColumnFilter',
          },
          {
            field: 'rating',
            headerName: 'Rating',
            width: 78,
            enableRowGroup: true,
            enablePivot: true,
            filter: 'agTextColumnFilter',
          },
        ],
      },
      {
        headerName: 'Market',
        children: [
          {
            field: 'price',
            headerName: 'Price',
            type: 'numericColumn',
            width: 92,
            enableValue: true,
            filter: 'agNumberColumnFilter',
          },
          {
            field: 'spread',
            headerName: 'Spread',
            type: 'numericColumn',
            width: 88,
            enableValue: true,
            filter: 'agNumberColumnFilter',
          },
          {
            field: 'notional',
            headerName: 'Notional',
            type: 'numericColumn',
            width: 116,
            enableValue: true,
            aggFunc: 'sum',
            filter: 'agNumberColumnFilter',
          },
        ],
      },
      {
        field: 'desk',
        headerName: 'Desk',
        width: 100,
        enableRowGroup: true,
        enablePivot: true,
        rowGroup: true,
        filter: 'agTextColumnFilter',
      },
    ],
    [],
  );
  const gridRef = useRef<AgGridReactType<Bond>>(null);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Pivot &amp; Sidebar — AG Grid</h2>
        <p>
          AG Grid reference for the pivot + sidebar scenario: pivot mode on, Desk row group, Sector
          column labels, sum(Notional) values. Same seeded dataset as the tabular Misc page.
        </p>
      </div>
      <div className="controls">
        <button type="button" onClick={() => gridRef.current?.api.openToolPanel('columns')}>
          Open Columns panel
        </button>
        <button type="button" onClick={() => gridRef.current?.api.openToolPanel('filters')}>
          Open Filters panel
        </button>
        <button type="button" onClick={() => gridRef.current?.api.closeToolPanel()}>
          Close panel
        </button>
      </div>
      <div className="grid-wrap">
        <AgGridReact<Bond>
          ref={gridRef}
          theme={gridTheme}
          rowData={rowData}
          columnDefs={columnDefs}
          getRowId={(p) => p.data.id}
          defaultColDef={{ floatingFilter: true }}
          pivotMode
          rowSelection={{ mode: 'multiRow', enableClickSelection: false }}
          cellSelection
          rowGroupPanelShow="onlyWhenGrouping"
          pivotPanelShow="onlyWhenPivoting"
          sideBar
          statusBar={{
            statusPanels: [
              { statusPanel: 'agTotalAndFilteredRowCountComponent' },
              { statusPanel: 'agSelectedRowCountComponent' },
              { statusPanel: 'agAggregationComponent' },
            ],
          }}
        />
      </div>
    </main>
  );
}
