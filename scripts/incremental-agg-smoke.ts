/**
 * Smoke test for AggEngine: O(dirty) updates and parity with full rescan.
 * Run: npx tsx scripts/incremental-agg-smoke.ts
 */
import { AggEngine } from '../packages/core/src/worker/incrementalAgg';
import type { AggModel, GroupAggUpdate } from '../packages/core/src/worker/protocol';
import { workerGroupKey } from '../packages/core/src/worker/protocol';

const DESKS = ['IG', 'HY', 'EM', 'SSA'];
const SECTORS = ['Fin', 'Tech', 'Energy', 'Utility', 'Health'];

type Row = Record<string, unknown>;

const model: AggModel = {
  groupCols: [
    { colId: 'desk', field: 'desk' },
    { colId: 'sector', field: 'sector' },
  ],
  aggCols: [{ colId: 'pnl', field: 'pnl', aggFunc: 'sum' }],
  grandTotal: true,
};

const GROUP_LEVELS = model.groupCols.length;
const MAX_UPDATES_PER_ROW = GROUP_LEVELS + (model.grandTotal ? 1 : 0);

function seedRows(n: number): { ids: string[]; rows: Row[] } {
  const ids: string[] = [];
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    const id = `b${i}`;
    ids.push(id);
    rows.push({
      id,
      desk: DESKS[i % DESKS.length]!,
      sector: SECTORS[i % SECTORS.length]!,
      pnl: (i % 17) - 8,
    });
  }
  return { ids, rows };
}

/** Full rescan reference: sum pnl per group node. */
function fullRescanAgg(rows: Map<string, Row>): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows.values()) {
    let path = '';
    for (const spec of model.groupCols) {
      const key = workerGroupKey(row[spec.field]);
      path = path ? `${path}/${key}` : key;
      const nodeId = `g:${spec.colId}:${path}`;
      out.set(nodeId, (out.get(nodeId) ?? 0) + (row.pnl as number));
    }
    if (model.grandTotal) {
      out.set('grand-total', (out.get('grand-total') ?? 0) + (row.pnl as number));
    }
  }
  return out;
}

function updatesToMap(updates: GroupAggUpdate[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const u of updates) {
    const v = u.agg.pnl;
    if (typeof v === 'number') out.set(u.groupId, v);
  }
  return out;
}

let failures = 0;

function fail(msg: string): void {
  failures++;
  console.error(`FAIL: ${msg}`);
}

// ── setup ───────────────────────────────────────────────────────────

const engine = new AggEngine();
engine.setAggModel(model);

const { ids, rows } = seedRows(10_000);
engine.setRowData(ids, rows);

const store = new Map<string, Row>();
for (let i = 0; i < ids.length; i++) store.set(ids[i]!, { ...rows[i]! });

// ── update 10 rows (same group membership) ──────────────────────────

const UPDATE_COUNT = 10;
const updateIds: string[] = [];
const update: Row[] = [];
for (let i = 0; i < UPDATE_COUNT; i++) {
  const id = ids[i * 100]!;
  const row = { ...store.get(id)! };
  row.pnl = (row.pnl as number) + 100;
  store.set(id, row);
  updateIds.push(id);
  update.push(row);
}

const updates = engine.applyTransaction({ updateIds, update });

// ── assert O(dirty) bound ───────────────────────────────────────────

const maxExpected = UPDATE_COUNT * MAX_UPDATES_PER_ROW;
if (updates.length > maxExpected) {
  fail(`updates.length ${updates.length} exceeds bound ${maxExpected}`);
}

// ── assert values match full rescan for dirty groups ────────────────

const ref = fullRescanAgg(store);
const got = updatesToMap(updates);

for (const [groupId, value] of got) {
  const expected = ref.get(groupId);
  if (expected === undefined) {
    fail(`unexpected dirty group ${groupId}`);
    continue;
  }
  if (value !== expected) {
    fail(`group ${groupId}: incremental ${value} vs rescan ${expected}`);
  }
}

// ── result ──────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`FAILED: ${failures} assertion(s)`);
  process.exit(1);
}

console.log(
  `OK: ${UPDATE_COUNT} row updates → ${updates.length} dirty groups (bound ≤ ${maxExpected}), values match full rescan`,
);
process.exit(0);
