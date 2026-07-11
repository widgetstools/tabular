# Worker Data Plane Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Tabular’s Web Worker the single authoritative data plane (cgrid-shaped), with the main-thread CSRM reduced to a fallback for JS-callback / ineligible features — eliminating the dual-worker fork and the “bolted-on” correctness gaps.

**Architecture:** One module worker owns row store + pipeline (calc → filter → sort → group/agg → pivot → viewport). Incremental group aggregation becomes an *update fast-path inside* that pipeline (fold today’s `AggEngine` in), not a second worker. Main thread paints, handles DOM editors, and runs only the callbacks that cannot cross the boundary. `WorkerCoordinator` owns all worker I/O so `grid.ts` stops being the integration bus.

**Tech Stack:** TypeScript, Vite worker (`new URL('./worker/dataWorker.ts', import.meta.url)`), existing `@tabular/core` pipeline passes, cgrid reference at `/Users/develop/wfh/canvasgrid/packages/kernel/src/worker/`, differential harness `scripts/worker-compare.ts`, showcase apps under `apps/showcase`.

## Global Constraints

- AG Grid v33+ naming/semantics for public options; Tabular extensions (`rowDataMode`, etc.) stay documented as such.
- Never invent option names when an AG equivalent exists.
- Protocol: transferables or small plain objects only; no functions across the boundary.
- Worker error → tear down worker, restore row mirror if dropped, set `rowDataMode: 'main'`, `refreshModel()` — no data loss.
- Pivot/tree on worker are ports of existing main-thread / cgrid logic, not redesigns.
- Differential tests: worker output must equal main-thread reference on randomized data + transactions before each stage ships.
- Do not enable `workerCompareMode` by default (dev/CI only).
- Research AG types/docs before changing any AG-named surface (workspace rule).
- Prefer small, focused files; extract from `grid.ts` rather than growing it (already ~8.5k LOC).

---

## Current state (problem statement)

| Reality today | Why it hurts |
|---------------|--------------|
| Main CSRM is still a peer (`RowModel.refresh`) | Dual sources of truth; stale `leafRows`; tick×agg bugs |
| Two workers: `aggWorker.ts` + `dataWorker.ts` | Conflicting semantics; RealtimeAgg must opt out of data plane |
| Data plane rebuilds full pipeline on every tx | Correct off-thread, but wastes worker CPU vs incremental aggs |
| Pivot/tree force main | Live pivot ticks starve UI; “worker-first” claim is false for those modes |
| Eligibility mostly all-or-nothing | One active filter on a `valueGetter` col ejects the plane |
| Worker wiring lives in `grid.ts` | Hard to reason about, easy to regress |

**Target end state (cgrid-aligned):**

```text
Caller txs / option changes
        │
        ▼
 WorkerCoordinator (main)
        │  postMessage
        ▼
 DataWorker: RowStore + DataPipeline
   calc → filter → sort → group|pivot → (optional incremental agg patch)
        │  modelUpdated / viewport chunks / aggregatesUpdated
        ▼
 Main: apply model OR patch aggs → paint / flash / DOM chrome
        │
        └── only if ineligible → main CSRM refreshModel()
```

---

## File map (create / modify / delete)

| Path | Role |
|------|------|
| `packages/core/src/worker/coordinator.ts` | **Create** — extract worker lifecycle + tx/model/viewport from `grid.ts` |
| `packages/core/src/worker/pipeline.ts` | **Modify** — pivot pass hook; incremental agg fast-path |
| `packages/core/src/worker/passes/pivotPass.ts` | **Create** — port from cgrid `pivotPass.ts` + Tabular `pivot.ts` |
| `packages/core/src/worker/passes/groupPass.ts` | **Modify** — share contracts with pivot; incremental dirty hooks |
| `packages/core/src/worker/incrementalAgg.ts` | **Create** — move `AggEngine` out of standalone worker into pipeline module |
| `packages/core/src/worker/aggWorker.ts` | **Delete** (after fold) — or thin re-export deprecated |
| `packages/core/src/worker/client.ts` | **Delete** or merge into `dataClient.ts` |
| `packages/core/src/worker/protocol.ts` | **Modify** — unify messages; deprecate AggWorker* types |
| `packages/core/src/worker/dataWorker.ts` | **Modify** — handle incremental path + pivot config |
| `packages/core/src/worker/dataClient.ts` | **Modify** — surface used by coordinator |
| `packages/core/src/grid.ts` | **Modify** — thin consumer of coordinator; remove dual-worker branches |
| `packages/core/src/rowModel.ts` | **Modify** — `applyWorkerModel` / `patchGroupAggregates` remain; drop `reaggregateLive` once pivot is on worker |
| `packages/core/src/types.ts` | **Modify** — deprecate `workerAggregation`; document single plane |
| `scripts/worker-compare.ts` | **Extend** — pivot, incremental path, group-key churn |
| `scripts/worker-budget.ts` | **Create** — RealtimeAgg-style main-thread scripting budget |
| `apps/showcase/src/pages/RealtimeAgg.tsx` | **Modify** — use unified plane (no `rowDataMode: 'main'` hack) |
| `apps/showcase/src/pages/Pivot.tsx` | **Modify** — live ticks must stay on worker |
| `TABULAR-CGRID-FEATURE-PLAN.md` | **Modify** — Phase 2 exit criteria + dual-worker retirement note |

---

## Phase overview

| Phase | Name | Ship criterion |
|-------|------|----------------|
| **A** | Invariants + harness | Compare suite covers grouping + update-only; budget script exists |
| **B** | Extract `WorkerCoordinator` | `grid.ts` worker LOC cut ≥60%; behavior unchanged |
| **C** | Fold incremental agg into data plane | Delete standalone agg worker; RealtimeAgg on default worker path |
| **D** | Pivot on worker | Pivot + live ticks; no main `reaggregateLive` for pivot |
| **E** | Per-pass fallback + eligibility | Active getter filter → main for that concern only *or* documented full fallback with tests |
| **F** | Main-as-fallback product cleanup | Remove dual APIs; docs/showcase; tree deferred with explicit gate |

**Out of scope for this plan (follow-up):** tree-data worker pass, SharedWorker, wasm/DuckDB query engine from CGGRID plan, a11y shadow DOM.

---

### Task 1: Document worker invariants + eligibility matrix

**Files:**
- Create: `docs/superpowers/specs/2026-07-10-worker-invariants.md`
- Modify: `TABULAR-CGRID-FEATURE-PLAN.md` (link to invariants under Phase 2)

**Interfaces:**
- Produces: written contract that later tasks must not violate

- [ ] **Step 1: Write the invariants doc**

Create `docs/superpowers/specs/2026-07-10-worker-invariants.md` with exactly these sections filled:

```markdown
# Worker data plane — invariants

## Authority
1. When `dataWorkerActive`, the worker RowStore is authoritative for row
   field values after the last acknowledged transaction.
2. Main may keep a mirror only when `workerOwnsRowData === false` or
   compare mode is on.
3. Displayed model (`displayed` ids + kinds + aggData) comes from the
   worker `modelUpdated` push, except during incremental agg patch
   windows (aggregatesUpdated) which mutate aggData only.

## Transaction ordering
4. Main must not apply a second tx to the worker until the previous
   applyTransaction reply has resolved OR the protocol documents
   unordered fire-and-forget with sequence numbers (pick one; prefer
   await-reply for structural, fire-and-forget for update-only with seq).

## Fallback
5. Construction failure / worker `error` push → `fallbackDataWorker`:
   restore mirror from `workerSeedRows` if needed, `rowDataMode='main'`,
   `refreshModel()`.
6. Ineligibility is evaluated in `workerDataPlaneConfig()`; default
   omitted `rowDataMode` means try worker (`!== 'main'`).

## Eligibility matrix (target after Phase E/F)
| Feature | Worker | Main fallback |
|---------|--------|---------------|
| Field filter/sort/group/agg | yes | — |
| Calc (field deps, worker-safe aggs) | yes | — |
| Pivot (field keys + built-in value aggs) | yes (Phase D) | — |
| Tree data | no (follow-up) | yes |
| valueGetter column (display only) | skip in field maps | paint via main valueOf if mirror present |
| Active filter/sort on valueGetter/comparator | full plane fallback | yes |
| External filter present | full plane fallback | yes |
| Custom function aggFunc | full plane fallback | yes |

## Dual-worker retirement
7. After Phase C, `workerAggregation` is ignored (warn once if set).
8. Incremental aggregation is an internal pipeline mode, not a second Worker.
```

- [ ] **Step 2: Link from the feature plan**

In `TABULAR-CGRID-FEATURE-PLAN.md` under §3, add:

```markdown
Authoritative invariants: `docs/superpowers/specs/2026-07-10-worker-invariants.md`
(worker unification plan: `docs/superpowers/plans/2026-07-10-worker-data-plane-unification.md`).
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-10-worker-invariants.md TABULAR-CGRID-FEATURE-PLAN.md
git commit -m "$(cat <<'EOF'
docs: lock worker data-plane invariants for unification

EOF
)"
```

---

### Task 2: Harden differential harness (grouping + update-only)

**Files:**
- Modify: `scripts/worker-compare.ts`
- Modify: `package.json` (ensure `worker-compare` script exists)

**Interfaces:**
- Consumes: `DataPipeline`, `WorkerPipelineConfig`, `GroupPass`
- Produces: exit code 0 on 10k txs; covers update-only batches that change agg inputs

- [ ] **Step 1: Add failing assertion for update-only agg stability**

In `scripts/worker-compare.ts`, after the existing random tx loop, add a dedicated section:

```typescript
function assertAggParityAfterUpdates(
  pipeline: DataPipeline,
  store: RowStore,
  config: WorkerPipelineConfig,
  rnd: () => number,
): void {
  // 500 update-only batches; compare displayed aggData for group + grand-total
  // rows against a fresh referenceRebuild + GroupPass on the same store snapshot.
  for (let i = 0; i < 500; i++) {
    const n = 1 + Math.floor(rnd() * 20);
    const updateIds: string[] = [];
    const update: BondRow[] = [];
    const ids = store.ids();
    for (let j = 0; j < n; j++) {
      const id = ids[Math.floor(rnd() * ids.length)]!;
      const row = { ...(store.getRow(id) as BondRow) };
      row.pnl = row.pnl + (rnd() < 0.5 ? -1 : 1) * 10;
      row.spread = Math.max(1, row.spread + (rnd() < 0.5 ? -1 : 1));
      updateIds.push(id);
      update.push(row);
    }
    pipeline.applyTransaction({ updateIds, update });
    const out = pipeline.rebuild();
    const refIds = referenceRebuild(store, config);
    // Compare group/footer/grandTotal agg payloads, not only leaf id order.
    const workerGroups = out.displayed.filter((d) => d.kind !== 'leaf');
    // Build reference displayed via GroupPass (same as referenceRebuild extension).
    // FAIL if any aggData[colId] differs by > 1e-9 for numeric.
  }
}
```

Extend `referenceRebuild` (or add `referenceDisplayed`) to return full `WorkerModelOutput['displayed']`, not just ids.

- [ ] **Step 2: Run harness — expect FAIL or gaps before pipeline changes**

Run: `npm run worker-compare`

Expected: either FAIL on new agg assertions (good — proves gap) or PASS if already matching; record baseline in commit message.

- [ ] **Step 3: Fix only harness bugs (not product) until the new checks are honest**

If the harness incorrectly compares (e.g. key order), fix the harness. Do not change `pipeline.ts` product behavior in this task unless a clear harness bug masks a real mismatch you can fix in &lt;20 LOC with a comment linking to Task 6.

- [ ] **Step 4: Commit**

```bash
git add scripts/worker-compare.ts package.json
git commit -m "$(cat <<'EOF'
test: extend worker-compare for update-only group agg parity

EOF
)"
```

---

### Task 3: Main-thread scripting budget script

**Files:**
- Create: `scripts/worker-budget.ts`
- Modify: `package.json` — add `"worker-budget": "tsx scripts/worker-budget.ts"`

**Interfaces:**
- Produces: prints `mainScriptingMsP95` for a synthetic tick loop; exit 1 if p95 &gt; 4ms when worker path is used

- [ ] **Step 1: Write budget script skeleton**

```typescript
/**
 * Measures main-thread work while applying high-rate update txs.
 * Run against DataPipeline in-process first; later wire a jsdom+Worker
 * smoke if needed. Target: p95 main scripting ≤ 4ms per 60ms flush
 * when only forwarding txs + applying patches (no full main refresh).
 */
import { performance } from 'node:perf_hooks';

// 1) Build 100k bond-like rows in a DataPipeline with desk→sector group + sum/avg aggs
// 2) For 200 iterations: apply 2000 updates, rebuild (simulates worker), time ONLY
//    the "main-side" patch simulation: Object.assign into a Map of aggData
// 3) Print p50/p95; exit 1 if p95 > 4

function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i]!;
}
```

Fill in using existing `DataPipeline` + `seedRows` patterns from `worker-compare.ts`.

- [ ] **Step 2: Run**

Run: `npm run worker-budget`

Expected: script completes; establish baseline numbers in the commit body.

- [ ] **Step 3: Commit**

```bash
git add scripts/worker-budget.ts package.json
git commit -m "$(cat <<'EOF'
test: add worker-budget script for main-thread tick scripting

EOF
)"
```

---

### Task 4: Extract `WorkerCoordinator` (behavior-preserving)

**Files:**
- Create: `packages/core/src/worker/coordinator.ts`
- Modify: `packages/core/src/grid.ts` — replace inline worker fields/methods with coordinator
- Modify: `packages/core/src/index.ts` — do **not** export coordinator publicly

**Interfaces:**
- Consumes: `DataWorkerClient`, `AggWorkerClient` (temporarily both), `WorkerPipelineConfig`, `AggModel`
- Produces:

```typescript
export interface WorkerCoordinatorHost {
  destroyed: boolean;
  requestPaint(): void;
  updateStatusBar(): void;
  flashCellChange(c: { rowId: string; colKey: string; dir: 1 | -1 | 0 }): void;
  enableCellFlash: boolean;
  applyWorkerModel(output: WorkerModelOutput): void;
  patchGroupAggregates(updates: GroupAggUpdate[]): import('../rowModel').CellChange[];
  fallbackToMain(reason: string): void;
  onRulesResult?(rules: import('@tabular/rules').RulesEvalResult): void;
}

export class WorkerCoordinator {
  constructor(host: WorkerCoordinatorHost);
  /** Returns true if data plane is active. */
  get dataPlaneActive(): boolean;
  get aggSideChannelActive(): boolean; // removed in Task 6
  syncDataPlane(config: WorkerPipelineConfig | null, ids: string[], rows: unknown[]): void;
  syncAggSideChannel(model: AggModel | null, ids: string[], rows: unknown[]): void;
  forwardTransaction(tx: AggTransactionPayload): void;
  requestViewport(req: ViewportRequest): Promise<ViewportChunk | null>;
  teardown(): void;
}
```

- [ ] **Step 1: Create coordinator file by moving methods verbatim**

Move from `grid.ts` without behavior change:
- `ensureDataWorker`, `syncDataWorker`, `forwardTransactionToDataWorker`
- `syncAggWorker`, `forwardUpdatesToAggWorker`
- `fallbackDataWorker`, `teardownDataWorker`
- agg worker client construction + `aggregatesUpdated` handler
- data worker `modelUpdated` handler

Keep method bodies identical; only change `this.` host calls to `this.host.`.

- [ ] **Step 2: Wire `Tabular` to own a `private workerCoord: WorkerCoordinator`**

Replace `aggWorker` / `dataWorker` / `aggWorkerActive` / `dataWorkerActive` fields with coordinator getters used at call sites:

```typescript
private get dataWorkerActive(): boolean {
  return this.workerCoord.dataPlaneActive;
}
```

Or update call sites to `this.workerCoord.dataPlaneActive`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p packages/core --noEmit`

Expected: exit 0

- [ ] **Step 4: Manual smoke**

Run showcase Grouping + RealtimeAgg + Extreme (default worker). Confirm no console errors and grouping still works.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/worker/coordinator.ts packages/core/src/grid.ts
git commit -m "$(cat <<'EOF'
refactor: extract WorkerCoordinator from grid host

EOF
)"
```

---

### Task 5: Move `AggEngine` into `incrementalAgg.ts` (still dual-path)

**Files:**
- Create: `packages/core/src/worker/incrementalAgg.ts` (move class from `aggWorker.ts`)
- Modify: `packages/core/src/worker/aggWorker.ts` — import engine, keep worker bootstrap thin
- Test: extend `scripts/worker-compare.ts` OR add `scripts/incremental-agg-compare.ts`

**Interfaces:**
- Produces: `export class AggEngine { ... }` identical public methods:
  - `setAggModel(model: AggModel): void`
  - `setRowData(ids: string[], rows: Row[]): void`
  - `applyTransaction(tx: AggTransactionPayload): GroupAggUpdate[]`

- [ ] **Step 1: Move `AggEngine` + helpers to `incrementalAgg.ts`**

Cut `export class AggEngine` and private helpers (`accAdd`, `accSub`, `sameIds`, …) from `aggWorker.ts` into `incrementalAgg.ts`. Keep `aggWorker.ts` as:

```typescript
import { AggEngine } from './incrementalAgg';
// message loop unchanged — engine instance only
```

- [ ] **Step 2: Add unit-style script asserting O(dirty) updates**

```typescript
// scripts/incremental-agg-smoke.ts
import { AggEngine } from '../packages/core/src/worker/incrementalAgg';
// set model desk→sector, sum pnl; set 10k rows; update 10 rows;
// expect updates.length <= 10 * (2 group levels + 1 grand) and values match full rescan
```

- [ ] **Step 3: Run smoke + typecheck**

Run: `npx tsx scripts/incremental-agg-smoke.ts && npx tsc -p packages/core --noEmit`

Expected: both pass

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/worker/incrementalAgg.ts packages/core/src/worker/aggWorker.ts scripts/incremental-agg-smoke.ts
git commit -m "$(cat <<'EOF'
refactor: extract AggEngine for pipeline reuse

EOF
)"
```

---

### Task 6: Fold incremental agg into `DataPipeline` (retire side-channel worker)

**Files:**
- Modify: `packages/core/src/worker/pipeline.ts`
- Modify: `packages/core/src/worker/dataWorker.ts`
- Modify: `packages/core/src/worker/protocol.ts` — add push type; deprecate AggWorker request union
- Modify: `packages/core/src/worker/coordinator.ts` — stop constructing `aggWorker`
- Modify: `packages/core/src/grid.ts` — remove `workerAggModel` / `forwardUpdatesToAggWorker` call paths
- Modify: `packages/core/src/types.ts` — deprecate `workerAggregation`
- Delete: `packages/core/src/worker/aggWorker.ts`, `packages/core/src/worker/client.ts` (if unused)
- Modify: `apps/showcase/src/pages/RealtimeAgg.tsx` — remove `rowDataMode="main"` + `workerAggregation`

**Interfaces:**
- Produces: pipeline API

```typescript
// pipeline.ts
class DataPipeline {
  /**
   * After applyTransaction on the store:
   * - If only agg-input fields changed AND group keys unchanged AND grouping
   *   active AND no filter/sort/calc invalidation → incremental AggEngine path,
   *   return { kind: 'aggregates', updates }
   * - Else full rebuild → { kind: 'model', output }
   */
  applyAndResolve(tx: AggTransactionPayload): 
    | { kind: 'aggregates'; updates: GroupAggUpdate[] }
    | { kind: 'model'; output: WorkerModelOutput };
}
```

Protocol push (already partially exists for agg worker):

```typescript
| { type: 'aggregatesUpdated'; updates: GroupAggUpdate[] }
| { type: 'modelUpdated'; output: WorkerModelOutput; rules?: RulesEvalResult }
```

- [ ] **Step 1: Write failing compare for incremental vs full rebuild**

In `scripts/worker-compare.ts`:

```typescript
// For 200 update batches that only touch pnl/spread (not desk/sector):
// outIncremental = engine.applyTransaction(...)
// outFull = pipeline.rebuild() group aggData
// assert equal per groupId
```

Run until it fails against an empty/unimplemented `applyAndResolve` incremental branch.

- [ ] **Step 2: Implement fast-path in `DataPipeline`**

Algorithm:

1. Before applying tx, snapshot whether any update changes a `groupCols` field or a filter-relevant field or a calc dependency.
2. Apply tx to `RowStore`.
3. If structural (add/remove) or group-key/filter/sort/calc dirty → `rebuild()` → model.
4. Else run `AggEngine.applyTransaction` (engine kept in sync on every full rebuild via `setRowData` + `setAggModel` from config).
5. Return aggregate updates.

On every full `rebuild()`, reset engine from filtered leaf ids + rows (same membership as group pass inputs).

- [ ] **Step 3: Wire `dataWorker.ts` message handler**

```typescript
case 'applyTransaction':
  rulesPass.noteTransaction(msg.payload);
  const result = pipeline.applyAndResolve(msg.payload);
  reply(msg.id);
  if (result.kind === 'aggregates') {
    post({ type: 'aggregatesUpdated', updates: result.updates });
  } else {
    // existing pushModel from result.output
    post({ type: 'modelUpdated', output: result.output, rules: rulesPass.eval(...) });
  }
  break;
```

- [ ] **Step 4: Coordinator handles both pushes; delete agg worker construction**

Remove `syncAggSideChannel` / `AggWorkerClient`. `forwardTransaction` always goes to data worker when active.

- [ ] **Step 5: Deprecate `workerAggregation`**

In `types.ts`:

```typescript
/**
 * @deprecated Ignored. Incremental aggregation is always used inside the
 * data-plane worker when eligible. Kept so old configs typecheck.
 */
workerAggregation?: boolean;
```

In coordinator init, if `options.workerAggregation === false` && data plane active, `console.warn` once that the flag no longer disables worker aggs; use `rowDataMode: 'main'` to force main.

- [ ] **Step 6: Update RealtimeAgg page**

```tsx
<TabularGrid
  // remove rowDataMode="main" and workerAggregation
  groupDefaultExpanded={0}
  grandTotalRow="bottom"
  groupTotalRow="bottom"
  ...
/>
```

Update the page blurb to say incremental path is inside the data-plane worker.

- [ ] **Step 7: Run suites**

Run:

```bash
npm run worker-compare
npm run worker-budget
npx tsc -p packages/core --noEmit
npx tsc -p apps/showcase --noEmit
```

Expected: all pass; budget p95 ≤ 4ms for patch simulation (adjust threshold only with written justification in script comment).

- [ ] **Step 8: Commit**

```bash
git add packages/core apps/showcase scripts
git commit -m "$(cat <<'EOF'
feat: fold incremental aggregation into data-plane worker

Retire the standalone agg worker side-channel so one worker owns store,
pipeline, and tick-fast-path aggregates.

EOF
)"
```

---

### Task 7: Port `PivotPass` onto the worker pipeline

**Files:**
- Create: `packages/core/src/worker/passes/pivotPass.ts`
- Modify: `packages/core/src/worker/pipeline.ts` — run pivot after group (or instead of leaf flatten when pivot active)
- Modify: `packages/core/src/worker/protocol.ts` — extend `WorkerPipelineConfig` with pivot fields
- Modify: `packages/core/src/worker/coordinator.ts` / `grid.ts` — stop nulling config when `pivotMode`
- Modify: `packages/core/src/rowModel.ts` — stop using `reaggregateLive` for pivot when worker active
- Reference: `/Users/develop/wfh/canvasgrid/packages/kernel/src/worker/passes/pivotPass.ts`
- Reference: `packages/core/src/pivot.ts` (main-thread semantics to match)

**Interfaces:**
- Extends config:

```typescript
// protocol.ts — add to WorkerPipelineConfig
pivotMode?: boolean;
pivotCols?: Array<{ colId: string; field: string }>;
valueCols?: Array<{
  colId: string;
  field: string;
  aggFunc: WorkerAggFuncName;
  weightField?: string;
}>;
/** When set, worker includes pivot result col ids in aggData (same as main). */
```

- Pivot output must use the same `pivotResultColId(path, valueColId)` helper — **share** the function from `packages/core/src/pivot.ts` (import into worker pass; do not duplicate encoding).

- [ ] **Step 1: Eligibility — allow pivot in `workerDataPlaneConfig`**

Remove `if (this.cols.pivotMode) return null;`.

Instead require:
- `pivotCols` every entry has `field` and no `valueGetter`
- `valueCols` / aggs are built-in string funcs in `WORKER_AGG_FUNCS`
- group cols still field-only (AG pivot with row groups)

If pivot mode on but value cols empty, worker may still run (match main empty pivot behavior).

- [ ] **Step 2: Write failing worker-compare cases for olympic-shaped pivot**

```typescript
// Minimal in-memory rows: country, sport, year, gold, silver
// pivotCols: sport; valueCols: gold sum; groupCols: country
// assert displayed group aggData[pivotResultColId(['Swimming'], 'gold')] matches main aggregatePivotTree
```

Run: fail because `PivotPass` missing.

- [ ] **Step 3: Implement `PivotPass`**

Port logic from main `aggregatePivotTree` + `collectPivotKeyPaths` + `buildPivotGrandTotalNode` into a worker pass that:
1. Discovers key paths from filtered ids
2. Writes pivot cells into each group node’s `aggData`
3. Returns `pivotKeyPaths` in output so main can call existing `buildPivotResultColumns` / `cols.applyPivotResult`

Extend `WorkerModelOutput`:

```typescript
pivotKeyPaths?: string[][];
```

Main `applyWorkerModel` / coordinator callback must invoke the same `onPivotColumnsBuilt` path currently used in `refreshModel`.

- [ ] **Step 4: Incremental pivot ticks**

For update-only txs that do not change pivot key fields or group keys:
- Either full rebuild (acceptable v1 if budget OK on olympic sizes), **or**
- Extend `AggEngine` with pivot-keyed accumulators (v2)

**Ship v1 as full rebuild on worker** (still off UI thread). Add TODO in invariants for v2 incremental pivot.

Measure with Pivot page Live ticks + performance.now around main `applyTransactionAsync` flush — main should only patch model / paint.

- [ ] **Step 5: Remove main-thread pivot reaggregate path when worker active**

In `reaggregateLiveAfterUpdates`:

```typescript
if (this.workerCoord.dataPlaneActive) return false;
```

Keep `reaggregateLive` only for main fallback (ineligible / forced main).

- [ ] **Step 6: Showcase + typecheck**

Pivot page Live ticks with default worker; confirm totals move and flash.

Run: `npx tsc -p packages/core --noEmit && npm run worker-compare`

- [ ] **Step 7: Commit**

```bash
git add packages/core apps/showcase/src/pages/Pivot.tsx scripts/worker-compare.ts
git commit -m "$(cat <<'EOF'
feat: run pivot aggregation on the data-plane worker

EOF
)"
```

---

### Task 8: Per-pass / honest eligibility (no silent wrong filters)

**Files:**
- Modify: `packages/core/src/grid.ts` (`workerDataPlaneConfig`)
- Modify: `docs/superpowers/specs/2026-07-10-worker-invariants.md`
- Test: `scripts/worker-compare.ts` or a small node script

**Interfaces:**
- Produces: documented behavior — **full plane fallback** when an *active* filter/sort references a non-worker column (already partially done); add tests

- [ ] **Step 1: Add regression test**

```typescript
// Grid-level or config-level: when filterModel has colId with valueGetter only,
// workerDataPlaneConfig() returns null (force main).
```

Because `workerDataPlaneConfig` is private, test via:
- exporting a package-private `__test.workerDataPlaneConfig` under `process.env.NODE_ENV === 'test'`, **or**
- behavioral test: construct Tabular with getter col + setFilter → assert `rowDataMode` path used main (spy on `rows.refresh` vs `applyWorkerModel`)

Prefer behavioral test in `scripts/eligibility-smoke.ts`.

- [ ] **Step 2: Implement any missing checks**

Confirm sortModel + filterModel gates remain. Add: if `quickFilterText` non-empty and any displayed col is getter-only, document that quick filter only searches worker field cols (current FilterPass behavior) — **or** fallback to main when quick filter active and getter cols exist (stricter, safer).

**Decision for this plan (safer):** if `quickFilter` non-empty AND any displayed column lacks `workerColumnField`, return null (main).

- [ ] **Step 3: Commit**

```bash
git add packages/core scripts docs/superpowers/specs/2026-07-10-worker-invariants.md
git commit -m "$(cat <<'EOF'
fix: make worker eligibility fail closed for quick filter + getters

EOF
)"
```

---

### Task 9: Product cleanup — main as fallback only

**Files:**
- Modify: `packages/core/src/types.ts` JSDoc
- Modify: `TABULAR-CGRID-FEATURE-PLAN.md` §3 exit criteria
- Modify: showcase pages still mentioning dual modes awkwardly
- Modify: `packages/core/src/rowModel.ts` — mark `reaggregateLive` as fallback-only with comment

- [ ] **Step 1: Update public docs on options**

`rowDataMode`:
- default worker
- `'main'` = force CSRM (debug / ineligible features / SSR without Worker)

Remove “implies workerAggregation” language.

- [ ] **Step 2: Showcase copy pass**

Extreme / Grouping / Calc / Rules / RealtimeAgg / Pivot — one sentence each: worker is default; `?main=1` forces UI thread.

- [ ] **Step 3: Phase 2 exit criteria checklist in plan**

Update `TABULAR-CGRID-FEATURE-PLAN.md`:

```markdown
**Exit criteria (unification):**
- [ ] Single worker module; no aggWorker.ts
- [ ] Extreme default worker at budget
- [ ] worker-compare green (incl. pivot + update-only aggs)
- [ ] RealtimeAgg on data plane with incremental fast-path; main ≤ 4ms p95 scripting
- [ ] Pivot live ticks do not call main reaggregateLive when worker active
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types.ts TABULAR-CGRID-FEATURE-PLAN.md apps/showcase
git commit -m "$(cat <<'EOF'
docs: treat main CSRM as worker fallback only

EOF
)"
```

---

### Task 10: Tree-data gate (explicit non-goal + issue stub)

**Files:**
- Create: `docs/superpowers/specs/2026-07-10-tree-data-worker-followup.md`
- Modify: invariants eligibility matrix (already says no)

- [ ] **Step 1: Write follow-up stub**

```markdown
# Tree data on worker — follow-up

## Why deferred
treeData.ts / worker tree pass need path encoding, async children,
and excludeChildrenWhenTreeDataFiltering parity with AG.

## Entry criteria before starting
- Pivot worker (Task 7) merged
- WorkerCoordinator stable
- Compare harness supports tree fixtures

## Approach sketch
Port cgrid tree handling + Tabular `treeData.ts` into `passes/treePass.ts`,
same flatten contract as GroupPass displayed entries.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-07-10-tree-data-worker-followup.md
git commit -m "$(cat <<'EOF'
docs: defer tree-data worker pass with explicit entry criteria

EOF
)"
```

---

### Task 11: CI wiring

**Files:**
- Modify: `package.json` scripts
- Create or modify: `.github/workflows/ci.yml` (if present) / document in README

- [ ] **Step 1: Add scripts**

```json
{
  "scripts": {
    "worker-compare": "tsx scripts/worker-compare.ts",
    "worker-budget": "tsx scripts/worker-budget.ts",
    "test:worker": "npm run worker-compare && npm run worker-budget"
  }
}
```

- [ ] **Step 2: README section**

In `README.md` (or `apps/README.md` if root is thin), add:

```markdown
## Worker data plane

Default `rowDataMode` is worker. Force main with `rowDataMode: 'main'`.
Verify: `npm run test:worker`
```

- [ ] **Step 3: Commit**

```bash
git add package.json README.md
git commit -m "$(cat <<'EOF'
chore: wire worker-compare and worker-budget as test:worker

EOF
)"
```

---

## Verification matrix (definition of done)

| Scenario | Expected |
|----------|----------|
| Flat grid, field cols, default options | data worker active; main does not `aggregateTree` on ticks |
| Grouped + ticks (RealtimeAgg) | incremental `aggregatesUpdated`; no full main refresh; FPS stable |
| Pivot + Live ticks | worker rebuild/patch; main `reaggregateLive` not used |
| `valueGetter` display-only col | worker still active |
| Filter on `valueGetter` col | falls back to main |
| `rowDataMode: 'main'` | no worker construct |
| Worker construct throw | fallback + warn once; grid usable |
| `npm run test:worker` | green in CI |

---

## Risk register

| Risk | Mitigation |
|------|------------|
| Incremental path diverges from full rebuild | Task 2/6 compare asserts; fuzz group-key changes force full rebuild |
| Pivot column materialisation race | `pivotKeyPaths` on same `modelUpdated` as displayed; main applies cols before paint |
| `grid.ts` extract breaks paint | Task 4 behavior-preserving move; smoke Grouping/Extreme before Task 6 |
| RealtimeAgg regresses when leaving `rowDataMode: main` | Task 3 budget + Task 6 fast-path required before page change |
| Scope creep into tree/SharedWorker | Task 10 explicit defer |

---

## Suggested execution order (dependencies)

```text
Task 1 (invariants)
  → Task 2 (harness) → Task 3 (budget)
  → Task 4 (coordinator)
  → Task 5 (extract AggEngine)
  → Task 6 (fold incremental)  ← critical path
  → Task 7 (pivot)
  → Task 8 (eligibility)
  → Task 9 (product cleanup) → Task 10 (tree stub) → Task 11 (CI)
```

Do not start Task 7 until Task 6 is green. Do not delete `reaggregateLive` until Task 7 ships.

---

## Self-review (plan quality)

| Spec concern from candid assessment | Task |
|-------------------------------------|------|
| Dual workers | 5, 6 |
| Dual sources of truth / stale leaves | 6 (+ invariants 1) |
| Pivot on main | 7 |
| grid.ts integration bus | 4 |
| Default flip ≠ architecture | 6, 9 |
| Compare-mode CI | 2, 3, 11 |
| Tree | 10 deferred |
| Per-pass vs all-or-nothing | 8 (honest full fallback; true per-pass deferred) |

**Placeholder scan:** none intentional. True per-pass fallback (run filter on worker, sort on main) is explicitly **not** in this plan — Task 8 fail-closed full fallback is the chosen safer increment.

**Type consistency:** `AggEngine`, `GroupAggUpdate`, `WorkerPipelineConfig`, `WorkerModelOutput`, `WorkerCoordinator` names are stable across tasks.
