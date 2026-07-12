import { useMemo, useRef, useState } from 'react';
import { TabularGrid } from '@tabular/react';
import type { AnyColDef, Tabular } from '@tabular/core';
import { makeBonds, type Bond } from '../data';
import { FI_ID, FI_DESC, FI_NESTED, FI_MEASURES, FI_GET_ROW_ID } from '../stomp/fiColumns';
import type { FiPosition } from '../stomp/fiPositionsSource';
import { useFiFeed, useFiUpdates } from '../stomp/sharedFeed';
import { FeedBadge } from '../stomp/FeedBadge';

/** FI columns organized into labeled groups: Identity, Ratings (nested), Risk (nested), Measures. */
const liveColumnDefs: AnyColDef<FiPosition>[] = [
  FI_ID,
  {
    groupId: 'identity',
    headerName: 'Identity',
    children: FI_DESC,
  },
  {
    groupId: 'ratings',
    headerName: 'Ratings',
    children: [
      FI_NESTED.find((c) => c.field === 'rating.composite')!,
      FI_NESTED.find((c) => c.field === 'rating.moody')!,
      FI_NESTED.find((c) => c.field === 'issuer.name')!,
      FI_NESTED.find((c) => c.field === 'issuer.sector')!,
    ],
  },
  {
    groupId: 'risk',
    headerName: 'Risk',
    children: [
      FI_NESTED.find((c) => c.field === 'riskMetrics.var95')!,
      FI_NESTED.find((c) => c.field === 'analytics.keyRateDuration.10Y')!,
      FI_MEASURES.find((c) => c.field === 'dv01')!,
      FI_MEASURES.find((c) => c.field === 'spread')!,
    ],
  },
  {
    groupId: 'measures',
    headerName: 'Measures',
    children: FI_MEASURES.filter((c) => c.field !== 'dv01' && c.field !== 'spread'),
  },
];

export function ColumnGroupsPage() {
  const { rows, status } = useFiFeed();
  const live = status === 'ready' && rows;
  const liveApiRef = useRef<Tabular<FiPosition> | null>(null);
  const [liveGroupState, setLiveGroupState] = useState('');
  useFiUpdates(
    (batch) => liveApiRef.current?.applyTransactionAsync({ update: batch }),
    !!live,
  );
  const rowData = useMemo(() => makeBonds(400), []);
  const columnDefs = useMemo<AnyColDef<Bond>[]>(
    () => [
      { field: 'cusip', headerName: 'CUSIP', pinned: 'left', width: 110 },
      {
        headerName: 'Instrument',
        children: [
          { field: 'issuer', headerName: 'Issuer', width: 160 },
          { field: 'sector', headerName: 'Sector', width: 110 },
          { field: 'rating', headerName: 'Rating', width: 78, align: 'center' },
        ],
      },
      {
        headerName: 'Terms',
        children: [
          { field: 'coupon', headerName: 'Coupon', type: 'number', width: 84 },
          { field: 'maturity', headerName: 'Maturity', width: 104 },
        ],
      },
      {
        groupId: 'market',
        headerName: 'Market',
        children: [
          // Summary column: only while the Market group is COLLAPSED.
          {
            colId: 'pxSummary',
            field: 'price',
            headerName: 'Px (net)',
            type: 'number',
            width: 96,
            columnGroupShow: 'closed',
          },
          // Detail columns: only while the Market group is EXPANDED.
          {
            headerName: 'Levels',
            columnGroupShow: 'open',
            children: [
              { field: 'price', headerName: 'Price', type: 'number', width: 92 },
              { field: 'yld', headerName: 'Yield', type: 'number', width: 84 },
              { field: 'spread', headerName: 'Spread', type: 'number', width: 84 },
            ],
          },
          { field: 'dv01', headerName: 'DV01', type: 'number', width: 96, columnGroupShow: 'open' },
          // Always visible regardless of group state.
          { field: 'notional', headerName: 'Notional', type: 'number', width: 116 },
        ],
      },
      {
        groupId: 'desk',
        headerName: 'Desk',
        children: [
          { field: 'desk', headerName: 'Desk', width: 100 },
          { field: 'trader', headerName: 'Trader', width: 90, columnGroupShow: 'open' },
        ],
      },
    ],
    [],
  );
  const [groupState, setGroupState] = useState('');
  const apiRef = useRef<Tabular<Bond> | null>(null);
  /** Demo group id: 'market' has columnGroupShow children on the synthetic grid; 'risk' mirrors it live. */
  const demoGroupId = live ? 'risk' : 'market';

  return (
    <main className="page">
      <div className="page-head">
        <h2>Column groups</h2>
        <p>
          {live ? (
            <>
              Live FI columns organized into labeled groups — <b>Identity</b>, <b>Ratings</b>{' '}
              (nested <code>rating.*</code> / <code>issuer.*</code>), <b>Risk</b> (nested{' '}
              <code>riskMetrics.*</code> / <code>analytics.*</code>), and <b>Measures</b>.
            </>
          ) : (
            <>
              Nested <code>ColGroupDef</code> headers with multi-row canvas painting.{' '}
              <code>columnGroupShow</code> drives per-column visibility: in <b>Market</b>, Levels +
              DV01 show <i>when expanded</i>, Px&nbsp;(net) shows <i>when collapsed</i>, Notional is{' '}
              <i>always visible</i>.
            </>
          )}{' '}
          Click a group label (▸/▾) to expand or collapse. Also right-click headers for the column
          context menu.
        </p>
      </div>
      <div className="controls">
        <button
          onClick={() =>
            (live ? liveApiRef.current : apiRef.current)?.setColumnGroupOpened(demoGroupId, true)
          }
        >
          Open {live ? 'Risk' : 'Market'} (API)
        </button>
        <button
          onClick={() =>
            (live ? liveApiRef.current : apiRef.current)?.setColumnGroupOpened(demoGroupId, false)
          }
        >
          Close {live ? 'Risk' : 'Market'} (API)
        </button>
        <button
          onClick={() => {
            const api = live ? liveApiRef.current : apiRef.current;
            api?.setColumnGroupState(api.getColumnGroupState().map((s) => ({ ...s, open: false })));
          }}
        >
          Close all (API)
        </button>
        <button
          onClick={() => {
            const api = live ? liveApiRef.current : apiRef.current;
            api?.setColumnGroupState(api.getColumnGroupState().map((s) => ({ ...s, open: true })));
          }}
        >
          Open all (API)
        </button>
      </div>
      <div className="grid-wrap">
        {live ? (
          <TabularGrid<FiPosition>
            key="stomp"
            columnDefs={liveColumnDefs}
            rowData={rows}
            getRowId={FI_GET_ROW_ID}
            density="compact"
            onReady={(api) => {
              liveApiRef.current = api;
              const sync = () =>
                setLiveGroupState(
                  api
                    .getColumnGroupState()
                    .map((s) => `${s.groupId}:${s.open ? 'open' : 'closed'}`)
                    .join(' · '),
                );
              api.on('columnGroupOpened', sync);
              sync();
            }}
          />
        ) : (
          <TabularGrid<Bond>
            key="synthetic"
            columnDefs={columnDefs}
            rowData={rowData}
            getRowId={(p) => p.data.id}
            density="compact"
            onReady={(api) => {
              apiRef.current = api;
              api.on('columnGroupOpened', () => {
                setGroupState(
                  api
                    .getColumnGroupState()
                    .map((s) => `${s.groupId}:${s.open ? 'open' : 'closed'}`)
                    .join(' · '),
                );
              });
              setGroupState(
                api
                  .getColumnGroupState()
                  .map((s) => `${s.groupId}:${s.open ? 'open' : 'closed'}`)
                  .join(' · '),
              );
            }}
          />
        )}
      </div>
      <div className="status">
        {(live ? liveGroupState : groupState) ? (
          <span>
            Group state <b>{live ? liveGroupState : groupState}</b>
          </span>
        ) : null}
        <FeedBadge status={status} />
      </div>
    </main>
  );
}
