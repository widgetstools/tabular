# pgrid

A standalone, ag-grid-style DOM data grid whose row model **is** a FinOS
Perspective view. Grouping, pivoting, filtering, sorting, and aggregation run
in the engine's WASM worker; group and pivot aggregates tick **push-based**
(`view.on_update` → window re-read → diffed stamp with flash) — no polling,
no refresh cadence, anywhere.

Phase 1 delivers the data-plane core: virtualized rows/columns, group tree
with expand/collapse, pivot mode with merged column-group headers, sort,
column resize, group/pivot panels + columns sidebar, React wrapper. Design
and measured results: `docs/superpowers/specs/2026-07-11-pgrid-design.md`
(§10 has the bench table — p95 frame 12.5ms at 10k updates/s, zero dropped,
aggregates repainting ~6×/s while the FinOS datagrid redraws ~1.4×/s on the
same feed).

## Quickstart

```ts
import { PspGrid } from 'pgrid';

const grid = new PspGrid(document.getElementById('root')!, {
  rowIdField: 'id',                    // Perspective table index column
  columnDefs: [
    { field: 'id' },
    { field: 'desk', rowGroup: true },
    { field: 'ccy', enablePivot: true },
    { field: 'mv', type: 'float', aggFunc: 'sum', format: '#,##0.00', width: 150 },
    { field: 'px', type: 'float', aggFunc: 'avg', format: '#,##0.00' },
  ],
  theme: 'dark',
  groupDefaultExpanded: 0,
  rowGroupPanelShow: 'always',
  pivotPanelShow: 'always',
  sideBar: true,
});

await grid.setSchema({ id: 'string', desk: 'string', ccy: 'string', mv: 'float', px: 'float' });
await grid.load(rows);                 // snapshot (chunked into the indexed table)
grid.update(ticks);                    // streaming updates — fire-and-forget;
                                       // rows replace by rowIdField, aggregates tick via push
```

React (optional peer, subpath export):

```tsx
import { PspGridReact } from 'pgrid/react';

<PspGridReact options={options} schema={schema} onReady={(grid) => grid.load(rows)} />
```

Memoize `options`/`schema` — identity changes re-create the grid.

## State & interactions

- `grid.applyColumnState({ rowGroupCols, pivotCols, valueCols, sortModel, filterModel, pivotMode })`
  — any subset; compiles to one Perspective view config (equivalent configs
  reuse the live view, so expansion state survives).
- Header click sorts (`desc → asc → none`, shift/ctrl additive); drag a header
  into the group/pivot strips; chips reorder by drag and remove with ×; the
  sidebar toggles group/pivot/value membership per column.
- Chevrons expand/collapse under live updates (identity re-checked against a
  fresh engine read). Pivot mode has no leaf level — the tree bottoms out at
  the deepest row group.
- Events: `grid.on('ready' | 'model-updated' | 'column-state-changed', cb)`.

## Vite

Perspective ships WASM + a module worker; consumers need:

```ts
export default defineConfig({
  build: { target: 'esnext' },
  optimizeDeps: { exclude: ['@finos/perspective'] },
});
```

## Dependencies

`@finos/perspective` is the only runtime dependency. React ≥18 is an optional
peer used solely by `pgrid/react`. The package is raw-TS workspace style
(`main: ./src/index.ts`).

## Roadmap

Phase 2+: editing (`__INDEX__` writeback), selection, clipboard/export, column
filters UI; then styling depth (rules, number bars, renderers); then the
engine-seam swap (worker-side materializer / SharedArrayBuffer plane — the
`RenderView`/`ViewHost` interfaces are the seam and must not leak Perspective
types). Details: spec §9.
