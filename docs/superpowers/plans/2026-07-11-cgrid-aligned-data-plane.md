# Cgrid-aligned data plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match cgrid tick/scroll feel — keep main row mirror by default, paint from viewport chunk with mirror fallback, never blank on ticks, fire-and-forget worker applies.

**Architecture:** See `docs/superpowers/specs/2026-07-11-cgrid-aligned-data-plane-design.md`.

**Tech Stack:** TypeScript, `packages/core` worker coordinator + grid paint path, showcase Extreme/LiveTicks/RealtimeAgg.

---

## File map

| File | Change |
|------|--------|
| `packages/core/src/types.ts` | Default docs: `workerOwnsRowData` default false |
| `packages/core/src/grid.ts` | Owns default; chunk clear policy; paint/prefetch split; flash without viewport refetch |
| `packages/core/src/worker/coordinator.ts` | Fire-and-forget ticks; no paint-blocking await semantics already partial |
| `apps/showcase/src/pages/Extreme.tsx` | `workerOwnsRowData: true` |
| `docs/superpowers/specs/2026-07-10-worker-invariants.md` | Authority §2 |

---

### Task 1: Default keep mirror + Extreme opt-in

**Files:**
- Modify: `packages/core/src/types.ts`, `packages/core/src/grid.ts` (`workerOwnsRowDataActive`), `apps/showcase/src/pages/Extreme.tsx`
- Modify: `docs/superpowers/specs/2026-07-10-worker-invariants.md`

- [ ] **Step 1:** Change `workerOwnsRowDataActive` so default is false (only true when `options.workerOwnsRowData === true`). Update JSDoc in `types.ts`.
- [ ] **Step 2:** Set `workerOwnsRowData: true` on Extreme page.
- [ ] **Step 3:** Update invariants §2: main keeps mirror unless `workerOwnsRowData === true`.

---

### Task 2: Chunk never blanks on ticks; flash without viewport refetch

**Files:**
- Modify: `packages/core/src/grid.ts`

- [ ] **Step 1:** `applyWorkerModelFromWorker`: only set `viewportChunk = null` when displayed id list identity changes (compare previous `displayedIds` vs new); otherwise keep chunk until swap.
- [ ] **Step 2:** Split `requestPaint({ prefetch?: boolean })` — default prefetch only when scroll/model needs it; flash-driven paints pass `prefetch: false`.
- [ ] **Step 3:** `invalidateViewportPrefetch` must not clear `viewportChunk`.
- [ ] **Step 4:** Ensure `valueAtDisplayed` already falls through to `node.data` when chunk miss (verify; fix if chunk empty-string overrides).

---

### Task 3: Tick path fire-and-forget + paint from mirror/chunk

**Files:**
- Modify: `packages/core/src/worker/coordinator.ts`, `packages/core/src/grid.ts`

- [ ] **Step 1:** On update-only forward: coalesce + postMessage without requiring paint to wait on ack before first paint (paint immediately from mirror after main `applyTransaction`).
- [ ] **Step 2:** After worker ack: invalidate prefetch key only (keep chunk); optional paint — do not clear mirror.
- [ ] **Step 3:** When mirror active, leaf `applyTransaction` already updates `displayedNodes[].data` — confirm Live Ticks paints new values even if chunk stale (chunk wins — **problem**). For ticks with mirror: prefer mirror for leaf field cols when `!workerOwnsRowData`, OR bump chunk invalidation so chunk doesn't win with stale data...

**Design resolution for stale chunk vs mirror:** Spec says chunk primary. Cgrid accepts one-batch lag. For Live Ticks *feel*, one-batch lag is OK if no blank/jank. So: keep chunk primary; don't clear it; refresh chunk async after ack. Mirror updates for API/flash PREV. Flash uses change dirs from main tx.

- [ ] **Step 4:** Remove per-ack double paint storms where possible (single rAF).

---

### Task 4: Scroll paint-first

**Files:**
- Modify: `packages/core/src/grid.ts` scroll handlers / `requestPaint`

- [ ] **Step 1:** On scroll: `requestPaint({ prefetch: true })` but paint uses current chunk immediately in same rAF (already true if chunk kept).
- [ ] **Step 2:** Coalesce prefetch: if in-flight for overlapping window, don't cancel with gen bump on every flash frame (flash uses prefetch:false).

---

### Task 5: Verify showcase

- [ ] **Step 1:** Live Ticks — scroll while running; no blanks; interactive.
- [ ] **Step 2:** Realtime Agg — expand/collapse under ticks.
- [ ] **Step 3:** Extreme with `workerOwnsRowData: true` — data stays after first frame.

---

## Done when

Live Ticks scrolls smoothly at 4k updates/s; no vanish; Extreme still works with owns=true; invariants doc updated.
