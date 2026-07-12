import { useEffect, useMemo, useRef, useState } from 'react';
import type { ColDef, Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';
import { FI_COLUMNS, FI_GET_ROW_ID } from '../stomp/fiColumns';
import type { FiPosition } from '../stomp/fiPositionsSource';
import { useFiFeed, useFiUpdates } from '../stomp/sharedFeed';
import { FeedBadge } from '../stomp/FeedBadge';

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

/** Aggregate a bucket of FI positions into a pinned summary row: sum of
 * notional / market value / PnL, weighted-average price. Nested/dot-path
 * fields are left blank, mirroring how the synthetic summaryRow blanks
 * issuer/sector/rating. */
function fiSummaryRow(rows: FiPosition[], label: string): FiPosition {
  const num = (r: FiPosition, f: string) => Number(r[f] ?? 0);
  const sum = (f: string) => rows.reduce((a, r) => a + num(r, f), 0);
  const notional = sum('notionalAmount');
  const wavgPrice = notional
    ? rows.reduce((a, r) => a + num(r, 'currentPrice') * num(r, 'notionalAmount'), 0) / notional
    : 0;
  return {
    positionId: `pinned-${label}`,
    cusip: label,
    ticker: '',
    instrumentName: label,
    desk: '',
    trader: '',
    region: '',
    currency: '',
    currentPrice: wavgPrice,
    notionalAmount: notional,
    marketValue: sum('marketValue'),
    pnl: sum('pnl'),
    quantity: sum('quantity'),
    dailyPnl: sum('dailyPnl'),
    yield: 0,
    dv01: sum('dv01'),
    spread: 0,
    rating: { composite: '', moody: '' },
    issuer: { name: '', sector: '' },
    riskMetrics: { var95: 0 },
    analytics: { keyRateDuration: { '10Y': 0 } },
  } as unknown as FiPosition;
}

export function PinnedRowsPage() {
  const { rows, status } = useFiFeed();
  const live = status === 'ready' && rows;
  const liveApiRef = useRef<Tabular<FiPosition> | null>(null);
  // Track the latest known state of every row (snapshot + applied live
  // updates) so the 1s recompute below reflects the same data the grid is
  // painting, not just the original snapshot. The Tabular API has no
  // getRowData()/forEachNode() to read the grid's own row model back out,
  // so we mirror it locally from the same update stream we feed the grid.
  const liveRowsMapRef = useRef<Map<string, FiPosition>>(new Map());
  useEffect(() => {
    if (rows) liveRowsMapRef.current = new Map(rows.map((r) => [String(r.positionId), r]));
  }, [rows]);
  useFiUpdates((batch) => {
    liveApiRef.current?.applyTransactionAsync({ update: batch });
    for (const r of batch) liveRowsMapRef.current.set(String(r.positionId), r);
  }, !!live);

  const [livePinnedTop, setLivePinnedTop] = useState<FiPosition[]>([]);
  const [livePinnedBottom, setLivePinnedBottom] = useState<FiPosition[]>([]);
  useEffect(() => {
    if (!live) return;
    const recompute = () => {
      const all = Array.from(liveRowsMapRef.current.values());
      if (all.length === 0) return;
      const top = [fiSummaryRow(all, 'BOOK')];
      const bottom = [
        fiSummaryRow(all.filter((r) => r.desk === 'IG Credit'), 'IG TOTAL'),
        fiSummaryRow(all.filter((r) => r.desk === 'HY Credit'), 'HY TOTAL'),
      ];
      setLivePinnedTop(top);
      setLivePinnedBottom(bottom);
      liveApiRef.current?.updateOptions({ pinnedTopRowData: top, pinnedBottomRowData: bottom });
    };
    recompute();
    const id = setInterval(recompute, 1000);
    return () => clearInterval(id);
  }, [live]);

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
          {live ? (
            <>
              {' '}
              Live FI positions: totals recompute every second from the running snapshot + tick
              stream (sum of notional / market value / PnL, weighted-average price).
            </>
          ) : null}
        </p>
      </div>
      <div className="grid-wrap">
        {live ? (
          <TabularGrid<FiPosition>
            key="stomp"
            columnDefs={FI_COLUMNS}
            rowData={rows}
            getRowId={FI_GET_ROW_ID}
            pinnedTopRowData={livePinnedTop}
            pinnedBottomRowData={livePinnedBottom}
            cellSelection
            suppressRowClickSelection
            statusBar
            density="comfortable"
            onReady={(api) => {
              liveApiRef.current = api;
            }}
          />
        ) : (
          <TabularGrid<Bond>
            key="synthetic"
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
        )}
      </div>
      <div className="status">
        <span>
          Pinned top <b>1</b> · pinned bottom <b>2</b> · body rows{' '}
          <b>{(live ? rows.length : rowData.length).toLocaleString()}</b>
        </span>
        <FeedBadge status={status} />
      </div>
    </main>
  );
}
