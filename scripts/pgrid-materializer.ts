/**
 * pgrid Task 5: Materializer against the real engine (node).
 * Run: npx tsx scripts/pgrid-materializer.ts
 * (scripts/ is CJS-scoped; the engine module is ESM with top-level await, so it
 * comes in via native dynamic import() — Task 1 Session Log. Materializer and
 * ViewHost have no runtime engine import, so their static imports are safe here.)
 */
import assert from 'node:assert/strict';
import { ViewHost } from '../packages/pgrid/src/viewHost';
import { compileView } from '../packages/pgrid/src/viewCompiler';
import { Materializer, formatValue } from '../packages/pgrid/src/materializer';
import type { ColDef, GridState } from '../packages/pgrid/src/types';

async function main(): Promise<void> {
  // formatValue is pure — assert the '#,##0.00' pattern subset up front.
  const mvDef: ColDef = { field: 'mv', type: 'float', format: '#,##0.00' };
  assert.equal(formatValue(1234.5, { field: 'x', type: 'float', format: '#,##0.00' }), '1,234.50');
  assert.equal(formatValue(null, { field: 'x', type: 'float', format: '#,##0.00' }), '');
  assert.equal(formatValue(undefined, mvDef), '');
  assert.equal(formatValue('Rates', { field: 'desk' }), 'Rates');

  const { createIndexedTable } = await import('../packages/pgrid/src/engine');
  const t = await createIndexedTable({ id: 'string', desk: 'string', mv: 'float' }, 'id');
  t.update([
    { id: 'a', desk: 'Rates', mv: 10 }, { id: 'b', desk: 'Rates', mv: 20 },
    { id: 'c', desk: 'Credit', mv: 5 },
  ]);
  // Real push wiring: engine update → onModelUpdated → invalidate → frame.
  let mat: Materializer | undefined;
  const host = new ViewHost(t, { onModelUpdated: () => mat?.invalidate() });
  const state: GridState = {
    columnDefs: [{ field: 'desk' }, mvDef],
    rowGroupCols: ['desk'], pivotCols: [], valueCols: [{ field: 'mv', aggFunc: 'sum' }],
    sortModel: [], filterModel: {}, pivotMode: false,
  };
  await host.setConfig(compileView(state), 0);        // depth 0 → TOTAL + 2 desk groups
  mat = new Materializer(host, (path) => (path === 'mv' ? mvDef : undefined));
  const waiters: (() => void)[] = [];
  mat.onFrame(() => { for (const w of waiters.splice(0)) w(); });
  const nextFrame = (): Promise<void> => new Promise((r) => waiters.push(r));

  // Frame 1: fresh window — Credit's sum formatted; first paint never flashes.
  let frame = nextFrame();
  mat.requestWindow({ firstRow: 0, lastRow: 2, subCellPx: 0 }, { firstCol: 0, lastCol: 0 });
  await frame;
  assert.equal(mat.rowCount(), 3);
  assert.equal(mat.rowMeta(1)?.kind, 'group');
  assert.equal(mat.rowMeta(1)?.path[0], 'Credit');    // groups sort asc by default
  assert.equal(mat.cell(1, 0)?.text, '5.00');         // aggregates visible (aggDepth 0)
  assert.equal(mat.cell(1, 0)?.flash, 0);

  // Push: mv 5 → 50 on the Credit leaf; the group aggregate ticks with flash up.
  frame = nextFrame();
  t.update([{ id: 'c', desk: 'Credit', mv: 50 }]);
  await frame;
  assert.equal(mat.cell(1, 0)?.text, '50.00');
  assert.equal(mat.cell(1, 0)?.flash, 1);             // value rose

  // Flash is one-frame-only: a re-read with no data change clears it.
  frame = nextFrame();
  mat.invalidate();
  await frame;
  assert.equal(mat.cell(1, 0)?.text, '50.00');
  assert.equal(mat.cell(1, 0)?.flash, 0);

  await host.dispose();
  await t.delete();
  console.log('pgrid-materializer OK');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
