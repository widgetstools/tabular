import { useEffect, useMemo, useRef, useState } from 'react';
import type { CellRenderParams, ColDef, Tabular } from '@tabular/core';
import { registerCellRenderer } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import {
  ColumnStats,
  TickHistory,
  heatBarRenderer,
  registerAllRenderers,
  sparklineAreaRenderer,
  sparklineColumnRenderer,
  sparklineRenderer,
  sparklineWinLossRenderer,
  rangeBarRenderer,
  bidirectionalRenderer,
  progressRenderer,
} from '@tabular/renderers';
import { makeBonds, makeRng, tick, type Bond } from '../data';

registerAllRenderers(registerCellRenderer);

export function RenderersPage() {
  const rows = useMemo(() => makeBonds(3000), []);
  const apiRef = useRef<Tabular<Bond> | null>(null);
  const [running, setRunning] = useState(true);
  const statsRef = useRef(new ColumnStats(['pnl', 'spread', 'price']));
  const ticksRef = useRef(new TickHistory(['price', 'pnl'], 24));

  const columnDefs = useMemo<ColDef<Bond>[]>(
    () => [
      { field: 'cusip', headerName: 'CUSIP', width: 100, pinned: 'left' },
      {
        field: 'rating',
        headerName: 'Rating',
        width: 80,
        cellRenderer: 'ratingBadge',
      },
      {
        field: 'rating',
        colId: 'statusPill',
        headerName: 'Pill',
        width: 80,
        cellRenderer: 'statusPill',
      },
      {
        field: 'rating',
        colId: 'traffic',
        headerName: 'TL',
        width: 70,
        cellRenderer: 'trafficLight',
      },
      {
        field: 'pnl',
        colId: 'side',
        headerName: 'Side',
        width: 70,
        cellRenderer: 'sideChip',
      },
      {
        field: 'price',
        headerName: 'Price',
        type: 'number',
        width: 90,
        format: '#,##0.00',
        cellRenderer: 'priceDirection',
      },
      {
        field: 'price',
        colId: 'ticks',
        headerName: '32nds',
        type: 'number',
        width: 80,
        cellRenderer: 'fractional32nds',
      },
      {
        field: 'price',
        colId: 'spark',
        headerName: 'Spark',
        width: 90,
        cellRenderer: (ctx, params: CellRenderParams<Bond>) => {
          const rowId = params.data?.id;
          const samples = rowId
            ? ticksRef.current.samples(rowId, 'price')
            : new Float64Array(0);
          return sparklineRenderer.paint(ctx, {
            ...params,
            tickSamples: samples,
          } as CellRenderParams);
        },
      },
      {
        field: 'price',
        colId: 'sparkCol',
        headerName: 'Cols',
        width: 80,
        cellRenderer: (ctx, params: CellRenderParams<Bond>) => {
          const rowId = params.data?.id;
          const samples = rowId
            ? ticksRef.current.samples(rowId, 'price')
            : new Float64Array(0);
          return sparklineColumnRenderer.paint(ctx, {
            ...params,
            tickSamples: samples,
          } as CellRenderParams);
        },
      },
      {
        field: 'price',
        colId: 'sparkArea',
        headerName: 'Area',
        width: 80,
        cellRenderer: (ctx, params: CellRenderParams<Bond>) => {
          const rowId = params.data?.id;
          const samples = rowId
            ? ticksRef.current.samples(rowId, 'price')
            : new Float64Array(0);
          return sparklineAreaRenderer.paint(ctx, {
            ...params,
            tickSamples: samples,
          } as CellRenderParams);
        },
      },
      {
        field: 'pnl',
        colId: 'winLoss',
        headerName: 'W/L',
        width: 80,
        cellRenderer: (ctx, params: CellRenderParams<Bond>) => {
          const rowId = params.data?.id;
          const samples = rowId
            ? ticksRef.current.samples(rowId, 'pnl')
            : new Float64Array(0);
          return sparklineWinLossRenderer.paint(ctx, {
            ...params,
            tickSamples: samples,
          } as CellRenderParams);
        },
      },
      {
        field: 'pnl',
        headerName: 'PnL',
        type: 'number',
        width: 100,
        cellRenderer: 'pnl',
      },
      {
        field: 'pnl',
        colId: 'delta',
        headerName: 'Δ',
        type: 'number',
        width: 90,
        cellRenderer: 'delta',
      },
      {
        field: 'notional',
        headerName: 'Notional',
        type: 'number',
        width: 90,
        cellRenderer: 'abbrevNumber',
      },
      {
        field: 'yld',
        colId: 'pct',
        headerName: 'Chg%',
        type: 'number',
        width: 80,
        // Demo: treat yield drift as a small fraction for pctChange
        valueGetter: (p) => ((p.data?.yld ?? 0) - 5) / 100,
        cellRenderer: 'pctChange',
      },
      {
        field: 'spread',
        colId: 'bps',
        headerName: 'bps',
        type: 'number',
        width: 80,
        // spread is already in bp-ish units; show as fraction * 10000 style via /10000
        valueGetter: (p) => (p.data?.spread ?? 0) / 10000,
        cellRenderer: 'bps',
      },
      {
        field: 'price',
        colId: 'progress',
        headerName: 'Prog',
        width: 90,
        cellRenderer: (ctx, params: CellRenderParams<Bond>) => {
          const price = typeof params.value === 'number' ? params.value : 0;
          // Map typical bond price band ~40–120 into 0..1
          const ratio = Math.min(1, Math.max(0, (price - 40) / 80));
          return progressRenderer.paint(ctx, { ...params, value: ratio } as CellRenderParams);
        },
      },
      {
        field: 'price',
        colId: 'gauge',
        headerName: 'Gauge',
        width: 70,
        valueGetter: (p) => {
          const price = p.data?.price ?? 0;
          return Math.min(1, Math.max(0, (price - 40) / 80));
        },
        cellRenderer: 'gauge',
      },
      {
        field: 'price',
        colId: 'volume',
        headerName: 'Vol',
        width: 50,
        valueGetter: (p) => {
          const price = p.data?.price ?? 0;
          return Math.min(1, Math.max(0, (price - 40) / 80));
        },
        cellRenderer: 'volume',
      },
      {
        field: 'spread',
        headerName: 'Heat',
        type: 'number',
        width: 100,
        cellRenderer: (ctx, params: CellRenderParams<Bond>) => {
          const s = statsRef.current.get('spread');
          return heatBarRenderer.paint(ctx, {
            ...params,
            columnStats: s ? { min: s.min, max: s.max } : undefined,
          } as CellRenderParams);
        },
      },
      {
        field: 'pnl',
        colId: 'bi',
        headerName: 'Bi',
        type: 'number',
        width: 90,
        cellRenderer: (ctx, params: CellRenderParams<Bond>) => {
          const s = statsRef.current.get('pnl');
          return bidirectionalRenderer.paint(ctx, {
            ...params,
            columnStats: s ? { min: s.min, max: s.max } : undefined,
          } as CellRenderParams);
        },
      },
      {
        field: 'price',
        colId: 'range',
        headerName: 'Range',
        type: 'number',
        width: 90,
        cellRenderer: (ctx, params: CellRenderParams<Bond>) => {
          const s = statsRef.current.get('price');
          return rangeBarRenderer.paint(ctx, {
            ...params,
            columnStats: s ? { min: s.min, max: s.max } : undefined,
          } as CellRenderParams);
        },
      },
      {
        colId: 'actions',
        headerName: '',
        width: 88,
        sortable: false,
        filter: false,
        cellRenderer: 'actionCluster',
      },
      { field: 'desk', headerName: 'Desk', width: 100 },
    ],
    [],
  );

  useEffect(() => {
    const stats = statsRef.current;
    stats.recompute(
      'pnl',
      rows.map((r) => r.pnl),
    );
    stats.recompute(
      'spread',
      rows.map((r) => r.spread),
    );
    stats.recompute(
      'price',
      rows.map((r) => r.price),
    );
    for (const r of rows.slice(0, 200)) {
      ticksRef.current.push(r.id, 'price', r.price);
      ticksRef.current.push(r.id, 'pnl', r.pnl);
    }
  }, [rows]);

  useEffect(() => {
    if (!running) return;
    const rnd = makeRng(99);
    const iv = setInterval(() => {
      const api = apiRef.current;
      if (!api) return;
      const batch = tick(rows, 80, rnd);
      for (const u of batch) {
        const idx = Number(u.id.slice(1));
        const prev = rows[idx];
        rows[idx] = u;
        statsRef.current.applyChange('pnl', prev?.pnl, u.pnl);
        statsRef.current.applyChange('spread', prev?.spread, u.spread);
        statsRef.current.applyChange('price', prev?.price, u.price);
        ticksRef.current.push(u.id, 'price', u.price);
        ticksRef.current.push(u.id, 'pnl', u.pnl);
      }
      api.applyTransactionAsync({ update: batch });
    }, 50);
    return () => clearInterval(iv);
  }, [running, rows]);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Renderer catalog</h2>
        <p>
          Full painter set: financial (<code>pnl</code>, <code>delta</code>, <code>bps</code>,{' '}
          <code>pctChange</code>, <code>abbrevNumber</code>, <code>fractional32nds</code>), bars,{' '}
          badges, sparkline variants, and <code>actionCluster</code> — over{' '}
          <code>ColumnStats</code> + <code>TickHistory</code>.
        </p>
      </div>
      <div className="controls">
        <button className={running ? 'on' : ''} onClick={() => setRunning((r) => !r)}>
          {running ? 'Pause' : 'Resume'}
        </button>
      </div>
      <div className="grid-wrap">
        <TabularGrid
          columnDefs={columnDefs}
          rowData={rows}
          getRowId={(p) => p.data.id}
          onReady={(api) => {
            apiRef.current = api;
          }}
          enableCellFlash
        />
      </div>
    </main>
  );
}
