# pgrid — Perspective-native DOM grid, phase 1 (data-plane core)

**Date:** 2026-07-11 · **Status:** approved (approach A chosen in design discussion)
**Prereq reading:** `docs/research/2026-07-11-perspective-engine-study.md` (engine
write/read paths), plus the two interaction studies summarized in §7.

## 1. Goal

A standalone, ag-grid-style, DOM-based data grid whose row model IS a FinOS
Perspective view — so grouping, pivoting, filtering, sorting, and aggregation
run in the engine's WASM worker, and group/pivot aggregates tick **push-based**
(`view.on_update` → repaint window), with no polling and no refresh cadence.
Phase 1 delivers the data-plane core; editing/selection/clipboard/etc. are
later phases (§9).

Non-goals for phase 1: editing, selection, clipboard/export, master-detail,
tree data (parent/child), pagination, cell spanning, variable row heights,
column filters UI (engine filter API is wired; the header filter UX is phase 2).

## 2. Package

- `packages/pgrid`, package name `pgrid`, private, raw-TS workspace style
  (`main: ./src/index.ts`, same as other packages in this repo).
- Dependencies: `@finos/perspective` **only**. React is an optional peer
  dependency; the wrapper lives at the `./react` subpath export.
- **No `@tabular/*` dependencies** — fully standalone. Patterns are borrowed
  (recycled row pool, RenderView seam), code is not.
- Vite consumers need `build.target: 'esnext'` + `optimizeDeps.exclude:
  ['@finos/perspective']` (documented in the package README).

## 3. Public API (ag-grid-style)

```ts
const grid = new PspGrid(rootEl, {
  columnDefs: ColDef[],        // field, headerName, type?, width?, format?,
                               // aggFunc?, rowGroup?, rowGroupIndex?, pivot?,
                               // pivotIndex?, enableRowGroup?, enablePivot?,
                               // enableValue?, pinned?
  defaultColDef?: Partial<ColDef>,
  rowIdField: string,          // Perspective table index column (required)
  pivotMode?: boolean,
  rowGroupPanelShow?: 'always' | 'never',
  pivotPanelShow?: 'always' | 'never',
  sideBar?: boolean,           // columns panel
  theme?: 'dark' | 'light',
  groupDefaultExpanded?: number,   // → view.set_depth after (re)build
});
// Data (source-agnostic; STOMP wiring stays app-side):
grid.setSchema(schema);              // {col: 'string'|'float'|'integer'|'boolean'|'datetime'}
await grid.load(rows);               // chunked into the indexed table
grid.update(rows);                   // ticking updates (chunk-safe, fire-and-forget)
// State:
grid.applyColumnState(...); grid.getColumnState();
grid.setPivotMode(b); grid.destroy();
// Events: 'model-updated', 'column-state-changed', 'ready'
```

React: `<PspGridReact options={...} onReady={api => ...} />` (thin: creates,
forwards option identity changes it can, destroys on unmount; StrictMode-safe).

## 4. Architecture

One indexed Perspective `Table` is the source of truth. Grid state compiles to
**one** Perspective view config; the view IS the row model (flat, grouped tree,
or pivoted). The renderer is a recycled-row-pool DOM plane bound from an async
`RenderView` seam. `view.on_update` is the push channel.

```
STOMP/app ──rows──▶ Table (indexed, WASM worker)
                      │ table.update(batch)
GridState ──compile──▶ View (group_by/split_by/agg/sort/filter)
                      │        │ on_update (throttled)
     window(first,last)│        ▼
                      ▼   Materializer ── diff vs prev frame ──▶ Pool.stampCell(+flash)
                 to_columns_string(viewport slice)
```

### Modules (each independently testable)

| Module | Purpose | Depends on |
|---|---|---|
| `engine.ts` | headless WASM bootstrap singleton (`init_client(perspective-js.wasm)` + `init_server` + `worker()`); `createIndexedTable(schema, idField)`; chunked load/update helpers | @finos/perspective |
| `types.ts` | ColDef, GridOptions, GridState, RowMeta, CellRender, WindowSlice | — |
| `viewCompiler.ts` | **pure**: GridState → view config; `isEquivalent(a, b)` for the reuse fast-path; sort tuples; filter op mapping; the split-path constant (§7.3) | types |
| `viewHost.ts` | owns Table+View lifecycle; config-diff rebuild vs reuse; `window(first,last)` reads; `on_update` throttle; `expand/collapse/setDepth`; cached `num_rows`/`column_paths`/schema | engine, viewCompiler |
| `windowMath.ts` | **pure**: spacer/percent-scroll mapping with 10M-px clamp, pool sizing, slot assignment, sub-cell offset | — |
| `materializer.ts` | async RenderView over ViewHost: window cache, previous-frame double buffer (flash diffs by `__ID__`+column), Intl formatter cache per (type, format) | viewHost, types |
| `pool.ts` | recycled row pool: position-keyed slots, stampCell (textContent + class swaps + geometry only), flash CSS retrigger | types |
| `styles.ts` | injected stylesheet + CSS-variable theming (dark/light) | — |
| `header.ts` | multi-row header (split_by column groups w/ colspan merge), sort indicators + click rotation, resize/reorder drag, pin | types |
| `panels.ts` | group panel, pivot panel, columns side panel; chip drag (pointer-based) | types |
| `grid.ts` | PspGrid orchestrator: viewport sync loop, delegated events, state transitions, scroll-preservation semantics, destroy | all above |
| `react.tsx` | wrapper (subpath export) | grid |

## 5. Engine interaction contract (from the datagrid study — what we adopt)

1. **Window reads**: `view.to_columns_string({start_row, end_row, start_col,
   end_col, id: true})` + one `JSON.parse` (string form skips wasm→JS object
   marshaling); `num_columns()` alongside; `num_rows()` cached and refreshed
   only on update/expand/collapse (`dimensions().num_view_rows` when split_by
   active). Schema + expression_schema re-fetched **only when the visible
   column-path set changes**, never on vertical scroll.
2. **Meta columns**: always filter through
   `/^__(?:ROW_PATH(?:_\d+)?|ID|GROUPING_ID)__$/` — per-level `__ROW_PATH_n__`
   columns can appear inline and must not leak as user columns.
3. **Group tree**: `__ROW_PATH__` drives RowMeta {level, isGroup, key path};
   aggregate cells blank when `path.length < aggDepth`. Expand/collapse call
   `view.expand(y)/collapse(y)` by absolute view row index;
   shift-variants use `set_depth`. After toggling: refresh num_rows, redraw —
   **awaited** (the datagrid doesn't await; that's a race we fix).
   Expansion state lives in the View: survives table updates; resets on view
   rebuild (config change) — accepted semantics, matching FinOS behavior,
   with `groupDefaultExpanded` re-applied via `set_depth` after rebuild.
4. **Updates**: subscribe `view.on_update` once per view; coalesce with an
   **adaptive throttle** (pace by last materialize+paint duration, debounce
   bursts to the latest — the viewer's renderer pattern). Per update: refresh
   num_rows, re-read the current window, diff, stamp changed cells with flash
   direction. Never touch scroll position.
5. **Config changes**: compile new view config; if `isEquivalent` → reuse
   view. Else build new view first, swap, then `old.remove_update(id)` +
   `old.delete()`. Scroll resets: scrollTop only when group_by changed,
   scrollLeft only when split_by changed; sort/filter changes preserve scroll.
6. **Pivot columns**: paths are `"A|B|measure"`; the measure name sits at
   index `split_by.length` — defined ONCE as `measureIndex(config)` in
   viewCompiler (the datagrid repeats this convention in ≥5 files; we don't).
   Header renders path parts as merged column groups.
7. **Sorting**: header click rotates `desc → asc → none` (their order),
   ctrl/meta appends multi-sort; sort is always a view-config change (engine
   sorts), tuple `[colName, dir]` — same encoding for pivot result columns.

## 6. Rendering plane (from the regular-table study — what we adopt/skip)

Adopt: absolute spacer + **percent-scroll mapping** clamped at 10M px (survives
any row count; sub-cell fractional offset applied as a CSS transform on the
row layer); position-keyed element pool with text diffing (skip write when
unchanged); draw-skip fast path when the logical window didn't change;
rAF-coalesced draws where a burst collapses into at most one queued redraw.

Skip (deliberately): lazy column-width measurement and the mid-draw refetch
loop (our column widths are explicit in ColDefs → single-pass draws); string-
OR-HTMLElement cells (phase 1 cells are text + classes only); style-listener
architecture (our materializer owns styling); variable `virtual_mode` (both
axes always virtualized).

Flash: previous-frame double buffer keyed by `__ID__` + column path, diffed on
update-triggered redraws only (same-viewport gate so scrolling never flashes).

## 7. Push-aggregation flow (the point of the project)

`table.update(batch)` → engine recomputes the view (grouped/pivoted included)
→ `on_update` fires → throttler schedules materialize → `window(first,last)`
re-read (~visible rows × visible cols, one JSON string) → diff against cached
frame → `pool.stampCell` for changed cells with flash → done. Group and pivot
aggregate rows tick because they ARE rows of the view — no refresh cadence, no
transactions, no special-casing of aggregate vs leaf rows.

## 8. Testing

- Pure modules (`windowMath`, `viewCompiler`): tsx assertion scripts (repo
  pattern, `scripts/pgrid-*.ts`).
- `viewHost` + `materializer`: **node-side integration tests against the real
  engine** (`@finos/perspective` has a node entry) — table+view lifecycle,
  window reads, expand/collapse, on_update firing, flash diff correctness.
- Browser: showcase page `PGrid (Perspective-native)` fed by the STOMP server
  (20k × 372 union schema, reusing the showcase's flatten/union-schema
  approach app-side), verified with the session's playwright flow.
- Bench: reuse the scroll/frame-time methodology from the stress page; success
  = p95 frame < 16ms during 10k updates/s with desk→currency grouping, zero
  dropped frames on 3s sweeps, aggregates visibly ticking with no refresh
  interval configured anywhere.

## 9. Phase roadmap (each phase = its own spec → plan → sessions)

- **P1 (this spec)**: data-plane core as above.
- **P2**: editing (indexed-table `__INDEX__` writeback on a dedicated port),
  selection modes, clipboard/export, column filters UI.
- **P3**: styling depth — rules/conditional formats, number bars, renderers,
  status bar, overlays, density.
- **P4**: engine-seam swap — worker-side materializer and/or the
  SharedArrayBuffer zero-copy plane (Rust engine track); `RenderView` +
  `ViewHost` are the two interfaces that must not leak Perspective types to
  make this possible (enforced from P1).

## 10. Phase 1 results (2026-07-12 addendum)

Bench setup: showcase `PGrid (P-native)` page, 20k rows × 372 union-schema
columns from the STOMP feed at ~10k row-updates/s (200 msgs/s × 50), dev
build, 120Hz display, playwright-driven 3s sweeps sampling rAF deltas.
Comparators on the same feed: `Perspective 20k × all cols` (FinOS
perspective-viewer-datagrid) and agref `Perspective SSRM (FinOS)` (ag-grid
SSRM over the engine, polled aggregates). Caveat: the browser tab was shared
with concurrent interactive use; numbers are from interference-checked runs.

| Metric (under 10k updates/s) | pgrid | FinOS datagrid | ag-grid SSRM |
|---|---|---|---|
| Vertical sweep p50 / p95 / worst (ms) | 9.1 / 12.5 / 14.4 | 8.9 / 12.3 / 14.6 | 8.4 / 13.1 / 18.4 |
| Frames > 20ms during sweeps | **0** | 0 (grouped); 1, worst 38.3 (flat 4s) | 0 |
| Horizontal sweep, flat 372 cols (p50/p95/worst) | 8.8 / 12.8 / 18.8, 0 dropped | not measured | n/a |
| Group-aggregate repaint cadence | **6.0/s** (push) | ~1.4 full-window redraws/s | = polling interval (1s best), by construction |
| Flat-view change fidelity | every real change painted (diffed) | whole window rewritten per draw; intermediate values skippable | poll-bounded |
| Tick→paint latency (probe row, group cell) | 274–465ms, median ~371 | not instrumentable (table not exposed) | ≥ polling interval |
| Engine heap across 20 view rebuilds | used_size 3.448→3.455→3.455MB (16MB heap, flat) — no leak | — | — |
| Refresh/polling code in the page | **zero** | zero (engine-push, undiffed) | aggregate refresh timer (1s/2s/5s/Off UI) |

Spec §8 success criteria: **all met** — p95 well under 16ms with desk→currency
grouping at 10k updates/s, zero dropped frames on 3s sweeps (both axes), and
aggregates tick with no refresh cadence configured anywhere.

Interpretation. Frame health is renderer-bound and equal across all three —
every grid idles at display cadence during sweeps; pgrid's recycled pool +
draw-skip does what regular-table does. The separation is the *data* path:
pgrid repaints aggregates ~4× more often than the FinOS datagrid on the same
saturated engine (lighter window reads: cached column paths, no per-fetch
schema round-trips, diffed stamping) and paints every real value change in
flat views, where the datagrid rewrites whole windows at ~1.4/s and can skip
intermediate values. SSRM's cadence is its polling interval by definition —
the refresh-timer UI pgrid exists to delete. Tick→paint latency (~370ms
median) is engine-queue-bound for everyone: reads serialize behind pending
update batches in the single-threaded WASM worker; this is the P4
SharedArrayBuffer/worker-materializer target (§9), not a phase-1 renderer
problem. Node-side leak check: alternating grouped↔pivoted rebuilds ×20 left
engine used_size flat after the first rebuild — the swap-then-delete lifecycle
(§5.5) holds. One engine footnote: the node in-process engine threw a
detached-ArrayBuffer error growing WASM memory under a 20k-row single-table
load (browser worker engine handles the same load fine); the leak check ran
at 5k rows.

## 11. Risks & mitigations

- **View-index expand/collapse under ticking**: expand(y) uses a row index
  that can shift between read and click. Mitigation: expand uses the row's
  identity from the *currently stamped frame* (index captured at stamp time,
  re-validated by `__ID__`/path before the call; on mismatch, re-resolve via
  the fresh window).
- **on_update storms**: adaptive throttle (§5.4) + the draw-skip fast path.
- **372-col windows**: column virtualization keeps reads to visible cols.
- **WASM memory growth**: one table + one live view at a time; views deleted
  on swap; verified by heap sampling in the bench task.
