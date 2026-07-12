import assert from 'node:assert/strict';
import { computeViewport, panelHeight, poolSize, poolSlot, visibleCols, MAX_PANEL_PX } from '../packages/pgrid/src/windowMath';

// Uncompressed: percent mapping degenerates to pixel mapping.
{
  const ph = panelHeight(1000, 20, 0);
  assert.equal(ph, 20_000);
  const v = computeViewport(400, ph, 500, 1000, 20, 0);
  assert.equal(v.firstRow, 20);
  assert.equal(v.subCellPx, 0);
}
// Fractional scroll → sub-cell offset.
{
  const v = computeViewport(410, 20_000, 500, 1000, 20, 0);
  assert.equal(v.firstRow, 20);
  assert.equal(v.subCellPx, 10);
}
// Compressed: 100M rows × 20px clamps to MAX_PANEL_PX; bottom maps to last page.
{
  const ph = panelHeight(100_000_000, 20, 0);
  assert.equal(ph, MAX_PANEL_PX);
  const v = computeViewport(ph - 500, ph, 500, 100_000_000, 20, 0);
  assert.equal(v.lastRow, 99_999_999);
}
// Pool invariants: no collision inside any window.
{
  const size = poolSize(500, 20, 1_000_000, 8);
  const v = computeViewport(123_456, 20_000_000 > MAX_PANEL_PX ? MAX_PANEL_PX : 20_000_000, 500, 1_000_000, 20, 8);
  const seen = new Set<number>();
  for (let r = v.firstRow; r <= v.lastRow; r++) {
    const s = poolSlot(r, size);
    assert.ok(!seen.has(s), `collision @${r}`);
    seen.add(s);
  }
}
// Column window: widths [100,50,200,100], scrollLeft 120 → firstCol 1, leftPx 100.
{
  const c = visibleCols(120, 250, [100, 50, 200, 100], 0);
  assert.equal(c.firstCol, 1);
  assert.equal(c.leftPx, 100);
  assert.ok(c.lastCol >= 2);
}
console.log('pgrid-window-math OK');
