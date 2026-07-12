import assert from 'node:assert/strict';
import { compileView, isEquivalent, measureIndex, splitPath, META_COLUMN_RE } from '../packages/pgrid/src/viewCompiler';
import type { GridState } from '../packages/pgrid/src/types';

const base: GridState = {
  columnDefs: [
    { field: 'desk' }, { field: 'ccy' },
    { field: 'mv', type: 'float', aggFunc: 'sum' },
    { field: 'px', type: 'float', aggFunc: 'avg' },
  ],
  rowGroupCols: ['desk'], pivotCols: [], valueCols: [
    { field: 'mv', aggFunc: 'sum' }, { field: 'px', aggFunc: 'avg' },
  ],
  sortModel: [{ colId: 'mv', sort: 'desc' }],
  filterModel: { ccy: { op: '==', value: 'USD' } },
  pivotMode: false,
};
const cfg = compileView(base);
assert.deepEqual(cfg.group_by, ['desk']);
assert.deepEqual(cfg.split_by, []);
assert.deepEqual(cfg.aggregates, { mv: 'sum', px: 'avg' });
assert.deepEqual(cfg.sort, [['mv', 'desc']]);
assert.deepEqual(cfg.filter, [['ccy', '==', 'USD']]);
// grouped → columns are the value fields; flat → all fields.
assert.deepEqual(cfg.columns, ['mv', 'px']);
const flat = compileView({ ...base, rowGroupCols: [] });
assert.deepEqual(flat.columns, ['desk', 'ccy', 'mv', 'px']);
// pivotMode adds split_by and keeps group_by.
const piv = compileView({ ...base, pivotMode: true, pivotCols: ['ccy'] });
assert.deepEqual(piv.split_by, ['ccy']);
assert.equal(measureIndex(piv), 1);
assert.deepEqual(splitPath('USD|mv', piv), { groups: ['USD'], measure: 'mv' });
// equivalence: identical → true; sort differs → false.
assert.ok(isEquivalent(cfg, compileView(base)));
assert.ok(!isEquivalent(cfg, compileView({ ...base, sortModel: [] })));
// meta predicate
for (const m of ['__ROW_PATH__', '__ROW_PATH_2__', '__ID__', '__GROUPING_ID__']) assert.ok(META_COLUMN_RE.test(m), m);
assert.ok(!META_COLUMN_RE.test('desk'));
console.log('pgrid-view-compiler OK');
