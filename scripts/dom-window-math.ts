import assert from 'node:assert/strict';
import { computeWindow, poolSize, poolSlot } from '../packages/dom/src/window';

{
  const w = computeWindow(0, 500, 20, 100_000, 8);
  assert.equal(w.firstRow, 0);
  assert.equal(w.lastRow, 25 - 1 + 8); // leading overscan clamped at 0
}
{
  const w = computeWindow(10_000, 500, 20, 100_000, 8);
  assert.equal(w.firstRow, 500 - 8);
  assert.equal(w.lastRow, 500 + 24 + 8);
}
{
  const w = computeWindow(100_000 * 20, 500, 20, 100_000, 8);
  assert.equal(w.lastRow, 99_999);
  assert.ok(w.firstRow <= w.lastRow);
}
{
  const w = computeWindow(0, 500, 20, 3, 8);
  assert.equal(w.firstRow, 0);
  assert.equal(w.lastRow, 2);
}
assert.equal(poolSize(500, 20, 100_000, 8), 25 + 1 + 16);
assert.equal(poolSize(500, 20, 3, 8), 3);
{
  const size = poolSize(500, 20, 100_000, 8);
  assert.equal(poolSlot(500, size), poolSlot(500 + size, size));
  const seen = new Set<number>();
  const w = computeWindow(10_000, 500, 20, 100_000, 8);
  for (let r = w.firstRow; r <= w.lastRow; r++) {
    const s = poolSlot(r, size);
    assert.ok(!seen.has(s), `slot collision at row ${r}`);
    seen.add(s);
  }
}
console.log('dom-window-math OK');
