/**
 * Fixed-income blotter — the vanilla-TS reference app. No framework:
 * `new Tabular(container, options)` and DOM chrome around it.
 */
import { Tabular, type CellParams, type ColDef, type Density, type ThemeName } from '@tabular/core';
import { makeBonds, makeRng, tick, type Bond } from './data';

const ROWS = 20_000;
const TICK_INTERVAL_MS = 50;

const fmt2 = (p: CellParams<Bond>) =>
  typeof p.value === 'number'
    ? p.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '';
const fmtInt = (p: CellParams<Bond>) =>
  typeof p.value === 'number' ? Math.round(p.value).toLocaleString() : '';

const pnlStyle = (p: CellParams<Bond>) => {
  const v = p.value as number;
  const t = p.api.getTheme();
  return v > 0 ? { color: t.up } : v < 0 ? { color: t.down } : undefined;
};

const columnDefs: ColDef<Bond>[] = [
  { field: 'cusip', headerName: 'CUSIP', pinned: 'left', width: 108 },
  { field: 'issuer', headerName: 'Issuer', width: 158 },
  { field: 'rating', headerName: 'Rtg', width: 64, align: 'center' },
  { field: 'sector', headerName: 'Sector', width: 106 },
  { field: 'coupon', headerName: 'Cpn', type: 'number', width: 70, valueFormatter: fmt2 },
  { field: 'maturity', headerName: 'Maturity', width: 100 },
  { field: 'bid', headerName: 'Bid', type: 'number', width: 84, valueFormatter: fmt2 },
  { field: 'ask', headerName: 'Ask', type: 'number', width: 84, valueFormatter: fmt2 },
  { field: 'yld', headerName: 'Yield', type: 'number', width: 78, valueFormatter: fmt2 },
  { field: 'spread', headerName: 'Sprd', type: 'number', width: 72, valueFormatter: fmtInt },
  { field: 'dv01', headerName: 'DV01', type: 'number', width: 92, valueFormatter: fmtInt },
  { field: 'notional', headerName: 'Notional', type: 'number', width: 112, valueFormatter: fmtInt },
  {
    field: 'pnl',
    headerName: 'PnL',
    type: 'number',
    width: 104,
    pinned: 'right',
    valueFormatter: (p) => {
      const v = p.value as number;
      return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v)).toLocaleString()}`;
    },
    cellStyle: pnlStyle,
  },
  { field: 'desk', headerName: 'Desk', width: 92 },
  { field: 'trader', headerName: 'Trader', width: 82 },
];

const rows = makeBonds(ROWS);

const grid = new Tabular<Bond>(document.getElementById('grid')!, {
  columnDefs,
  rowData: rows,
  getRowId: (p) => p.data.id,
  rowSelection: 'multiple',
  theme: 'dark',
  density: 'compact',
});

// ── ticking ──────────────────────────────────────────────────────────
const rnd = makeRng(77);
let running = true;
let perBatch = Math.round((4000 * TICK_INTERVAL_MS) / 1000);
let applied = 0;

setInterval(() => {
  if (!running) return;
  const batch = tick(rows, perBatch, rnd);
  for (const u of batch) rows[Number(u.id.slice(1))] = u;
  grid.applyTransactionAsync({ update: batch });
  applied += batch.length;
}, TICK_INTERVAL_MS);

// ── toolbar ──────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

$<HTMLSelectElement>('rate').addEventListener('change', (e) => {
  const perSec = Number((e.target as HTMLSelectElement).value);
  perBatch = Math.max(1, Math.round((perSec * TICK_INTERVAL_MS) / 1000));
});

$('pause').addEventListener('click', () => {
  running = !running;
  $('pause').textContent = running ? 'Pause' : 'Resume';
});

const densities: Density[] = ['comfortable', 'compact', 'dense'];
let densityIx = 1;
$('density').addEventListener('click', () => {
  densityIx = (densityIx + 1) % densities.length;
  grid.setDensity(densities[densityIx]);
  $('density').textContent = `Density: ${densities[densityIx]}`;
});

let theme: ThemeName = 'dark';
$('theme').addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  grid.setTheme(theme);
  document.body.classList.toggle('light', theme === 'light');
  $('theme').textContent = theme === 'dark' ? 'Theme: Cursor Dark' : 'Theme: Cursor Light';
});

$('export').addEventListener('click', () => {
  const blob = new Blob([grid.exportCsv()], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'blotter.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});

// ── status bar ───────────────────────────────────────────────────────
function renderCounts(): void {
  $('counts').innerHTML = `Rows <b>${grid.getRowCount().toLocaleString()}</b> · Displayed <b>${grid
    .getDisplayedRowCount()
    .toLocaleString()}</b> · Updates <b>${applied.toLocaleString()}</b>`;
}

function renderSelection(): void {
  const sel = grid.getSelectedRows();
  if (!sel.length) {
    $('selection').textContent = '';
    $('aggregates').textContent = '';
    return;
  }
  const notional = sel.reduce((s, b) => s + b.notional, 0);
  const pnl = sel.reduce((s, b) => s + b.pnl, 0);
  const wSpread = sel.reduce((s, b) => s + b.spread * b.notional, 0) / notional;
  $('selection').innerHTML = `Selected <b>${sel.length.toLocaleString()}</b>`;
  $('aggregates').innerHTML =
    `Σ Notional <b>${notional.toLocaleString()}</b> · Σ PnL <b>${Math.round(pnl).toLocaleString()}</b>` +
    ` · Wtd Sprd <b>${wSpread.toFixed(1)}</b>`;
}

grid.on('modelUpdated', renderCounts);
grid.on('selectionChanged', renderSelection);
setInterval(renderCounts, 1000);
renderCounts();
