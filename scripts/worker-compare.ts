/**
 * Differential harness: DataPipeline output must match a reference pass chain
 * on randomized transactions (10k tx suite). Run: npm run worker-compare
 */
import { DataPipeline } from '../packages/core/src/worker/pipeline';
import { FilterPass } from '../packages/core/src/worker/passes/filterPass';
import { SortPass } from '../packages/core/src/worker/passes/sortPass';
import { GroupPass } from '../packages/core/src/worker/passes/groupPass';
import { CalcPass } from '../packages/core/src/worker/passes/calcPass';
import { AggScopeResolver, buildGroupRowIndex } from '../packages/core/src/worker/passes/aggScopePass';
import { PrevStore } from '../packages/core/src/worker/prevStore';
import { RowStore } from '../packages/core/src/worker/rowStore';
import { workerCalcField } from '../packages/core/src/worker/protocol';
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

const calcCols: WorkerPipelineConfig['calcCols'] = [
  { colId: 'spreadCalc', source: '[spread]', field: workerCalcField('spreadCalc'), prePass: [], usesPrev: false },
  {
    colId: 'deskSum',
    source: "SUM([notional], 'group')",
    field: workerCalcField('deskSum'),
    prePass: [{ slot: 0, fn: 'SUM', colId: 'notional', scope: { kind: 'group' } }],
    usesPrev: false,
  },
  {
    colId: 'pnlPrev',
    source: 'PREV([pnl])',
    field: workerCalcField('pnlPrev'),
    prePass: [],
    usesPrev: true,
  },
];

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

function referenceDisplayed(
  store: RowStore,
  config: WorkerPipelineConfig,
): WorkerDisplayEntry[] {
  const calcPass = new CalcPass();
  calcPass.setColumns(config.calcCols);
  calcPass.setPrevStore(store.prev);

  const allIds = store.ids();
  const groupingActive = config.groupCols.length > 0;
  const readRaw = (id: string) => store.getRow(id) ?? {};

  calcPass.setAggResolver(
    AggScopeResolver.forPhase(
      config.calcCols.flatMap((c) => c.prePass ?? []),
      allIds,
      allIds,
      readRaw,
      null,
      groupingActive,
    ),
  );
  const readFilter = (id: string) => calcPass.mergedRow(id, readRaw(id));
  let ids = new FilterPass(config.filterCols, config.quickFilterTerms).apply(
    store,
    config.filterModel as FilterModel,
    readFilter,
  );

  calcPass.setAggResolver(
    AggScopeResolver.forPhase(
      config.calcCols.flatMap((c) => c.prePass ?? []),
      allIds,
      ids,
      readFilter,
      null,
      groupingActive,
    ),
  );
  const readSort = (id: string) => calcPass.mergedRow(id, readRaw(id));
  const sortColMap = new Map(config.sortCols.map((c) => [c.colId, c]));
  ids = new SortPass(sortColMap).apply(store, ids, config.sortModel as SortModelItem[], readSort);

  const groupIndex = buildGroupRowIndex(ids, config.groupCols, readSort);
  calcPass.setAggResolver(
    AggScopeResolver.forPhase(
      config.calcCols.flatMap((c) => c.prePass ?? []),
      allIds,
      ids,
      readSort,
      groupIndex,
      groupingActive,
    ),
  );
  const readGroup = (id: string) => calcPass.mergedRow(id, readRaw(id));

  const displayed = new GroupPass().apply(
    store,
    ids,
    {
      groupCols: config.groupCols,
      aggCols: config.aggCols,
      groupDefaultExpanded: config.groupDefaultExpanded,
      expandedState: config.expandedState,
      groupTotalRow: config.groupTotalRow,
      grandTotalRow: config.grandTotalRow,
    },
    readGroup,
  );
  return displayed;
}

function referenceRebuild(
  store: RowStore,
  config: WorkerPipelineConfig,
): string[] {
  return referenceDisplayed(store, config).map((d) => d.id);
}

const AGG_EPS = 1e-9;

function compareAggData(
  worker: Record<string, unknown>,
  ref: Record<string, unknown>,
  context: string,
): number {
  let local = 0;
  const keys = new Set([...Object.keys(worker), ...Object.keys(ref)]);
  for (const colId of keys) {
    const wv = worker[colId];
    const rv = ref[colId];
    if (typeof wv === 'number' && typeof rv === 'number') {
      if (Math.abs(wv - rv) > AGG_EPS) {
        local++;
        console.error(`${context}: agg ${colId} numeric mismatch ${wv} vs ${rv}`);
      }
    } else if (wv !== rv) {
      local++;
      console.error(`${context}: agg ${colId} mismatch ${String(wv)} vs ${String(rv)}`);
    }
  }
  return local;
}

function compareDisplayedAgg(
  worker: readonly WorkerDisplayEntry[],
  ref: readonly WorkerDisplayEntry[],
  context: string,
): number {
  let local = 0;
  const workerGroups = worker.filter((d) => d.kind !== 'leaf');
  const refGroups = ref.filter((d) => d.kind !== 'leaf');

  if (workerGroups.length !== refGroups.length) {
    local++;
    console.error(
      `${context}: non-leaf count mismatch ${workerGroups.length} vs ${refGroups.length}`,
    );
    return local;
  }

  const refById = new Map(refGroups.map((d) => [d.id, d]));
  for (const w of workerGroups) {
    const r = refById.get(w.id);
    if (!r) {
      local++;
      console.error(`${context}: missing reference entry for ${w.id} (${w.kind})`);
      continue;
    }
    if (w.kind !== r.kind) {
      local++;
      console.error(`${context}: kind mismatch for ${w.id}: ${w.kind} vs ${r.kind}`);
    }
    local += compareAggData(w.aggData, r.aggData, `${context} ${w.id}`);
  }
  return local;
}

function assertIncrementalApplyAndResolveParity(
  pipeline: DataPipeline,
  allIds: string[],
  config: WorkerPipelineConfig,
  rnd: () => number,
): number {
  let local = 0;
  pipeline.setConfig(config);
  pipeline.rebuild();

  for (let i = 0; i < 200; i++) {
    const n = 1 + Math.floor(rnd() * 20);
    const updateIds: string[] = [];
    const update: BondRow[] = [];
    for (let j = 0; j < n; j++) {
      const id = allIds[Math.floor(rnd() * allIds.length)]!;
      const row = { ...(pipeline.getRow(id) as BondRow) };
      row.pnl = row.pnl + (rnd() < 0.5 ? -1 : 1) * 10;
      row.spread = Math.max(1, row.spread + (rnd() < 0.5 ? -1 : 1));
      row.notional = Math.max(1, row.notional + (rnd() < 0.5 ? -1 : 1) * Math.floor(rnd() * 10_000));
      updateIds.push(id);
      update.push(row);
    }
    const payload = { updateIds, update };
    const result = pipeline.applyAndResolve(payload);
    if (result.kind !== 'aggregates') {
      local++;
      console.error(`incremental batch ${i}: expected aggregates path, got ${result.kind}`);
      continue;
    }
    const full = pipeline.rebuild();
    const refByGroup = new Map<string, Record<string, unknown>>();
    for (const d of full.displayed) {
      if (d.kind === 'footer') {
        refByGroup.set(d.id.slice(0, -':footer'.length), d.aggData);
      } else if (d.kind === 'group' && Object.keys(d.aggData).length) {
        refByGroup.set(d.id, d.aggData);
      } else if (d.kind === 'grandTotal') {
        refByGroup.set('grand-total', d.aggData);
      }
    }
    for (const u of result.updates) {
      const ref = refByGroup.get(u.groupId);
      if (!ref) {
        local++;
        console.error(`incremental batch ${i}: missing group ${u.groupId} in full rebuild`);
        continue;
      }
      local += compareAggData(u.agg, ref, `incremental batch ${i} ${u.groupId}`);
    }
  }
  return local;
}

function incrementalAggConfig(): WorkerPipelineConfig {
  return {
    filterCols: [],
    sortCols: [],
    calcCols: [],
    filterModel: {},
    quickFilterTerms: [],
    sortModel: [],
    groupCols: [
      { colId: 'desk', field: 'desk' },
      { colId: 'sector', field: 'sector' },
    ],
    aggCols: [
      { colId: 'notional', field: 'notional', aggFunc: 'sum' },
      { colId: 'pnl', field: 'pnl', aggFunc: 'sum' },
      { colId: 'spread', field: 'spread', aggFunc: 'max' },
    ],
    groupDefaultExpanded: -1,
    expandedState: [],
    grandTotalRow: 'bottom',
  };
}

function assertAggParityAfterUpdates(
  pipeline: DataPipeline,
  store: RowStore,
  config: WorkerPipelineConfig,
  rnd: () => number,
): number {
  let local = 0;
  for (let i = 0; i < 500; i++) {
    const n = 1 + Math.floor(rnd() * 20);
    const updateIds: string[] = [];
    const update: BondRow[] = [];
    const ids = store.ids();
    for (let j = 0; j < n; j++) {
      const id = ids[Math.floor(rnd() * ids.length)]!;
      const row = { ...(store.getRow(id) as BondRow) };
      row.pnl = row.pnl + (rnd() < 0.5 ? -1 : 1) * 10;
      row.spread = Math.max(1, row.spread + (rnd() < 0.5 ? -1 : 1));
      row.notional = Math.max(1, row.notional + (rnd() < 0.5 ? -1 : 1) * Math.floor(rnd() * 10_000));
      updateIds.push(id);
      update.push(row);
    }
    const payload = { updateIds, update };
    store.applyTransaction(payload);
    pipeline.applyTransaction(payload);
    const out = pipeline.rebuild();
    const refDisplayed = referenceDisplayed(store, config);
    local += compareDisplayedAgg(out.displayed, refDisplayed, `update-batch ${i}`);
  }
  return local;
}

function pipelineConfig(filterModel: FilterModel, sortModel: SortModelItem[]): WorkerPipelineConfig {
  return {
    filterCols: [
      { colId: 'desk', field: 'desk' },
      { colId: 'spreadCalc', field: workerCalcField('spreadCalc') },
    ],
    sortCols: [
      { colId: 'spread', field: 'spread', type: 'number' },
      { colId: 'spreadCalc', field: workerCalcField('spreadCalc'), type: 'number' },
    ],
    calcCols,
    filterModel,
    quickFilterTerms: [],
    sortModel,
    groupCols: [{ colId: 'desk', field: 'desk' }],
    aggCols: [{ colId: 'notional', field: 'notional', aggFunc: 'sum' }],
    groupDefaultExpanded: 1,
    expandedState: [],
    groupTotalRow: 'bottom',
    grandTotalRow: 'bottom',
  };
}

function applyRandomTx(
  storeRef: RowStore,
  pipeline: DataPipeline,
  ids: string[],
  rows: BondRow[],
  rand: () => number,
): void {
  const op = Math.floor(rand() * 3);
  if (op === 0 && ids.length > 10) {
    const idx = Math.floor(rand() * ids.length);
    const id = ids[idx]!;
    const row = rows.find((r) => r.id === id);
    if (row) {
      row.spread = Math.round(rand() * 300);
      row.pnl = Math.round(rand() * 20) - 10;
      const payload = { updateIds: [id], update: [{ ...row }] };
      storeRef.applyTransaction(payload);
      pipeline.applyTransaction(payload);
    }
    return;
  }
  if (op === 1) {
    const id = `x${Date.now()}${Math.floor(rand() * 1e6)}`;
    const row: BondRow = {
      id,
      desk: DESKS[Math.floor(rand() * DESKS.length)]!,
      sector: SECTORS[Math.floor(rand() * SECTORS.length)]!,
      spread: Math.round(rand() * 300),
      notional: 500_000,
      pnl: 0,
    };
    ids.push(id);
    rows.push(row);
    const payload = { addIds: [id], add: [{ ...row }] };
    storeRef.applyTransaction(payload);
    pipeline.applyTransaction(payload);
    return;
  }
  if (ids.length > 20) {
    const idx = Math.floor(rand() * ids.length);
    const id = ids[idx]!;
    ids.splice(idx, 1);
    const ri = rows.findIndex((r) => r.id === id);
    if (ri >= 0) rows.splice(ri, 1);
    const payload = { removeIds: [id] };
    storeRef.applyTransaction(payload);
    pipeline.applyTransaction(payload);
  }
}

const TX_COUNT = 10_000;
const ROW_COUNT = 1_200;
let mismatches = 0;

for (let seed = 1; seed <= 3; seed++) {
  const rand = mulberry32(seed);
  const { ids, rows } = seedRows(ROW_COUNT);
  const rowRecords = rows as unknown as Record<string, unknown>[];

  const storeRef = new RowStore();
  const pipeline = new DataPipeline();
  storeRef.setAll(ids, rowRecords.map((r) => ({ ...r })));
  pipeline.setRowData(ids, rowRecords.map((r) => ({ ...r })));

  const filterModel: FilterModel = {};
  const sortModel: SortModelItem[] = [{ colId: 'spreadCalc', sort: 'asc' }];
  const config = pipelineConfig(filterModel, sortModel);
  pipeline.setConfig(config);

  for (let t = 0; t < TX_COUNT; t++) {
    applyRandomTx(storeRef, pipeline, ids, rows, rand);
  }

  mismatches += assertAggParityAfterUpdates(pipeline, storeRef, config, rand);

  const refIds = referenceRebuild(storeRef, config);
  const workerIds = pipeline.rebuild().displayed.map((d) => d.id);

  if (refIds.length !== workerIds.length) {
    mismatches++;
    console.error(`seed ${seed}: length mismatch ${refIds.length} vs ${workerIds.length}`);
    continue;
  }
  for (let i = 0; i < refIds.length; i++) {
    if (refIds[i] !== workerIds[i]) {
      mismatches++;
      console.error(`seed ${seed}: id mismatch at ${i}: ${refIds[i]} vs ${workerIds[i]}`);
      break;
    }
  }
}

// Incremental applyAndResolve vs full rebuild (200 update-only batches)
{
  const { ids, rows } = seedRows(800);
  const rowRecords = rows as unknown as Record<string, unknown>[];
  const pipeline = new DataPipeline();
  pipeline.setRowData(ids, rowRecords.map((r) => ({ ...r })));
  mismatches += assertIncrementalApplyAndResolveParity(
    pipeline,
    ids,
    incrementalAggConfig(),
    mulberry32(99),
  );
}

// PREV store smoke test
{
  const prev = new PrevStore();
  const row = { pnl: 5, spread: 100 };
  prev.captureBeforeUpdate('r1', { pnl: 7 }, row);
  if (prev.get('r1', 'pnl') !== 5) {
    mismatches++;
    console.error('PREV store capture failed');
  }
}

if (mismatches > 0) {
  console.error(`FAILED: ${mismatches} mismatch(es)`);
  process.exit(1);
}

console.log(
  `OK: ${TX_COUNT} randomized transactions × 3 seeds + 500 update-only agg batches + 200 incremental applyAndResolve batches — DataPipeline parity (calc+agg+PREV)`,
);
process.exit(0);
