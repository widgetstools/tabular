# Cgrid-aligned data plane — design

**Status:** approved — implementing  
**Date:** 2026-07-11  
**Supersedes (in part):** `2026-07-10-worker-invariants.md` §Authority items 2–3 and default `workerOwnsRowData`

## Goal

Match cgrid’s live-tick and scroll feel: smooth scrolling under high update rates, no blank frames, flash without UI freeze. Worker remains the canonical store for filter/sort/group/agg/slice; main never blocks paint on worker RPC.

## Non-goals

- Greenfield rewrite of the canvas grid / AG API surface
- Tree-data on worker (still follow-up)
- Perfect numerical parity with cgrid’s chunk binary layout (semantics matter; wire format may differ)

## Success criteria

| Scenario | Bar |
|----------|-----|
| Live Ticks (5k rows, ~4k updates/s) | Smooth scroll; no blank cells; flash visible; UI stays interactive |
| Realtime Agg (100k, grouped, ~40k updates/s) | Incremental agg patches; expand/collapse under load; ≥60 fps paint when idle scrolling |
| Extreme (1M×500, `workerOwnsRowData: true`) | Chunk-only paint still works; first frame then stable; no vanish-after-appear |
| Scroll during ticks | Immediate repaint from **current** chunk (may be one batch stale); prefetch coalesced, never clears chunk before replacement |

## Architecture (cgrid-aligned)

```
Tick / applyTransactionAsync
  → main: update row mirror synchronously
  → worker: fire-and-forget apply (batched ~50–60ms) — do NOT await on call path
  → return to feed immediately

Worker
  → RowStore mutate → (incremental agg | dataOnly | model rebuild)
  → push modelUpdated / aggregatesUpdated (rAF-coalesced on main)

Main on modelUpdated
  → apply displayed ids/kinds/aggData
  → requestViewport (coalesced) — do NOT null the current chunk first

Main on getViewport reply
  → swap this.viewportChunk = chunk
  → requestPaint

Scroll
  → update scroll offsets
  → requestPaint immediately (current chunk)
  → schedule coalesced viewport prefetch (velocity/overscan)
```

### Ownership table

| Layer | Role |
|-------|------|
| Worker `RowStore` | Canonical field values after last applied tx |
| Main row mirror (`byId` / `original`) | **Always retained by default** — API, rules, flash PREV, valueGetter paint fallback, transactions |
| Main `viewportChunk` | Primary paint source for worker-eligible field/calc columns |
| `workerOwnsRowData: true` | Opt-in Extreme path: may drop mirror after warm chunk; paint chunk-only |

### Paint read order (`valueAtDisplayed`)

1. When mirror is kept (`workerOwnsRowData` not true) and the row is a leaf
   with `node.data` → paint via `valueOf` (fresh ticks; no getViewport gate)
2. Else if `viewportChunk` covers the cell → use chunk (Extreme / owns mode)
3. Else group `aggData` / auto-group key paths as today

Stale chunk during Extreme ticks is acceptable (one batch lag). **Blank is not.**

## Behavioural changes vs current Tabular

1. **Default `workerOwnsRowData` → `false`** (keep mirror). Only Extreme (or explicit opt-in) sets `true`.
2. **Never clear `viewportChunk` on tick/dataOnly/aggregatesUpdated.** Clear only when displayed identity set changes (filter/sort/group expand that changes row list) *or* replace atomically on new chunk.
3. **Tick path must not await worker.** Coordinator: fire-and-forget apply with coalescing; invalidate prefetch key without blanking; paint from current chunk + mirror fallback.
4. **Scroll path:** `requestPaint` must not *require* a completed prefetch before painting; prefetch is best-effort.
5. **Serial op queue:** keep for config/rebuild vs tick coalescing so expand/collapse is not starved; ticks merge into one pending payload, never block the JS call stack.
6. **Flash:** continue rAF while flashes active, but do not schedule a new `getViewport` on every flash frame — only on scroll/model/chunk-invalidation.

## API / options

| Option | New default | Notes |
|--------|-------------|-------|
| `rowDataMode` | omit = try worker | unchanged |
| `workerOwnsRowData` | **`false`** | was effectively true; document Extreme opt-in |
| (internal) `pendingMirrorDrop` | only when owns=true | unchanged semantics |

Update `docs/superpowers/specs/2026-07-10-worker-invariants.md` Authority §2 to: main **keeps** mirror unless `workerOwnsRowData === true`.

## Showcase

- Live Ticks: no page-level `rowDataMode: 'main'` hack required once defaults are fixed
- Extreme: set `workerOwnsRowData: true` explicitly
- Realtime Agg: mirror kept; incremental agg + chunk refresh

## Risks

| Risk | Mitigation |
|------|------------|
| Memory: 1M-row mirror on Extreme | Opt-in drop via `workerOwnsRowData: true` |
| Dual paint paths diverge | Chunk wins when present; mirror only gap-fills |
| Stale values during ticks | Accept ≤1 batch lag (cgrid); never blank |

## Implementation outline (for plan)

1. Flip default + Extreme opt-in; stop dropping mirror unless owns=true  
2. Stop blanking chunk on non-structural updates; flash without viewport refetch  
3. Align tick coordinator with fire-and-forget + coalesce (cgrid TransactionQueue semantics)  
4. Scroll: paint-first, prefetch-second  
5. Verify Live Ticks / Realtime Agg / Extreme in showcase; update invariants doc  

## Open points (resolved in this design)

- Paint from chunk vs mirror: **chunk primary, mirror fallback** (stricter than “mirror-only paint”, matches cgrid + our blank-avoidance need)
- Mirror drop: **opt-in only**
