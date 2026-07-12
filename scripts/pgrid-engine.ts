/**
 * pgrid Task 1: headless engine bootstrap + indexed table semantics.
 * Run: npx tsx scripts/pgrid-engine.ts
 * (scripts/ is CJS-scoped; perspective's node entry is ESM with top-level await,
 * so it must come in via native dynamic import() — not a static import.)
 */
import assert from 'node:assert/strict';

async function main(): Promise<void> {
  const { ensureEngine, createIndexedTable } = await import('../packages/pgrid/src/engine');
  const client = await ensureEngine();
  assert.ok(client, 'engine client');
  const t = await createIndexedTable({ id: 'string', px: 'float' }, 'id');
  t.update([{ id: 'a', px: 1 }, { id: 'b', px: 2 }]);
  t.update([{ id: 'a', px: 5 }]);                    // replace by index
  const view = await t.raw().view();
  assert.equal(await view.num_rows(), 2);            // indexed: still 2 rows
  const cols = JSON.parse(await view.to_columns_string({ start_row: 0, end_row: 2 }));
  assert.deepEqual(cols.px.sort(), [2, 5]);
  await view.delete();
  await t.delete();
  console.log('pgrid-engine OK');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
