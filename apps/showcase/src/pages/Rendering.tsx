import { useMemo, useRef } from 'react';
import {
  registerCellRenderer,
  withAlpha,
  type CellParams,
  type CellRendererComp,
  type CellStyle,
  type ColDef,
  type Tabular,
} from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';
import { FI_ID, FI_GET_ROW_ID } from '../stomp/fiColumns';
import type { FiPosition } from '../stomp/fiPositionsSource';
import { useFiFeed, useFiUpdates } from '../stomp/sharedFeed';
import { FeedBadge } from '../stomp/FeedBadge';

const IG = new Set(['AAA', 'AA+', 'AA', 'AA-', 'A+', 'A', 'A-', 'BBB+', 'BBB', 'BBB-']);
const HY = new Set(['BB+', 'BB', 'BB-', 'B+', 'B', 'B-']);

// Registered canvas renderer — columns reference it by name (`cellRenderer:
// 'ratingPill'`), mirroring AG's registered-component pattern.
const ratingPill: CellRendererComp<Bond | FiPosition> = {
  paint(ctx, p) {
    const label = String(p.value ?? '');
    if (!label) return;
    const t = p.theme;
    const color = IG.has(label) ? '#3fb27f' : HY.has(label) ? '#d29a43' : '#d05f5f';
    ctx.font = `600 ${t.fontSize - 1}px ${t.fontSans}`;
    const pw = Math.min(p.width - 8, ctx.measureText(label).width + 14);
    const ph = Math.min(p.height - 6, 18);
    const px = p.x + (p.width - pw) / 2;
    const py = p.y + (p.height - ph) / 2;
    ctx.beginPath();
    ctx.roundRect(px, py, pw, ph, ph / 2);
    ctx.fillStyle = withAlpha(color, 0.16);
    ctx.fill();
    ctx.strokeStyle = withAlpha(color, 0.55);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(label, px + pw / 2, py + ph / 2 + 0.5);
  },
};
registerCellRenderer('ratingPill', ratingPill);

const CLASS_STYLES: Record<string, CellStyle> = {
  'spread-hot': { background: 'rgba(220, 60, 60, 0.24)', fontWeight: 600 },
  'spread-warm': { background: 'rgba(220, 140, 40, 0.18)' },
  'row-pnl-risk': { background: 'rgba(120, 40, 120, 0.14)' },
};

/** Live columns: same renderer/formatter/style demos over FI fields.
 * rating.composite / issuer.name are the nested dot-path columns. */
const liveColumnDefs: ColDef<FiPosition>[] = [
  { ...FI_ID, pinned: 'left' },
  { field: 'issuer.name', headerName: 'Issuer', width: 150 },
  {
    field: 'rating.composite',
    headerName: 'Rating',
    width: 78,
    align: 'center',
    cellRenderer: 'ratingPill',
  },
  {
    field: 'spread',
    headerName: 'Spread',
    type: 'number',
    width: 88,
    valueFormatter: (p: CellParams<FiPosition>) =>
      typeof p.value === 'number' ? `${Math.round(p.value)} bp` : '',
    cellClassRules: {
      'spread-hot': (p: CellParams<FiPosition>) => typeof p.value === 'number' && p.value >= 400,
      'spread-warm': (p: CellParams<FiPosition>) =>
        typeof p.value === 'number' && p.value >= 250 && p.value < 400,
    },
  },
  {
    field: 'currentPrice',
    headerName: 'Price',
    type: 'number',
    width: 92,
    enableCellChangeFlash: true,
    valueFormatter: (p: CellParams<FiPosition>) =>
      typeof p.value === 'number' ? p.value.toFixed(2) : '',
  },
  {
    field: 'pnl',
    headerName: 'PnL',
    type: 'number',
    width: 108,
    valueFormatter: (p: CellParams<FiPosition>) => {
      const v = p.value as number;
      return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v)).toLocaleString()}`;
    },
    cellStyle: (p: CellParams<FiPosition>) => {
      const v = p.value as number;
      const t = p.api.getTheme();
      return v > 0 ? { color: t.up } : v < 0 ? { color: t.down } : undefined;
    },
  },
  {
    field: 'notionalAmount',
    headerName: 'Notional',
    type: 'number',
    width: 116,
    valueFormatter: (p: CellParams<FiPosition>) =>
      typeof p.value === 'number' ? Math.round(p.value).toLocaleString() : '',
  },
];

export function RenderingPage() {
  const { rows, status } = useFiFeed();
  const live = status === 'ready' && rows;
  const liveApiRef = useRef<Tabular<FiPosition> | null>(null);
  useFiUpdates(
    (batch) => liveApiRef.current?.applyTransactionAsync({ update: batch }),
    !!live,
  );

  const rowData = useMemo(() => makeBonds(120), []);
  const columnDefs = useMemo<ColDef<Bond>[]>(
    () =>
      [
        { field: 'cusip', headerName: 'CUSIP', pinned: 'left' as const, width: 110 },
        { field: 'issuer', headerName: 'Issuer', width: 150 },
        {
          field: 'rating',
          headerName: 'Rating',
          width: 78,
          align: 'center' as const,
          // Registered renderer resolved by name via the component registry.
          cellRenderer: 'ratingPill',
        },
        {
          field: 'spread',
          headerName: 'Spread',
          type: 'number' as const,
          width: 88,
          valueFormatter: (p: CellParams<Bond>) =>
            typeof p.value === 'number' ? `${Math.round(p.value)} bp` : '',
          cellClassRules: {
            'spread-hot': (p: CellParams<Bond>) => typeof p.value === 'number' && p.value >= 400,
            'spread-warm': (p: CellParams<Bond>) =>
              typeof p.value === 'number' && p.value >= 250 && p.value < 400,
          },
        },
        {
          field: 'price',
          headerName: 'Price',
          type: 'number' as const,
          width: 92,
          enableCellChangeFlash: true,
          valueFormatter: (p: CellParams<Bond>) =>
            typeof p.value === 'number' ? p.value.toFixed(2) : '',
        },
        {
          field: 'pnl',
          headerName: 'PnL',
          type: 'number' as const,
          width: 108,
          valueFormatter: (p: CellParams<Bond>) => {
            const v = p.value as number;
            return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v)).toLocaleString()}`;
          },
          cellStyle: (p: CellParams<Bond>) => {
            const v = p.value as number;
            const t = p.api.getTheme();
            return v > 0 ? { color: t.up } : v < 0 ? { color: t.down } : undefined;
          },
        },
        {
          field: 'notional',
          headerName: 'Notional',
          type: 'number' as const,
          width: 116,
          valueFormatter: (p: CellParams<Bond>) =>
            typeof p.value === 'number' ? Math.round(p.value).toLocaleString() : '',
        },
      ] as ColDef<Bond>[],
    [],
  );
  const apiRef = useRef<Tabular<Bond> | null>(null);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Rendering features</h2>
        <p>
          Cell / row styling: <code>cellStyle</code>, <code>cellClassRules</code>,{' '}
          <code>rowClassRules</code>, <code>valueFormatter</code>, and <code>flashCells</code>. Class
          names resolve through <code>classStyles</code> (canvas grids map AG CSS classes to paint
          attributes). The Rating column uses a canvas renderer registered by name
          (<code>registerCellRenderer('ratingPill')</code> → <code>cellRenderer: 'ratingPill'</code>).
          {live ? (
            <>
              {' '}
              Live FI positions — Rating renderer reads <code>rating.composite</code>, Issuer shows{' '}
              <code>issuer.name</code> (nested dot-path columns).
            </>
          ) : null}
        </p>
      </div>
      <div className="controls">
        <button
          type="button"
          onClick={() => {
            if (live) {
              const api = liveApiRef.current;
              const row = rows?.[0];
              if (!api || !row) return;
              const price = Number(row.currentPrice ?? 0);
              api.applyTransaction({
                update: [{ ...row, currentPrice: price + (Math.random() > 0.5 ? 0.05 : -0.05) }],
              });
              return;
            }
            const api = apiRef.current;
            if (!api) return;
            const row = rowData[0];
            if (!row) return;
            api.applyTransaction({ update: [{ ...row, price: row.price + (Math.random() > 0.5 ? 0.05 : -0.05) }] });
          }}
        >
          Tick row 1 price
        </button>
        <button
          type="button"
          onClick={() =>
            (live ? liveApiRef.current : apiRef.current)?.flashCells({
              rowIndexes: [0, 1],
              columns: live ? ['currentPrice', 'pnl'] : ['price', 'pnl'],
            })
          }
        >
          Flash rows 1–2
        </button>
      </div>
      <div className="grid-wrap">
        {live ? (
          <TabularGrid<FiPosition>
            key="stomp"
            columnDefs={liveColumnDefs}
            rowData={rows}
            getRowId={FI_GET_ROW_ID}
            density="compact"
            classStyles={CLASS_STYLES}
            rowClassRules={{
              'row-pnl-risk': (p) => typeof p.data?.pnl === 'number' && Math.abs(p.data.pnl as number) >= 50_000,
            }}
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
            density="compact"
            classStyles={CLASS_STYLES}
            rowClassRules={{
              'row-pnl-risk': (p) => typeof p.data?.pnl === 'number' && Math.abs(p.data.pnl) >= 500_000,
            }}
            onReady={(api) => {
              apiRef.current = api;
              (window as unknown as { __renderApi: Tabular<Bond> }).__renderApi = api;
            }}
          />
        )}
      </div>
      <div className="status">
        <FeedBadge status={status} />
      </div>
    </main>
  );
}
