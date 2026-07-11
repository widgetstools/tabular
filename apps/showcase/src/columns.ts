/** Shared bond column definitions used across showcase pages. */
import type { CellParams, ColDef } from '@tabular/core';
import type { Bond } from './data';

const fmtInt = (p: CellParams<Bond>) =>
  typeof p.value === 'number' ? Math.round(p.value).toLocaleString() : '';
const fmt2 = (p: CellParams<Bond>) =>
  typeof p.value === 'number'
    ? p.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '';

export function bondColumns(): ColDef<Bond>[] {
  return [
    { field: 'cusip', headerName: 'CUSIP', pinned: 'left', width: 110 },
    { field: 'issuer', headerName: 'Issuer', width: 160, filter: 'text' },
    { field: 'sector', headerName: 'Sector', width: 110, filter: 'text' },
    { field: 'rating', headerName: 'Rating', width: 78, align: 'center', filter: 'text' },
    { field: 'coupon', headerName: 'Coupon', type: 'number', width: 84, valueFormatter: fmt2 },
    { field: 'maturity', headerName: 'Maturity', width: 104, filter: 'date' },
    { field: 'price', headerName: 'Price', type: 'number', width: 92, valueFormatter: fmt2 },
    { field: 'yld', headerName: 'Yield', type: 'number', width: 84, valueFormatter: fmt2 },
    { field: 'spread', headerName: 'Spread', type: 'number', width: 84, valueFormatter: fmtInt, filter: 'number' },
    { field: 'dv01', headerName: 'DV01', type: 'number', width: 96, valueFormatter: fmtInt, filter: 'number' },
    { field: 'notional', headerName: 'Notional', type: 'number', width: 116, valueFormatter: fmtInt, filter: 'number' },
    {
      field: 'pnl',
      headerName: 'PnL',
      type: 'number',
      width: 108,
      valueFormatter: (p) => {
        const v = p.value as number;
        return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v)).toLocaleString()}`;
      },
      cellStyle: (p) => {
        const v = p.value as number;
        const t = p.api.getTheme();
        return v > 0 ? { color: t.up } : v < 0 ? { color: t.down } : undefined;
      },
    },
    { field: 'desk', headerName: 'Desk', width: 100 },
    { field: 'trader', headerName: 'Trader', width: 90 },
  ];
}
