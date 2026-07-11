/**
 * Smoke test: patchGroupAggregates updates displayedNodes after applyWorkerModel
 * (groupRoots empty on worker path).
 * Run: npx tsx scripts/patch-group-agg-smoke.ts
 */
import { RowModel } from '../packages/core/src/rowModel';
import type { WorkerModelOutput } from '../packages/core/src/worker/protocol';

type Row = { id: string; desk: string; pnl: number };

const GROUP_ID = 'g:desk:IG';

function workerOutput(withFooter: boolean): WorkerModelOutput {
  const displayed: WorkerModelOutput['displayed'] = [
    {
      id: GROUP_ID,
      kind: 'group',
      level: 0,
      expanded: true,
      key: 'IG',
      field: 'desk',
      childCount: 2,
      groupId: GROUP_ID,
      aggData: withFooter ? {} : { pnl: 10 },
    },
    {
      id: '1',
      kind: 'leaf',
      level: 1,
      expanded: false,
      key: '',
      field: '',
      childCount: 0,
      groupId: null,
      aggData: {},
    },
    {
      id: '2',
      kind: 'leaf',
      level: 1,
      expanded: false,
      key: '',
      field: '',
      childCount: 0,
      groupId: null,
      aggData: {},
    },
  ];
  if (withFooter) {
    displayed.push({
      id: `${GROUP_ID}:footer`,
      kind: 'footer',
      level: 0,
      expanded: false,
      key: 'IG',
      field: 'desk',
      childCount: 2,
      groupId: GROUP_ID,
      aggData: { pnl: 10 },
    });
  }
  return {
    filteredCount: 2,
    filteredSortedIds: ['1', '2'],
    displayed,
  };
}

let failures = 0;

function fail(msg: string): void {
  failures++;
  console.error(`FAIL: ${msg}`);
}

const model = new RowModel<Row>((r) => r.id);
model.setRowData([
  { id: '1', desk: 'IG', pnl: 5 },
  { id: '2', desk: 'IG', pnl: 5 },
]);

// Group header row (no footer) — worker path patches displayedNodes directly
model.applyWorkerModel(workerOutput(false));
const groupIdx = model.displayedIds.indexOf(GROUP_ID);
if (groupIdx < 0) fail(`group row ${GROUP_ID} missing from displayed`);
model.patchGroupAggregates([{ groupId: GROUP_ID, agg: { pnl: 42 } }]);
if (model.displayedNodes[groupIdx]?.aggData.pnl !== 42) {
  fail(`group displayed aggData.pnl expected 42, got ${model.displayedNodes[groupIdx]?.aggData.pnl}`);
}

// Footer copy when expanded group blanks the header
model.applyWorkerModel(workerOutput(true));
const footerIdx = model.displayedIds.indexOf(`${GROUP_ID}:footer`);
if (footerIdx < 0) fail(`footer row missing from displayed`);
const footerChanges = model.patchGroupAggregates([{ groupId: GROUP_ID, agg: { pnl: 77 } }]);
if (model.displayedNodes[footerIdx]?.aggData.pnl !== 77) {
  fail(
    `footer displayed aggData.pnl expected 77, got ${model.displayedNodes[footerIdx]?.aggData.pnl}`,
  );
}
if (!footerChanges.some((c) => c.rowId === `${GROUP_ID}:footer` && c.newValue === 77)) {
  fail('expected footer cell change in patchGroupAggregates result');
}

// Grand-total path (regression)
model.applyWorkerModel({
  filteredCount: 2,
  filteredSortedIds: ['1', '2'],
  displayed: [
    {
      id: 'grand-total',
      kind: 'grandTotal',
      level: 0,
      expanded: false,
      key: '',
      field: '',
      childCount: 0,
      groupId: null,
      aggData: { pnl: 10 },
    },
  ],
});
model.patchGroupAggregates([{ groupId: 'grand-total', agg: { pnl: 99 } }]);
const gtIdx = model.displayedIds.indexOf('grand-total');
if (model.displayedNodes[gtIdx]?.aggData.pnl !== 99) {
  fail(`grand-total aggData.pnl expected 99, got ${model.displayedNodes[gtIdx]?.aggData.pnl}`);
}

if (failures > 0) {
  console.error(`FAILED: ${failures} assertion(s)`);
  process.exit(1);
}

console.log('OK: patchGroupAggregates updates displayedNodes on worker model path');
process.exit(0);
