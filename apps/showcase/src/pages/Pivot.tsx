import { useEffect, useMemo, useRef, useState } from 'react';
import type { ColDef, Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { fetchOlympicData, type OlympicRow } from '../olympic';
import { FI_ID, FI_DESC, FI_NESTED, FI_GET_ROW_ID } from '../stomp/fiColumns';
import type { FiPosition } from '../stomp/fiPositionsSource';
import { useFiFeed, useFiUpdates } from '../stomp/sharedFeed';
import { FeedBadge } from '../stomp/FeedBadge';

type PivotDemoMode = 'group' | 'pivotOff' | 'pivotSport' | 'pivotNested';

/**
 * Live pivot: group by desk, pivot on rating.composite (a nested dot-path
 * field — exercises the pivot key derivation over dotted names), values
 * sum(pnl) / sum(marketValue).
 */
const liveColumnDefs: ColDef<FiPosition>[] = [
  FI_ID,
  ...FI_DESC.map((c) => (c.field === 'desk' ? { ...c, rowGroup: true } : c)),
  ...FI_NESTED.map((c) =>
    c.field === 'rating.composite' ? { ...c, pivot: true, enablePivot: true } : c,
  ),
  {
    field: 'pnl',
    headerName: 'PnL',
    aggFunc: 'sum',
    enableValue: true,
    type: 'number',
    width: 110,
    format: '#,##0',
    enableCellChangeFlash: true,
  },
  {
    field: 'marketValue',
    headerName: 'Mkt Value',
    aggFunc: 'sum',
    enableValue: true,
    type: 'number',
    width: 130,
    format: '#,##0.00',
    enableCellChangeFlash: true,
  },
];

/**
 * Mirrors AG Grid pivoting docs + pivot column groups (sport, sport+year).
 * https://www.ag-grid.com/react-data-grid/pivoting/
 * https://www.ag-grid.com/react-data-grid/pivoting-column-groups/
 */
export function PivotPage() {
  const { rows: liveRows, status } = useFiFeed();
  const live = status === 'ready' && liveRows;
  const liveApiRef = useRef<Tabular<FiPosition> | null>(null);
  const [liveDisplayed, setLiveDisplayed] = useState(0);
  const [livePivotResultCount, setLivePivotResultCount] = useState(0);
  useFiUpdates(
    (batch) => liveApiRef.current?.applyTransactionAsync({ update: batch }),
    !!live,
  );

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
          {live ? (
            <>
              Live FI positions: group by desk, pivot on <code>rating.composite</code> — a nested
              dot-path field, exercising pivot key derivation over dotted names — with sum(PnL) /
              sum(Market Value) values.
            </>
          ) : (
            <>
              Olympic dataset aligned with AG Grid pivot docs. Use <b>4 — Nested (sport + year)</b>{' '}
              to reproduce collapsible, multi-level pivot column headers (click group labels or the
              chevrons). Single-pivot sport mode matches AG: groups are not collapsible. Turn on{' '}
              <b>Live ticks</b> to watch pivot cells and group totals update in real time.
            </>
          )}{' '}
          The worker data plane is the default; append <code>?main=1</code> to force the UI
          thread.
        </p>
      </div>
      <div className="controls">
        {live ? null : (
          <>
            <button
              type="button"
              className={mode === 'group' ? 'active' : ''}
              onClick={() => setMode('group')}
            >
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
          </>
        )}
        <button
          type="button"
          onClick={() => (live ? liveApiRef.current : apiRef.current)?.expandAll()}
        >
          Expand rows
        </button>
        <button
          type="button"
          onClick={() => (live ? liveApiRef.current : apiRef.current)?.collapseAll()}
        >
          Collapse rows
        </button>
        <button
          type="button"
          onClick={() =>
            (live ? liveApiRef.current : apiRef.current)?.setPivotColumnGroupsExpanded(true)
          }
        >
          Expand pivot headers
        </button>
        <button
          type="button"
          onClick={() =>
            (live ? liveApiRef.current : apiRef.current)?.setPivotColumnGroupsExpanded(false)
          }
        >
          Collapse pivot headers
        </button>
        {live ? null : (
          <button type="button" className={ticking ? 'on' : ''} onClick={() => setTicking((v) => !v)}>
            {ticking ? 'Pause ticks' : 'Live ticks'}
          </button>
        )}
      </div>
      <div className="grid-wrap">
        {live ? (
          <TabularGrid<FiPosition>
            key="stomp"
            columnDefs={liveColumnDefs}
            rowData={liveRows}
            getRowId={FI_GET_ROW_ID}
            density="compact"
            pivotMode
            pivotDefaultExpanded={1}
            groupDefaultExpanded={1}
            grandTotalRow="bottom"
            groupTotalRow="bottom"
            suppressAggFuncInHeader
            rowGroupPanelShow="always"
            pivotPanelShow="onlyWhenPivoting"
            onReady={(api) => {
              liveApiRef.current = api;
              api.setPivotColumns(['rating.composite']);
              const syncPivotCount = () => setLivePivotResultCount(api.getPivotResultColumns().length);
              api.on('modelUpdated', (e) => {
                setLiveDisplayed(e.displayedRowCount);
                syncPivotCount();
              });
              api.on('columnPivotChanged', syncPivotCount);
              syncPivotCount();
            }}
          />
        ) : loadError ? (
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
          Mode <b>{live ? 'live-pivot' : mode}</b>
        </span>
        <span>
          Displayed nodes <b>{(live ? liveDisplayed : displayed).toLocaleString()}</b>
        </span>
        <span>
          Pivot result cols <b>{live ? livePivotResultCount : pivotResultCount}</b>
        </span>
        <span>
          Source rows <b>{(live ? liveRows.length : rowData.length).toLocaleString()}</b>
        </span>
        <FeedBadge status={status} />
      </div>
    </main>
  );
}
