import { useEffect, useMemo, useRef, useState } from 'react';
import type { ColDef, Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { fetchOlympicData, type OlympicRow } from '../olympic';

type PivotDemoMode = 'group' | 'pivotOff' | 'pivotSport' | 'pivotNested';

/**
 * Mirrors AG Grid pivoting docs + pivot column groups (sport, sport+year).
 * https://www.ag-grid.com/react-data-grid/pivoting/
 * https://www.ag-grid.com/react-data-grid/pivoting-column-groups/
 */
export function PivotPage() {
  const [rowData, setRowData] = useState<OlympicRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<PivotDemoMode>('pivotNested');
  const [ticking, setTicking] = useState(false);
  const apiRef = useRef<Tabular<OlympicRow> | null>(null);

  useEffect(() => {
    fetchOlympicData()
      .then(setRowData)
      .catch((e) => setLoadError(String(e)));
  }, []);

  // Live medal ticks — verifies pivot cells / group totals re-aggregate on updates.
  useEffect(() => {
    if (!ticking || !rowData.length) return;
    const iv = setInterval(() => {
      const api = apiRef.current;
      if (!api) return;
      const batch: OlympicRow[] = [];
      for (let i = 0; i < 40; i++) {
        const idx = Math.floor(Math.random() * rowData.length);
        const row = rowData[idx];
        const next = {
          ...row,
          gold: Math.max(0, row.gold + (Math.random() < 0.5 ? -1 : 1)),
          silver: Math.max(0, row.silver + (Math.random() < 0.5 ? -1 : 1)),
          bronze: Math.max(0, row.bronze + (Math.random() < 0.5 ? -1 : 1)),
        };
        rowData[idx] = next;
        batch.push(next);
      }
      api.applyTransactionAsync({ update: batch });
    }, 80);
    return () => clearInterval(iv);
  }, [ticking, rowData]);

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
      {
        field: 'gold',
        aggFunc: 'sum',
        enableValue: true,
        type: 'number',
        width: 110,
        enableCellChangeFlash: true,
      },
      {
        field: 'silver',
        aggFunc: 'sum',
        enableValue: true,
        type: 'number',
        width: 110,
        enableCellChangeFlash: true,
      },
      {
        field: 'bronze',
        aggFunc: 'sum',
        enableValue: true,
        type: 'number',
        width: 110,
        enableCellChangeFlash: true,
      },
      { field: 'athlete', width: 160 },
      { field: 'age', type: 'number', width: 72 },
      { field: 'date', width: 110 },
    ],
    [mode, nestedPivot],
  );

  const [displayed, setDisplayed] = useState(0);
  const [pivotResultCount, setPivotResultCount] = useState(0);

  const pivotMode = mode !== 'group';
  const pivotActive = mode === 'pivotSport' || nestedPivot;

  return (
    <main className="page">
      <div className="page-head">
        <h2>Pivot mode</h2>
        <p>
          Olympic dataset aligned with AG Grid pivot docs. Use <b>4 — Nested (sport + year)</b> to
          reproduce collapsible, multi-level pivot column headers (click group labels or the
          chevrons). Single-pivot sport mode matches AG: groups are not collapsible. Turn on{' '}
          <b>Live ticks</b> to watch pivot cells and group totals update in real time. The worker
          data plane is the default; append <code>?main=1</code> to force the UI thread.
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
        <button type="button" onClick={() => apiRef.current?.expandAll()}>
          Expand rows
        </button>
        <button type="button" onClick={() => apiRef.current?.collapseAll()}>
          Collapse rows
        </button>
        <button type="button" onClick={() => apiRef.current?.setPivotColumnGroupsExpanded(true)}>
          Expand pivot headers
        </button>
        <button type="button" onClick={() => apiRef.current?.setPivotColumnGroupsExpanded(false)}>
          Collapse pivot headers
        </button>
        <button
          type="button"
          className={ticking ? 'on' : ''}
          onClick={() => setTicking((v) => !v)}
        >
          {ticking ? 'Pause ticks' : 'Live ticks'}
        </button>
      </div>
      <div className="grid-wrap">
        {loadError ? (
          <p className="error">{loadError}</p>
        ) : (
          <TabularGrid<OlympicRow>
            key={mode}
            columnDefs={columnDefs}
            rowData={rowData}
            defaultColDef={{ flex: 1, minWidth: 130 }}
            autoGroupColumnDef={{ minWidth: 200, headerName: 'Country' }}
            density="compact"
            pivotMode={pivotMode}
            pivotDefaultExpanded={1}
            groupDefaultExpanded={1}
            grandTotalRow="bottom"
            groupTotalRow="bottom"
            suppressAggFuncInHeader
            rowGroupPanelShow="always"
            pivotPanelShow={pivotActive ? 'onlyWhenPivoting' : 'never'}
            onReady={(api) => {
              apiRef.current = api;
              if (mode === 'pivotSport') api.setPivotColumns(['sport']);
              else if (mode === 'pivotNested') api.setPivotColumns(['sport', 'year']);
              else api.setPivotColumns([]);
              const syncPivotCount = () => setPivotResultCount(api.getPivotResultColumns().length);
              api.on('modelUpdated', (e) => {
                setDisplayed(e.displayedRowCount);
                syncPivotCount();
              });
              api.on('columnPivotChanged', syncPivotCount);
              syncPivotCount();
            }}
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
          Pivot result cols <b>{pivotResultCount}</b>
        </span>
        <span>
          Source rows <b>{rowData.length.toLocaleString()}</b>
        </span>
      </div>
    </main>
  );
}
