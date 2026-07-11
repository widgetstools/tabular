import { useMemo } from 'react';
import type { ColDef } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';

/**
 * Phase 5 Tier 0 — Excel-style format codes + named presets via ColDef.format.
 */
export function FormatPage() {
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
        </p>
      </div>
      <div className="grid-wrap">
        <TabularGrid<Bond & { changePct: number; tradedAt: string }>
          columnDefs={columnDefs}
          rowData={rowData}
          formatting={{ locale: 'en-US', currency: 'USD' }}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
        />
      </div>
    </main>
  );
}
