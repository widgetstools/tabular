import { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, GridApi } from 'ag-grid-community';
import { gridTheme } from '../theme';
import { fetchOlympicData, type OlympicRow } from '../olympic';

type PivotDemoMode = 'group' | 'pivotOff' | 'pivotSport' | 'pivotNested';

/** AG Grid reference — Olympic pivot + nested pivot column groups. */
export function PivotPage() {
  const [rowData, setRowData] = useState<OlympicRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<PivotDemoMode>('pivotNested');

  useEffect(() => {
    fetchOlympicData()
      .then(setRowData)
      .catch((e) => setLoadError(String(e)));
  }, []);

  const nestedPivot = mode === 'pivotNested';

  const columnDefs = useMemo<ColDef<OlympicRow>[]>(
    () => [
      { field: 'country', rowGroup: true, enableRowGroup: true },
      {
        field: 'sport',
        pivot: mode === 'pivotSport' || nestedPivot,
        enablePivot: true,
      },
      {
        field: 'year',
        pivot: nestedPivot,
        enablePivot: true,
      },
      { field: 'gold', aggFunc: 'sum', enableValue: true, type: 'rightAligned', width: 110 },
      { field: 'silver', aggFunc: 'sum', enableValue: true, type: 'rightAligned', width: 110 },
      { field: 'bronze', aggFunc: 'sum', enableValue: true, type: 'rightAligned', width: 110 },
      { field: 'athlete', width: 160 },
      { field: 'age', type: 'rightAligned', width: 72 },
      { field: 'date', width: 110 },
    ],
    [mode, nestedPivot],
  );

  const apiRef = useRef<GridApi<OlympicRow> | null>(null);
  const [displayed, setDisplayed] = useState(0);

  const pivotMode = mode !== 'group';

  return (
    <main className="page">
      <div className="page-head">
        <h2>Pivot mode</h2>
        <p>
          AG Grid Enterprise reference — same modes as showcase. Mode 4 uses sport + year pivot with{' '}
          <code>pivotDefaultExpanded=&#123;1&#125;</code> (AG pivot column groups docs).
        </p>
      </div>
      <div className="controls">
        <button type="button" className={mode === 'group' ? 'active' : ''} onClick={() => setMode('group')}>
          1 — Grouping only
        </button>
        <button
          type="button"
          className={mode === 'pivotOff' ? 'active' : ''}
          onClick={() => setMode('pivotOff')}
        >
          2 — Pivot mode (no pivot cols)
        </button>
        <button
          type="button"
          className={mode === 'pivotSport' ? 'active' : ''}
          onClick={() => setMode('pivotSport')}
        >
          3 — Pivot (sport)
        </button>
        <button
          type="button"
          className={mode === 'pivotNested' ? 'active' : ''}
          onClick={() => setMode('pivotNested')}
        >
          4 — Nested (sport + year)
        </button>
      </div>
      <div className="grid-wrap">
        {loadError ? (
          <p className="error">{loadError}</p>
        ) : (
          <AgGridReact<OlympicRow>
            key={mode}
            theme={gridTheme}
            columnDefs={columnDefs}
            rowData={rowData}
            defaultColDef={{ flex: 1, minWidth: 130, enableValue: true, enableRowGroup: true, enablePivot: true }}
            autoGroupColumnDef={{ minWidth: 200, headerName: 'Country' }}
            pivotMode={pivotMode}
            pivotDefaultExpanded={1}
            groupDefaultExpanded={1}
            rowGroupPanelShow="always"
            pivotPanelShow={mode === 'pivotSport' || nestedPivot ? 'onlyWhenPivoting' : 'never'}
            onGridReady={(e) => {
              apiRef.current = e.api;
              if (mode === 'pivotSport') e.api.setPivotColumns(['sport']);
              else if (mode === 'pivotNested') e.api.setPivotColumns(['sport', 'year']);
              else e.api.setPivotColumns([]);
              setDisplayed(e.api.getDisplayedRowCount());
            }}
            onModelUpdated={(e) => setDisplayed(e.api.getDisplayedRowCount())}
          />
        )}
      </div>
      <div className="status">
        <span>
          Mode <b>{mode}</b>
        </span>
        <span>
          Displayed nodes <b>{displayed.toLocaleString()}</b>
        </span>
        <span>
          Source rows <b>{rowData.length.toLocaleString()}</b>
        </span>
      </div>
    </main>
  );
}
