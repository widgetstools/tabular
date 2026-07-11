import { useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { gridTheme } from '../theme';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';

/** Aggregate the book into a synthetic summary row for the pinned bands. */
function summaryRow(rows: Bond[], label: string): Bond {
  const sum = (f: (b: Bond) => number) => rows.reduce((a, b) => a + f(b), 0);
  const notional = sum((b) => b.notional);
  const wavg = (f: (b: Bond) => number) =>
    notional ? rows.reduce((a, b) => a + f(b) * b.notional, 0) / notional : 0;
  return {
    id: `pinned-${label}`,
    cusip: label,
    issuer: '',
    sector: '',
    rating: '',
    coupon: wavg((b) => b.coupon),
    maturity: '',
    price: wavg((b) => b.price),
    yld: wavg((b) => b.yld),
    spread: wavg((b) => b.spread),
    dv01: sum((b) => b.dv01),
    notional,
    pnl: sum((b) => b.pnl),
    desk: '',
    trader: '',
  };
}

export function PinnedRowsPage() {
  const rowData = useMemo(() => makeBonds(500), []);
  const pinnedTop = useMemo(() => [summaryRow(rowData, 'BOOK')], [rowData]);
  const pinnedBottom = useMemo(
    () => [
      summaryRow(rowData.filter((b) => b.desk === 'IG Credit'), 'IG TOTAL'),
      summaryRow(rowData.filter((b) => b.desk === 'HY Credit'), 'HY TOTAL'),
    ],
    [rowData],
  );
  const columnDefs = useMemo(() => bondColumns(), []);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Row pinning</h2>
        <p>
          pinnedTopRowData: book summary; pinnedBottomRowData: per-desk totals. Pinned rows never
          sort, filter or select.
        </p>
      </div>
      <div className="grid-wrap">
        <AgGridReact<Bond>
          theme={gridTheme}
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
          pinnedTopRowData={pinnedTop}
          pinnedBottomRowData={pinnedBottom}
          cellSelection
        />
      </div>
    </main>
  );
}
