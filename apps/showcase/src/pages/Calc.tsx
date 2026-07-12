import { useMemo, useRef } from 'react';
import type { ColDef, Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';
import { FI_ID, FI_GET_ROW_ID } from '../stomp/fiColumns';
import type { FiPosition } from '../stomp/fiPositionsSource';
import { useFiFeed, useFiUpdates } from '../stomp/sharedFeed';
import { FeedBadge } from '../stomp/FeedBadge';

const mainMode =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('main') === '1';

const compareMode =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('compare') === '1';

function spreadGetter(row: Bond): number {
  return row.spread;
}

function fiSpreadGetter(row: FiPosition): number {
  return Number(row.spread ?? 0);
}

/**
 * Live calc columns: expressions over FLAT fields only — the calc DSL
 * can't reference dotted names (e.g. `issuer.sector`, `marketValue - bookValue`
 * is fine, but a field like `issuer.sector` is not) — so nested FI columns
 * (issuer.name / issuer.sector) appear only as plain display columns, never
 * inside a `calc`. Mirrors the synthetic demo one-for-one over FI's flat
 * spread / notionalAmount / pnl fields.
 */
const liveColumnDefs: ColDef<FiPosition>[] = [
  FI_ID,
  { field: 'desk', headerName: 'Desk', width: 100, rowGroup: true, rowGroupIndex: 0 },
  { field: 'issuer.name', headerName: 'Issuer', width: 160 },
  { field: 'issuer.sector', headerName: 'Sector', width: 110 },
  { field: 'spread', headerName: 'Spread (field)', type: 'number', width: 100 },
  {
    colId: 'spreadCalc',
    headerName: 'Spread (calc)',
    type: 'number',
    width: 110,
    calc: '[spread]',
  },
  {
    colId: 'deskNotionalCalc',
    headerName: 'Desk notional Σ',
    type: 'number',
    width: 130,
    format: '#,##0',
    calc: "SUM([notionalAmount], 'group')",
  },
  {
    colId: 'spreadBpsCalc',
    headerName: 'Spread bps',
    type: 'number',
    width: 100,
    calc: 'ROUND([spread] * 100)',
  },
  {
    colId: 'spreadGetterCol',
    headerName: 'Spread (getter)',
    type: 'number',
    width: 120,
    valueGetter: (p) => fiSpreadGetter(p.data as FiPosition),
  },
  {
    colId: 'pnlPrevCalc',
    headerName: 'PnL prev',
    type: 'number',
    width: 100,
    format: '#,##0',
    calc: 'PREV([pnl])',
  },
  {
    colId: 'pnlFlagCalc',
    headerName: 'PnL flag',
    width: 90,
    calc: 'IF([pnl] < 0, "loss", "gain")',
  },
];

export function CalcPage() {
  const { rows: liveRows, status } = useFiFeed();
  const live = status === 'ready' && liveRows;
  const liveApiRef = useRef<Tabular<FiPosition> | null>(null);
  useFiUpdates(
    (batch) => liveApiRef.current?.applyTransactionAsync({ update: batch }),
    !!live,
  );

  const rowData = useMemo(() => makeBonds(500), []);
  const columnDefs = useMemo<ColDef<Bond>[]>(
    () => [
      { field: 'desk', headerName: 'Desk', width: 100, rowGroup: true, rowGroupIndex: 0 },
      { field: 'issuer', headerName: 'Issuer', width: 150 },
      { field: 'spread', headerName: 'Spread (field)', type: 'number', width: 100 },
      {
        colId: 'spreadCalc',
        headerName: 'Spread (calc)',
        type: 'number',
        width: 110,
        calc: '[spread]',
      },
      {
        colId: 'deskNotional',
        headerName: 'Desk notional Σ',
        type: 'number',
        width: 130,
        calc: "SUM([notional], 'group')",
      },
      {
        colId: 'spreadBps',
        headerName: 'Spread bps',
        type: 'number',
        width: 100,
        calc: 'ROUND([spread] * 100)',
      },
      {
        colId: 'spreadGetter',
        headerName: 'Spread (getter)',
        type: 'number',
        width: 120,
        valueGetter: (p) => spreadGetter(p.data as Bond),
      },
      {
        colId: 'pnlPrev',
        headerName: 'PnL prev',
        type: 'number',
        width: 100,
        calc: 'PREV([pnl])',
      },
      {
        colId: 'pnlFlag',
        headerName: 'PnL flag',
        width: 90,
        calc: 'IF([pnl] < 0, "loss", "gain")',
      },
    ],
    [],
  );

  return (
    <main className="page">
      <div className="page-head">
        <h2>Calculated columns</h2>
        <p>
          <code>ColDef.calc</code> with field refs, aggregate scopes, and <code>PREV([field])</code>.
          Group by Desk to see{' '}
          <code>SUM([{live ? 'notionalAmount' : 'notional'}], &apos;group&apos;)</code>. Edit PnL
          cells then update again to observe PREV. Worker pipeline is the default (getter columns
          are skipped for filter/sort maps).
          {live
            ? ' Live FI positions — calc expressions run over flat fields only (issuer.name / issuer.sector show as plain nested display columns, not inside a calc expression).'
            : null}{' '}
          Append <code>?main=1</code> to force the UI thread, or <code>?compare=1</code> for
          differential checks.
        </p>
      </div>
      <div className="grid-wrap">
        {live ? (
          <TabularGrid<FiPosition>
            key="stomp"
            columnDefs={liveColumnDefs}
            rowData={liveRows}
            getRowId={FI_GET_ROW_ID}
            defaultColDef={{ sortable: true, filter: true, resizable: true, editable: true }}
            sideBar
            onReady={(api) => {
              liveApiRef.current = api;
            }}
          />
        ) : (
          <TabularGrid<Bond>
            key="synthetic"
            columnDefs={columnDefs}
            rowData={rowData}
            rowDataMode={mainMode ? 'main' : undefined}
            workerCompareMode={compareMode && !mainMode}
            defaultColDef={{ sortable: true, filter: true, resizable: true, editable: true }}
            sideBar
          />
        )}
      </div>
      <div className="status">
        <FeedBadge status={status} />
      </div>
    </main>
  );
}
