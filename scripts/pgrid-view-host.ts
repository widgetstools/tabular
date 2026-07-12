/**
 * pgrid Task 4: ViewHost against the real engine (node).
 * Run: npx tsx scripts/pgrid-view-host.ts
 * (scripts/ is CJS-scoped; the engine module is ESM with top-level await, so it
 * comes in via native dynamic import() — Task 1 Session Log. ViewHost itself has
 * no runtime engine import, so its static import is safe here.)
 */
import assert from 'node:assert/strict';
import { ViewHost } from '../packages/pgrid/src/viewHost';
import { compileView } from '../packages/pgrid/src/viewCompiler';
import type { GridState } from '../packages/pgrid/src/types';

async function main(): Promise<void> {
  const { createIndexedTable } = await import('../packages/pgrid/src/engine');
  const t = await createIndexedTable({ id: 'string', desk: 'string', mv: 'float' }, 'id');
  t.update([
    { id: 'a', desk: 'Rates', mv: 10 }, { id: 'b', desk: 'Rates', mv: 20 },
    { id: 'c', desk: 'Credit', mv: 5 },
  ]);
  let updates = 0;
  const host = new ViewHost(t, { onModelUpdated: () => { updates++; } });
  const state: GridState = {
    columnDefs: [{ field: 'desk' }, { field: 'mv', type: 'float', aggFunc: 'sum' }],
    rowGroupCols: ['desk'], pivotCols: [], valueCols: [{ field: 'mv', aggFunc: 'sum' }],
    sortModel: [], filterModel: {}, pivotMode: false,
  };
  await host.setConfig(compileView(state), 0);        // depth 0 → collapsed groups
  // TOTAL + 2 desk groups = 3 rows
  assert.equal(host.rowCount(), 3);
  const w = await host.window(0, 2, 0, 0);
  assert.equal(w.metas[0].kind, 'group');             // TOTAL row (level 0, path [])
  assert.equal(w.metas[1].path[0], 'Credit');         // groups sort asc by default
  assert.equal(w.values[0][1], 5);                    // sum(mv) for Credit
  // expand Credit (view row 1) → leaf appears, rowCount grows
  await host.expand(1);
  assert.equal(host.rowCount(), 4);
  // push: engine update fires onModelUpdated
  const before = updates;
  t.update([{ id: 'c', desk: 'Credit', mv: 50 }]);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(updates > before, 'on_update fired');
  const w2 = await host.window(0, 3, 0, 0);
  assert.equal(w2.values[0][1], 50);                  // Credit sum ticked
  // config reuse: identical config must not recreate the view (expansion survives)
  await host.setConfig(compileView(state), 0);
  assert.equal(host.rowCount(), 4);                   // still expanded
  await host.dispose();

  // split_by: window values key off the cached column paths (null-filled when
  // absent), and an update that introduces a new split value grows the column
  // set by the next flush (FinOS datagrid parity — see 2026-07-12 fix row).
  const t2 = await createIndexedTable({ id: 'string', ccy: 'string', mv: 'float' }, 'id');
  t2.update([{ id: 'a', ccy: 'USD', mv: 1 }, { id: 'b', ccy: 'EUR', mv: 2 }]);
  let updates2 = 0;
  const host2 = new ViewHost(t2, { onModelUpdated: () => { updates2++; } });
  const state2: GridState = {
    columnDefs: [{ field: 'id' }, { field: 'ccy' }, { field: 'mv', type: 'float', aggFunc: 'sum' }],
    rowGroupCols: ['id'], pivotCols: ['ccy'], valueCols: [{ field: 'mv', aggFunc: 'sum' }],
    sortModel: [], filterModel: {}, pivotMode: true,
  };
  await host2.setConfig(compileView(state2), 0);
  assert.deepEqual(host2.columnPaths(), ['EUR|mv', 'USD|mv']);
  const wp = await host2.window(0, 2, 0, 1);
  assert.deepEqual(wp.cols, ['EUR|mv', 'USD|mv']);       // cache order, not response-key order
  assert.equal(wp.values[1][0], 1);                      // TOTAL row, USD sum
  // Pivot mode: no injected leaf level — deepest groups are the tree floor.
  assert.equal(wp.metas[0].expandable, true);            // TOTAL can expand to id groups
  assert.equal(wp.metas[1].kind, 'group');
  assert.equal(wp.metas[1].expandable, false);           // deepest level: no leaf drill-down
  t2.update([{ id: 'c', ccy: 'CHF', mv: 3 }]);           // new split value → new column
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(updates2 > 0, 'split on_update fired');
  assert.deepEqual(host2.columnPaths(), ['CHF|mv', 'EUR|mv', 'USD|mv']);
  const wp2 = await host2.window(0, 3, 0, 2);
  assert.deepEqual(wp2.cols, ['CHF|mv', 'EUR|mv', 'USD|mv']);
  assert.equal(wp2.values[0][0], 3);                     // TOTAL row, CHF sum
  await host2.dispose();
  await t2.delete();

  console.log('pgrid-view-host OK');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
