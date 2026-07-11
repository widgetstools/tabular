/**
 * Repro for "showcase hangs on the Pivot tab / grid looks empty".
 *
 * Two asserted defects:
 *  1. collectPivotKeyPaths emits the CARTESIAN PRODUCT of per-level keys,
 *     manufacturing pivot result columns for (sport, year) combos that never
 *     occur in the data — hundreds of permanently-blank columns (the "no
 *     data" look) and ~2.6× the aggregation work on the Olympic dataset.
 *  2. ColumnModel.getColumn is a linear scan over `all`; pivot aggregation
 *     calls it per row × per level × per path, which multiplies into
 *     millions of O(n) scans once 1000+ pivot result columns are installed
 *     (the "hang").
 *
 * Run: npx tsx scripts/pivot-repro.ts
 * Exit 0 = both fixed; non-zero = failing (prints which).
 */
import { collectPivotKeyPaths, aggregatePivotTree } from '../packages/core/src/pivot';
import type { InternalColumn } from '../packages/core/src/columnModel';
import type { GroupNode } from '../packages/core/src/grouping';

interface Row { sport: string; year: number; country: string; gold: number }

// Sparse combos: sport A only in 2000/2002, sport B only in 2004. A full
// cartesian walk would emit 2 sports × 3 years = 6 paths; the data has 3.
const rows: Row[] = [
  { sport: 'A', year: 2000, country: 'US', gold: 1 },
  { sport: 'A', year: 2002, country: 'US', gold: 2 },
  { sport: 'B', year: 2004, country: 'NO', gold: 3 },
  { sport: 'A', year: 2000, country: 'NO', gold: 4 },
];

const col = (id: string): InternalColumn<Row> => ({
  colId: id,
  def: { field: id } as InternalColumn<Row>['def'],
  width: 100, flex: 0, pinned: null, sort: null, sortIndex: -1,
  hide: false, groupHidden: false, ancestorGroups: [],
});
const columns = [col('sport'), col('year'), col('gold')];
const colsApi = { getColumn: (id: string) => columns.find((c) => c.colId === id) };
const valueOf = (row: Row, c: InternalColumn<Row>) =>
  (row as unknown as Record<string, unknown>)[c.def.field as string];

let failures = 0;
const check = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
};

// ── 1. Key paths must cover only combos present in the data ──────────────
const paths = collectPivotKeyPaths(
  rows,
  [{ colId: 'sport' }, { colId: 'year' }],
  valueOf,
  colsApi,
);
const pathStrs = paths.map((p) => p.join('/')).sort();
check(
  'paths = existing combos only (no cartesian product)',
  JSON.stringify(pathStrs) === JSON.stringify(['A/2000', 'A/2002', 'B/2004']),
  `got [${pathStrs.join(', ')}]`,
);

// ── 2. Aggregation results for existing combos stay correct ──────────────
const root: GroupNode<Row> = {
  key: 'US', field: 'country', level: 0, children: [],
  leafRows: rows.filter((r) => r.country === 'US'),
  aggData: {},
} as unknown as GroupNode<Row>;
aggregatePivotTree([root], [{ colId: 'sport' }, { colId: 'year' }],
  [{ colId: 'gold', aggFunc: 'sum' }], paths, valueOf, colsApi);
check(
  'sum(gold) US × A/2000 = 1',
  root.aggData['pivot_A|2000__gold'] === 1,
  `got ${JSON.stringify(root.aggData)}`,
);
check(
  'sum(gold) US × A/2002 = 2',
  root.aggData['pivot_A|2002__gold'] === 2,
  `got ${JSON.stringify(root.aggData)}`,
);

// ── 3. getColumn must not be a linear scan (hang at 1000+ pivot cols) ────
// Olympic-shaped load: 8k rows, 400 paths, 2 levels, 3 value cols against a
// column model holding 1200 columns. With O(n) getColumn this takes tens of
// seconds; indexed it is < 1s even on slow machines.
import { ColumnModel } from '../packages/core/src/columnModel';

const bigDefs = Array.from({ length: 1200 }, (_, i) => ({ field: `c${i}` }));
const model = new ColumnModel<Record<string, unknown>>(bigDefs, undefined, 800);

const t0 = performance.now();
const N = 2_000_000;
let hits = 0;
for (let i = 0; i < N; i++) {
  if (model.getColumn(`c${(i * 7) % 1200}`)) hits++;
}
const elapsed = performance.now() - t0;
check(
  `2M getColumn lookups over 1200 cols < 1000ms (took ${Math.round(elapsed)}ms)`,
  elapsed < 1000 && hits === N,
  'linear scan detected',
);

process.exit(failures ? 1 : 0);
