import { useEffect, useRef, useState } from 'react';
import type { ColDef, Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { connectFiPositions, type FiPosition } from '../stomp/fiPositionsSource';

const mainMode =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('main') === '1';

/**
 * Stable initial rowData: the react wrapper re-applies the rowData prop when
 * its identity changes, so an inline `[]` would wipe the streamed rows on
 * every meter re-render. Data arrives exclusively via api.setRowData /
 * applyTransactionAsync.
 */
const EMPTY_ROWS: FiPosition[] = [];

/**
 * Wide nested FI rows from the STOMP view server. Nested dot-path fields
 * (rating.*, issuer.*, riskMetrics.*, analytics.keyRateDuration.*) exercise
 * exactly the parts of the pipeline flat demo data never touches.
 */
const columnDefs: ColDef<FiPosition>[] = [
  { field: 'cusip', headerName: 'CUSIP', pinned: 'left', width: 110 },
  { field: 'ticker', headerName: 'Ticker', width: 90 },
  { field: 'instrumentName', headerName: 'Instrument', width: 170 },
  { field: 'desk', headerName: 'Desk', width: 110, enableRowGroup: true },
  { field: 'trader', headerName: 'Trader', width: 100, enableRowGroup: true },
  { field: 'region', headerName: 'Region', width: 90, enableRowGroup: true },
  { field: 'currency', headerName: 'Ccy', width: 60 },
  { field: 'rating.composite', headerName: 'Rating', width: 80, enableRowGroup: true },
  { field: 'rating.moody', headerName: "Moody's", width: 80 },
  { field: 'rating.sp', headerName: 'S&P', width: 70 },
  { field: 'issuer.name', headerName: 'Issuer', width: 160 },
  { field: 'issuer.sector', headerName: 'Sector', width: 110, enableRowGroup: true },
  { field: 'notionalAmount', headerName: 'Notional', type: 'number', width: 120, format: '#,##0', aggFunc: 'sum' },
  { field: 'marketValue', headerName: 'Mkt Value', type: 'number', width: 130, format: '#,##0.00', aggFunc: 'sum' },
  { field: 'currentPrice', headerName: 'Price', type: 'number', width: 90, format: '#,##0.0000' },
  { field: 'pnl', headerName: 'PnL', type: 'number', width: 110, format: '#,##0', aggFunc: 'sum' },
  { field: 'dailyPnl', headerName: 'Day PnL', type: 'number', width: 100, format: '#,##0', aggFunc: 'sum' },
  { field: 'ytdPnl', headerName: 'YTD PnL', type: 'number', width: 110, format: '#,##0' },
  { field: 'yield', headerName: 'Yield', type: 'number', width: 80, format: '#,##0.000' },
  { field: 'modifiedDuration', headerName: 'Mod Dur', type: 'number', width: 90, format: '#,##0.00' },
  { field: 'dv01', headerName: 'DV01', type: 'number', width: 90, format: '#,##0.00', aggFunc: 'sum' },
  { field: 'spread', headerName: 'Spread', type: 'number', width: 80, format: '#,##0' },
  { field: 'riskMetrics.var95', headerName: 'VaR 95', type: 'number', width: 110, format: '#,##0', aggFunc: 'sum' },
  { field: 'riskMetrics.sharpeRatio', headerName: 'Sharpe', type: 'number', width: 80, format: '#,##0.000' },
  { field: 'analytics.keyRateDuration.2Y', headerName: 'KRD 2Y', type: 'number', width: 90, format: '#,##0.0000' },
  { field: 'analytics.keyRateDuration.10Y', headerName: 'KRD 10Y', type: 'number', width: 90, format: '#,##0.0000' },
  { field: 'bucket_0_pv', headerName: 'Bucket 0 PV', type: 'number', width: 110, format: '#,##0' },
];

export function StompLivePage() {
  const apiRef = useRef<Tabular<FiPosition> | null>(null);
  const [rows, setRows] = useState(5000);
  const [rate, setRate] = useState(200);
  const [upt, setUpt] = useState(50);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('idle — start the server with `npm run dev:stomp`, then connect');
  const [updPerSec, setUpdPerSec] = useState(0);

  useEffect(() => {
    if (!running) return;
    let received = 0;
    const meter = setInterval(() => {
      setUpdPerSec(received);
      received = 0;
    }, 1000);
    const dispose = connectFiPositions(
      { rows, rate, updatesPerTick: upt },
      {
        onStatus: setStatus,
        onSnapshotProgress: (n) => setStatus(`snapshot: ${n.toLocaleString()} rows…`),
        onReady: (all) => apiRef.current?.setRowData(all),
        onUpdates: (batch) => {
          received += batch.length;
          apiRef.current?.applyTransactionAsync({ update: batch });
        },
      },
    );
    return () => {
      clearInterval(meter);
      dispose();
    };
  }, [running, rows, rate, upt]);

  return (
    <main className="page">
      <div className="page-head">
        <h2>STOMP live feed — wide nested FI positions</h2>
        <p>
          Real-time datasource from <code>apps/stomp-view-server</code> (STOMP 1.2 over WebSocket,
          port 8081): snapshot then full-row live updates at up to {(rate * upt).toLocaleString()}
          /s. Rows are wide (~1,500 flattened paths) with nested objects — the grid reads them via
          dot-path fields like <code>rating.composite</code> and{' '}
          <code>analytics.keyRateDuration.10Y</code>. Append <code>?main=1</code> to force the
          main-thread data plane.
        </p>
      </div>
      <div className="controls">
        <button onClick={() => setRunning(!running)}>{running ? 'Disconnect' : 'Connect'}</button>
        <label>
          Rows{' '}
          <select value={rows} onChange={(e) => setRows(Number(e.target.value))} disabled={running}>
            {[1000, 5000, 10000, 20000].map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </select>
        </label>
        <label>
          Ticks/s{' '}
          <select value={rate} onChange={(e) => setRate(Number(e.target.value))} disabled={running}>
            {[50, 100, 200, 500].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          Updates/tick{' '}
          <select value={upt} onChange={(e) => setUpt(Number(e.target.value))} disabled={running}>
            {[1, 10, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <span>
          Target <b>{(rate * upt).toLocaleString()}/s</b>
        </span>
        <span>
          Applied <b>{updPerSec.toLocaleString()}/s</b>
        </span>
        <span>{status}</span>
      </div>
      <div className="grid-wrap">
        <TabularGrid<FiPosition>
          columnDefs={columnDefs}
          rowData={EMPTY_ROWS}
          getRowId={(p) => String(p.data.positionId)}
          rowDataMode={mainMode ? 'main' : 'worker'}
          density="dense"
          rowGroupPanelShow="onlyWhenGrouping"
          onReady={(api) => {
            apiRef.current = api;
            (window as unknown as { __stompApi?: unknown }).__stompApi = api;
          }}
        />
      </div>
    </main>
  );
}
