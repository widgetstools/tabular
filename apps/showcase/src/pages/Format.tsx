import { useMemo, useRef } from 'react';
import type { ColDef, Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';
import { FI_ID, FI_GET_ROW_ID } from '../stomp/fiColumns';
import type { FiPosition } from '../stomp/fiPositionsSource';
import { useFiFeed, useFiUpdates } from '../stomp/sharedFeed';
import { FeedBadge } from '../stomp/FeedBadge';

/**
 * Live columns: same Format DSL codes/presets, over FI measures.
 * `changePct` is a `valueGetter` (pnl / notionalAmount) — computed on every
 * render so it stays correct across live tick updates without needing a
 * physical field. `issuer.name` / `metadata.modifiedDate` are nested
 * dot-path display extras (relativeTime format on the latter).
 */
const liveColumnDefs: ColDef<FiPosition>[] = [
  { ...FI_ID, pinned: 'left' },
  { field: 'issuer.name', headerName: 'Issuer', width: 160 },
  { field: 'desk', headerName: 'Desk', width: 100 },
  {
    field: 'currentPrice',
    headerName: 'Price #,##0.00',
    type: 'number',
    width: 110,
    format: '#,##0.00',
  },
  {
    field: 'notionalAmount',
    headerName: 'Notional (currency)',
    type: 'number',
    width: 140,
    format: 'currency',
  },
  {
    field: 'notionalAmount',
    colId: 'notionalAbbrev',
    headerName: 'Notional (K/M/B)',
    type: 'number',
    width: 120,
    format: 'abbreviated',
  },
  {
    colId: 'changePct',
    headerName: 'Change %',
    type: 'number',
    width: 100,
    format: 'percent',
    valueGetter: (p) => {
      const pnl = Number(p.data?.pnl ?? 0);
      const notional = Number(p.data?.notionalAmount ?? 0);
      return notional ? pnl / notional : 0;
    },
  },
  {
    field: 'pnl',
    headerName: 'PnL [up]/[down]',
    type: 'number',
    width: 130,
    format: '[up]#,##0;[down]-#,##0;0',
  },
  {
    field: 'pnl',
    colId: 'pnlTags',
    headerName: 'PnL Tier1 tags',
    type: 'number',
    width: 130,
    format: '[if=x<0:[color=down][weight=bold]]#,##0;[if=x>=0:[color=up]]#,##0',
  },
  {
    field: 'spread',
    headerName: 'Spread 0.00',
    type: 'number',
    width: 100,
    format: '0.00',
  },
  {
    field: 'maturityDate',
    headerName: 'Maturity date',
    width: 120,
    format: 'yyyy-mm-dd',
  },
  {
    field: 'metadata.modifiedDate',
    headerName: 'Modified (relative)',
    width: 140,
    format: 'relativeTime',
  },
  {
    field: 'couponRate',
    headerName: 'Coupon 0.000%',
    type: 'number',
    width: 110,
    format: '0.000"%"',
  },
  {
    field: 'dv01',
    headerName: 'DV01 scaled',
    type: 'number',
    width: 100,
    format: '#,##0,',
  },
];

/**
 * Phase 5 Tier 0 — Excel-style format codes + named presets via ColDef.format.
 */
export function FormatPage() {
  const { rows, status } = useFiFeed();
  const live = status === 'ready' && rows;
  const liveApiRef = useRef<Tabular<FiPosition> | null>(null);
  useFiUpdates(
    (batch) => liveApiRef.current?.applyTransactionAsync({ update: batch }),
    !!live,
  );

  const rowData = useMemo(() => {
    const bonds = makeBonds(200);
    const now = Date.now();
    return bonds.map((b, i) => ({
      ...b,
      // Fraction for percent preset (0.0123 → 1.23%)
      changePct: (b.pnl / Math.max(1, b.notional)) * (i % 3 === 0 ? -1 : 1),
      tradedAt: new Date(now - (i * 37 + 5) * 60_000).toISOString(),
    }));
  }, []);

  const columnDefs = useMemo<ColDef<(typeof rowData)[number]>[]>(
    () => [
      { field: 'issuer', headerName: 'Issuer', width: 150 },
      { field: 'desk', headerName: 'Desk', width: 100 },
      {
        field: 'price',
        headerName: 'Price #,##0.00',
        type: 'number',
        width: 110,
        format: '#,##0.00',
      },
      {
        field: 'notional',
        headerName: 'Notional (currency)',
        type: 'number',
        width: 140,
        format: 'currency',
      },
      {
        field: 'notional',
        colId: 'notionalAbbrev',
        headerName: 'Notional (K/M/B)',
        type: 'number',
        width: 120,
        format: 'abbreviated',
      },
      {
        field: 'changePct',
        headerName: 'Change %',
        type: 'number',
        width: 100,
        format: 'percent',
      },
      {
        field: 'pnl',
        headerName: 'PnL [up]/[down]',
        type: 'number',
        width: 130,
        // Section colors: theme tokens preferred over Excel [Red]/[Green]
        format: '[up]#,##0;[down]-#,##0;0',
      },
      {
        field: 'pnl',
        colId: 'pnlTags',
        headerName: 'PnL Tier1 tags',
        type: 'number',
        width: 130,
        format: '[if=x<0:[color=down][weight=bold]]#,##0;[if=x>=0:[color=up]]#,##0',
      },
      {
        field: 'spread',
        headerName: 'Spread 0.00',
        type: 'number',
        width: 100,
        format: '0.00',
      },
      {
        field: 'maturity',
        headerName: 'Maturity date',
        width: 120,
        format: 'yyyy-mm-dd',
      },
      {
        field: 'tradedAt',
        headerName: 'Traded (relative)',
        width: 130,
        format: 'relativeTime',
      },
      {
        field: 'coupon',
        headerName: 'Coupon 0.000%',
        type: 'number',
        width: 110,
        // coupon is already a percent-ish number (e.g. 5.25) — scale display
        format: '0.000"%"',
      },
      {
        field: 'dv01',
        headerName: 'DV01 scaled',
        type: 'number',
        width: 100,
        format: '#,##0,',
      },
    ],
    [],
  );

  return (
    <main className="page">
      <div className="page-head">
        <h2>Format DSL (Tier 0)</h2>
        <p>
          <code>ColDef.format</code> Excel codes (<code>pos;neg;zero;text</code>) and presets (
          <code>number</code>, <code>currency</code>, <code>percent</code>, <code>date</code>,{' '}
          <code>relativeTime</code>, <code>abbreviated</code>). Bracket colors map to theme tokens (
          <code>[up]</code>/<code>[down]</code>). Bad codes fail closed to <code>String(value)</code>.
          {live ? (
            <>
              {' '}
              Live FI positions — same codes over <code>currentPrice</code>/<code>notionalAmount</code>
              /<code>pnl</code>/<code>spread</code>/<code>dv01</code>; <code>issuer.name</code> and{' '}
              <code>metadata.modifiedDate</code> are nested dot-path display extras.
            </>
          ) : null}
        </p>
      </div>
      <div className="grid-wrap">
        {live ? (
          <TabularGrid<FiPosition>
            key="stomp"
            columnDefs={liveColumnDefs}
            rowData={rows}
            getRowId={FI_GET_ROW_ID}
            formatting={{ locale: 'en-US', currency: 'USD' }}
            defaultColDef={{ sortable: true, filter: true, resizable: true }}
            onReady={(api) => {
              liveApiRef.current = api;
            }}
          />
        ) : (
          <TabularGrid<Bond & { changePct: number; tradedAt: string }>
            key="synthetic"
            columnDefs={columnDefs}
            rowData={rowData}
            formatting={{ locale: 'en-US', currency: 'USD' }}
            defaultColDef={{ sortable: true, filter: true, resizable: true }}
          />
        )}
      </div>
      <div className="status">
        <FeedBadge status={status} />
      </div>
    </main>
  );
}
