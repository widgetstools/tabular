# @tabular/dom Renderer + Canvas Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hot-path-subset DOM renderer (`@tabular/dom`) where the worker performs ALL data-plane work — filter/sort/group/agg AND formatting AND style computation — and the UI thread only stamps precomputed text + class ids; plus a side-by-side showcase page benchmarking it against the canvas renderer.

**Architecture:** Native scroller + fixed recycled row pool bound from a `RenderView` — an interface over *precomputed* cells (`{text, styleClass}`). Two materializers implement it: a worker materializer (render-window protocol: worker ships formatted text + style-id arrays + pre-rendered tick deltas) and a main-thread fallback (same interface, computed synchronously — used when JS-callback options make columns worker-ineligible). Styling is CSS-variable themed classes; the worker's deduped style table maps to generated CSS classes registered once per table version. Tick flash is a CSS animation class.

**Tech Stack:** TypeScript (strict, raw-TS workspace packages, `main: ./src/index.ts`), no runtime deps beyond `@tabular/core`. Verification: `tsc`, tsx assertion scripts (repo's existing test pattern), browser checks against the vite showcase.

**Spec:** `docs/superpowers/specs/2026-07-11-dom-renderer-design.md` (see "Compute (shared) + render plane (worker-materialized)")

## Global Constraints

- `@tabular/dom` has exactly one dependency: `"@tabular/core": "*"`.
- No deep imports into another package's `src/` — anything needed from core gets re-exported from `packages/core/src/index.ts`.
- **UI thread never formats, resolves styles, or evaluates expressions when the worker is active.** Binding = `textContent` + class swaps + geometry only.
- Worker-eligible render config is declarative only: `ColDef.format` (format DSL), `type: 'number'` default formatting, rules (@tabular/rules). JS callbacks (`valueFormatter`, function `cellStyle`, `valueGetter`) force the main-thread materializer (log one dev warning naming the column).
- Render messages carry `modelRevision`; the UI drops responses/deltas older than the last applied revision.
- No per-cell event listeners; one delegated listener set on the grid root.
- No inline styles for anything expressible as a class; inline style only for geometry (`transform`, `width`, `left`, `paddingLeft`) plus pool `display` show/hide toggles; `data-row`/`data-odd` attributes are the sanctioned non-class state (zebra CSS + hit-testing read them).
- Style table capped at 1024 ids; on overflow evict LRU and `console.warn` once.
- All packages keep `npm run typecheck` green.
- Out of scope (ignore silently): editing, clipboard, master/detail, pivot chrome, floating filters, side bar, pagination, tree data, calc columns, cell spanning, full-width rows.
- New worker protocol messages are **additive** — do not change the shape or behavior of existing messages (the current dataOnly/pendingTx issues are tracked separately; don't entangle).
- Follow core's code style: JSDoc on exported symbols; comments explain constraints, not mechanics.

---

### Task 1: Core re-exports

**Files:**
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces (used by every later task):
  - `RowModel<TData>` — `new RowModel(getRowId?)`; used members: `setRowData`, `refresh(cols, valueOf, external?, groupOpts?, treeOpts?)`, `applyTransaction(tx): CellChange[]`, `displayedNodes`, `displayedIds`, `hasGroupRows`, `getDisplayedNode(i)`, `getId(row)`, `displayedIndexOf(id)`, `quickFilter`, `filterModel`, `setGroupExpanded`, `applyWorkerModel(output)`, `patchGroupAggregates(updates)`, `dataMirrorActive`, `restoreDataMirror(rows)`.
  - `ColumnModel<TData>` — constructor `(defs, defaultColDef?, columnHeaderHeight?, floatingFilterHeight?, floatingFiltersEnabled?, treeMode?, autoGroupColumnDef?, selectionMode?, selectionColumnDef?)`; used members: `all`, `displayed()`, `getColumn(colId)`, `setViewportWidth(w)`, `totalWidth`, `setSort(colId, sort, additive)` (columnModel.ts:849), `sortModel()`, `rowGroupColumns()`.
  - Types/classes: `InternalColumn`, `Region`, `CellChange`, `WorkerCoordinator`, `WorkerCoordinatorHost`, `WorkerPipelineConfig`, `WorkerModelOutput`, `GroupAggUpdate`, `DisplayedNode` (already exported).

- [ ] **Step 1: Add re-exports**

Append to `packages/core/src/index.ts`:

```ts
// Internal building blocks re-exported for alternate renderers (@tabular/dom).
// The canvas Tabular remains the primary API; these are the compute layer.
export { RowModel } from './rowModel';
export type { CellChange, RowModelOptions } from './rowModel';
export { ColumnModel } from './columnModel';
export type { InternalColumn, Region } from './columnModel';
export { WorkerCoordinator } from './worker/coordinator';
export type { WorkerCoordinatorHost } from './worker/coordinator';
export type {
  WorkerPipelineConfig,
  WorkerModelOutput,
  GroupAggUpdate,
} from './worker/protocol';
```

Verify each name exists with that exact spelling (`grep -n "RowModelOptions" packages/core/src/rowModel.ts`, `grep -n "WorkerCoordinatorHost" packages/core/src/worker/coordinator.ts`, `grep -n "GroupAggUpdate" packages/core/src/worker/protocol.ts`). If a source name differs, use the source's name and keep later tasks' imports consistent.

- [ ] **Step 2: Typecheck** — `npx tsc -p packages/core`, exit 0.
- [ ] **Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): re-export compute internals for alternate renderers"
```

---

### Task 2: Package scaffold + viewport window math (TDD)

**Files:**
- Create: `packages/dom/package.json`, `packages/dom/tsconfig.json`, `packages/dom/src/window.ts`, `packages/dom/src/index.ts`
- Create: `scripts/dom-window-math.ts` (test)
- Modify: root `package.json` (typecheck chain)

**Interfaces:**
- Produces:
  - `computeWindow(scrollTop, viewportH, rowHeight, rowCount, overscan=8): { firstRow; lastRow }`
  - `poolSize(viewportH, rowHeight, rowCount, overscan=8): number`
  - `poolSlot(rowIndex, size): number` — rows `size` apart share a slot (recycle invariant).

- [ ] **Step 1: Scaffold**

`packages/dom/package.json`:

```json
{
  "name": "@tabular/dom",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "sideEffects": false,
  "dependencies": { "@tabular/core": "*" }
}
```

`packages/dom/tsconfig.json`: mirror `packages/renderers/tsconfig.json` exactly (check with `cat`), adjusting only paths/references. `src/index.ts`: `export { computeWindow, poolSize, poolSlot } from './window';`. Root typecheck script: insert `tsc -p packages/dom && ` before `tsc -p packages/react`. Run `npm install`.

- [ ] **Step 2: Write the failing test** — `scripts/dom-window-math.ts`:

```ts
import assert from 'node:assert/strict';
import { computeWindow, poolSize, poolSlot } from '../packages/dom/src/window';

{
  const w = computeWindow(0, 500, 20, 100_000, 8);
  assert.equal(w.firstRow, 0);
  assert.equal(w.lastRow, 25 - 1 + 8); // leading overscan clamped at 0
}
{
  const w = computeWindow(10_000, 500, 20, 100_000, 8);
  assert.equal(w.firstRow, 500 - 8);
  assert.equal(w.lastRow, 500 + 24 + 8);
}
{
  const w = computeWindow(100_000 * 20, 500, 20, 100_000, 8);
  assert.equal(w.lastRow, 99_999);
  assert.ok(w.firstRow <= w.lastRow);
}
{
  const w = computeWindow(0, 500, 20, 3, 8);
  assert.equal(w.firstRow, 0);
  assert.equal(w.lastRow, 2);
}
assert.equal(poolSize(500, 20, 100_000, 8), 25 + 1 + 16);
assert.equal(poolSize(500, 20, 3, 8), 3);
{
  const size = poolSize(500, 20, 100_000, 8);
  assert.equal(poolSlot(500, size), poolSlot(500 + size, size));
  const seen = new Set<number>();
  const w = computeWindow(10_000, 500, 20, 100_000, 8);
  for (let r = w.firstRow; r <= w.lastRow; r++) {
    const s = poolSlot(r, size);
    assert.ok(!seen.has(s), `slot collision at row ${r}`);
    seen.add(s);
  }
}
console.log('dom-window-math OK');
```

- [ ] **Step 3: Run — expect FAIL** — `npx tsx scripts/dom-window-math.ts` (no implementation yet).
- [ ] **Step 4: Implement `packages/dom/src/window.ts`**

```ts
/**
 * Pure viewport-window math for the recycled row pool. DOM-free so it is
 * testable with a plain tsx script (repo convention — no test framework).
 */

export interface ViewportWindow {
  firstRow: number;
  lastRow: number;
}

/** Rows the pool must currently display, including overscan on both edges. */
export function computeWindow(
  scrollTop: number,
  viewportH: number,
  rowHeight: number,
  rowCount: number,
  overscan = 8,
): ViewportWindow {
  if (rowCount <= 0) return { firstRow: 0, lastRow: -1 };
  const visible = Math.ceil(viewportH / rowHeight);
  const anchor = Math.floor(scrollTop / rowHeight);
  const first = Math.max(0, anchor - overscan);
  const last = Math.min(rowCount - 1, anchor + visible - 1 + overscan);
  return { firstRow: Math.min(first, last), lastRow: last };
}

/** Fixed element count covering every window the viewport can produce. */
export function poolSize(
  viewportH: number,
  rowHeight: number,
  rowCount: number,
  overscan = 8,
): number {
  const visible = Math.ceil(viewportH / rowHeight);
  return Math.max(1, Math.min(rowCount, visible + 1 + overscan * 2));
}

/**
 * Stable slot assignment: rows `size` apart share a slot, so advancing the
 * window by one row rebinds exactly one element (DOM analog of the canvas
 * scroll blit).
 */
export function poolSlot(rowIndex: number, size: number): number {
  return rowIndex % size;
}
```

If the test's exact edge numbers disagree, trust the invariants (no in-window collision, recycle stability, clamping) and fix whichever side is wrong.

- [ ] **Step 5: Run — expect `dom-window-math OK`.**
- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add packages/dom scripts/dom-window-math.ts package.json package-lock.json
git commit -m "feat(dom): scaffold @tabular/dom with tested viewport window math"
```

---

### Task 3: Stylesheet, theme CSS variables, style-table classes

**Files:**
- Create: `packages/dom/src/styles.ts`
- Modify: `packages/dom/src/index.ts`

**Interfaces:**
- Consumes: `ResolvedTheme`, `CellStyle` types from `@tabular/core`.
- Produces:
  - `ensureDomGridStyles(): void` — injects the base stylesheet once (`<style id="tabular-dom-styles">`).
  - `applyThemeVars(root: HTMLElement, t: ResolvedTheme): void` — `--td-*` custom properties.
  - `CLS` constants: `root, header, headerCell, scroller, spacer, layer, row, cell, num, group, footer, selected, focusCell, flashUp, flashDown, sortAsc, sortDesc`.
  - `StyleTable` — registers worker-deduped styles as CSS classes:

```ts
export class StyleTable {
  /** Returns the class name for a style id, '' for id 0 (no style). */
  className(id: number): string;
  /** Replace table contents for a new version; regenerates the <style> rules. */
  setTable(version: number, styles: CellStyle[]): void;
  get version(): number;
  dispose(): void;
}
```

- [ ] **Step 1: Base stylesheet + theme vars**

Implement `CLS`, `applyThemeVars`, `ensureDomGridStyles` exactly as follows (verify every theme token against `packages/core/src/theme.ts` — `ResolvedTheme extends ThemeTokens, DensitySpec`; if a token doesn't exist, derive it the way `renderer.ts` does, e.g. its `gridlineColor(t)` helper — do not invent tokens):

```ts
import type { CellStyle, ResolvedTheme } from '@tabular/core';

export const CLS = {
  root: 'td-root', header: 'td-header', headerCell: 'td-hcell',
  scroller: 'td-scroller', spacer: 'td-spacer', layer: 'td-layer',
  row: 'td-row', cell: 'td-cell', num: 'td-num', group: 'td-group',
  footer: 'td-footer', selected: 'td-selected', focusCell: 'td-focus',
  flashUp: 'td-flash-up', flashDown: 'td-flash-down',
  sortAsc: 'td-sort-asc', sortDesc: 'td-sort-desc',
} as const;

export function applyThemeVars(root: HTMLElement, t: ResolvedTheme): void {
  const v: Record<string, string> = {
    '--td-base': t.base, '--td-raised': t.raised, '--td-header-bg': t.headerBg,
    '--td-text': t.textPrimary, '--td-text-2': t.textSecondary,
    '--td-accent': t.accent, '--td-accent-dim': t.accentDim,
    '--td-up': t.up, '--td-down': t.down,
    '--td-font': t.fontSans, '--td-font-mono': t.fontMono,
    '--td-font-size': `${t.fontSize}px`, '--td-header-font-size': `${t.headerFontSize}px`,
    '--td-row-h': `${t.rowHeight}px`, '--td-header-h': `${t.headerHeight}px`,
    '--td-pad-x': `${t.paddingX}px`,
  };
  for (const [k, val] of Object.entries(v)) root.style.setProperty(k, val);
}
```

Base rules (same file, injected once): copy the stylesheet block below verbatim; `--td-gridline` must be set in `applyThemeVars` using the same derivation `renderer.ts` uses for gridlines.

```css
.td-root { position: relative; height: 100%; display: flex; flex-direction: column;
  background: var(--td-base); color: var(--td-text);
  font: var(--td-font-size) var(--td-font); user-select: none; }
.td-header { display: flex; flex: none; height: var(--td-header-h);
  background: var(--td-header-bg); border-bottom: 1px solid var(--td-gridline);
  overflow: hidden; position: relative; z-index: 1; }
.td-hcell { flex: none; display: flex; align-items: center; padding: 0 var(--td-pad-x);
  font-size: var(--td-header-font-size); color: var(--td-text-2); font-weight: 500;
  cursor: pointer; position: relative; border-right: 1px solid var(--td-gridline); }
.td-hcell.td-num { justify-content: flex-end; }
.td-hcell.td-sort-asc::after { content: ' \2191'; color: var(--td-accent); }
.td-hcell.td-sort-desc::after { content: ' \2193'; color: var(--td-accent); }
.td-scroller { flex: 1; overflow: auto; position: relative; }
.td-spacer { position: absolute; top: 0; left: 0; width: 1px; visibility: hidden; }
.td-layer { position: absolute; top: 0; left: 0; }
.td-row { position: absolute; left: 0; height: var(--td-row-h);
  border-bottom: 1px solid var(--td-gridline); will-change: transform; contain: strict; }
.td-row[data-odd="1"] { background: var(--td-raised); }
.td-row.td-group { background: color-mix(in srgb, var(--td-accent-dim) 8%, transparent); font-weight: 500; }
.td-row.td-footer { background: color-mix(in srgb, var(--td-accent-dim) 14%, transparent); color: var(--td-text-2); }
.td-row.td-selected { background: color-mix(in srgb, var(--td-accent-dim) 18%, var(--td-base)); }
.td-cell { position: absolute; top: 0; height: 100%; display: flex; align-items: center;
  padding: 0 var(--td-pad-x); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.td-cell.td-num { justify-content: flex-end; font-family: var(--td-font-mono);
  font-variant-numeric: tabular-nums; }
.td-cell.td-focus { outline: 1px solid var(--td-accent); outline-offset: -1px; }
@keyframes td-flash-up { 0%,15% { background: color-mix(in srgb, var(--td-up) 22%, transparent); }
  100% { background: transparent; } }
@keyframes td-flash-down { 0%,15% { background: color-mix(in srgb, var(--td-down) 22%, transparent); }
  100% { background: transparent; } }
.td-cell.td-flash-up { animation: td-flash-up 590ms ease-out; }
.td-cell.td-flash-down { animation: td-flash-down 590ms ease-out; }
```

- [ ] **Step 2: StyleTable**

```ts
/**
 * Worker-computed styles arrive as a deduped table; each entry becomes one
 * generated CSS class so per-cell application is a single class token.
 * Id 0 is reserved for "no style".
 */
export class StyleTable {
  private el: HTMLStyleElement;
  private ver = -1;
  private count = 0;
  constructor(private readonly prefix = `tds${Math.floor(Math.random() * 1e6)}`) {
    this.el = document.createElement('style');
    document.head.appendChild(this.el);
  }
  get version(): number { return this.ver; }
  className(id: number): string { return id > 0 && id <= this.count ? `${this.prefix}-${id}` : ''; }
  setTable(version: number, styles: CellStyle[]): void {
    if (version === this.ver) return;
    this.ver = version;
    this.count = styles.length;
    this.el.textContent = styles
      .map((s, i) => `.${this.prefix}-${i + 1} { ${cssOf(s)} }`)
      .join('\n');
  }
  dispose(): void { this.el.remove(); }
}

function cssOf(s: CellStyle): string {
  const out: string[] = [];
  const bg = s.background ?? s.backgroundColor;
  if (bg) out.push(`background:${bg}`);
  if (s.color) out.push(`color:${s.color}`);
  if (s.fontWeight) out.push(`font-weight:${s.fontWeight}`);
  if (s.fontStyle) out.push(`font-style:${s.fontStyle}`);
  return out.join(';');
}
```

Check `CellStyle`'s actual fields in `packages/core/src/types.ts` and extend `cssOf` to cover the fields the rules engine emits (grep the rules package for the style keys it produces — e.g. border may exist; map what exists, ignore the rest).

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc -p packages/dom
git add packages/dom/src
git commit -m "feat(dom): stylesheet, theme CSS vars, worker style-table classes"
```

---

### Task 4: RenderView seam + row pool

**Files:**
- Create: `packages/dom/src/renderView.ts`
- Create: `packages/dom/src/rowPool.ts`
- Modify: `packages/dom/src/index.ts`

**Interfaces:**
- Produces `renderView.ts` (the worker/main seam — later tasks implement it twice):

```ts
/** One precomputed cell: everything the UI needs to stamp it. */
export interface CellRender {
  text: string;
  /** '' or a StyleTable class name; the pool applies it verbatim. */
  styleClass: string;
}
export interface RowMeta {
  id: string;
  kind: 'leaf' | 'group' | 'footer';
  level: number;
  expanded: boolean;
}
/**
 * Read model the pool binds from. Implementations: MainMaterializer (Task 5,
 * synchronous over RowModel) and WorkerMaterializer (Task 7, async over the
 * render-window protocol). cell() may return undefined while data is in
 * flight — the pool leaves the previous content in place (stale-but-correct).
 */
export interface RenderView<TData> {
  rowCount(): number;
  rowMeta(rowIndex: number): RowMeta | undefined;
  cell(rowIndex: number, colIndex: number): CellRender | undefined;
  /** Hint: the pool is about to bind this window; async impls fetch it. */
  requestWindow(firstRow: number, lastRow: number): void;
  /** Fires when new data for the current window arrived (rebind needed). */
  onUpdate(cb: () => void): void;
}
```

- Produces `rowPool.ts`:

```ts
export interface PoolGeometry<TData> {
  cols: InternalColumn<TData>[];   // display order
  colLeft: (i: number) => number;  // accumulated offsets
  rowHeight: number;
  groupIndent: number;
  totalWidth: number;
}
export class RowPool<TData> {
  constructor(layer: HTMLElement);
  setSize(size: number, colCount: number): void;
  bindWindow(firstRow: number, lastRow: number, view: RenderView<TData>, geo: PoolGeometry<TData>, selected: ReadonlySet<string>, focused: { rowIndex: number; colId: string } | null): void;
  rebindCell(rowIndex: number, colIndex: number, view: RenderView<TData>, geo: PoolGeometry<TData>, flashDir: 1 | -1 | 0): boolean;
  clear(): void;
}
```

- [ ] **Step 1: Implement**

`rowPool.ts` core (complete; keep private `Slot { el, cells, boundRow, boundVersion }`):

```ts
import type { InternalColumn } from '@tabular/core';
import { CLS } from './styles';
import { poolSlot } from './window';
import type { RenderView } from './renderView';

interface Slot {
  el: HTMLDivElement;
  cells: HTMLDivElement[];
  boundRow: number; // -1 = unbound
}

export class RowPool<TData> {
  private slots: Slot[] = [];
  private size = 0;
  constructor(private readonly layer: HTMLElement) {}

  setSize(size: number, colCount: number): void {
    this.clear();
    this.size = size;
    for (let s = 0; s < size; s++) {
      const el = document.createElement('div');
      el.className = CLS.row;
      const cells: HTMLDivElement[] = [];
      for (let c = 0; c < colCount; c++) {
        const cell = document.createElement('div');
        cell.className = CLS.cell;
        el.appendChild(cell);
        cells.push(cell);
      }
      this.layer.appendChild(el);
      this.slots.push({ el, cells, boundRow: -1 });
    }
  }

  bindWindow(
    firstRow: number, lastRow: number,
    view: RenderView<TData>, geo: PoolGeometry<TData>,
    selected: ReadonlySet<string>, focused: { rowIndex: number; colId: string } | null,
  ): void {
    view.requestWindow(firstRow, lastRow);
    for (let r = firstRow; r <= lastRow; r++) {
      const slot = this.slots[poolSlot(r, this.size)];
      if (!slot) continue;
      const meta = view.rowMeta(r);
      if (!meta) {
        // Data in flight: keep previous pixels only if this slot still shows
        // a row inside the window; otherwise hide it.
        if (slot.boundRow < firstRow || slot.boundRow > lastRow) {
          slot.el.style.display = 'none';
          slot.boundRow = -1;
        }
        continue;
      }
      slot.el.style.display = '';
      slot.el.style.transform = `translate3d(0, ${r * geo.rowHeight}px, 0)`;
      slot.el.style.width = `${geo.totalWidth}px`;
      slot.el.dataset.row = String(r);
      slot.el.dataset.odd = r % 2 === 1 ? '1' : '0';
      slot.el.classList.toggle(CLS.group, meta.kind === 'group');
      slot.el.classList.toggle(CLS.footer, meta.kind === 'footer');
      slot.el.classList.toggle(CLS.selected, selected.has(meta.id));
      const rebindAll = slot.boundRow !== r;
      for (let c = 0; c < geo.cols.length; c++) {
        this.stampCell(slot, r, c, view, geo, focused, rebindAll);
      }
      slot.boundRow = r;
    }
    for (const slot of this.slots) {
      if (slot.boundRow !== -1 && (slot.boundRow < firstRow || slot.boundRow > lastRow)) {
        slot.el.style.display = 'none';
        slot.boundRow = -1;
      }
    }
  }

  private stampCell(
    slot: Slot, r: number, c: number,
    view: RenderView<TData>, geo: PoolGeometry<TData>,
    focused: { rowIndex: number; colId: string } | null,
    rebindAll: boolean,
  ): void {
    const col = geo.cols[c];
    const cell = slot.cells[c];
    if (!col || !cell) return;
    const focusedHere = focused?.rowIndex === r && focused.colId === col.colId;
    if (!rebindAll) {
      cell.classList.toggle(CLS.focusCell, focusedHere);
      return;
    }
    cell.style.left = `${geo.colLeft(c)}px`;
    cell.style.width = `${col.width}px`;
    const meta = view.rowMeta(r);
    cell.style.paddingLeft = meta?.kind === 'group' && c === 0
      ? `${meta.level * geo.groupIndent + 20}px` : '';
    const cr = view.cell(r, c);
    const isNum = col.def.type === 'number';
    cell.className = `${CLS.cell}${isNum ? ` ${CLS.num}` : ''}${cr?.styleClass ? ` ${cr.styleClass}` : ''}`;
    cell.classList.toggle(CLS.focusCell, focusedHere);
    const text = cr?.text ?? '';
    if (cell.textContent !== text) cell.textContent = text;
  }

  rebindCell(rowIndex: number, colIndex: number, view: RenderView<TData>, geo: PoolGeometry<TData>, flashDir: 1 | -1 | 0): boolean {
    const slot = this.slots[poolSlot(rowIndex, this.size)];
    if (!slot || slot.boundRow !== rowIndex) return false;
    this.stampCell(slot, rowIndex, colIndex, view, geo, null, true);
    if (flashDir !== 0) {
      const cell = slot.cells[colIndex];
      if (cell) {
        cell.classList.remove(CLS.flashUp, CLS.flashDown);
        void cell.offsetWidth; // retrigger the CSS animation
        cell.classList.add(flashDir > 0 ? CLS.flashUp : CLS.flashDown);
      }
    }
    return true;
  }

  clear(): void {
    for (const s of this.slots) s.el.remove();
    this.slots = [];
    this.size = 0;
  }
}
```

Note: `stampCell(..., null, true)` in `rebindCell` clears focus outline on that cell; the grid re-applies focus on the next `bindWindow` — acceptable for tick cells. Export both modules from index.ts.

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc -p packages/dom
git add packages/dom/src
git commit -m "feat(dom): RenderView seam + recycled row pool"
```

---

### Task 5: TabularDom main class + main-thread materializer (fallback mode)

**Files:**
- Create: `packages/dom/src/mainMaterializer.ts`
- Create: `packages/dom/src/domGrid.ts`
- Modify: `packages/dom/src/index.ts`

**Interfaces:**
- Produces:

```ts
export class TabularDom<TData = unknown> {
  constructor(root: HTMLElement, options: GridOptions<TData>);
  readonly scrollerElement: HTMLElement;
  setRowData(rows: TData[]): void;
  applyTransactionAsync(tx: { add?: TData[]; update?: TData[]; remove?: TData[] }): void;
  refreshModel(): void;
  destroy(): void;
}
export class MainMaterializer<TData> implements RenderView<TData> { /* sync over RowModel */ }
```

- [ ] **Step 1: MainMaterializer**

Synchronous `RenderView` over `RowModel` + `ColumnModel`. `rowCount` = `rows.displayedNodes.length`; `rowMeta(r)` maps `DisplayedNode` (`kind`: `footer ? 'footer' : group ? 'group' : 'leaf'`); `cell(r, c)`:
- value: `col.def.valueGetter?.(...) ?? dot-path field read` (copy the dot-path helper semantics from grid.ts — grep `split('.')` there);
- text: group auto-column → `` `${node.key} (${node.childCount})` ``, footer → `` `Total ${node.key}` ``, agg cells on group rows → read `node.aggData` with the same key grid.ts/renderer.ts uses (grep `aggData[`), else `valueFormatter` → format DSL via core's exported `resolveFormat`/`compileFormat` (compile once per column, cache on the materializer) → `String(value)`;
- styleClass: static `col.def.cellStyle` object → registered once per column in a local `StyleTable` (function `cellStyle` = ineligible for worker but fine here: evaluate and stringify through the same table, capped).
`requestWindow` is a no-op; `onUpdate` never fires (sync).

- [ ] **Step 2: TabularDom**

Contract (all building blocks exist):
1. **Construct**: `ensureDomGridStyles()`; resolve theme the way grid.ts does (grep `resolveTheme(` in grid.ts for the exact call); `applyThemeVars`. DOM: root → header div + scroller (spacer + layer). `ColumnModel` as `grid.ts:365-375` (same argument order); `RowModel` as `grid.ts:376`. One `AbortController`; every listener passes `{ signal }`.
2. **refreshModel** (main mode): `rows.refresh(cols, valueOf, undefined, groupOpts, null)` with `groupOpts` mirroring grid.ts's `refreshModel` construction (grep `groupOpts` in grid.ts; subset fields: groupCols, aggCols from `def.aggFunc` string columns, `groupDefaultExpanded`, `groupTotalRow`, `grandTotalRow`). Then layout sync + full `bindWindow`.
3. **Layout**: `ResizeObserver` → viewWidth/Height, `cols.setViewportWidth`, `pool.setSize(poolSize(...), cols.displayed().length)`, spacer height = rowCount × rowH (cap 15_000_000 — bench data stays under it), layer width = `cols.totalWidth`; rebuild header cells (`data-col-id`, `CLS.num` for number cols, sort classes from `col.sort`).
4. **Scroll**: passive listener → rAF-coalesced `syncViewport()`: `computeWindow(...)` → `pool.bindWindow(first, last, view, geo, selectedIds, focused)`.
5. **Sort**: delegated header click → cycle `null→'asc'→'desc'→null` via `cols.setSort(colId, next, e.shiftKey)` → `refreshModel()`.
6. **Selection/focus**: delegated mousedown on scroller → row from `target.closest('[data-row]')`, column by binary-searching accumulated offsets at `e.clientX`; update `selectedIds` (click = single select, ctrl/cmd = toggle) and `focused`; `syncViewport()`.
7. **Group expand/collapse**: delegated click on a group row's first cell → `rows.setGroupExpanded(meta.id, !meta.expanded)` (verify id vs groupId: grep how grid.ts's chevron click resolves the group id and copy it) → `refreshModel()`.
8. **Transactions**: `applyTransactionAsync` coalesces on a 60ms timer (match grid.ts's `txTimer` interval); on flush `rows.applyTransaction(batch)` → update-only: for each `CellChange` (shape at rowModel.ts:38) find `displayedIndexOf(rowId)`, colIndex from colId, `pool.rebindCell(r, c, view, geo, dir)`; add/remove present → `refreshModel()`.
9. **destroy()**: abort controller, disconnect RO, cancel rAF, clear timer, `pool.clear()`, `styleTable.dispose()`, `root.innerHTML=''`, remove root class.

- [ ] **Step 3: Typecheck** — `npm run typecheck`, exit 0.
- [ ] **Step 4: Browser smoke test**

Create the minimal comparison page now (fleshed out in Task 8): `apps/showcase/src/pages/DomVsCanvas.tsx` rendering only `TabularDom` with 60k generated rows (id/name/group + numeric cols using `format: '#,##0.00'`), `rowDataMode:'main'`. Register `{ id: 'domvs', label: 'DOM vs Canvas', component: DomVsCanvasPage }` in App.tsx. Add `"@tabular/dom": "*"` to `apps/showcase/package.json`, `npm install`. Verify in the browser: renders, scrolls end-to-end + jump, sorts on header click, group by adding `rowGroup: true` to the group column works with expand/collapse, no console errors.

- [ ] **Step 5: Commit**

```bash
git add packages/dom/src apps/showcase package.json package-lock.json
git commit -m "feat(dom): TabularDom with main-thread materializer fallback"
```

---

### Task 6: Core render plane (worker materializes text + styles)

**Files:**
- Create: `packages/core/src/worker/renderPlane.ts` (worker-side materializer)
- Modify: `packages/core/src/worker/protocol.ts` (additive messages)
- Modify: `packages/core/src/worker/dataWorker.ts` (handle new messages)
- Modify: `packages/core/src/worker/dataClient.ts` or `coordinator.ts` (client-side send/receive plumbing — follow how existing requests flow; keep the pattern)
- Modify: `packages/core/src/index.ts` (export new types)
- Create: `scripts/dom-render-plane.ts` (test — runs the render materializer directly, no browser)

**Interfaces (additive protocol — exact shapes):**

```ts
/** main → worker: describe how to render cells (set once per config change). */
export interface RenderPlaneConfig {
  /** Display-order columns the renderer shows. */
  cols: Array<{
    colId: string;
    field: string;
    type?: 'number';
    /** Format DSL string (ColDef.format); compiled worker-side. */
    format?: string;
    /** Static style — participates in the style table. */
    cellStyle?: import('../types').CellStyle;
  }>;
  groupIndentColId?: string; // auto-group column id
}
/** main → worker */
export interface RenderWindowRequest {
  type: 'renderWindow';
  firstRow: number;
  lastRow: number;
}
/** worker → main */
export interface RenderWindowResult {
  type: 'renderWindowResult';
  modelRevision: number;
  firstRow: number;
  rowIds: string[];
  rowKind: Uint8Array;      // 0 leaf, 1 group, 2 footer
  rowLevel: Uint8Array;
  rowExpanded: Uint8Array;
  /** rows × cols, row-major. */
  text: string[];
  styleIds: Uint16Array;    // transferable
  styleTableVersion: number;
  /** Present only when the client's known version is stale. */
  styleTable?: import('../types').CellStyle[];
}
/** worker → main, pushed after update transactions. */
export interface RenderDeltas {
  type: 'renderDeltas';
  modelRevision: number;
  deltas: Array<{ rowIndex: number; colIndex: number; text: string; styleId: number; dir: 1 | -1 | 0 }>;
  styleTableVersion: number;
  styleTable?: import('../types').CellStyle[];
}
```

- [ ] **Step 1: Write the failing test**

`scripts/dom-render-plane.ts` — construct the worker-side pipeline directly (import `DataPipeline` the way `scripts/worker-compare.ts` does — copy its setup boilerplate for a small dataset: 100 rows, 3 cols: name, `price` numeric with `format: '#,##0.00'`, `qty` numeric with a rules-style static cellStyle on the config). Then:

```ts
// after pipeline setup + setRowData + rebuildModel:
const plane = new RenderPlane(pipeline, renderConfig);
const win = plane.materialize(0, 9);
assert.equal(win.text.length, 10 * 3);
assert.equal(win.text[0 * 3 + 1], '1,234.50');           // formatted by DSL in "worker"
assert.ok(win.styleIds[0 * 3 + 2] > 0);                    // static style got a table id
assert.equal(win.styleTable![win.styleIds[0 * 3 + 2] - 1].background, '#112233');
// dedupe: same style object → same id on another row
assert.equal(win.styleIds[1 * 3 + 2], win.styleIds[0 * 3 + 2]);
// deltas: apply an update, expect a rendered delta for the visible window
const deltas = plane.deltasFor([{ rowId: 'r1', colId: 'price', dir: 1 }], 0, 9);
assert.equal(deltas[0].text, /* new formatted price */ deltas[0].text);
assert.ok(deltas[0].dir === 1);
console.log('dom-render-plane OK');
```

(Exact assertion values depend on the seeded data — set row r0's price to 1234.5 and both r0/r1's qty style to `{ background: '#112233' }` so the numbers above are literal.)

- [ ] **Step 2: Run — expect FAIL** (`RenderPlane` doesn't exist).

- [ ] **Step 3: Implement `renderPlane.ts`**

`RenderPlane` wraps the worker-side model (whatever `DataPipeline` exposes as the displayed rows — read `packages/core/src/worker/pipeline.ts` to find the displayed output the worker holds after rebuild; `scripts/worker-compare.ts` shows how to read it). Responsibilities:
- compile `format` DSL per column once (`compileFormat` from `@tabular/format` — core already depends on it);
- `materialize(first, last)`: walk displayed entries, produce the flat arrays; group rows: text for `groupIndentColId` = `` `${key} (${childCount})` ``, agg columns read the entry's `aggData`; footer rows `Total ${key}`;
- style table: `Map<styleKey, id>` where styleKey = JSON.stringify of the effective style (static col style; rules styles when worker rules are active — read how `onRulesResult`/worker rules store per-cell styles in the worker and reuse that map if present; if worker rules aren't wired in the current tree, cover static styles only and leave a `// rules styles: wired when worker rules land on this path` note); cap 1024, LRU evict, bump `styleTableVersion` whenever contents change;
- `deltasFor(changes, first, last)`: for changes whose row is displayed within `[first,last]`, produce rendered deltas.

Wire into `dataWorker.ts`: handle `setRenderConfig`, `renderWindow` (respond with `renderWindowResult`, transferring `styleIds.buffer`), and after update-transaction application push `renderDeltas` for the last-requested window. Keep every existing message untouched. Client side: add matching send/receive in the same file that owns the existing request/response plumbing (`dataClient.ts` — follow the pattern of the existing viewport-chunk request; grep `chunk` there).

- [ ] **Step 4: Run — expect `dom-render-plane OK`.** Also `npx tsc -p packages/core` exit 0.

- [ ] **Step 5: Export types + commit**

Add to core index: `export type { RenderPlaneConfig, RenderWindowResult, RenderDeltas } from './worker/protocol';`

```bash
git add packages/core/src scripts/dom-render-plane.ts
git commit -m "feat(core): worker render plane — materialized text + style-table ids per viewport window"
```

---

### Task 7: Worker materializer in @tabular/dom

**Files:**
- Create: `packages/dom/src/workerMaterializer.ts`
- Create: `packages/dom/src/workerFeed.ts`
- Modify: `packages/dom/src/domGrid.ts`

**Interfaces:**
- Consumes: Task 6 protocol; `WorkerCoordinator` host pattern from `grid.ts:379-411`; `StyleTable` (Task 3).
- Produces: `WorkerMaterializer<TData> implements RenderView<TData>`; `buildWorkerConfig(cols, rows, options): WorkerPipelineConfig | null`; `buildRenderConfig(cols): RenderPlaneConfig | null` (null when any column is render-ineligible: function `valueFormatter`/`cellStyle`/`valueGetter` — one dev warning naming the first offending column).

- [ ] **Step 1: buildWorkerConfig + buildRenderConfig**

`buildWorkerConfig`: mirror grid.ts's `workerDataPlaneConfig()` mapping (grep it; read the whole function) for the subset only — filterCols/sortCols from plain-field displayed columns, sortModel from `cols.sortModel()`, filterModel/quickFilterTerms from RowModel state, groupCols from `cols.rowGroupColumns()`, aggCols from string `aggFunc` columns, `calcCols: []`, no pivot/tree. Same bail conditions grid.ts uses (valueGetter/comparator/function agg → null).

- [ ] **Step 2: WorkerMaterializer**

Holds the last `RenderWindowResult` + `StyleTable`. `rowCount()` from the model output length (coordinator's applyWorkerModel keeps RowModel in sync — reuse `rows.displayedNodes.length`); `rowMeta/cell` read the cached window (return `undefined` outside it); `requestWindow(first,last)` sends `renderWindow` (coalesced: skip if same range in flight; always re-request after a `modelUpdated`); on `renderWindowResult`: drop if `modelRevision` older than last applied; `styleTable` present → `styleTable.setTable(version, styles)`; cache arrays; fire `onUpdate`. On `renderDeltas`: same revision check; for each delta call the grid's `onRenderDelta(rowIndex, colIndex, text, styleClass, dir)` (grid forwards to `pool.rebindCell` — the materializer also patches its cached window arrays so a subsequent bindWindow stays consistent).

- [ ] **Step 3: Wire into TabularDom**

`rowDataMode !== 'main'` and both configs non-null → construct `WorkerCoordinator` with a host copied from `grid.ts:379-411` shape (`updateStatusBar`/`onRulesResult`/`syncWorkerRulesConfig` no-ops; `workerOwnsRowData` false; `applyWorkerModel: (o) => { rows.applyWorkerModel(o); workerMat.invalidate(); syncViewport(); }`; `fallbackToMain: () => { mode='main'; view=mainMat; refreshModel(); }`), call `syncDataPlane(config, ids, rows)` as `grid.ts:2483` does (read surrounding lines for the exact args), send `setRenderConfig`, and set `view = workerMaterializer`. Transactions: forward via `workerCoord.forwardTransaction(payload)` copying grid.ts's `workerTransactionPayload` construction; visible-cell updates then arrive as `renderDeltas` (do NOT also rebind locally from `CellChange`s in worker mode — single source).

- [ ] **Step 4: Browser verification**

DomVsCanvas page, DOM grid in worker mode: DevTools shows the data worker; **UI-thread proof**: in DevTools take a 5s Performance profile while ticking at 5k updates/s — confirm no `compileFormat`/format/rules frames on the main thread (only pool binding); sort/expand work; kill the worker in DevTools → grid falls back to main mode and keeps rendering (one warning).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add packages/dom/src
git commit -m "feat(dom): worker materializer — UI thread stamps precomputed text and style ids"
```

---

### Task 8: Comparison page + bench API

**Files:**
- Modify: `apps/showcase/src/pages/DomVsCanvas.tsx` (full version)

**Interfaces:**
- Produces `window.__benchDomVsCanvas`:

```ts
interface BenchSide {
  scroll(durationMs?: number, pxPerFrame?: number): Promise<{ frames: number; p50: number; p90: number; p99: number; avgFps: number }>;
  tickLatency(nSamples?: number): Promise<{ p50: number; p95: number }>;
}
interface BenchApi { canvas: BenchSide; dom: BenchSide; setTickRate(perSec: number): void; }
```

- [ ] **Step 1: Build the page**

Two flex panels (50% each, full height): left canvas `<TabularGrid>` (@tabular/react), right `TabularDom` in a ref div (create in `useEffect`, destroy on cleanup — StrictMode-safe). Shared module-level dataset: 60k rows (id, name, group, 11 numeric metrics), same `columnDefs` for both — numeric columns use `type:'number'` + `format: '#,##0.00'` (DSL, worker-eligible; NO valueFormatter functions), group column `rowGroup: true` behind a "grouped" toggle. Same theme/density. `rowDataMode` toggle (worker/main) applied to both grids (remount). Tick generator: one `setInterval(16)` building batches of random-row updates (2 numeric fields), applied to **both** grids via `applyTransactionAsync`; rate control 0/1k/5k/20k updates/s; per-side rAF fps chips.

`scroll()`: drive `scrollTop += pxPerFrame` per rAF on that side's scroller (canvas: query the scrollable div inside the canvas grid root, as `window.__bench_scroll` did this session; dom: `grid.scrollerElement`), collect frame deltas, return percentiles. `tickLatency()`: pause ticks; per sample `t0 = performance.now(); applyTransactionAsync(single-cell update); await double-rAF; sample = now - t0`.

- [ ] **Step 2: Verify in browser**

Both sides render identical first-20-rows text; ticks flash both sides at 5k/s; both bench functions return numbers; worker/main toggle works on both; no console errors in either mode.

- [ ] **Step 3: Commit**

```bash
git add apps/showcase
git commit -m "feat(showcase): DOM vs Canvas side-by-side comparison page with bench API"
```

---

### Task 9: Measure, record, push

**Files:**
- Modify: `docs/superpowers/specs/2026-07-11-dom-renderer-design.md` (results addendum)

- [ ] **Step 1: Run the scenarios** — chrome-devtools MCP or manual: (a) normal Chrome, (b) `cpuThrottlingRate: 6`, (c) OpenFin (`npm run openfin:showcase`, CDP on :9092 as done this session). Each: `scroll()` + `tickLatency()` per side, ticks at 5k/s, DOM grid in worker mode (canvas in its default worker data plane).
- [ ] **Step 2: Append results table** — scenario × renderer × {scroll p50/p90/avgFps, tick p50/p95} + a short interpretation paragraph.
- [ ] **Step 3: Full verification + push**

```bash
npm run typecheck && npx tsx scripts/dom-window-math.ts && npx tsx scripts/dom-render-plane.ts
git add docs .shots
git commit -m "docs: DOM vs canvas benchmark results"
git push origin main
```

---

## Self-review notes

- Spec coverage: render plane worker-side (T6), UI stamps only (T4 pool + T7 materializer + global constraint), style table → classes (T3 StyleTable, T6 dedupe/cap), tick deltas (T6/T7), revision guards (T6/T7), eligibility + main fallback via same seam (T5/T7), shared compute (T1), bench page + scenarios (T8/T9), destroy/error handling (T5 §9, T7 fallback).
- Names verified against source this session: RowModel/ColumnModel members, `setSort` (columnModel.ts:849), `WorkerCoordinator(host)` (coordinator.ts:84; host shape grid.ts:379-411), `syncDataPlane` call site (grid.ts:2483), `WorkerPipelineConfig` (protocol.ts:117). Task 1 double-checks the two names not directly read (`RowModelOptions`, `WorkerCoordinatorHost`).
- Known dependency: Task 6 touches `pipeline.ts`/`dataWorker.ts`, which carry unrelated WIP issues (pendingTx drop, dataOnly agg gap) — the render plane is strictly additive; implementers must not refactor those paths in passing.
