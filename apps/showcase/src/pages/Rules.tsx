import { useEffect, useMemo, useRef, useState } from 'react';
import type { AlertEvent, Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, makeRng, tick, type Bond } from '../data';
import { bondColumns } from '../columns';

export function RulesPage() {
  const rows = useMemo(() => makeBonds(1200), []);
  const columnDefs = useMemo(() => bondColumns(), []);
  const apiRef = useRef<Tabular<Bond> | null>(null);
  const [running, setRunning] = useState(true);
  const [rate, setRate] = useState(120);
  const [alerts, setAlerts] = useState<AlertEvent<Bond>[]>([]);

  const rules = useMemo(
    () => ({
      style: [
        {
          id: 'pnl-drop',
          condition: '[pnl.new] < [pnl.old] * 0.95',
          style: { backgroundColor: 'rgba(220, 38, 38, 0.28)', fontWeight: 600 },
          field: 'pnl',
          priority: 10,
          flash: 'pulse' as const,
          activeDurationMs: 900,
          indicator: { icon: 'alert-triangle' as const, color: '#f59e0b' },
        },
        {
          id: 'spread-wide',
          condition: '[spread] > 350',
          style: { backgroundColor: 'rgba(245, 158, 11, 0.2)' },
          field: 'spread',
          priority: 5,
          indicator: { icon: 'trending-down' as const },
        },
        {
          id: 'price-spike',
          condition: '[price.new] > [price.old] + 0.35 || [price.new] < [price.old] - 0.35',
          style: { backgroundColor: 'rgba(56, 189, 248, 0.18)' },
          field: 'price',
          flash: 'glow' as const,
          activeDurationMs: 600,
        },
      ],
      alerts: [
        {
          id: 'pnl-crash',
          condition: '[pnl.new] < [pnl.old] * 0.9',
          message: 'PnL dropped more than 10%',
          severity: 'error' as const,
          trigger: 'relativeChange' as const,
          field: 'pnl',
          debounceMs: 750,
        },
        {
          id: 'spread-blowout',
          condition: '[spread.new] > [spread.old] + 25',
          message: 'Spread widened sharply',
          severity: 'warn' as const,
          trigger: 'relativeChange' as const,
          field: 'spread',
        },
      ],
      alertRateLimit: { tokens: 12, perMs: 1000 },
    }),
    [],
  );

  useEffect(() => {
    if (!running) return;
    const rnd = makeRng(4242);
    const iv = setInterval(() => {
      const api = apiRef.current;
      if (!api) return;
      const batch = tick(rows, rate, rnd);
      for (const u of batch) {
        const idx = Number(u.id.slice(1));
        rows[idx] = u;
      }
      api.applyTransactionAsync({ update: batch });
    }, 50);
    return () => clearInterval(iv);
  }, [running, rate, rows]);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Rules, indicators &amp; alerts</h2>
        <p>
          Style rules compile via <code>@tabular/expression</code> and evaluate on the{' '}
          <code>transactionApplied</code> delta feed — paint reads precomputed styles, never
          re-evaluates expressions. Delta refs <code>[field.old]</code> / <code>[field.new]</code>{' '}
          drive relative-change rules; alerts are debounced per rule and globally token-bucketed.
          The worker data plane is the default; append <code>?main=1</code> to force the UI thread.
        </p>
      </div>
      <div className="controls">
        <button className={running ? 'on' : ''} onClick={() => setRunning((r) => !r)}>
          {running ? 'Pause' : 'Resume'}
        </button>
        <label>
          batch size
          <input
            type="range"
            min={20}
            max={400}
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
          />
          {rate}
        </label>
        <span className="stat">{alerts.length} alerts (ring)</span>
      </div>
      {alerts.length > 0 && (
        <div className="alert-feed">
          {alerts
            .slice(-6)
            .reverse()
            .map((a, i) => (
              <div key={`${a.at}-${i}`} className={`alert-item ${a.severity}`}>
                <strong>{a.ruleId}</strong> — {a.message} ({a.rowId})
              </div>
            ))}
        </div>
      )}
      <div className="grid-wrap">
        <TabularGrid
          columnDefs={columnDefs}
          rowData={rows}
          getRowId={(p) => p.data.id}
          rules={rules}
          rowDataMode={
            typeof window !== 'undefined' &&
            new URLSearchParams(window.location.search).get('main') === '1'
              ? 'main'
              : undefined
          }
          onReady={(api) => {
            apiRef.current = api;
          }}
          onAlert={(e) => setAlerts((prev) => [...prev.slice(-99), e])}
          enableCellFlash
        />
      </div>
    </main>
  );
}
