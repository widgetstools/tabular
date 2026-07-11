import { useMemo, useRef } from 'react';
import type { ColDef, Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
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
  const columnDefs = useMemo<ColDef<Bond>[]>(() => bondColumns(), []);
  const apiRef = useRef<Tabular<Bond> | null>(null);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Row pinning</h2>
        <p>
          AG-style pinned rows: <code>pinnedTopRowData</code> holds a book-level summary above the
          viewport, <code>pinnedBottomRowData</code> holds per-desk totals below it. Pinned rows
          are outside the row model — they never sort, filter or select — and stay put while the
          body scrolls. Data updates go through{' '}
          <code>updateOptions(&#123; pinnedTopRowData &#125;)</code>{' '}
          (<code>pinnedRowDataChanged</code> fires). Weighted averages for Coupon/Price/Yield/Spread,
          sums for DV01/Notional/PnL.
        </p>
      </div>
      <div className="grid-wrap">
        <TabularGrid<Bond>
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
          pinnedTopRowData={pinnedTop}
          pinnedBottomRowData={pinnedBottom}
          cellSelection
          suppressRowClickSelection
          statusBar
          density="comfortable"
          onReady={(api) => {
            apiRef.current = api;
            (window as unknown as { __pinnedApi: Tabular<Bond> }).__pinnedApi = api;
          }}
        />
      </div>
      <div className="status">
        <span>
          Pinned top <b>1</b> · pinned bottom <b>2</b> · body rows <b>{rowData.length}</b>
        </span>
      </div>
    </main>
  );
}
