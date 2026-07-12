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
  console.log('pgrid-view-host OK');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
