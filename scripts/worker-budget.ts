/**
 * Measures main-thread work while applying high-rate update txs.
 * Run against DataPipeline in-process first; later wire a jsdom+Worker
 * smoke if needed. Target: p95 main scripting ≤ 4ms per 60ms flush
 * when only forwarding txs + applying patches (no full main refresh).
 *
 * Run: npm run worker-budget
 */
import { performance } from 'node:perf_hooks';
import { DataPipeline } from '../packages/core/src/worker/pipeline';
import type { WorkerDisplayEntry, WorkerPipelineConfig } from '../packages/core/src/worker/protocol';
import type { FilterModel, SortModelItem } from '../packages/core/src/types';

interface BondRow {
  id: string;
  desk: string;
  sector: string;
  spread: number;
  notional: number;
  pnl: number;
}

const DESKS = ['IG', 'HY', 'EM', 'SSA'];
const SECTORS = ['Fin', 'Tech', 'Energy', 'Utility', 'Health'];

const ROW_COUNT = 100_000;
const ITERATIONS = 200;
const UPDATES_PER_ITER = 2000;
const P95_THRESHOLD_MS = 4;

function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i]!;
}

function seedRows(n: number): { ids: string[]; rows: BondRow[] } {
  const ids: string[] = [];
  const rows: BondRow[] = [];
  for (let i = 0; i < n; i++) {
    const id = `b${i}`;
    ids.push(id);
    rows.push({
      id,
      desk: DESKS[i % DESKS.length]!,
      sector: SECTORS[i % SECTORS.length]!,
      spread: 50 + (i % 200),
      notional: 1_000_000 + i * 1000,
      pnl: (i % 17) - 8,
    });
  }
  return { ids, rows };
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pipelineConfig(): WorkerPipelineConfig {
  return {
    filterCols: [{ colId: 'desk', field: 'desk' }],
    sortCols: [],
    calcCols: [],
    filterModel: {} as FilterModel,
    quickFilterTerms: [],
    sortModel: [] as SortModelItem[],
    groupCols: [
      { colId: 'desk', field: 'desk' },
      { colId: 'sector', field: 'sector' },
    ],
    aggCols: [
      { colId: 'notional', field: 'notional', aggFunc: 'sum' },
      { colId: 'pnl', field: 'pnl', aggFunc: 'avg' },
    ],
    groupDefaultExpanded: 0,
    expandedState: [],
    groupTotalRow: 'bottom',
    grandTotalRow: 'bottom',
  };
}

function aggChanged(prev: Record<string, unknown> | undefined, next: Record<string, unknown>): boolean {
  if (!prev) return true;
  for (const [k, v] of Object.entries(next)) {
    if (prev[k] !== v) return true;
  }
  return false;
}

function extractGroupUpdates(
  displayed: readonly WorkerDisplayEntry[],
  prevMap: Map<string, Record<string, unknown>>,
): Array<{ groupId: string; agg: Record<string, unknown> }> {
  const updates: Array<{ groupId: string; agg: Record<string, unknown> }> = [];
  for (const d of displayed) {
    if (d.kind === 'leaf') continue;
    if (aggChanged(prevMap.get(d.id), d.aggData)) {
      updates.push({ groupId: d.id, agg: d.aggData });
    }
  }
  return updates;
}

/** Simulates main-thread `patchGroupAggregates`: Object.assign into aggData map. */
function applyMainPatches(
  aggMap: Map<string, Record<string, unknown>>,
  updates: Array<{ groupId: string; agg: Record<string, unknown> }>,
): void {
  for (const u of updates) {
    let target = aggMap.get(u.groupId);
    if (!target) {
      target = {};
      aggMap.set(u.groupId, target);
    }
    Object.assign(target, u.agg);
  }
}

function seedAggMap(
  displayed: readonly WorkerDisplayEntry[],
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const d of displayed) {
    if (d.kind === 'leaf') continue;
    map.set(d.id, { ...d.aggData });
  }
  return map;
}

function applyUpdateBatch(
  pipeline: DataPipeline,
  ids: string[],
  rnd: () => number,
  count: number,
): Array<{ groupId: string; agg: Record<string, unknown> }> {
  const updateIds: string[] = [];
  const update: BondRow[] = [];
  for (let i = 0; i < count; i++) {
    const id = ids[Math.floor(rnd() * ids.length)]!;
    const raw = pipeline.getRow(id) as BondRow | undefined;
    if (!raw) continue;
    const row: BondRow = { ...raw };
    row.pnl += (rnd() < 0.5 ? -1 : 1) * 10;
    row.spread = Math.max(1, row.spread + (rnd() < 0.5 ? -1 : 1));
    row.notional = Math.max(1, row.notional + (rnd() < 0.5 ? -1 : 1) * Math.floor(rnd() * 10_000));
    updateIds.push(id);
    update.push(row);
  }
  const result = pipeline.applyAndResolve({ updateIds, update });
  if (result.kind === 'aggregates') return result.updates;
  return extractGroupUpdates(result.output.displayed, new Map());
}

const rnd = mulberry32(42);
const { ids, rows } = seedRows(ROW_COUNT);
const rowRecords = rows as unknown as Record<string, unknown>[];

const pipeline = new DataPipeline();
pipeline.setRowData(ids, rowRecords.map((r) => ({ ...r })));
pipeline.setConfig(pipelineConfig());

let out = pipeline.rebuild();
const aggMap = seedAggMap(out.displayed);

// Warm-up: one full tick batch outside the measured loop.
const warmUpdates = applyUpdateBatch(pipeline, ids, rnd, UPDATES_PER_ITER);
applyMainPatches(aggMap, warmUpdates);

const samples: number[] = [];

for (let i = 0; i < ITERATIONS; i++) {
  const updates = applyUpdateBatch(pipeline, ids, rnd, UPDATES_PER_ITER);

  const t0 = performance.now();
  applyMainPatches(aggMap, updates);
  const t1 = performance.now();
  samples.push(t1 - t0);
}

samples.sort((a, b) => a - b);
const p50 = percentile(samples, 50);
const p95 = percentile(samples, 95);

console.log(`rows=${ROW_COUNT} iterations=${ITERATIONS} updatesPerIter=${UPDATES_PER_ITER}`);
console.log(`mainScriptingMsP50=${p50.toFixed(3)}`);
console.log(`mainScriptingMsP95=${p95.toFixed(3)}`);

if (p95 > P95_THRESHOLD_MS) {
  console.error(`FAILED: mainScriptingMsP95 ${p95.toFixed(3)} > ${P95_THRESHOLD_MS}ms threshold`);
  process.exit(1);
}

console.log(`OK: main-side patch simulation p95 ≤ ${P95_THRESHOLD_MS}ms`);
process.exit(0);
