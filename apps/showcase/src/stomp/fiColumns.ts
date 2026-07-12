/**
 * Shared FI position column definitions for STOMP-fed showcase pages.
 * Pages compose from these so nested dot-path fields (rating.*, issuer.*,
 * riskMetrics.*, analytics.*) are exercised consistently everywhere.
 */
import type { ColDef } from '@tabular/core';
import type { FiPosition } from './fiPositionsSource';

export const FI_ID: ColDef<FiPosition> = {
  field: 'cusip',
  headerName: 'CUSIP',
  width: 110,
};

/** Identity / descriptive columns. */
export const FI_DESC: ColDef<FiPosition>[] = [
  { field: 'ticker', headerName: 'Ticker', width: 90 },
  { field: 'instrumentName', headerName: 'Instrument', width: 170 },
  { field: 'desk', headerName: 'Desk', width: 110, enableRowGroup: true },
  { field: 'trader', headerName: 'Trader', width: 100, enableRowGroup: true },
  { field: 'region', headerName: 'Region', width: 90, enableRowGroup: true },
  { field: 'currency', headerName: 'Ccy', width: 60 },
];

/** Nested-object columns — the dot-path stress set. */
export const FI_NESTED: ColDef<FiPosition>[] = [
  { field: 'rating.composite', headerName: 'Rating', width: 80, enableRowGroup: true },
  { field: 'rating.moody', headerName: "Moody's", width: 80 },
  { field: 'issuer.name', headerName: 'Issuer', width: 160 },
  { field: 'issuer.sector', headerName: 'Sector', width: 110, enableRowGroup: true },
  { field: 'riskMetrics.var95', headerName: 'VaR 95', type: 'number', width: 110, format: '#,##0', aggFunc: 'sum' },
  { field: 'analytics.keyRateDuration.10Y', headerName: 'KRD 10Y', type: 'number', width: 90, format: '#,##0.0000' },
];

/** Numeric/measure columns (flat — safe for editing, calc DSL, worker agg). */
export const FI_MEASURES: ColDef<FiPosition>[] = [
  { field: 'quantity', headerName: 'Qty', type: 'number', width: 90, format: '#,##0' },
  { field: 'notionalAmount', headerName: 'Notional', type: 'number', width: 120, format: '#,##0', aggFunc: 'sum' },
  { field: 'marketValue', headerName: 'Mkt Value', type: 'number', width: 130, format: '#,##0.00', aggFunc: 'sum' },
  { field: 'currentPrice', headerName: 'Price', type: 'number', width: 90, format: '#,##0.0000' },
  { field: 'pnl', headerName: 'PnL', type: 'number', width: 110, format: '#,##0', aggFunc: 'sum' },
  { field: 'dailyPnl', headerName: 'Day PnL', type: 'number', width: 100, format: '#,##0', aggFunc: 'sum' },
  { field: 'yield', headerName: 'Yield', type: 'number', width: 80, format: '#,##0.000' },
  { field: 'dv01', headerName: 'DV01', type: 'number', width: 90, format: '#,##0.00', aggFunc: 'sum' },
  { field: 'spread', headerName: 'Spread', type: 'number', width: 80, format: '#,##0' },
];

/** The standard broad set most pages use. */
export const FI_COLUMNS: ColDef<FiPosition>[] = [
  { ...FI_ID, pinned: 'left' },
  ...FI_DESC,
  ...FI_NESTED,
  ...FI_MEASURES,
];

export const FI_GET_ROW_ID = (p: { data: FiPosition }): string => String(p.data.positionId);
