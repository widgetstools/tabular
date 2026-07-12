/**
 * Regression: worker passes must read dotted (nested) fields with the same
 * dot-path semantics as the main-thread model (grid.ts valueOf). Before the
 * readField fix, `row['rating.grade']` returned undefined in every worker
 * pass, so sort produced arbitrary order, filters dropped nothing/everything,
 * groups collapsed to '(Blank)', and aggregates were empty.
 * Run: npx tsx scripts/worker-nested-fields.ts
 */
import assert from 'node:assert/strict';
import { DataPipeline } from '../packages/core/src/worker/pipeline';
import type { WorkerPipelineConfig } from '../packages/core/src/worker/protocol';

interface NestedRow {
  id: string;
  desk: string;
  rating: { grade: string };
  risk: { var95: number; weights: { w: number } };
  [key: string]: unknown;
}

const GRADES = ['AAA', 'AA', 'A', 'BBB', 'BB'];

function seed(n: number): { ids: string[]; rows: NestedRow[] } {
  const ids: string[] = [];
  const rows: NestedRow[] = [];
  for (let i = 0; i < n; i++) {
    const id = `p${i}`;
    ids.push(id);
    rows.push({
      id,
      desk: i % 2 ? 'IG' : 'HY',
      rating: { grade: GRADES[i % GRADES.length]! },
      risk: { var95: ((i * 7919) % 1000) + 1, weights: { w: (i % 9) + 1 } },
    });
  }
  return { ids, rows };
}

function baseConfig(): WorkerPipelineConfig {
  return {
    filterCols: [
      { colId: 'rating.grade', field: 'rating.grade' },
      { colId: 'risk.var95', field: 'risk.var95', type: 'number' },
    ] as WorkerPipelineConfig['filterCols'],
    sortCols: [
      { colId: 'rating.grade', field: 'rating.grade' },
      { colId: 'risk.var95', field: 'risk.var95', type: 'number' },
    ] as WorkerPipelineConfig['sortCols'],
    calcCols: [],
    filterModel: {},
    quickFilterTerms: [],
    sortModel: [],
    groupCols: [],
    aggCols: [],
    groupDefaultExpanded: -1,
    expandedState: [],
  };
}

const { ids, rows } = seed(500);

// ── sort on nested numeric field ─────────────────────────────────────────
{
  const p = new DataPipeline();
  p.setRowData(ids, rows.map((r) => ({ ...r })));
  const cfg = baseConfig();
  cfg.sortModel = [{ colId: 'risk.var95', sort: 'desc' }];
  p.setConfig(cfg);
  p.rebuild();
  const displayed = p.displayed;
  assert.ok(displayed.length === 500, `expected 500 leaves, got ${displayed.length}`);
  let prev = Infinity;
  for (const entry of displayed) {
    const row = p.getRow(entry.id) as NestedRow;
    const v = row.risk.var95;
    assert.ok(v <= prev, `sort broken: ${v} follows ${prev}`);
    prev = v;
  }
}

// ── filter on nested string field ────────────────────────────────────────
{
  const p = new DataPipeline();
  p.setRowData(ids, rows.map((r) => ({ ...r })));
  const cfg = baseConfig();
  cfg.filterModel = { 'rating.grade': { type: 'set', values: ['AAA'] } } as never;
  p.setConfig(cfg);
  p.rebuild();
  const displayed = p.displayed;
  assert.equal(displayed.length, 100, `set filter on nested field: got ${displayed.length}`);
  for (const entry of displayed) {
    const row = p.getRow(entry.id) as NestedRow;
    assert.equal(row.rating.grade, 'AAA');
  }
}

// ── group + sum aggregate on nested fields ───────────────────────────────
{
  const p = new DataPipeline();
  p.setRowData(ids, rows.map((r) => ({ ...r })));
  const cfg = baseConfig();
  cfg.groupCols = [{ colId: 'rating.grade', field: 'rating.grade' }];
  cfg.aggCols = [{ colId: 'risk.var95', field: 'risk.var95', aggFunc: 'sum' }] as WorkerPipelineConfig['aggCols'];
  p.setConfig(cfg);
  p.rebuild();
  const groups = p.displayed.filter((e) => e.kind === 'group');
  assert.equal(groups.length, GRADES.length, `expected ${GRADES.length} groups, got ${groups.length}`);
  const keys = groups.map((g) => g.key).sort();
  assert.deepEqual(keys, [...GRADES].sort(), `group keys wrong: ${keys.join(',')}`);
  assert.ok(!keys.includes('(Blank)'), 'nested group key fell back to (Blank)');
  // expected sum for AAA (i % 5 === 0)
  let expected = 0;
  for (let i = 0; i < 500; i += 5) expected += ((i * 7919) % 1000) + 1;
  const aaa = groups.find((g) => g.key === 'AAA')!;
  assert.equal(aaa.aggData['risk.var95'], expected, `AAA sum: ${aaa.aggData['risk.var95']} !== ${expected}`);
}

console.log('worker-nested-fields OK');
