# pgrid Phase 1 (Perspective-native DOM grid) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone DOM grid (`packages/pgrid`) whose row model is a FinOS Perspective view, with push-based ticking aggregates at group and pivot levels (no polling).

**Architecture:** One indexed Perspective Table; grid state compiles to a single view (group_by/split_by/aggregates/sort/filter); a recycled-row-pool DOM plane binds from an async RenderView; `view.on_update` (adaptively throttled) re-reads the visible window and stamps diffs with flash. Spec: `docs/superpowers/specs/2026-07-11-pgrid-design.md` — read it first, especially §5 (engine contract) and §6 (render plane).

**Tech Stack:** TypeScript strict, raw-TS workspace package (`main: ./src/index.ts`), `@finos/perspective` (only runtime dep), React optional peer at `./react`. Tests: tsx assertion scripts (repo convention — `@finos/perspective` works in node, so engine integration tests run headless).

## Worklog (session protocol)

Each task below is sized for one working session. Session protocol:

1. Read the spec (`docs/superpowers/specs/2026-07-11-pgrid-design.md`) and this plan's **Global Constraints**, then your task only.
2. Execute the task's steps in order, checking boxes (`- [x]`) as you go.
3. On completion: run `npm run typecheck` + the task's test commands, commit with the given message, **append a row to the Session Log below**, and commit the plan-file update too.
4. If you deviate from the plan, record what/why in the Session Log row.

### Session Log

| Date | Task | Result | Notes / deviations |
|---|---|---|---|
| _(append rows here)_ | | | |
| 2026-07-12 | Fix (pivot, user-reported) + FinOS datagrid re-study | ✅ Pivot matrix verified correct under ticks (each desk's values only in its own ccy columns, blanks elsewhere, 0 label leaks, all rows ticking); node tests + full typecheck green; commits `f080c8f`, `a424af0` | User reported pivot "all messed up" and asked for a FinOS datagrid re-read (sources extracted from the npm sourcemap into scratch). Findings: (1) **Empty pivot intersections showed the group label** — Task 5's blank-cell label fallback predates the auto group column and mislabeled legitimately-null cells; removed, null → blank (FinOS `format_cell` returns null for null too). (2) **Split column-set parity** (probed live): updates that introduce a new split value grow `column_paths` immediately, and window responses include them at once — our per-view path cache and response-key-derived columns let data and headers disagree. Now: `window()` keys values off the cached paths with null-fill (the datagrid's `columns[path] \|\| fill(null)` defense), ViewHost refreshes the cache on every update flush when split_by is active, and the grid rebuilds display columns + header when the path fingerprint changes. Regression block added to `scripts/pgrid-view-host.ts`. Non-adopted divergences, deliberate: FinOS's split-view sort rotation has extra `col desc/col asc` states (spec §5.7 chose the simple rotation — phase 2); FinOS renders one row-header column per group level vs our ag-grid-style single auto group column (approach A); FinOS doesn't await expand redraws (spec §5.3 fixes that race). Perspective 3.8 no longer omits empty columns from split windows (probed), but the null-fill guard is kept — it's what makes cache-keyed reads safe mid-update. |
| 2026-07-12 | Fix (post-T8, user-reported) | ✅ Real-input verification: chevron click expands/collapses (7↔31 rows), resize drag keeps header/body pixel-aligned (all per-column deltas 0.0), no accidental sort on release; commit `0bc206b` | User reported groups not expanding + misalignment. Three defects, all real. (1) **Chevron unreachable by real clicks**: cells are later siblings painted above the chevron, so hit-testing never reached it — Tasks 7/8 smoke "passed" because it dispatched events directly at the chevron, bypassing hit-testing. Fixed with `z-index: 1`; **lesson: verify interactions with trusted playwright clicks (real hit-testing), not `dispatchEvent`.** (2) **Header resize never updated the dragged cell in place** — the Task 7 log claimed it did, but it was unimplemented; body columns moved while the header stayed stale. (3) **No standalone box-sizing reset** — pgrid only looked aligned because the showcase has a global `* { box-sizing: border-box }`; now scoped to `.pg-root`. Part of the user-visible mess was also cross-session browser interference (see Task 8 note): during this very verification an unrequested `ccy` grouping appeared mid-run — external, not pgrid. |
| 2026-07-12 | Task 8 | ✅ Browser-verified (chip remove unwinds grouped→flat with scroll reset; header→group-strip drag with ghost + drop highlight regroups; sidebar G toggle → desk→ccy two-level with ticking subgroup sums; sidebar P + pivot-mode toggle → split_by ccy with merged hgroup headers and ticking pivoted TOTAL; chip reorder desk,ccy→ccy,desk rebuilds as "Ccy / Desk"; sort-only change preserves scrollTop=500 in the flat 5k view while group change resets to 0), `tsc -p packages/pgrid` + full `npm run typecheck` green, all 5 node tests pass, commit `f8232b9` | Deviations/notes. (1) **Panels constructor takes a 4th `show` arg** (`{groupPanel, pivotPanel, sideBar}`) mapped from GridOptions; panel options default to hidden (`'never'`/false, ag-grid semantics) and the harness opts in with `'always'`/true. (2) **Header→panel drag is meaningful from flat views only** — grouped views don't display non-value columns (engine `columns` = value fields), so the plan's "drag ccy header into group strip" was verified as: ungroup → drag Desk header in → re-group, with ccy added via the sidebar G toggle (the sidebar exists exactly for columns not currently displayed). (3) **`setPointerCapture` wrapped in try/catch** in panels chip-drag and header resize — it throws NotFoundError for already-lifted pointers (touch race; also synthetic test events), which aborted the whole drag handler. (4) Small additions to Task 6's styles.ts: ghost-chip/drop-highlight/sidebar-row/toggle rules + 2 CLS keys. Verification interference note: the playwright-MCP browser profile is shared with another concurrent session (profile-lock error at session start; two untracked state mutations observed mid-verification with `isTrusted` instrumentation later confirming zero real events during my runs) — all pass results above come from interference-free instrumented runs. |
| 2026-07-12 | Task 7 | ✅ Browser smoke passed (5k rows, group sums ticking with zero refresh code, expand/collapse under 2k updates/s, sort desc + indicator, contiguous scroll with 0 blank rows, clean destroy/remount through StrictMode, no console errors), `tsc -p packages/pgrid` + full `npm run typecheck` green, all node tests still pass, commit `0b88ece` | Three deviations/additions. (1) **Auto group column** (resolves the Task 5/6 group-label question): a display-only first column, implemented as a grid-side RenderView adapter over the Materializer — offsets data columns by 1 when grouped, synthesizes label cells (`groupLabel(meta)` for groups, last path part = row id for leaves) with flash 0. Materializer/pool contracts untouched; ticking aggregates stay visible (ag-grid semantics). (2) **`Viewport.anchor` added to windowMath** (additive; Task 2 test untouched and still green): the floored anchor row, so the grid places the row layer at `scrollTop − (anchor − firstRow)·rowH` without re-deriving the percent mapping. (3) **`GridOptions` added to types.ts** — spec §4 lists it there but no prior task created it. Also noteworthy: `load()` resolves via a barrier read (`host.window(0,0,0,0)` serializes behind the update in the engine queue) since `TableHandle.update` is fire-and-forget; resize drags update the header cell width in place instead of re-rendering (a rebuild would destroy the pointer-capture target mid-drag); expand identity-check validates kind/expanded against the current frame's meta — full re-resolve-on-mismatch (spec §10) deferred, risk window is sub-frame; sort/state changes rebuild the view so expansion resets (accepted spec §5.3 semantics, observed in smoke). Harness page registered as `PGrid (P-native)` with `pgrid: "*"` showcase dep. |
| 2026-07-12 | Task 6 | ✅ `tsc -p packages/pgrid` + full `npm run typecheck` green, materializer/viewHost node tests still pass, commit `0466e84` | No deviations — structure lifted from the repo's dom renderer (`packages/dom/src/{styles,rowPool}.ts`) as the plan directs, colors from `packages/core/src/theme.ts` Cursor tokens with the plan's softened up/down (`#7CB88C`/`#C87878`). Details made explicit: (1) geometry/font `--pg-*` vars default on `.pg-root` in the base stylesheet (dark values too, so an unthemed root renders); `applyTheme` sets color vars only, as inline style overrides. (2) Flash retrigger fires when `flash !== 0` AND (text changed OR the row landed in a different slot); a same-row re-stamp with unchanged text preserves the running animation instead of restarting it every `bindWindow` (dom renderer's keepFlash lesson — without it, any scroll during the 590ms window restarts the flash). (3) In-flight rows (no meta yet) keep stale pixels only while their `boundRow` stays inside the window, and are re-placed at the new window-relative y so a mid-flight scroll doesn't strand them. (4) Chevron is a per-slot dedicated element shown via CSS only on `.pg-group` rows; group-row first cells pad by `level*groupIndent + 20px` to clear it, leaf cells by `level*groupIndent`. `groupLabel()` from Task 5 stays unused here — the group-name rendering decision (aggDepth opt-in vs auto group column) lands with Task 7's browser smoke. |
| 2026-07-12 | Task 5 | ✅ `pgrid-materializer OK` (first run after implementation), `tsc -p packages/pgrid` + full `npm run typecheck` green, commit `a6e584a` | Two deviations, both reconciliations of plan-internal tension. (1) **Group label is a blank-cell fallback, not an unconditional override**: Step 3's "first visible column renders `path[level-1] ?? 'TOTAL'`" contradicts Step 1's own assertion (`cell(1,0).text === '5.00'` — Credit's ticking sum) given Task 4's aggDepth-0 default (aggregates visible). Resolved: the label renders in the first visible column only where the aggregate is blanked (`raw == null`); a `groupLabel(meta)` helper is exported so Task 6's pool can render the label in the chevron/group cell regardless. (2) **`splitPath` not consumed**: the materializer can't call it — `splitPath` needs the `PspViewConfig`, which lives grid-side (ViewHost doesn't expose it). Pivot-path → ColDef resolution belongs in the injected `getColDef` (Task 7's grid owns the config and calls `splitPath` there). Also: the test wires `onModelUpdated → invalidate()` (real push channel) instead of calling `invalidate()` manually right after `t.update` — a manual call could race the engine's async update apply; the plan's invalidate-after-update sequence still holds, just triggered by `on_update`. Flash gate compares the requested window tuple (firstRow/lastRow/firstCol/lastCol) between consecutive swaps; buffer keys are `rowId + ' ' + colPath` so row shifts within a same-viewport swap can't cross-flash. |
| 2026-07-12 | Task 4 | ✅ `pgrid-view-host OK`, `tsc -p packages/pgrid` + full `npm run typecheck` green, commit `f7e4863` | Three deviations, all engine-reality-driven (probed the real engine before implementing). (1) **Leaf-level injection**: Perspective's grouped tree is exactly `group_by.length` levels deep — with `group_by:['desk']` there is no leaf level and `expand` past it throws ("Cannot expand past 1"). ViewHost appends the table's index column (`table.get_index()`) to the **engine** `group_by`, giving groups expandable leaf rows (ag-grid semantics); the user-facing `PspViewConfig` is untouched and remains the equivalence key, so the plan's test passes unchanged (3 rows at depth 0 → 4 after `expand(1)`). Leaves are rows whose `path.length > ` user `group_by.length`. (2) **aggDepth resolved**: the FinOS datagrid's blanking rule is `path.length < min(column.aggregate_depth ?? 0, group_by.length)` — a per-column opt-in defaulting to 0, i.e. **no blanking by default**. Implemented as a `ViewHost.aggDepth` hook (0 in phase 1) rather than unconditional blanking, which would have blanked the ticking group aggregates the project exists for. (3) Test script wrapped in `main()` with dynamic `import()` of engine (same Task 1 CJS constraint); `viewHost.ts` itself uses only type-level perspective imports so its static import is safe. Also: `set_depth` clamps to the engine tree depth (it throws past it), `-1` maps to expand-all. |
| 2026-07-12 | Task 3 | ✅ `pgrid-view-compiler OK`, `tsc -p packages/pgrid` + full `npm run typecheck` green, commit `cada2e3` | No deviations — direct mapping as planned; test passed on first run after implementation. Two unstated details made explicit: (1) unknown filter ops **throw** rather than being silently dropped (a dropped filter would render wrong data); (2) `columns` uses value fields when `group_by` **or** `split_by` is nonempty (pivot-only views are aggregated too), matching the test's grouped/flat split. |
| 2026-07-12 | Task 2 | ✅ `pgrid-window-math OK`, `tsc -p packages/pgrid` + full `npm run typecheck` green, commit `6afb126` | No deviations — test and math implemented exactly as planned; test passed on first run after implementation. One unstated detail made explicit: the plan leaves the `overscan` default unspecified, so a single `DEFAULT_OVERSCAN = 4` is shared by `computeViewport`, `poolSize`, and `visibleCols` — viewport and pool sizing must agree on overscan or `poolSlot` collides when callers omit it. |
| 2026-07-11 | Task 1 | ✅ `pgrid-engine OK`, typecheck green, commit `06e0e70` | Two deviations. (1) The `node` entry of `@finos/perspective@3.8.0` has **no `worker()` factory** — it boots the engine in-process via top-level await at import and default-exports a module-level client facade (`{table, websocket, system_info, ...}`); `ensureEngine`'s node branch returns that default cast as `Client` (structurally sufficient — we only call `.table`). Browser branch unchanged (tsc under `moduleResolution: bundler` resolves browser types, so `worker`/`init_client`/`init_server` typecheck natively; no `vite-env.d.ts` needed — `as string` on the `?url` specifiers suffices). (2) Test script: `scripts/` is CJS-scoped (root package.json lacks `"type": "module"`) and perspective's ESM node entry can't be CJS-transformed (top-level await), so the plan's top-level-await test body is wrapped in `main()` and the engine module loaded via native dynamic `import()`. Same file name, same run command, same assertions. |

## Global Constraints

- `packages/pgrid` has exactly one runtime dependency: `"@finos/perspective": "^3.8.0"`. No `@tabular/*` imports anywhere.
- All Perspective types stay behind `viewHost.ts` and `engine.ts` — nothing above them imports from `@finos/perspective` (this is the P4 engine-swap seam; spec §9).
- Meta-column predicate applied to every column list read from the engine: `/^__(?:ROW_PATH(?:_\d+)?|ID|GROUPING_ID)__$/` (spec §5.2).
- The measure index in split column paths is `config.split_by.length`, defined once as `measureIndex()` in `viewCompiler.ts` — never repeat the constant inline (spec §5.6).
- Hot window reads use `to_columns_string(...)` + one `JSON.parse`, with `id: true` (spec §5.1).
- UI thread stamping = `textContent` + class swaps + geometry inline styles only. No per-cell listeners; one delegated listener set on the grid root.
- Scroll resets: scrollTop only when group_by changed; scrollLeft only when split_by changed; sort/filter preserve scroll (spec §5.5).
- Expand/collapse: always `await` the redraw after `view.expand/collapse/set_depth` (spec §5.3 — fixes the datagrid's race).
- Every task keeps `npm run typecheck` green and ends with a commit.
- Code style: JSDoc on exported symbols; comments explain constraints, not mechanics.

---

### Task 1: Package scaffold + headless engine bootstrap

**Files:**
- Create: `packages/pgrid/package.json`, `packages/pgrid/tsconfig.json`, `packages/pgrid/src/index.ts`, `packages/pgrid/src/engine.ts`, `packages/pgrid/src/types.ts`
- Test: `scripts/pgrid-engine.ts`
- Modify: root `package.json` (typecheck chain + workspaces already covers `packages/*`)

**Interfaces:**
- Produces (used by every later task):

```ts
// engine.ts
export function ensureEngine(): Promise<Client>;                    // singleton; node + browser
export interface TableHandle {
  update(rows: Record<string, unknown>[]): void;                    // chunked internally (2500)
  raw(): Table;                                                     // viewHost-only escape hatch
  delete(): Promise<void>;
}
export async function createIndexedTable(
  schema: Record<string, string>, indexField: string,
): Promise<TableHandle>;

// types.ts (grid-facing; NO perspective imports)
export type ColType = 'string' | 'float' | 'integer' | 'boolean' | 'datetime' | 'date';
export interface ColDef {
  field: string; headerName?: string; type?: ColType; width?: number;
  format?: string;                       // Intl-style: '#,##0.00' subset, see Task 5
  aggFunc?: 'sum' | 'avg' | 'min' | 'max' | 'count' | null;
  rowGroup?: boolean; rowGroupIndex?: number;
  pivot?: boolean; pivotIndex?: number;
  enableRowGroup?: boolean; enablePivot?: boolean; enableValue?: boolean;
  pinned?: 'left' | 'right' | null;
}
export interface GridState {
  columnDefs: ColDef[]; rowGroupCols: string[]; pivotCols: string[];
  valueCols: { field: string; aggFunc: string }[];
  sortModel: { colId: string; sort: 'asc' | 'desc' }[];
  filterModel: Record<string, { op: string; value: unknown }>;
  pivotMode: boolean;
}
export interface RowMeta { id: string; kind: 'leaf' | 'group'; level: number; path: string[]; expanded: boolean; }
export interface CellRender { text: string; styleClass: string; flash: 1 | -1 | 0; }
export interface WindowSlice {
  firstRow: number; rowCount: number;
  metas: RowMeta[];                       // window-relative
  cols: string[];                         // visible column paths (meta-filtered)
  values: unknown[][];                    // [colIdx][rowIdx-window-relative]
}
```

- [x] **Step 1: Scaffold.** `packages/pgrid/package.json`:

```json
{
  "name": "pgrid",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts", "./react": "./src/react.tsx" },
  "sideEffects": false,
  "dependencies": { "@finos/perspective": "^3.8.0" },
  "peerDependencies": { "react": ">=18" },
  "peerDependenciesMeta": { "react": { "optional": true } }
}
```

`tsconfig.json`: copy `packages/renderers/tsconfig.json`, adjust include to `src`. Add `tsc -p packages/pgrid && ` to the root `typecheck` script (before `tsc -p apps/showcase`). `npm install`.

- [x] **Step 2: Write the failing test** — `scripts/pgrid-engine.ts`:

```ts
import assert from 'node:assert/strict';
import { ensureEngine, createIndexedTable } from '../packages/pgrid/src/engine';

const client = await ensureEngine();
assert.ok(client, 'engine client');
const t = await createIndexedTable({ id: 'string', px: 'float' }, 'id');
t.update([{ id: 'a', px: 1 }, { id: 'b', px: 2 }]);
t.update([{ id: 'a', px: 5 }]);                    // replace by index
const view = await t.raw().view();
assert.equal(await view.num_rows(), 2);            // indexed: still 2 rows
const cols = JSON.parse(await view.to_columns_string({ start_row: 0, end_row: 2 }));
assert.deepEqual(cols.px.sort(), [2, 5]);
await view.delete();
await t.delete();
console.log('pgrid-engine OK');
process.exit(0);
```

- [x] **Step 3: Run — expect FAIL** (`npx tsx scripts/pgrid-engine.ts`; module doesn't exist).
- [x] **Step 4: Implement `engine.ts`.** Node/browser dual bootstrap: in node, `import perspective from '@finos/perspective'` works directly (its `node` export condition boots the engine without fetch). In the browser, init requires the wasm assets:

```ts
import perspective from '@finos/perspective';
import type { Client, Table } from '@finos/perspective';

let clientPromise: Promise<Client> | null = null;

/** Headless engine bootstrap; browser callers must have wasm reachable via import.meta.url resolution (Vite: exclude '@finos/perspective' from optimizeDeps). */
export function ensureEngine(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      if (typeof window !== 'undefined') {
        const [{ default: SERVER_WASM }, { default: CLIENT_WASM }] = await Promise.all([
          import('@finos/perspective/dist/wasm/perspective-server.wasm?url' as string),
          import('@finos/perspective/dist/wasm/perspective-js.wasm?url' as string),
        ]);
        perspective.init_client(fetch(CLIENT_WASM));
        perspective.init_server(fetch(SERVER_WASM));
        return perspective.worker();
      }
      // Node: the package's node entry hosts the engine in-process.
      return (perspective as unknown as { worker(): Promise<Client> }).worker();
    })();
  }
  return clientPromise;
}
```

Verify the node path actually works by reading `node_modules/@finos/perspective/dist/esm/perspective.node.js` exports — if node exposes a different factory than `worker()` (e.g. a default in-process client), adapt and note it in the Session Log. `createIndexedTable`: `client.table(schema as never, { index: indexField })`, wrap with a 2500-row chunking `update`, `delete()` forwarding. If the dynamic `?url` import trips tsc in node context, isolate it behind `/* @vite-ignore */` + a `declare module '*?url'` in `packages/pgrid/src/vite-env.d.ts`.

- [x] **Step 5: Run — expect `pgrid-engine OK`.** Then `npm run typecheck` — exit 0.
- [x] **Step 6: Commit** — `git add packages/pgrid scripts/pgrid-engine.ts package.json package-lock.json && git commit -m "feat(pgrid): scaffold + headless Perspective engine bootstrap"`

---

### Task 2: windowMath (pure, TDD)

**Files:**
- Create: `packages/pgrid/src/windowMath.ts`
- Test: `scripts/pgrid-window-math.ts`

**Interfaces:**
- Produces:

```ts
export const MAX_PANEL_PX = 10_000_000;
export interface Viewport { firstRow: number; lastRow: number; subCellPx: number; }
export function panelHeight(rowCount: number, rowHeight: number, headerPx: number): number; // clamped
export function computeViewport(scrollTop: number, panelH: number, clipH: number, rowCount: number, rowHeight: number, overscan?: number): Viewport;
export function poolSize(clipH: number, rowHeight: number, rowCount: number, overscan?: number): number;
export function poolSlot(rowIndex: number, size: number): number;
export function visibleCols(scrollLeft: number, clipW: number, widths: number[], overscan?: number): { firstCol: number; lastCol: number; leftPx: number };
```

- [x] **Step 1: Write the failing test** — `scripts/pgrid-window-math.ts`:

```ts
import assert from 'node:assert/strict';
import { computeViewport, panelHeight, poolSize, poolSlot, visibleCols, MAX_PANEL_PX } from '../packages/pgrid/src/windowMath';

// Uncompressed: percent mapping degenerates to pixel mapping.
{
  const ph = panelHeight(1000, 20, 0);
  assert.equal(ph, 20_000);
  const v = computeViewport(400, ph, 500, 1000, 20, 0);
  assert.equal(v.firstRow, 20);
  assert.equal(v.subCellPx, 0);
}
// Fractional scroll → sub-cell offset.
{
  const v = computeViewport(410, 20_000, 500, 1000, 20, 0);
  assert.equal(v.firstRow, 20);
  assert.equal(v.subCellPx, 10);
}
// Compressed: 100M rows × 20px clamps to MAX_PANEL_PX; bottom maps to last page.
{
  const ph = panelHeight(100_000_000, 20, 0);
  assert.equal(ph, MAX_PANEL_PX);
  const v = computeViewport(ph - 500, ph, 500, 100_000_000, 20, 0);
  assert.equal(v.lastRow, 99_999_999);
}
// Pool invariants: no collision inside any window.
{
  const size = poolSize(500, 20, 1_000_000, 8);
  const v = computeViewport(123_456, 20_000_000 > MAX_PANEL_PX ? MAX_PANEL_PX : 20_000_000, 500, 1_000_000, 20, 8);
  const seen = new Set<number>();
  for (let r = v.firstRow; r <= v.lastRow; r++) {
    const s = poolSlot(r, size);
    assert.ok(!seen.has(s), `collision @${r}`);
    seen.add(s);
  }
}
// Column window: widths [100,50,200,100], scrollLeft 120 → firstCol 1, leftPx 100.
{
  const c = visibleCols(120, 250, [100, 50, 200, 100], 0);
  assert.equal(c.firstCol, 1);
  assert.equal(c.leftPx, 100);
  assert.ok(c.lastCol >= 2);
}
console.log('pgrid-window-math OK');
```

- [x] **Step 2: Run — expect FAIL.**
- [x] **Step 3: Implement.** Percent-scroll model (spec §6): when `rowCount*rowHeight+headerPx <= MAX_PANEL_PX` the mapping is exact (`anchor = scrollTop / rowHeight`); when clamped, `percent = scrollTop / (panelH - clipH)`, `anchorFloat = percent * (rowCount - clipH/rowHeight)`; `firstRow = floor(anchorFloat) - overscan` (clamped ≥0), `lastRow = firstRow + ceil(clipH/rowHeight) + 2*overscan` (clamped ≤ rowCount-1), `subCellPx = (anchorFloat % 1) * rowHeight`. `poolSize` = `min(rowCount, ceil(clipH/rowHeight) + 1 + 2*overscan)`, floor 1. `poolSlot` = `rowIndex % size`. `visibleCols` walks accumulated widths (no measurement — widths are authoritative from ColDefs).
- [x] **Step 4: Run — expect `pgrid-window-math OK`;** `npx tsc -p packages/pgrid` exit 0.
- [x] **Step 5: Commit** — `git commit -m "feat(pgrid): percent-scroll window math with 10M-px clamp"` (add both files).

---

### Task 3: viewCompiler (pure, TDD)

**Files:**
- Create: `packages/pgrid/src/viewCompiler.ts`
- Test: `scripts/pgrid-view-compiler.ts`

**Interfaces:**
- Produces:

```ts
export interface PspViewConfig {           // mirror of engine config; still no @finos import
  group_by: string[]; split_by: string[]; columns: string[];
  aggregates: Record<string, string>; sort: string[][];
  filter: (string | number | boolean)[][];
}
export function compileView(state: GridState): PspViewConfig;
export function isEquivalent(a: PspViewConfig, b: PspViewConfig): boolean;   // deep, order-sensitive
export function measureIndex(cfg: PspViewConfig): number;                    // === cfg.split_by.length
export function splitPath(path: string, cfg: PspViewConfig): { groups: string[]; measure: string };
export const META_COLUMN_RE: RegExp;      // /^__(?:ROW_PATH(?:_\d+)?|ID|GROUPING_ID)__$/
```

- [x] **Step 1: Write the failing test** — `scripts/pgrid-view-compiler.ts`:

```ts
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
```

- [x] **Step 2: Run — expect FAIL.**
- [x] **Step 3: Implement.** Direct mapping; sort tuples pass through only for columns present in `columns` (grouped views sort on aggregates — engine handles it); filterModel ops map 1:1 for `== != < <= > >= contains`, `isNull → [field, 'is null']` (two-element). `isEquivalent` = `JSON.stringify(a) === JSON.stringify(b)` with key-sorted aggregates/filter normalization (implement a small `normalize(cfg)` that sorts aggregate keys and filter rows).
- [x] **Step 4: Run — expect OK; typecheck.**
- [x] **Step 5: Commit** — `git commit -m "feat(pgrid): GridState→view compiler with equivalence fast-path"`.

---

### Task 4: ViewHost (engine integration, node-tested)

**Files:**
- Create: `packages/pgrid/src/viewHost.ts`
- Test: `scripts/pgrid-view-host.ts`

**Interfaces:**
- Consumes: `ensureEngine/createIndexedTable` (Task 1), `compileView/isEquivalent/META_COLUMN_RE/splitPath` (Task 3).
- Produces (the P4 seam — no Perspective types leak):

```ts
export interface ViewHostEvents {
  onModelUpdated(rowCountChanged: boolean): void;   // fired ≤1×/frame; adaptive throttle inside
}
export class ViewHost {
  constructor(table: TableHandle, events: ViewHostEvents);
  /** Rebuilds only when !isEquivalent(prev, next); resolves when active. */
  async setConfig(cfg: PspViewConfig, groupDefaultExpanded: number): Promise<void>;
  rowCount(): number;                                // cached; refreshed on update/expand
  columnPaths(): string[];                           // meta-filtered, cached per view
  async window(firstRow: number, lastRow: number, firstCol: number, lastCol: number): Promise<WindowSlice>;
  async expand(viewRowIndex: number): Promise<void>;   // refreshes rowCount before resolving
  async collapse(viewRowIndex: number): Promise<void>;
  async setDepth(n: number): Promise<void>;
  async dispose(): Promise<void>;
}
```

- [x] **Step 1: Write the failing test** — `scripts/pgrid-view-host.ts` (real engine, node):

```ts
import assert from 'node:assert/strict';
import { createIndexedTable } from '../packages/pgrid/src/engine';
import { ViewHost } from '../packages/pgrid/src/viewHost';
import { compileView } from '../packages/pgrid/src/viewCompiler';
import type { GridState } from '../packages/pgrid/src/types';

const t = await createIndexedTable({ id: 'string', desk: 'string', mv: 'float' }, 'id');
t.update([
  { id: 'a', desk: 'Rates', mv: 10 }, { id: 'b', desk: 'Rates', mv: 20 },
  { id: 'c', desk: 'Credit', mv: 5 },
]);
let updates = 0;
const host = new ViewHost(t, { onModelUpdated: () => { updates++; } });
const state: GridState = {
  columnDefs: [{ field: 'desk' }, { field: 'mv', type: 'float', aggFunc: 'sum' }],
  rowGroupCols: ['desk'], pivotCols: [], valueCols: [{ field: 'mv', aggFunc: 'sum' }],
  sortModel: [], filterModel: {}, pivotMode: false,
};
await host.setConfig(compileView(state), 0);        // depth 0 → collapsed groups
// TOTAL + 2 desk groups = 3 rows
assert.equal(host.rowCount(), 3);
const w = await host.window(0, 2, 0, 0);
assert.equal(w.metas[0].kind, 'group');             // TOTAL row (level 0, path [])
assert.equal(w.metas[1].path[0], 'Credit');         // groups sort asc by default
assert.equal(w.values[0][1], 5);                    // sum(mv) for Credit
// expand Credit (view row 1) → leaf appears, rowCount grows
await host.expand(1);
assert.equal(host.rowCount(), 4);
// push: engine update fires onModelUpdated
const before = updates;
t.update([{ id: 'c', desk: 'Credit', mv: 50 }]);
await new Promise((r) => setTimeout(r, 300));
assert.ok(updates > before, 'on_update fired');
const w2 = await host.window(0, 3, 0, 0);
assert.equal(w2.values[0][1], 50);                  // Credit sum ticked
// config reuse: identical config must not recreate the view (expansion survives)
await host.setConfig(compileView(state), 0);
assert.equal(host.rowCount(), 4);                   // still expanded
await host.dispose();
console.log('pgrid-view-host OK');
process.exit(0);
```

- [x] **Step 2: Run — expect FAIL.**
- [x] **Step 3: Implement `viewHost.ts`** per spec §5. Key behaviors:
  - `setConfig`: `isEquivalent(current, next) && view` → no-op (return). Else `table.raw().view(cfg as never)` FIRST, then swap, then `old.delete()` (never a gap with no view); subscribe `view.on_update(handler)`; `set_depth(groupDefaultExpanded)` when `group_by.length > 0`; refresh caches (`num_rows`, `column_paths()` meta-filtered).
  - `window`: `to_columns_string({ start_row, end_row: lastRow + 1, start_col, end_col: lastCol + 1, id: true })` → parse; build `WindowSlice`: metas from `__ROW_PATH__` (kind = path.length < group_by.length+? → group; level = path.length; id from `__ID__` join('|') for leaves, path join for groups; expanded = engine doesn't say — set true and let Task 7 derive chevron state from child visibility: a group row is *expanded* iff the next view row's path is deeper. Compute that here from the slice, and for the last row of the slice read one row ahead in the same call by requesting `lastRow + 2`).
  - Aggregate blanking (spec §5.3): value for a group cell whose `path.length < aggDepth` → `null`.
  - on_update handler: adaptive throttle — record `lastPaintMs` (set by grid via `notePaintDuration(ms)`, add that method to the class); coalesce with a trailing-edge timer of `max(16, lastPaintMs)`; on fire: `num_rows()` refresh (or `dimensions().num_view_rows` when split_by nonempty), invoke `events.onModelUpdated(countChanged)`.
  - `expand/collapse`: engine call, then refresh `num_rows`, then resolve (caller awaits and redraws — Global Constraints).
- [x] **Step 4: Run — expect `pgrid-view-host OK`;** typecheck.
- [x] **Step 5: Commit** — `git commit -m "feat(pgrid): ViewHost — view lifecycle, windows, expand, push updates"`.

---

### Task 5: Materializer (formatting + flash double buffer, node-tested)

**Files:**
- Create: `packages/pgrid/src/materializer.ts`
- Test: `scripts/pgrid-materializer.ts`

**Interfaces:**
- Consumes: `ViewHost.window`, `WindowSlice`, `splitPath` (Task 3).
- Produces:

```ts
export interface RenderView {
  rowCount(): number;
  rowMeta(rowIndex: number): RowMeta | undefined;                 // undefined while in flight
  cell(rowIndex: number, colIndex: number): CellRender | undefined;
  requestWindow(v: Viewport, cols: { firstCol: number; lastCol: number }): void;
  onFrame(cb: () => void): void;                                  // new data ready → rebind
}
export class Materializer implements RenderView {
  constructor(host: ViewHost, getColDef: (path: string) => ColDef | undefined);
  invalidate(): void;                                             // model updated → refetch window
}
export function formatValue(v: unknown, def: ColDef | undefined): string;  // exported for tests
```

- [x] **Step 1: Write the failing test** — `scripts/pgrid-materializer.ts`: build the same 3-row grouped table as Task 4; wrap in a Materializer with `mv` def `{ field: 'mv', type: 'float', format: '#,##0.00' }`; `requestWindow`, await one `onFrame`, assert `cell(1, 0).text === '5.00'` and `flash === 0`; then `t.update([{ id:'c', desk:'Credit', mv: 50 }])`, `invalidate()`, await next frame, assert `cell(1, 0)` is `'50.00'` with `flash === 1` (value rose); assert a second read without changes has `flash === 0` (flash is one-frame). Full script mirrors Task 4's setup; assert also `formatValue(1234.5, { field: 'x', type: 'float', format: '#,##0.00' }) === '1,234.50'` and `formatValue(null, ...) === ''`.
- [x] **Step 2: Run — expect FAIL.**
- [x] **Step 3: Implement.** Window cache = last `WindowSlice` + formatted strings (lazy per cell, memoized per frame). Previous-frame buffer: `Map<rowId + ' ' + colPath, rawValue>` rotated on each successful window swap **only when the viewport is unchanged** (same-first/last — spec §6 flash gate); flash dir = sign(new - old) for numbers, `1` for other changed values. Formatter cache: `Map<type + '|' + format, (v) => string>`; `'#,##0.00'` subset → `Intl.NumberFormat(undefined, { minimumFractionDigits, maximumFractionDigits, useGrouping })` derived from the pattern (decimals = chars after `.`; grouping = pattern contains `,`). Group rows: first visible column renders `path[level-1] ?? 'TOTAL'` (chevron handled by pool via meta, not text).
- [x] **Step 4: Run — expect OK; typecheck.**
- [x] **Step 5: Commit** — `git commit -m "feat(pgrid): materializer — window cache, Intl formatting, flash double buffer"`.

---

### Task 6: DOM plane — styles + recycled pool

**Files:**
- Create: `packages/pgrid/src/styles.ts`, `packages/pgrid/src/pool.ts`

**Interfaces:**
- Produces:

```ts
// styles.ts
export const CLS: { root; header; hcell; hgroup; panel; chip; scroller; spacer; layer; row; cell; num; group; chevron; flashUp; flashDown; sortAsc; sortDesc; sidebar };
export function ensureStyles(): void;                    // idempotent <style id="pgrid-styles">
export function applyTheme(root: HTMLElement, theme: 'dark' | 'light'): void;  // --pg-* vars
// pool.ts
export interface PoolGeometry { colWidths: number[]; colLefts: number[]; rowHeight: number; groupIndent: number; totalWidth: number; firstCol: number; lastCol: number; }
export class RowPool {
  constructor(layer: HTMLElement);
  setSize(size: number, colCount: number): void;
  bindWindow(v: Viewport, view: RenderView, geo: PoolGeometry): void;   // stamps all slots
  clear(): void;
}
```

- [x] **Step 1: Implement `styles.ts`.** CSS custom props (`--pg-base/-raised/-text/-text-2/-accent/-up/-down/-gridline/-row-h/-header-h/-font/-font-size`), dark defaults matching the showcase Cursor-Dark tokens (`#141414` base, `#F0F0F0` text, `#81A1C1` accent, up `#7CB88C`, down `#C87878`), light overrides via `applyTheme`. Row/cell/flash rules follow the structure proven in this repo's dom renderer (absolute rows, `translate3d`, `contain: strict`, flash as CSS `@keyframes` classes `pg-flash-up/down` 590ms). Chevron = CSS triangle on `.pg-chevron` with `[data-expanded="1"]` rotation. Group panel/chips/sidebar get minimal chrome (border, 2px radius, chip close ×).
- [x] **Step 2: Implement `pool.ts`.** Slots `{ el, cells, boundRow }`; `bindWindow` uses `poolSlot`; per row: geometry (`translate3d(0, (r - v.firstRow) * rowH - v.subCellPx …)` — NOTE: rows position inside a layer that itself sits at the window top; use window-relative offsets so the 10M-px clamp never hits element coordinates), `data-row`, group class + chevron cell with `data-expanded`, indent `meta.level * groupIndent`; per cell: `left/width` from geo, `textContent` diff-write, `.pg-num` for float/integer cols, flash class retrigger (`remove → void offsetWidth → add`) when `cell.flash !== 0`. Only columns `firstCol..lastCol` get cells (column virtualization); pool is resized when the visible col count changes.
- [x] **Step 3: Typecheck + commit** — `git commit -m "feat(pgrid): DOM plane — themed styles and recycled row pool"`.

---

### Task 7: PspGrid orchestrator + header (browser-verified)

**Files:**
- Create: `packages/pgrid/src/header.ts`, `packages/pgrid/src/grid.ts`; modify `packages/pgrid/src/index.ts` (export PspGrid + types)
- Create: `apps/showcase/src/pages/PGrid.tsx` (minimal harness; fleshed out in Task 9); register `{ id: 'pgrid', label: 'PGrid (P-native)' }` in `apps/showcase/src/App.tsx`; add `"pgrid": "*"` to showcase deps; `npm install`.

**Interfaces:**
- Consumes: everything above.
- Produces:

```ts
export class PspGrid {
  constructor(root: HTMLElement, options: GridOptions);   // GridOptions per spec §3
  setSchema(schema: Record<string, string>): Promise<void>;
  load(rows: Record<string, unknown>[]): Promise<void>;
  update(rows: Record<string, unknown>[]): void;
  applyColumnState(state: Partial<GridState>): Promise<void>;
  getColumnState(): GridState;
  setPivotMode(on: boolean): Promise<void>;
  on(event: 'ready' | 'model-updated' | 'column-state-changed', cb: () => void): () => void;
  destroy(): Promise<void>;
}
// header.ts
export class Header {
  constructor(el: HTMLElement, callbacks: { onSortClick(colId: string, additive: boolean): void; onResize(colId: string, w: number): void; onDragStart(colId: string, ev: PointerEvent): void });
  render(state: GridState, columnPaths: string[], cfg: PspViewConfig, widths: number[], scrollLeft: number): void;  // builds split_by group rows w/ colspan merge, sort arrows
}
```

- [x] **Step 1: Implement `grid.ts`.** Construction: `ensureStyles`, `applyTheme`, DOM skeleton (panels strip → header → scroller[spacer + layer]), `AbortController` for all listeners. Wiring:
  1. `setSchema` → `createIndexedTable(schema, options.rowIdField)`; derive GridState from columnDefs (rowGroup/pivot/aggFunc initial state); `ViewHost.setConfig(compileView(state), groupDefaultExpanded)`; Materializer; emit `ready`.
  2. Viewport sync loop: scroll (passive) → rAF-coalesced `sync()`: `computeViewport` + `visibleCols` → skip when logical window AND subCellPx unchanged (fast path) → `view.requestWindow` → `pool.bindWindow`; spacer height = `panelHeight(...)`; record paint duration → `host.notePaintDuration`.
  3. `onModelUpdated(rowCountChanged)` → `materializer.invalidate()`; if count changed also resize spacer; then `sync()`.
  4. State transitions (`applyColumnState`, sort click, panel drops, `setPivotMode`): compute next GridState → `compileView` → decide scroll resets (group_by changed → scrollTop=0; split_by changed → scrollLeft=0 — Global Constraints) → `host.setConfig` → header.render → `sync()`.
  5. Expand/collapse: delegated click on `.pg-chevron` → resolve meta from `data-row` + current frame; **verify identity** (meta.path) against a fresh `rowMeta` before calling (spec §10 risk) → `await host.expand/collapse(rowIndex)` → `sync()` awaited.
  6. `update(rows)` → `table.update(rows)` (fire-and-forget; push takes over).
  7. `destroy()`: abort listeners, dispose materializer/pool/host/table, clear root.
- [x] **Step 2: Implement `header.ts`.** Two-plus row header when `split_by` present: group rows built from `splitPath(...)` parts with colspan merge of adjacent equal prefixes; measure row shows measure names (index `measureIndex(cfg)`); flat mode = single row of headerName/field. Sort click cycles `desc → asc → none` (spec §5.7), shift = additive. Resize: pointer-drag on a 5px right-edge handle → `onResize` (updates ColDef width in GridState; no view rebuild — pure geometry). Header scrolls horizontally in lockstep via `transform: translateX(-scrollLeft)`.
- [x] **Step 3: Browser smoke.** Minimal `PGrid.tsx`: 5k synthetic rows (id, desk, ccy, mv, px), `rowGroup: desk`, aggFuncs sum/avg, a `setInterval(50)` mutating 100 random rows via `grid.update`. Verify in the browser (dev server + playwright as this session did): groups render with ticking sums **with no refresh code in the page**, expand/collapse works under ticks, sort click re-sorts, scroll is smooth, `destroy` on page switch leaves no console errors.
- [x] **Step 4: Typecheck + commit** — `git commit -m "feat(pgrid): PspGrid orchestrator + header — push-ticking grouped grid"`.

---

### Task 8: Panels — group / pivot / columns (browser-verified)

**Files:**
- Create: `packages/pgrid/src/panels.ts`; modify `grid.ts` (mount panels, handle drops)

**Interfaces:**
- Produces:

```ts
export class Panels {
  constructor(strip: HTMLElement, sidebar: HTMLElement, cb: {
    onGroupChange(fields: string[]): void; onPivotChange(fields: string[]): void;
    onValueChange(cols: { field: string; aggFunc: string }[]): void; onPivotMode(on: boolean): void;
  });
  render(state: GridState): void;   // chips with remove ×; sidebar column list with group/pivot/value toggles
}
```

- [x] **Step 1: Implement.** Group panel + pivot panel as horizontal chip strips (`rowGroupPanelShow/pivotPanelShow: 'always'`); chips removable (×) and reorderable by pointer drag within the strip. Header→panel drag: `Header.onDragStart` starts a pointer capture; a ghost chip follows the pointer; dropping over a strip calls the matching `on*Change`. Sidebar: checkbox list of all columns (visibility phase 2 — checkboxes toggle group/pivot/value membership via three small icon buttons per row; keep it simple). Pivot mode toggle button in the pivot strip.
- [x] **Step 2: Browser verify** on the Task 7 harness: drag `ccy` header into group strip → desk→ccy two-level grouping, aggregates still ticking; drag to pivot strip + pivot mode on → pivoted columns appear with merged headers and tick; remove chips → state unwinds; scroll preserved on sort/filter-only changes, reset correctly on group/pivot changes.
- [x] **Step 3: Typecheck + commit** — `git commit -m "feat(pgrid): group/pivot/columns panels with drag interactions"`.

---

### Task 9: React wrapper + STOMP showcase page (full demo)

**Files:**
- Create: `packages/pgrid/src/react.tsx`
- Modify: `apps/showcase/src/pages/PGrid.tsx` (full version)

**Interfaces:**
- Produces: `export function PspGridReact(props: { options: GridOptions; schema?: Record<string,string>; onReady?(grid: PspGrid): void; className?: string }): JSX.Element` — creates PspGrid in a ref effect, StrictMode-safe (cancellation pattern used by the showcase Perspective pages: guard `cancelled`, dispose created grid when unmounted mid-init), destroys on unmount.

- [ ] **Step 1: Implement wrapper** (React optional peer; the file compiles only when consumed via `pgrid/react`).
- [ ] **Step 2: Full showcase page.** Reuse the showcase's existing STOMP wiring (`connectFiPositions` + the stress page's `flatten`/`buildSchema` helpers — import from a small shared module, extract if needed): 20k rows × union schema into `grid.setSchema` + `grid.load` + `grid.update` per batch. Default state: group by desk, values mv/pnl/dailyPnl sum + px/yield avg; panels on. Status bar: rows, columns, updates applied, feed badge.
- [ ] **Step 3: Browser verify** (the full success criteria, spec §8): grouped aggregates tick with ZERO refresh/polling code; expand under ticks stable; pivot by currency ticks; 372-col horizontal scroll smooth.
- [ ] **Step 4: Typecheck + commit** — `git commit -m "feat(pgrid): React wrapper + STOMP-fed showcase page"`.

---

### Task 10: Bench + results + docs

**Files:**
- Modify: `docs/superpowers/specs/2026-07-11-pgrid-design.md` (results addendum); `packages/pgrid/README.md` (create: usage + Vite config note)

- [ ] **Step 1: Bench** with the session's established methodology (programmatic 3s scroll sweeps sampling rAF deltas + aggregate-tick latency): pgrid page vs `Perspective (FinOS)` viewer page vs `Perspective SSRM` ag-grid page, same feed. Record: scroll p50/p95/worst/dropped both axes at 10k updates/s grouped desk→ccy; tick-to-paint latency (update → changed group cell repaint, via a marked row probe); WASM heap before/after 10 view rebuilds (leak check).
- [ ] **Step 2: Results addendum** table + interpretation in the spec; README with quickstart, Vite `optimizeDeps.exclude` note, and the P2+ roadmap pointer.
- [ ] **Step 3: Final** — `npm run typecheck && npx tsx scripts/pgrid-engine.ts && npx tsx scripts/pgrid-window-math.ts && npx tsx scripts/pgrid-view-compiler.ts && npx tsx scripts/pgrid-view-host.ts && npx tsx scripts/pgrid-materializer.ts`; commit `docs+README`; push.

---

## Self-review notes

- Spec coverage: §2 package (T1), §3 API (T7/T9), §4 modules (T1-T8 map 1:1), §5 engine contract (T4 window/meta/expand, T7 scroll-reset + awaited expand, T3 measureIndex), §6 render plane (T2 percent-scroll, T6 pool/flash CSS, T5 flash gate), §7 push flow (T4 on_update → T7 invalidate→sync, verified T7/T9), §8 testing (per-task scripts + T9 browser + T10 bench), §10 risks (T7 identity re-check, T4 throttle, T10 heap check).
- Type consistency: `Viewport`/`WindowSlice`/`RowMeta`/`CellRender` defined T1/T2, consumed T4-T7 with identical names; `RenderView` defined T5, consumed T6/T7; `notePaintDuration` introduced T4, called T7.
- Deliberate scope cuts vs spec: none — filter UI, editing, selection are already spec non-goals (§1).
