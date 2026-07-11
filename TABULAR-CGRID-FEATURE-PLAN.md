# Tabular × cgrid — Feature Adoption Plan

Bringing every cgrid capability (worker data plane, calc/expressions, rules/alerts,
format DSL, renderer catalog, edit ops, state/layouts/profiles, UI tooling) into
Tabular **without compromising what Tabular already is**: a lean, canvas-first,
AG Grid v35+-shaped engine.

Companion documents: the cgrid/Tabular feature inventories (gap-analysis canvas),
`CGGRID-IMPLEMENTATION-PLAN (1).md` (the original architecture brief).

---

## 0. Doctrine — the four constraints, stated as rules

Every task in this plan is judged against these four rules. A change that violates
one is redesigned, not shipped.

### 0.1 Non-intrusive: the engine grows seams, not features

`packages/core` gains **extension seams** — registries, resolver chains, state
slices — and almost nothing else. Each cgrid subsystem lands as a satellite
package that plugs into those seams:

```
packages/
  core/          ← engine. Gains seams (§1). Stays AG-shaped.
  react/         ← unchanged thin wrapper
  expression/    ← NEW  parse/compile/eval DSL          (no deps on core)
  calc/          ← NEW  calculated columns + agg scopes  (core + expression)
  rules/         ← NEW  conditional styles + alerts      (core + expression)
  format/        ← NEW  Excel codes, style tags, composite cells (core)
  renderers/     ← NEW  the painter catalog              (core, tree-shakable)
  edit/          ← NEW  smart edit, bulk update, journal+ (core)
  ext/           ← NEW  shell, toolbars, pickers, profiles (core + others)
```

Rules of the seam:
- **Zero cost when unused.** A grid with nothing registered must paint the same
  bytes and allocate the same objects as today. Seam checks are a single
  null/`undefined` test on the hot path, hoisted out of per-cell loops wherever
  the answer is per-column or per-frame.
- **No satellite imports inside core.** Core defines the interfaces; satellites
  import core, never the reverse. (This is how cgrid keeps its kernel vanilla,
  and it is why its Lit dependency never leaked past `customizer`.)
- **AG parity is untouched.** New options that mirror AG (editors, fill handle,
  pinned rows, `initialState`) use AG's exact names per the workspace rule.
  Tabular-only capabilities (rules, calc, format DSL) live under one namespaced
  option each (`calc`, `rules`, `formatting`) so the AG-shaped surface stays
  clean and the deviation is self-documenting.

### 0.2 Organic: grow from what exists, strangler-style

Nothing is rewritten. Each subsystem extends a structure that is already in the
codebase and already proven:

| Existing structure | Grows into |
|---|---|
| `worker/protocol.ts` + `aggWorker.ts` + `client.ts` | The full worker data plane (§3). The agg worker already mirrors the row store and applies transactions — filter/sort/group are added as passes over that same store, one at a time. |
| `aggWorker.ts` hard-coded accumulators | Pluggable `registerAggregate {init, add, remove, update, finalize}` delta contract (§4). |
| `flash.ts` (decaying tick flash) | Rule flash modes (fade/pulse/glow) and expiry (§5). |
| `styling.ts` (class rules → canvas styles) | The style resolver chain that rules and format tiers plug into (§1.3). |
| `renderer.ts` default cell paint | `paintCell` renderer dispatch → registry + selector (§1.2). |
| `toolPanels/` vanilla-DOM panels + `sideBar.ts` | The chrome component kit and custom tool panel adapter (§8). |
| `theme.ts` tokens + `icons.ts` Lucide registry | The **only** source of color, spacing, and iconography for every new pixel (§0.4). |
| `getColumnState` / `getFilterModel` | Unified versioned `getState`/`setState` + layouts (§2). |

### 0.3 Performance paramount: budgets, not vibes

Standing budgets, enforced by the existing benchmark pages plus new scripted
runs (§10):

| Scenario | Budget |
|---|---|
| RealtimeAgg: 100k rows, grouped, 200k updates/s | ≤ 8ms scripting+paint per frame, 0 dropped frames over 30s |
| Extreme: 1M × 500, cold scroll | 60fps sustained, first frame ≤ current baseline +5% |
| Idle grid with all satellites **loaded but unregistered** | Byte-identical paint path; no new per-frame allocation |
| Any worker round trip (viewport chunk, agg push) | ≤ 1 frame of latency at 60fps; transferables only, no structured-clone of row arrays |
| Expression evaluation | Compiled closures only; parse once, never in a paint or tick path |

Techniques carried over from cgrid and from the cggrid brief: typed-array
viewport chunks with text-offset encoding, per-cell dirty rects, object pools
for paint descriptors, LRU `measureText` cache, incremental (delta) aggregation,
compile-don't-interpret for every DSL.

### 0.4 Look and feel: one token system, AG-verified

- Every new pixel — ribbon, drawer, pickers, rule indicators, composite cells —
  resolves its colors, spacing, fonts, and radii from `theme.ts` tokens and its
  icons from `icons.ts`. No new hex values, no new fonts, no inline styles that
  bypass the theme.
- Density awareness is mandatory: chrome heights and paddings derive from the
  active density the way row/header heights already do.
- Anything with an AG Grid equivalent (editors, fill handle, pinned rows,
  column menu additions, date filter) is verified **side by side against
  `apps/agref`** with seeded data, per the workspace rule — behavior, wording,
  and visuals, not just compilation.
- Tabular-only chrome (ribbon, settings drawer, rules UI) follows the existing
  Tabular chrome idiom (sidebar/tool panel styling), so the grid reads as one
  instrument, not an engine with a bolted-on toolkit.
- Motion discipline: the tick flash remains the only decorative animation. Rule
  flashes are information (they ride the same flash layer); menus, drawers, and
  pickers open instantly.

---

## 1. Core seams (Phase 0 — the only invasive work in the plan)

Small, surgical additions to `packages/core`. Everything later depends on these,
so they are built first and built carefully. Estimated touch points: `types.ts`,
`grid.ts`, `renderer.ts`, `rowModel.ts`, `styling.ts`, `sideBar.ts`.

### 1.1 Registries

```ts
// All registries are per-grid (constructor-scoped), with an optional global
// fallback registry for app-wide registration — mirrors registerIcons.
registerCellRenderer(name: string, renderer: CanvasCellRenderer): void
registerCellEditor(name: string, editor: CellEditorFactory): void
registerAggregate(name: string, agg: DeltaAggregate): void        // §4
registerToolPanel(id: string, panel: ToolPanelFactory): void      // §8
```

- `ColDef.cellRenderer` accepts a registered name (string) in addition to the
  existing callback — AG semantics.
- `ColDef.cellRendererSelector` / `cellEditorSelector` added (AG names).
- Renderer lookup is resolved **once per column per model refresh**, not per
  cell paint; the per-cell dispatch is one indexed call.

### 1.2 Renderer contract

Formalize what `renderer.ts` already passes implicitly into a stable
`CellPaintContext` (ctx, rect, value, formatted, row node, column, theme,
density, flash state, selection state) plus two optional capabilities:

- `hitTest(localX, localY, ctx) => HitRegion | null` — for interactive painters
  (action clusters, links). Grid routes clicks/hover through it; this is the
  same mechanism the header buttons and chevrons use today, generalized.
- `measure(ctx) => number | undefined` — opt-in participation in autosize.

### 1.3 Resolver chains (the rules/format hook)

Two ordered chains, evaluated at paint time with per-frame memoization:

```ts
// Style: base ← classStyles/cellClassRules (existing) ← chain entries (rules, format tiers)
addCellStyleResolver(fn: (cell: CellRef, out: MutableCellStyle) => void, priority: number)
// Value text: valueFormatter (existing) ← chain entries (format DSL)
addValueFormatResolver(fn: (cell: CellRef) => string | undefined, priority: number)
```

- Resolvers write into a **pooled mutable style object** (no per-cell allocation).
- The chain is skipped entirely (single length check) when empty — rule 0.1.
- `styling.ts`'s existing class-rule resolution becomes the first chain entry,
  proving the mechanism against current behavior before anything new uses it.

### 1.4 Unified state + module slices

AG-shaped where AG has a shape, cgrid-shaped where it doesn't:

```ts
api.getState(): GridState            // AG name; columns, filters, sort, group/pivot,
api.setState(s: GridState): void     // sidebar, pagination, + module slices
options.initialState?: GridState     // applied before first paint (AG name)

registerStateModule({ id, version, get(): unknown, set(data, version): void })
```

- `GridState` is versioned; migrations are pure functions keyed by version.
- Satellites (calc, rules, format, edit settings, ext chrome) persist through
  slices — core never knows their shape.
- `persistState: boolean` + `gridId: string` → debounced localStorage autosave
  (cgrid semantics; trivially small once `getState` exists).

### 1.5 Transaction tap (the rules/renderers/history feed)

A read-only subscription to the transaction stream **after** `getRowId`
resolution, carrying old/new values per changed field:

```ts
api.onTransactionApplied(fn: (delta: RowDelta[]) => void): Unsub
```

The flash manager effectively consumes this already; exposing it lets rules
(`[col.old]`/`[col.new]`), `PREV()`, tick history ring buffers, and alerts all
ride one feed with zero duplicate bookkeeping.

**Exit criteria (Phase 0):** all seams in place; grid with no registrations is
pixel- and allocation-identical (verified with a paint-trace diff on the
showcase pages); `getState`/`setState` round-trips every existing showcase page;
`initialState` restores before first paint.

---

## 2. Phase 1 — Editing & interaction table stakes

User-visible parity gaps, independent of architecture. All AG-named, all
verified against `agref` side by side.

1. **Built-in editors** via the §1.1 registry: `agNumberCellEditor`,
   `agDateCellEditor`, `agDateStringCellEditor`, `agSelectCellEditor`,
   `agLargeTextCellEditor`, `agCheckboxCellEditor` (AG names). Each is a DOM
   overlay pixel-registered to the cell (same font/size/padding/baseline —
   glyph-diff test).
2. **Fill handle**: 6px square at range corner with 12px hit slop, drag-to-fill
   with AG's default fill inference, `fillOperation` callback, Ctrl+D fill-down.
   Painted on the overlay canvas next to the existing range stroke.
3. **Delete clears range** (leaf editable cells only), one undo batch.
4. **Multiple cell ranges**: Ctrl+drag adds ranges; `getCellRanges()` returns
   all; status-bar aggregation spans all ranges. Overlay paints each perimeter.
5. **Pinned rows**: `pinnedTopRowData` / `pinnedBottomRowData`. Rendering
   reuses the sticky-band mechanics built for `groupSticky` and the pinned
   grand-total row; pinned rows are non-selectable, non-groupable, editable per
   AG semantics.
6. **Date filter** (`agDateColumnFilter` semantics) in `filters.ts`, floating
   filter included.
7. **Edit journal upgrade**: stack cap 100 (from 10), batches carry a `source`
   tag (`edit | paste | fill | smartEdit | bulkUpdate`) so §7's ops integrate
   without a rewrite.

**Exit criteria:** side-by-side parity on an extended Editing/RangeSelection
agref page pair; fill-handle behavior matches AG on numeric series, strings,
and multi-column ranges; RealtimeAgg budget unaffected.

---

## 3. Phase 2 — The worker data plane (the structural investment)

The single most important adoption, executed as a **strangler** on the existing
`worker/` seam. The worker data plane is now the default; the main-thread CSRM
remains the fallback for ineligible features, debug, and environments without
Worker support.

Authoritative invariants: `docs/superpowers/specs/2026-07-10-worker-invariants.md`
(worker unification plan: `docs/superpowers/plans/2026-07-10-worker-data-plane-unification.md`).

### 3.1 Approach

`workerAggregation: true` today means: worker mirrors rows, applies update
transactions, pushes group aggregates. The plan generalizes this in stages,
each stage independently shippable and verified by differential testing
(worker output must equal main-thread output on randomized data + transactions):

1. **Stage W1 — mirrored store becomes authoritative for updates.** All
   transaction types (add/remove, not just update) applied on the worker;
   main thread keeps its own model (dual-write, compare mode in dev).
2. **Stage W2 — filter pass on worker.** The worker computes the filtered id
   set; main thread consumes it instead of running `filters.ts`. Filter model
   changes post to the worker. Quick filter tokenization moves with it.
3. **Stage W3 — sort pass on worker.** Sorted index arrays (Uint32Array,
   transferable). Comparators: field-based columns sort on the worker;
   columns with JS `comparator`/`valueGetter` fall back to main thread for
   that pass (documented, same eligibility pattern as `workerAggModel()` today).
4. **Stage W4 — group/flatten on worker.** Group tree + flatten output as
   typed row-index arrays with per-row metadata (level, group flag, expanded)
   — this is where the existing agg engine merges into the pipeline instead of
   being a side-channel.
5. **Stage W5 — viewport chunks.** The worker owns row *data* for visible
   windows: typed-array columns (Float64 for numerics, offset-encoded UTF-8
   for text) shipped as transferables per scroll window, with velocity-scaled
   overscan (cgrid's `prefetchRange`). Main thread paints from chunks and
   drops its full-row mirror for worker-eligible grids.
6. **Stage W6 — worker services.** Clipboard TSV serialize/parse, CSV bytes,
   real OOXML `.xlsx` writer (replaces the SpreadsheetML deviation), and
   `measureText` autosize via OffscreenCanvas with main-thread fallback.

### 3.2 Option surface

```ts
rowDataMode?: 'main' | 'worker'   // Tabular extension; default 'worker' (falls back to main when ineligible).
// workerAggregation is deprecated; ignored when set.
```

Eligibility rules (no pivot/tree in W2–W4 initially; JS callbacks force
per-pass fallback) follow the existing `workerAggModel()` pattern: detect,
degrade gracefully, log once in dev.

### 3.3 Non-negotiables

- Protocol messages carry only transferables or small plain objects; the
  RowDelta feed (§1.5) is produced worker-side and forwarded.
- Every stage keeps `refreshModel()` as the fallback; a worker error tears the
  worker down and reverts to main-thread mode without data loss (rows of
  record remain the caller's objects until W5).
- Pivot and tree data stay main-thread until a dedicated follow-up; the seam
  is the same flatten-output contract, so they are ports, not redesigns.

**Exit criteria (unification):**
- [ ] Single worker module; no aggWorker.ts
- [ ] Extreme default worker at budget
- [ ] worker-compare green (incl. pivot + update-only aggs)
- [ ] RealtimeAgg on data plane with incremental fast-path; main ≤ 4ms p95 scripting
- [ ] Pivot live ticks do not call main reaggregateLive when worker active

---

## 4. Phase 3 — Expression engine and calculated columns

### 4.1 `@tabular/expression` (dependency-free)

Port of the cgrid design: tokenizer → parser → compiler emitting **closures**
(CSP-safe, no `eval`), `[field]` refs, arithmetic/comparison/logical operators,
ternary, string ops, ~20 builtins (`IF`, `COALESCE`, `ROUND`, `ABS`, `FIXED`,
date parts, …). Deliverables: `parse`, `compile`, `validate` (with position-
aware errors for editor UIs), `dependencies(expr) => string[]`.

### 4.2 `@tabular/calc`

- `ColDef` extension: `calc?: string` (expression) as an alternative to
  `valueGetter`. Compiled once at column resolution; evaluated wherever
  `valueGetter` is evaluated today — so sort/filter/group/agg work unchanged.
- **Watched-column invalidation**: `dependencies()` drives a per-column dirty
  set; an update transaction touching only unwatched fields skips recompute.
- **Aggregate scopes** (`SUM`, `AVG`, …, `PCT_OF_TOTAL`, with
  `all | visible | group | parent` scopes): computed on the worker as part of
  the agg pass, exposed to expressions as pre-resolved constants per node —
  expressions never iterate rows on the main thread.
- `PREV([field])` reads the RowDelta feed's old-value snapshot (§1.5).
- The `aggWorker` accumulator set is refactored to the public
  `registerAggregate` delta contract (§1.1); the existing 8 built-ins become
  its first registrations, proving the contract with zero behavior change.

**Exit criteria:** calc columns sort/filter/group correctly; a 100k-row grid
with 5 calc columns (2 with aggregate scopes) holds the RealtimeAgg budget;
differential test: calc column equals equivalent `valueGetter`.

---

## 5. Phase 4 — Rules and alerts (`@tabular/rules`)

- **Style rules**: `{ condition: '[pnl.new] < [pnl.old] * 0.95', style, priority }`.
  Conditions compile via `@tabular/expression`; evaluation happens **on the
  RowDelta feed** (event-driven, not per-paint) and materializes into the
  §1.3 style resolver chain as a per-cell active-rule bitmap — paint reads a
  precomputed style, never evaluates an expression.
- **Old/new refs** (`[col.old]`, `[col.new]`) come from the delta feed; rules
  without them evaluate only on model refresh.
- **Indicators**: Lucide badge at cell/row-start/row-end via a renderer
  decorator (post-paint hook in the renderer contract). Icon geometry from
  `icons.ts`.
- **Flash modes**: extend `flash.ts` with per-rule fade/pulse/glow curves and
  `activeDurationMs` expiry, sharing the existing decay clock (pure function
  of `now − matchedAt`, no timers).
- **Alerts**: same compiled conditions, `dataChange | relativeChange | rowChange`
  triggers, severity, per-rule debounce + global token bucket, bounded history
  ring, `onAlert` callback. Evaluated worker-side when the data plane is in
  worker mode; main-thread otherwise. No UI in this phase beyond the event —
  the ext bell (§8) consumes it later.
- State: one `rules` state slice (§1.4).

**Exit criteria:** 50 active rules over 100k rows at 200k updates/s inside
budget; indicators/flash verified visually in a new showcase page; alert storm
(rule matching every row) stays bounded by the token bucket.

---

## 6. Phase 5 — Format DSL and composite cells (`@tabular/format`)

- **Tier 0 — Excel codes**: section-aware parse (`pos;neg;zero;text`), digit
  placeholders, thousands/scaling, colors mapped to theme-token-compatible
  slots, date tokens. Compiled to a closure; wired as a `valueFormatter`-
  compatible entry in the §1.3 format resolver chain. `ColDef.format?: string`.
- **Tier 1 — style tags**: `[color=]`, `[bg=]`, `[weight=]`, `[if]`
  conditions, `{icon:name}` — compiles into style-chain writes + inline icon
  paint. Colors resolve through the theme (named tokens preferred; raw hex
  allowed but discouraged in docs).
- **Tier 2 — composite cells**: multi-fragment cell definitions (value +
  badge + icon + secondary text) rendered by a composite painter registered
  through §1.1; fragments reuse catalog painters (§7).
- **Preset registry**: number/currency/percent/date/relativeTime/abbreviated —
  consumed by the ext format picker later.
- **Styled clipboard**: `text/html` alongside TSV on copy, preserving Tier 0/1
  output (worker-serialized in worker mode).

**Exit criteria:** format-heavy column (code + tags) paints within 10% of the
plain-text column baseline (compiled path, LRU'd formatted strings keyed by
value); agref side-by-side for anything with an AG analog (`valueFormatter`
interop).

---

## 7. Phase 6 — Renderer catalog (`@tabular/renderers`) and edit ops (`@tabular/edit`)

Two packages, parallelizable once Phases 0/3 are done.

### 7.1 Renderers

- **Infrastructure first**: `ColumnStats` (incremental min/max/sum per column,
  maintained on the delta feed / worker) and `TickHistory` (fixed-size ring
  buffers per watched cell, opt-in per column) — the data that sparklines,
  heat bars, and price-direction painters need. Typed arrays, transferable.
- **Catalog**, in dependency order, each painter a standalone registration:
  1. Financial numerics: price w/ tick flash, price-direction, pnl, delta,
     bps, pct-change, 32nds fractional, K/M/B abbreviation.
  2. Bars & gauges: progress, range, bidirectional, heat gradient, gauge,
     spread, volume, maturity ladder.
  3. Badges & indicators: status pill, rating badge/cluster, venue/side/TIF
     chips, status dot, traffic light.
  4. Sparklines: line/column/area/bar/win-loss/pie/yield-curve (TickHistory).
  5. Action cells: icon cluster + row menu using the renderer `hitTest`
     capability (§1.2).
- All geometry density-scaled; all colors from theme tokens; direction hues
  reuse the flash gain/loss tokens so the whole grid agrees on what up/down
  look like.
- New showcase page: a live blotter demo composing catalog painters over the
  RealtimeAgg feed — this is both the demo and the perf gate.

### 7.2 Edit ops

- **Smart edit**: range-targeted `× ÷ + −` operations with preview
  (before/after in the panel), applied through `applyTransaction` as one
  journal batch.
- **Bulk update**: distinct-value listing for a column (reuses
  `getDistinctValues`) + set/replace over the filtered set, previewed.
- **Nudges**: configurable +/- keys and magnitude suffix parsing (`1.5k`,
  `2M`, `1B`) in the number editor's parser.
- Panels register through the §8 tool-panel adapter; engine logic lives in
  `@tabular/edit`, UI in ext — same split cgrid uses (`edit` vs `customizer`).

**Exit criteria:** catalog page holds frame budget with 20 painter-heavy
columns × 100k rows ticking; smart-edit preview/apply/undo round-trips as one
journal entry.

---

## 8. Phase 7 — UI tooling (`@tabular/ext`)

The batteries-included layer. **Vanilla DOM, no Lit** — Tabular's tool panels
are already vanilla and dependency-free, and one chrome idiom is worth more
than a component framework. (cgrid's Lit decision was scoped to `customizer`;
we get the same panel ergonomics from a small helper module instead.)

- **Extension system**: `TabularExt` wrapper class + `<tabular-ext>` custom
  element; `ExtensionRegistry` with `toolbar-item` and `settings-module`
  kinds; shared context (grid api, profiles, event bus, modal host). The
  wrapper owns layout only — the grid never knows ext exists.
- **Shell**: title bar + optional ribbon reserving space above the grid
  (same pattern as the row-group panel), non-modal right settings drawer
  overlaid on the grid. Every surface themed from the grid's resolved tokens
  so chrome and data read as one instrument.
- **Custom tool panels in core**: the small missing piece —
  `registerToolPanel` (§1.1) + `SideBarDef` accepting registered ids; the
  sidebar's "not yet supported" branch is replaced by the adapter. Ext panels
  and user panels use the same door.
- **Title bar**: brand, expandable search (drives `setQuickFilter`),
  notifications (consumes §5 alerts), layouts menu, dirty-aware save,
  settings launcher, overflow.
- **Layouts menu**: switch/rename/duplicate/delete/save-new/export/import over
  a named-layouts API added to core state (§1.4): layouts are named
  `GridState` snapshots with a `layoutChanged` event.
- **Column config popover**: per-column quick settings over multi-column
  targets (filter type + floating, group/pivot, agg func + show-in-header,
  behavior flags) — reuses existing runtime APIs plus small def-patch support.
- **Format picker** (preset catalog + custom-code tab with live compiled
  preview via `@tabular/format`) and **icon/emoji picker** (searchable, lazy
  tile grid over the `icons.ts` registry).
- **Settings modules**: drawer-hosted, read/write via `setGridOption`, persist
  via state slices; Grid Options module is the proof module.
- **Profiles**: `ProfilesController` + pluggable async `ProfileStore`
  (localStorage built-in); snapshot = `getState()` + ext chrome state; dirty
  tracking drives the save affordances.

**Exit criteria:** a showcase page running the full shell (title bar + ribbon +
drawer) over the blotter demo; layouts round-trip including satellite slices;
grid mounted *without* ext is byte-identical to today.

---

## 9. Phase 8 — Hardening

- **A11y ARIA shadow**: hidden `role="grid"` window mirroring the viewport
  (rows near focus), `aria-rowcount`/`aria-colcount`, live-region
  announcements, focus routing — per the cggrid brief §8.
- **Theme params**: `withParams`-style token overrides at runtime
  (`setThemeParams`/`getThemeParams`) layered over the existing dark/light
  sets; ext settings UI consumes it.
- **Remaining parity odds and ends**: scoped select-all
  (`all | filtered | currentPage`), `groupDisplayType` variants
  (`multipleColumns`, `groupRows`), group niceties
  (`groupRemoveSingleChildren`, `showOpenedGroup`), Excel-style keyboard
  editing option, full-row edit mode.
- **Perf regression harness** becomes CI-runnable (§10).

---

## 10. Verification strategy (continuous, not a phase)

1. **Differential testing** — the worker plane, calc columns, and the
   aggregate contract are all verified by "two implementations, one answer":
   randomized data + transaction sequences, worker/satellite output compared
   to the main-thread reference. This is the same technique that caught the
   agg-worker PnL mismatch.
2. **Paint-trace diffing** — a dev hook records the sequence of canvas calls
   for a frame; Phase 0's "zero cost when unused" and ext's "byte-identical
   without shell" claims are asserted by diffing traces, not by eyeballing.
3. **agref side-by-side** — every AG-named feature gets/extends an agref page
   with seeded data and a Playwright screenshot pair, per the workspace rule.
4. **Perf gates** — scripted Playwright runs of RealtimeAgg (200k updates/s,
   30s, frame histogram) and Extreme (scroll sweep) with the §0.3 budgets;
   run before merging each phase.
5. **Property tests** — expression compiler (parse→print→parse fixpoint,
   randomized ASTs), format codes vs a reference table, delta aggregates
   converge to full recompute.

---

## 11. Sequencing and dependencies

```
Phase 0  Core seams + state           ──┬─ everything depends on this
Phase 1  Editing table stakes         ──┤  (independent of worker plane)
Phase 2  Worker data plane W1–W6      ──┼─ enables calc scopes, alerts-on-worker,
Phase 3  Expression + calc            ──┤  worker export, chunked rendering
Phase 4  Rules + alerts               ──┤  needs 0 (chains, delta feed), 3 (expressions)
Phase 5  Format DSL + composite       ──┤  needs 0 (chains); picker UI waits for 7
Phase 6  Renderers + edit ops         ──┤  needs 0 (registry); TickHistory better on 2
Phase 7  Ext UI tooling               ──┤  needs 0 (state/layouts), 5 (format picker),
Phase 8  Hardening                    ──┘  6 (edit panels); shell itself only needs 0
```

Phases 1 and 2 can proceed in parallel (different files, different risk
profiles). Within Phase 2, each W-stage ships behind the default-off option.
Phases 4–6 are parallelizable across the three satellite packages once 0 and 3
land. The ext shell (7) can start any time after 0 with reduced scope and
absorb pickers/panels as their engines arrive.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Seam checks creep into per-cell hot loops | Resolve per-column/per-frame; paint-trace diff gate (§10.2) fails the build if the empty-seam path changes |
| Worker plane destabilizes the proven CSRM | Strangler stages, default-off, dual-write compare mode in dev, automatic fallback on worker error |
| Expression/rules evaluated at paint time by accident | Architectural rule: DSLs compile at config time, evaluate on the delta feed, materialize into precomputed state that paint reads |
| Satellite sprawl fragments look & feel | Single token/icon source enforced by lint (no hex literals outside `theme.ts`); chrome idiom documented once, in ext |
| AG parity drift while adding Tabular-only options | AG-named things stay AG-shaped (workspace rule + agref pages); Tabular extensions namespaced under one option each |
| State slices break across versions | Versioned slices with pure migrations; round-trip tests on every showcase page config |
| Scope: 50-painter catalog stalls delivery | Catalog ships in the §7.1 dependency order; each painter is standalone; the blotter demo page defines "enough" per family |
