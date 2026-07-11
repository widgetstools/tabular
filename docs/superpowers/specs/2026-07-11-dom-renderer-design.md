# DOM renderer (@tabular/dom) + canvas comparison — design

Date: 2026-07-11
Status: approved (user, 2026-07-11)

## Why

OpenFin/VDI desks frequently run software-rasterized Chromium, where the
canvas grid's immediate-mode repaint degrades linearly with main-thread speed
(measured: 23fps at 6× CPU throttle before the scroll-blit work; profiling
showed the cost is per-cell JS, not pixel drawing). A DOM renderer rides the
browser's retained-mode machinery — cached compositor tiles, off-main-thread
scrolling — and degrades gracefully in exactly those environments (the
architecture FINOS Perspective converged on). This milestone builds a
hot-path-subset DOM renderer over the existing compute stack and a
side-by-side benchmark so the choice between renderers is made on measured
numbers, not theory.

## Scope

In: virtualized viewport rendering, worker data plane feed, sort/filter/group
display (group rows, indent, chevron, aggregates), live tick updates with
flash, row selection + cell focus display, formatted values, rule/cell styles,
theme parity with the canvas grid.

Out (this milestone): editing, clipboard, master/detail, pivot chrome, column
drag/resize UI, floating filters, side bar, pagination, ARIA layer (fast
follow — DOM makes it possible; not needed for the benchmark).

## Decisions (user-approved)

1. **Scope: hot-path subset** — enough to benchmark honestly; not parity.
2. **Reuse core internals** — `@tabular/dom` imports `RowModel`,
   `ColumnModel`, filters, formatting bridge, and the worker coordinator from
   `@tabular/core` (core re-exports them). Both renderers run identical
   compute; the benchmark isolates rendering.
3. **Comparison: side-by-side showcase page + bench API** — run in Chrome,
   6×-throttled Chrome, and OpenFin.

## Architecture

### Package

`packages/dom` → `@tabular/dom`, zero runtime deps besides `@tabular/core`.
Public API: `new TabularDom<TData>(element, options)` with the same
`GridOptions`/`ColDef` types as core; `destroy()`; the API-surface subset the
comparison page needs (`applyTransactionAsync`, `setSort`/`setFilterModel`
equivalents via shared options, `onReady`). Unsupported options are ignored.

### Renderer: native scroller + recycled row pool

- Root → sticky header (flat divs per column) → scroller div containing a
  height spacer (reuse core's spacer/scroll-ratio math for >16.7M px) and an
  absolutely positioned row layer.
- Row pool: `ceil(viewport/rowHeight) + overscan (8)` row divs, repositioned
  with `transform: translate3d(0, y, 0)`, never created/destroyed during
  scroll. Each cell is one flat div: `textContent`, class tokens, fixed
  width/left from `ColumnModel` offsets.
- No per-cell listeners; one delegated pointer/keyboard listener set on the
  root.
- Scroll (rAF-coalesced): small deltas rebind only rows entering the window
  (DOM analog of the canvas blit); jumps rebind the whole pool (~300 cells,
  ~1–2ms).
- Ticks: rebind only affected visible cells; flash is a CSS animation class
  toggled per changed cell (no JS repaint loop — the structural win over
  canvas for dense ticking).
- Model updates (sort/filter/group/agg push from worker): full pool rebind.
- Selection/focus: class toggles.

### Styling

Theme tokens → CSS custom properties on the grid root (both renderers read
the same theme source, so they look identical). Static cell styles
(alignment, number font) are classes in an injected stylesheet. Rule styles
resolve through the same resolver chain as canvas; results map to a
precompiled class per rule where possible, inline style on the affected cell
otherwise.

### Compute (shared) + render plane (worker-materialized)

Same `RowModel`, worker pipeline, and transaction paths as the canvas grid.
Core's `index.ts` re-exports the needed internals; no deep `src/` imports
across packages.

**All data-plane work runs in the worker — including formatting and style
computation.** The UI thread only stamps precomputed output:

- **Render window**: the UI requests `[firstRow, lastRow]` (rAF-coalesced,
  with overscan); the worker responds with flat arrays — formatted text per
  cell, a style-class id per cell (`Uint16Array`, transferable), and row
  metadata (kind/level/expanded/rowId). Binding a cell is `textContent` +
  one class swap; no formatting, no style resolution, no expression
  evaluation on the UI thread.
- **Style table**: the worker dedupes resolved cell styles (rules engine
  output + static `cellStyle` objects) into a versioned table; the UI
  registers each table version once as generated CSS classes and thereafter
  applies ids.
- **Tick deltas**: for update transactions the worker pushes pre-rendered
  deltas `{ rowIndex, colIndex, text, styleId, flashDir }`; the UI rebinds
  only those visible cells and toggles the flash class.
- **Versioning**: render responses and deltas carry a monotonically
  increasing `modelRevision`; the UI drops anything older than the last
  applied revision (avoids the stale-patch class of bugs found in review).

**Worker eligibility for rendering**: declarative configs cross the worker
boundary — `ColDef.format` (format DSL), rules (@tabular/rules), expression
styles. Arbitrary JS callbacks (`valueFormatter`, function `cellStyle`,
`valueGetter`) cannot; columns using them force main-thread materialization
(same fallback pattern as the existing data-plane eligibility checks). The
main-thread fallback uses the same materializer interface so the renderer
code is identical in both modes.

## Comparison page & bench

Showcase page "DOM vs Canvas": both grids side by side, same 100k-row
dataset, one shared tick generator (adjustable rate), same theme/density.
`window.__benchDomVsCanvas` exposes per-grid:

- `scroll(durationMs, pxPerFrame)` → frames, p50/p90/p99 frame time, avg fps
- `tickLatency(n)` → p50/p95 of applyTransactionAsync→painted-frame time
- cell/DOM counts for context

Scenarios to record: normal Chrome, 6× CPU throttle (VDI proxy), inside the
OpenFin window (`npm run openfin:showcase`).

## Error handling

- Worker ineligibility falls back exactly as canvas does (shared coordinator).
- Unsupported options: ignored silently in this milestone (documented).
- `destroy()` removes listeners, disconnects observers, cancels rAF, empties
  the root.

## Testing / verification

- `tsc` clean across the monorepo (dom package added to the typecheck chain).
- Visual: side-by-side screenshots (basic, grouped, ticking) — same data
  renders identically in both grids.
- Bench numbers captured in the three scenarios and appended to this doc as
  a results addendum.
- Existing `test:worker` untouched (compute shared, not duplicated).

## Results addendum (measured 2026-07-11)

Setup: DomVsCanvas showcase page, 60k rows × 14 cols, flat, ticks at 5,000
updates/s during all runs, scroll at 60px/frame for 3s, tickLatency = 30
single-cell samples (double-rAF). DOM grid in worker-materialized mode unless
noted. Machine: Apple Silicon macOS; OpenFin runtime 43.142.104.1 (GPU on).

| Scenario | Renderer | scroll p50/p90 ms | avg fps | tick p50/p95 ms |
|---|---|---|---|---|
| Chrome, normal | canvas | 8.3 / 9.2 | 120 | 16.7 / 17.6 |
| Chrome, normal | DOM (worker) | 8.3 / 9.0 | 120 | 16.7 / 17.5 |
| Chrome, 6× CPU throttle | canvas | 16.2 / 25.1 | 67 | 21.0 / 33.2 |
| Chrome, 6× CPU throttle | DOM (worker) | 24.5 / 33.4 | 42 | 27.4 / 43.4 |
| Chrome, 6× CPU throttle | DOM (main) | 17.1 / 33.1 | 47 | 20.5 / 37.6 |
| OpenFin (GPU on) | canvas | 8.3 / 9.0 | 120 | 16.6 / 17.8 |
| OpenFin (GPU on) | DOM (worker) | 8.3 / 9.1 | 120 | 16.5 / 19.3 |

Interpretation:

- **At full speed (Chrome and healthy OpenFin) the two renderers are a dead
  heat at the display cap** — both 120fps, one-frame tick latency. The
  worker-materialized DOM path adds no measurable cost when the CPU is fast.
- **Under 6× CPU throttle the canvas renderer wins scrolling** (67fps vs
  42fps worker / 47fps main). Credit where due: this is the scroll-blit
  optimization — canvas now repaints only scrolled-in rows via one
  drawImage, which is cheaper than DOM row rebinding + style recalc under a
  slow CPU. Pre-blit canvas measured 23fps on comparable load, so both
  renderers beat the original baseline.
- **Worker mode costs ~7ms p50 on throttled scroll vs main mode** (24.5 vs
  17.1) — the async render-window round-trip. In exchange the UI thread does
  zero format/style work (profile-verified), leaving headroom for app code
  that a scroll-fps number does not capture.
- **Caveat**: 6× CPU throttling approximates a slow main thread but NOT
  GPU-disabled compositing, where canvas pays extra for full-surface
  uploads/blends and DOM benefits from retained-mode tile caching. The
  decisive OpenFin-VDI comparison (`--disable-gpu` runtime args) is the
  remaining follow-up measurement.
- Structural (unmeasured here): the DOM renderer gets accessibility, IME,
  and text selection for free, and its tick path has no sustained repaint
  loop (CSS animation flash) — the canvas grid keeps a full-repaint rAF loop
  alive during flash decay.

## Phase 2 (approved direction): FINOS Perspective engine behind the same seam

After the renderer comparison lands, add a `PerspectiveEngine` option: the
existing data worker hosts a Perspective (Apache-2.0, C++/WASM) table + view
in-thread and the render plane materializes text/styles from its windowed
reads (`view.to_columns({start_row, end_row})`) — same protocol to the UI,
engine swapped behind the seam. Motivation: hardened incremental
filter/sort/group/agg (including weighted mean) replacing the custom pipeline;
known gaps to solve then: AG-style footer-row synthesis (Perspective puts
aggregates on group headers), tree-path → DisplayedNode mapping, per-cell
flash direction bookkeeping, ~3-5MB WASM asset. The bench page then compares
three configurations: canvas+tabular, DOM+tabular, DOM+perspective.

## Risks (render plane)

- **Async window fetch**: fast scroll outruns the worker round-trip; UI keeps
  the previous window bound (stale-but-correct) and binds fresh data on
  arrival; overscan hides most of the gap. Revision checks prevent
  out-of-order application.
- **Style-table growth**: unbounded distinct styles would leak classes; the
  table is capped (1024 ids) with LRU eviction and a dev warning.

## Risks

- **Scroll-blank on fling** when worker chunks lag: mitigated by overscan and
  binding stale-but-correct previous window until fresh data lands (same
  behavior as canvas Extreme mode).
- **Style churn**: inline-style fallback per rule-styled cell could recalc-storm
  on dense rule usage; mitigation is the precompiled-class path and measuring
  in the bench page.
- **Apples-to-oranges**: avoided by sharing compute and theme; the only
  variable is the render layer.
