import { useMemo, useRef, useState } from 'react';
import { TabularGrid } from '@tabular/react';
import type { AnyColDef, Tabular } from '@tabular/core';
import { makeBonds, type Bond } from '../data';

export function ColumnGroupsPage() {
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

  return (
    <main className="page">
      <div className="page-head">
        <h2>Column groups</h2>
        <p>
          Nested <code>ColGroupDef</code> headers with multi-row canvas painting. Click a group label
          (▸/▾) to expand or collapse. <code>columnGroupShow</code> drives per-column visibility:
          in <b>Market</b>, Levels + DV01 show <i>when expanded</i>, Px&nbsp;(net) shows{' '}
          <i>when collapsed</i>, Notional is <i>always visible</i>. Also right-click headers for the
          column context menu.
        </p>
      </div>
      <div className="controls">
        <button onClick={() => apiRef.current?.setColumnGroupOpened('market', true)}>
          Open Market (API)
        </button>
        <button onClick={() => apiRef.current?.setColumnGroupOpened('market', false)}>
          Close Market (API)
        </button>
        <button
          onClick={() =>
            apiRef.current?.setColumnGroupState(
              apiRef.current.getColumnGroupState().map((s) => ({ ...s, open: false })),
            )
          }
        >
          Close all (API)
        </button>
        <button
          onClick={() =>
            apiRef.current?.setColumnGroupState(
              apiRef.current.getColumnGroupState().map((s) => ({ ...s, open: true })),
            )
          }
        >
          Open all (API)
        </button>
      </div>
      <div className="grid-wrap">
        <TabularGrid<Bond>
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
      </div>
      {groupState ? (
        <div className="status">
          <span>
            Group state <b>{groupState}</b>
          </span>
        </div>
      ) : null}
    </main>
  );
}
