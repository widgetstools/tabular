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

### Compute (unchanged, shared)

Same `RowModel`, worker pipeline, transaction paths, and format bridge as the
canvas grid. Core's `index.ts` re-exports the needed internals; no deep
`src/` imports across packages.

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

## Risks

- **Scroll-blank on fling** when worker chunks lag: mitigated by overscan and
  binding stale-but-correct previous window until fresh data lands (same
  behavior as canvas Extreme mode).
- **Style churn**: inline-style fallback per rule-styled cell could recalc-storm
  on dense rule usage; mitigation is the precompiled-class path and measuring
  in the bench page.
- **Apples-to-oranges**: avoided by sharing compute and theme; the only
  variable is the render layer.
