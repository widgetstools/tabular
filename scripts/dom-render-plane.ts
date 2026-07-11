/**
 * Task 6 render-plane test: drive the worker-side RenderPlane directly (no
 * browser). Seeds a small dataset, materializes a window, and asserts the
 * flat text/styleId arrays, style-table dedupe, and rendered deltas.
 *
 * Run: npx tsx scripts/dom-render-plane.ts
 */
import assert from 'node:assert/strict';
import { compileFormat } from '@tabular/format';
import { DataPipeline } from '../packages/core/src/worker/pipeline';
import { RenderPlane } from '../packages/core/src/worker/renderPlane';
import type { RenderPlaneConfig } from '../packages/core/src/worker/protocol';
import type { WorkerPipelineConfig } from '../packages/core/src/worker/protocol';

interface Row {
  id: string;
  name: string;
  price: number;
  qty: number;
}

function seedRows(n: number): { ids: string[]; rows: Row[] } {
  const ids: string[] = [];
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    const id = `r${i}`;
    ids.push(id);
    rows.push({
      id,
      name: `name-${i}`,
      // r0 seeded so the literal '1,234.50' assertion holds.
      price: i === 0 ? 1234.5 : 100 + i,
      qty: 10 + i,
    });
  }
  return { ids, rows };
}

const pipelineConfig: WorkerPipelineConfig = {
  filterCols: [],
  sortCols: [],
  calcCols: [],
  filterModel: {},
  quickFilterTerms: [],
  sortModel: [],
  groupCols: [],
  aggCols: [],
  groupDefaultExpanded: 0,
  expandedState: [],
};

// qty carries a static rules-style column style that must be deduped into the
// style table (same object → same id across rows).
const renderConfig: RenderPlaneConfig = {
  cols: [
    { colId: 'name', field: 'name' },
    { colId: 'price', field: 'price', type: 'number', format: '#,##0.00' },
    { colId: 'qty', field: 'qty', type: 'number', cellStyle: { background: '#112233' } },
  ],
};

const { ids, rows } = seedRows(100);
const pipeline = new DataPipeline();
pipeline.setConfig(pipelineConfig);
pipeline.setRowData(ids, rows as unknown as Record<string, unknown>[]);
pipeline.rebuild();

const plane = new RenderPlane(pipeline, renderConfig);
const win = plane.materialize(0, 9);

assert.equal(win.text.length, 10 * 3);
assert.equal(win.text[0 * 3 + 1], '1,234.50'); // formatted by DSL in "worker"
assert.ok(win.styleIds[0 * 3 + 2] > 0); // static style got a table id
assert.equal(win.styleTable![win.styleIds[0 * 3 + 2] - 1]!.background, '#112233');
// dedupe: same style object → same id on another row
assert.equal(win.styleIds[1 * 3 + 2], win.styleIds[0 * 3 + 2]);
// name column has no style → id 0
assert.equal(win.styleIds[0 * 3 + 0], 0);
// rowIds/rowKind sanity
assert.equal(win.rowIds[0], 'r0');
assert.equal(win.rowKind[0], 0); // leaf

// deltas: apply an update, expect a rendered delta for the visible window.
const updated = { ...rows[1], price: 9999.5 };
pipeline.applyAndResolve({ updateIds: ['r1'], update: [updated] });
const deltas = plane.deltasFor([{ rowId: 'r1', colId: 'price', dir: 1 }], 0, 9);
const expected = compileFormat('#,##0.00').format(9999.5);
assert.equal(deltas.length, 1);
assert.equal(deltas[0]!.rowIndex, 1);
assert.equal(deltas[0]!.colIndex, 1);
assert.equal(deltas[0]!.text, expected); // new formatted price
assert.equal(deltas[0]!.text, '9,999.50');
assert.ok(deltas[0]!.dir === 1);

// deltas outside the window are dropped.
assert.equal(plane.deltasFor([{ rowId: 'r50', colId: 'price', dir: -1 }], 0, 9).length, 0);

// ── RenderDeltas.firstRow: rowIndex is relative to the window's firstRow ──
// The pushed RenderDeltas message carries `firstRow` (the worker's last
// renderWindow); the client reconstructs the absolute displayed index as
// firstRow + rowIndex. Verify deltasFor over an offset window yields a
// window-relative rowIndex so that firstRow + rowIndex lands on the right row.
{
  const winFirst = 5;
  const offWin = plane.materialize(winFirst, winFirst + 9);
  assert.equal(offWin.firstRow, winFirst);
  const updated7 = { ...rows[7], price: 4242.5 };
  pipeline.applyAndResolve({ updateIds: ['r7'], update: [updated7] });
  const offDeltas = plane.deltasFor(
    [{ rowId: 'r7', colId: 'price', dir: 1 }],
    winFirst,
    winFirst + 9,
  );
  assert.equal(offDeltas.length, 1);
  // window-relative: r7 sits at displayed index 7, window starts at 5 → 2.
  assert.equal(offDeltas[0]!.rowIndex, 2);
  // absolute index the client computes as firstRow + rowIndex must be 7.
  assert.equal(offWin.firstRow + offDeltas[0]!.rowIndex, 7);
}

// ── Review fix 2: structural rebuilds bump modelRevision ─────────────
// An add-only transaction rebuilds the displayed model (applyAndResolve →
// kind 'model'); the next materialize must carry a bumped revision so two
// different displayed models never share one modelRevision.
{
  const revBefore = plane.materialize(0, 9).modelRevision;
  const added: Row = { id: 'r-new', name: 'name-new', price: 1, qty: 1 };
  const result = pipeline.applyAndResolve({ addIds: ['r-new'], add: [added] });
  assert.equal(result.kind, 'model'); // add-only → structural rebuild
  const revAfter = plane.materialize(0, 9).modelRevision;
  assert.ok(
    revAfter > revBefore,
    `modelRevision must bump on structural rebuild (${revBefore} → ${revAfter})`,
  );
}

// ── Review fix 1: footer / grand-total labels ────────────────────────
// groupPass emits footer entries with key ALREADY prefixed ('Total G0') and
// grandTotal key 'Grand Total' — the render plane must echo them verbatim
// (no double 'Total Total', no '(count)' suffix on grand total).
{
  const gPipeline = new DataPipeline();
  gPipeline.setConfig({
    ...pipelineConfig,
    groupCols: [{ colId: 'name', field: 'name' }],
    aggCols: [{ colId: 'price', field: 'price', aggFunc: 'sum' }],
    groupDefaultExpanded: -1,
    groupTotalRow: 'bottom',
    grandTotalRow: 'bottom',
  });
  const gRows: Row[] = [
    { id: 'a0', name: 'G0', price: 1, qty: 1 },
    { id: 'a1', name: 'G0', price: 2, qty: 2 },
    { id: 'a2', name: 'G1', price: 3, qty: 3 },
  ];
  gPipeline.setRowData(gRows.map((r) => r.id), gRows as unknown as Record<string, unknown>[]);
  gPipeline.rebuild();

  const gPlane = new RenderPlane(gPipeline, {
    ...renderConfig,
    groupIndentColId: 'name',
  });
  const gWin = gPlane.materialize(0, gPipeline.displayed.length - 1);
  const kinds = Array.from(gWin.rowKind);
  const labelAt = (r: number): string => gWin.text[r * 3 + 0]!;

  const firstGroup = kinds.indexOf(1);
  assert.equal(labelAt(firstGroup), 'G0 (2)'); // real group: key (childCount)
  const firstFooter = kinds.indexOf(2);
  assert.equal(labelAt(firstFooter), 'Total G0'); // verbatim — no double prefix
  // grandTotal rows share the group kind code; find by row id.
  const grandIdx = gWin.rowIds.indexOf('grand-total');
  assert.ok(grandIdx >= 0);
  assert.equal(labelAt(grandIdx), 'Grand Total'); // verbatim — no '(N)' suffix
}

console.log('dom-render-plane OK');
