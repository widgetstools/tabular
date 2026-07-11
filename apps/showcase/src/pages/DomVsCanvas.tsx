import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ColDef, GridOptions, Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { TabularDom } from '@tabular/dom';
import { makeRng, makeWide, type WideRow } from '../data';

const ROWS = 60_000;
const METRICS = 11;
const TICK_INTERVAL_MS = 16;
const RATES = [0, 1_000, 5_000, 20_000] as const;

/** Shared module-level dataset: both grids read the same array, and tick
 * updates mutate it in place so the two sides never drift apart. */
const sharedRows: WideRow[] = makeWide(ROWS, METRICS);

export interface BenchSide {
  scroll(
    durationMs?: number,
    pxPerFrame?: number,
  ): Promise<{ frames: number; p50: number; p90: number; p99: number; avgFps: number }>;
  tickLatency(nSamples?: number): Promise<{ p50: number; p95: number }>;
}
export interface BenchApi {
  canvas: BenchSide;
  dom: BenchSide;
  setTickRate(perSec: number): void;
}

declare global {
  interface Window {
    __benchDomVsCanvas?: BenchApi;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function doubleRaf(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** Finds the scrollable descendant div (scrollHeight > clientHeight) inside a grid root. */
function findScroller(root: HTMLElement): HTMLElement | null {
  const divs = root.querySelectorAll<HTMLElement>('div');
  for (const d of divs) {
    if (d.scrollHeight > d.clientHeight) return d;
  }
  return null;
}

/** Drives `scrollTop += pxPerFrame` every rAF for `durationMs`, collecting frame deltas. */
async function benchScroll(
  getScroller: () => HTMLElement | null,
  durationMs = 1000,
  pxPerFrame = 40,
): Promise<{ frames: number; p50: number; p90: number; p99: number; avgFps: number }> {
  const el = getScroller();
  if (!el) return { frames: 0, p50: 0, p90: 0, p99: 0, avgFps: 0 };
  return new Promise((resolve) => {
    const deltas: number[] = [];
    const start = performance.now();
    let last = start;
    let frames = 0;
    const step = (now: number) => {
      deltas.push(now - last);
      last = now;
      frames++;
      el.scrollTop += pxPerFrame;
      if (now - start < durationMs) {
        requestAnimationFrame(step);
      } else {
        // Drop the first delta (time from call to first rAF, not a frame interval).
        const sorted = deltas.slice(1).sort((a, b) => a - b);
        const elapsedS = (now - start) / 1000;
        resolve({
          frames,
          p50: percentile(sorted, 0.5),
          p90: percentile(sorted, 0.9),
          p99: percentile(sorted, 0.99),
          avgFps: elapsedS > 0 ? frames / elapsedS : 0,
        });
      }
    };
    requestAnimationFrame(step);
  });
}

/** Pauses the tick generator, applies `nSamples` single-cell updates one at a time to
 * `apply`, and times each round-trip through a double-rAF wait. */
async function benchTickLatency(
  apply: (tx: { update: WideRow[] }) => void,
  pausedRef: { current: boolean },
  rnd: () => number,
  nSamples = 20,
): Promise<{ p50: number; p95: number }> {
  pausedRef.current = true;
  const samples: number[] = [];
  try {
    for (let i = 0; i < nSamples; i++) {
      const idx = Math.floor(rnd() * sharedRows.length);
      const row = sharedRows[idx];
      const next: WideRow = { ...row, m0: Math.round(rnd() * 100_000) / 100 };
      sharedRows[idx] = next;
      const t0 = performance.now();
      apply({ update: [next] });
      await doubleRaf();
      samples.push(performance.now() - t0);
    }
  } finally {
    pausedRef.current = false;
  }
  const sorted = samples.slice().sort((a, b) => a - b);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
}

/** Frame-rate meter: counts rAF callbacks per second (drops when the thread is busy). */
function useFpsMeter(): number {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let last = performance.now();
    const loop = (now: number) => {
      frames++;
      if (now - last >= 1000) {
        setFps(Math.round((frames * 1000) / (now - last)));
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return fps;
}

interface CanvasSideProps {
  columnDefs: ColDef<WideRow>[];
  mode: 'worker' | 'main';
  containerRef: RefObject<HTMLDivElement | null>;
  onApi: (api: Tabular<WideRow> | null) => void;
}

function CanvasSide({ columnDefs, mode, containerRef, onApi }: CanvasSideProps) {
  // Latest `onApi` without retriggering the cleanup effect on every parent render
  // (the inline callback prop gets a fresh identity each render).
  const onApiRef = useRef(onApi);
  onApiRef.current = onApi;
  // Cleanup runs exactly when this instance unmounts (key change on the parent).
  useEffect(() => () => onApiRef.current(null), []);
  return (
    <div ref={containerRef} className="grid-wrap" style={{ flex: 1, minWidth: 0 }}>
      <TabularGrid<WideRow>
        columnDefs={columnDefs}
        rowData={sharedRows}
        getRowId={(p) => p.data.id}
        density="compact"
        rowDataMode={mode}
        onReady={(api) => onApi(api)}
      />
    </div>
  );
}

interface DomSideProps {
  columnDefs: ColDef<WideRow>[];
  mode: 'worker' | 'main';
  onApi: (grid: TabularDom<WideRow> | null) => void;
}

function DomSide({ columnDefs, mode, onApi }: DomSideProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const options: GridOptions<WideRow> = {
      columnDefs,
      getRowId: (p) => p.data.id,
      density: 'compact',
      rowDataMode: mode,
      rowData: sharedRows,
    };
    const grid = new TabularDom<WideRow>(host, options);
    onApi(grid);
    return () => {
      onApi(null);
      grid.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnDefs, mode]);

  return <div ref={hostRef} className="grid-wrap" style={{ flex: 1, minWidth: 0 }} />;
}

/**
 * Side-by-side DOM vs Canvas comparison: identical column defs, identical row
 * data, identical tick generator driving both `applyTransactionAsync`
 * pipelines. Exposes `window.__benchDomVsCanvas` for scroll/tick-latency
 * probes (see chrome-devtools verification in the task report).
 */
export function DomVsCanvasPage() {
  const [mode, setMode] = useState<'worker' | 'main'>('worker');
  const [grouped, setGrouped] = useState(false);
  const [rate, setRate] = useState<number>(0);
  const [updates, setUpdates] = useState(0);

  const canvasApiRef = useRef<Tabular<WideRow> | null>(null);
  const domGridRef = useRef<TabularDom<WideRow> | null>(null);
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const rateRef = useRef(rate);
  const pausedRef = useRef(false);
  const totalRef = useRef(0);

  const canvasFps = useFpsMeter();
  const domFps = useFpsMeter();

  useEffect(() => {
    rateRef.current = rate;
  }, [rate]);

  const columnDefs = useMemo<ColDef<WideRow>[]>(() => {
    const defs: ColDef<WideRow>[] = [
      { field: 'id', headerName: 'Id', width: 90 },
      { field: 'name', headerName: 'Name', width: 160 },
      grouped
        ? { field: 'group', headerName: 'Group', width: 90, rowGroup: true }
        : { field: 'group', headerName: 'Group', width: 90 },
    ];
    for (let m = 0; m < METRICS; m++) {
      defs.push({
        field: `m${m}`,
        headerName: `Metric ${m}`,
        type: 'number',
        width: 120,
        format: '#,##0.00',
        aggFunc: 'sum',
      });
    }
    return defs;
  }, [grouped]);

  // Tick generator: one 16ms interval driving both grids via applyTransactionAsync.
  useEffect(() => {
    const rnd = makeRng(2024);
    const iv = setInterval(() => {
      if (pausedRef.current) return;
      const perSec = rateRef.current;
      if (perSec <= 0) return;
      const count = Math.max(1, Math.round((perSec * TICK_INTERVAL_MS) / 1000));
      const batch: WideRow[] = [];
      for (let i = 0; i < count; i++) {
        const idx = Math.floor(rnd() * sharedRows.length);
        const row = sharedRows[idx];
        const m1 = Math.floor(rnd() * METRICS);
        let m2 = Math.floor(rnd() * METRICS);
        if (METRICS > 1) {
          while (m2 === m1) m2 = Math.floor(rnd() * METRICS);
        }
        const next: WideRow = { ...row };
        next[`m${m1}`] = Math.round(rnd() * 100_000) / 100;
        if (METRICS > 1) next[`m${m2}`] = Math.round(rnd() * 100_000) / 100;
        sharedRows[idx] = next;
        batch.push(next);
      }
      canvasApiRef.current?.applyTransactionAsync({ update: batch });
      domGridRef.current?.applyTransactionAsync({ update: batch });
      totalRef.current += batch.length;
    }, TICK_INTERVAL_MS);
    const meter = setInterval(() => setUpdates(totalRef.current), 500);
    return () => {
      clearInterval(iv);
      clearInterval(meter);
    };
  }, []);

  // The bench API — stable for the page's lifetime, reads through refs.
  useEffect(() => {
    const rnd = makeRng(9999);
    const api: BenchApi = {
      canvas: {
        scroll: (durationMs, pxPerFrame) =>
          benchScroll(() => {
            const root = canvasContainerRef.current;
            return root ? findScroller(root) : null;
          }, durationMs, pxPerFrame),
        tickLatency: (n) =>
          benchTickLatency(
            (tx) => canvasApiRef.current?.applyTransactionAsync(tx),
            pausedRef,
            rnd,
            n,
          ),
      },
      dom: {
        scroll: (durationMs, pxPerFrame) =>
          benchScroll(() => domGridRef.current?.scrollerElement ?? null, durationMs, pxPerFrame),
        tickLatency: (n) =>
          benchTickLatency((tx) => domGridRef.current?.applyTransactionAsync(tx), pausedRef, rnd, n),
      },
      setTickRate: (perSec: number) => setRate(perSec),
    };
    window.__benchDomVsCanvas = api;
    return () => {
      delete window.__benchDomVsCanvas;
    };
  }, []);

  return (
    <main className="page">
      <div className="page-head">
        <h2>DOM vs Canvas — {ROWS.toLocaleString()} rows</h2>
        <p>
          The same column defs, the same row array, and the same tick generator drive a canvas{' '}
          <code>TabularGrid</code> (left) and a pure-DOM <code>TabularDom</code> (right) side by
          side. Numeric columns use the <code>format</code> DSL only (no value getters/formatters)
          so both grids stay worker-eligible when the worker/main toggle is set to worker.{' '}
          <code>window.__benchDomVsCanvas</code> exposes <code>canvas</code>/<code>dom</code>{' '}
          <code>scroll()</code> and <code>tickLatency()</code> probes plus <code>setTickRate()</code>.
        </p>
      </div>
      <div className="controls">
        <label>Data plane</label>
        <button className={mode === 'worker' ? 'on' : ''} onClick={() => setMode('worker')}>
          Worker
        </button>
        <button className={mode === 'main' ? 'on' : ''} onClick={() => setMode('main')}>
          Main
        </button>
        <span style={{ width: 16 }} />
        <button className={grouped ? 'on' : ''} onClick={() => setGrouped((g) => !g)}>
          {grouped ? 'Grouped' : 'Flat'}
        </button>
        <span style={{ width: 16 }} />
        <label>Ticks / s</label>
        {RATES.map((r) => (
          <button key={r} className={rate === r ? 'on' : ''} onClick={() => setRate(r)}>
            {r.toLocaleString()}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, gap: 6 }}>
          <div className="status">
            <span>
              Canvas <b>{mode}</b>
            </span>
            <span>
              Paint <b>{canvasFps} fps</b>
            </span>
          </div>
          <CanvasSide
            columnDefs={columnDefs}
            mode={mode}
            containerRef={canvasContainerRef}
            onApi={(api) => (canvasApiRef.current = api)}
            key={`canvas-${mode}-${grouped}`}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, gap: 6 }}>
          <div className="status">
            <span>
              DOM <b>{mode}</b>
            </span>
            <span>
              Paint <b>{domFps} fps</b>
            </span>
          </div>
          <DomSide
            columnDefs={columnDefs}
            mode={mode}
            onApi={(grid) => (domGridRef.current = grid)}
            key={`dom-${mode}-${grouped}`}
          />
        </div>
      </div>
      <div className="status">
        <span>
          Rows <b>{ROWS.toLocaleString()}</b>
        </span>
        <span>
          Rate <b>{rate.toLocaleString()}/s</b>
        </span>
        <span>
          Updates applied <b>{updates.toLocaleString()}</b>
        </span>
      </div>
    </main>
  );
}
