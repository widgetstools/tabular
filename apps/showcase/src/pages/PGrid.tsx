/**
 * pgrid minimal harness (phase-1 Task 7; fleshed out with the STOMP feed in
 * Task 9). 5k synthetic rows grouped by desk with sum/avg aggregates, and a
 * 50ms mutator batching 100 random rows through `grid.update` — there is NO
 * refresh or polling code here: group sums tick because `view.on_update` is
 * the grid's row model push channel.
 */
import { useEffect, useRef, useState } from 'react';
import { PspGrid } from 'pgrid';

const SCHEMA = {
  id: 'string',
  desk: 'string',
  ccy: 'string',
  mv: 'float',
  px: 'float',
} as const;

const DESKS = ['Rates', 'Credit', 'FX', 'Equities', 'Munis', 'Agency'];
const CCYS = ['USD', 'EUR', 'JPY', 'GBP'];
const ROWS = 5000;

interface Row {
  [key: string]: unknown;
  id: string;
  desk: string;
  ccy: string;
  mv: number;
  px: number;
}

function makeRows(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < ROWS; i++) {
    rows.push({
      id: `P${String(i).padStart(5, '0')}`,
      desk: DESKS[i % DESKS.length],
      ccy: CCYS[(i * 7) % CCYS.length],
      mv: Math.round((Math.random() * 2_000_000 - 500_000) * 100) / 100,
      px: Math.round((80 + Math.random() * 60) * 100) / 100,
    });
  }
  return rows;
}

export function PGridPage() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState('booting engine…');
  const [updates, setUpdates] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    let timer: number | undefined;
    const grid = new PspGrid(el, {
      rowIdField: 'id',
      columnDefs: [
        { field: 'id', headerName: 'Position' },
        { field: 'desk', headerName: 'Desk', rowGroup: true },
        { field: 'ccy', headerName: 'Ccy', width: 80 },
        { field: 'mv', headerName: 'Mkt value', type: 'float', aggFunc: 'sum', format: '#,##0.00', width: 150 },
        { field: 'px', headerName: 'Price', type: 'float', aggFunc: 'avg', format: '#,##0.00', width: 120 },
      ],
      theme: 'dark',
      groupDefaultExpanded: 0,
    });
    (async () => {
      await grid.setSchema(SCHEMA as unknown as Record<string, string>);
      if (cancelled) return;
      const rows = makeRows();
      await grid.load(rows);
      if (cancelled) return;
      setStatus(`live — ${ROWS.toLocaleString()} rows, no refresh cadence`);
      let n = 0;
      timer = window.setInterval(() => {
        const batch: Row[] = [];
        for (let i = 0; i < 100; i++) {
          const row = rows[Math.floor(Math.random() * rows.length)];
          row.mv = Math.round((row.mv + (Math.random() - 0.5) * 50_000) * 100) / 100;
          row.px = Math.round((row.px + (Math.random() - 0.5)) * 100) / 100;
          batch.push({ ...row });
        }
        grid.update(batch);
        n += 1;
        if (n % 20 === 0) setUpdates(n * 100);
      }, 50);
    })().catch((err) => {
      console.error(err);
      setStatus(String(err));
    });
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      void grid.destroy();
    };
  }, []);

  return (
    <main className="page">
      <div className="page-head">
        <h2>PGrid — Perspective-native DOM grid</h2>
        <p>
          The row model IS a Perspective view: grouping and aggregation run in the engine, and
          group sums tick push-based via <code>view.on_update</code> — zero polling, zero refresh
          interval. {status}
          {updates > 0 ? ` · ${updates.toLocaleString()} row updates applied` : ''}
        </p>
      </div>
      <div className="grid-wrap">
        <div ref={ref} style={{ height: '100%' }} />
      </div>
    </main>
  );
}
