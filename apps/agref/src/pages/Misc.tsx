import { useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { AgGridReact as AgGridReactType } from 'ag-grid-react';
import type { ColDef, ColGroupDef } from 'ag-grid-community';
import { makeBonds, type Bond } from '../data';
import { gridTheme } from '../theme';

export function MiscPage() {
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
        filter: 'agTextColumnFilter',
      },
    ],
    [],
  );
  const gridRef = useRef<AgGridReactType<Bond>>(null);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Misc — status bar &amp; side panel</h2>
        <p>AG Grid reference — side bar tool panels and status bar (column groups).</p>
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
          rowSelection={{ mode: 'multiRow', enableClickSelection: false }}
          cellSelection
          rowGroupPanelShow="onlyWhenGrouping"
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
