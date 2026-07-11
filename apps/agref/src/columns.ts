/** Bond columns mirroring the tabular showcase, in AG Grid v33+ ColDef form. */
import type { ColDef, ValueFormatterParams, CellClassParams } from 'ag-grid-community';
import type { Bond } from './data';

const fmtInt = (p: ValueFormatterParams<Bond>) =>
  typeof p.value === 'number' ? Math.round(p.value).toLocaleString() : '';
const fmt2 = (p: ValueFormatterParams<Bond>) =>
  typeof p.value === 'number'
    ? p.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '';

const num: Partial<ColDef<Bond>> = {
  type: 'rightAligned',
  cellStyle: { fontFamily: "'JetBrains Mono', ui-monospace, monospace" },
};

export function bondColumns(): ColDef<Bond>[] {
  return [
    { field: 'cusip', headerName: 'CUSIP', pinned: 'left', width: 110 },
    { field: 'issuer', headerName: 'Issuer', width: 160, filter: 'agTextColumnFilter' },
    { field: 'sector', headerName: 'Sector', width: 110, filter: 'agTextColumnFilter' },
    {
      field: 'rating',
      headerName: 'Rating',
      width: 78,
      cellStyle: { textAlign: 'center' },
      filter: 'agTextColumnFilter',
    },
    { field: 'coupon', headerName: 'Coupon', ...num, width: 84, valueFormatter: fmt2 },
    {
      field: 'maturity',
      headerName: 'Maturity',
      width: 104,
      filter: 'agDateColumnFilter',
      filterParams: {
        comparator: (filterDate: Date, cellValue: string) => {
          const cell = new Date(`${cellValue}T00:00:00`);
          return cell.getTime() - filterDate.getTime();
        },
      },
    },
    { field: 'price', headerName: 'Price', ...num, width: 92, valueFormatter: fmt2 },
    { field: 'yld', headerName: 'Yield', ...num, width: 84, valueFormatter: fmt2 },
    {
      field: 'spread',
      headerName: 'Spread',
      ...num,
      width: 84,
      valueFormatter: fmtInt,
      filter: 'agNumberColumnFilter',
    },
    {
      field: 'dv01',
      headerName: 'DV01',
      ...num,
      width: 96,
      valueFormatter: fmtInt,
      filter: 'agNumberColumnFilter',
    },
    {
      field: 'notional',
      headerName: 'Notional',
      ...num,
      width: 116,
      valueFormatter: fmtInt,
      filter: 'agNumberColumnFilter',
    },
    {
      field: 'pnl',
      headerName: 'PnL',
      type: 'rightAligned',
      width: 108,
      valueFormatter: (p: ValueFormatterParams<Bond>) => {
        const v = p.value as number;
        if (typeof v !== 'number') return '';
        return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v)).toLocaleString()}`;
      },
      cellStyle: (p: CellClassParams<Bond>) => {
        const v = p.value as number;
        const base = { fontFamily: "'JetBrains Mono', ui-monospace, monospace" };
        return v > 0 ? { ...base, color: '#3FA266' } : v < 0 ? { ...base, color: '#E34671' } : base;
      },
    },
    { field: 'desk', headerName: 'Desk', width: 100 },
    { field: 'trader', headerName: 'Trader', width: 90 },
  ];
}
