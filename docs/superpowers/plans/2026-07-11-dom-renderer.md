# @tabular/dom Renderer + Canvas Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hot-path-subset DOM renderer (`@tabular/dom`) sharing @tabular/core's compute (RowModel/ColumnModel/worker plane), plus a side-by-side showcase page benchmarking it against the canvas renderer.

**Architecture:** Native scroller + fixed recycled row pool. Each visible row is one absolutely positioned div repositioned with `translate3d`; cells are flat divs bound by `textContent` + class toggles. All sort/filter/group/agg compute comes from core's existing `RowModel` (main mode) and `WorkerCoordinator` (worker mode). Styling is CSS-variable themed classes from an injected stylesheet; tick flash is a CSS animation class, not a JS repaint loop.

**Tech Stack:** TypeScript (strict, raw-TS workspace packages, `main: ./src/index.ts`), no runtime deps beyond `@tabular/core`. Verification: `tsc`, tsx assertion scripts (repo's existing test pattern), browser checks against the vite showcase.

**Spec:** `docs/superpowers/specs/2026-07-11-dom-renderer-design.md`

## Global Constraints

- `@tabular/dom` has exactly one dependency: `"@tabular/core": "*"`.
- No deep imports into another package's `src/` — anything needed from core gets re-exported from `packages/core/src/index.ts` (Task 1).
- No per-cell event listeners; one delegated listener set on the grid root.
- No inline styles for anything expressible as a class; inline style is allowed only for geometry (`transform`, `width`, `left`, `height`).
- All packages must keep `npm run typecheck` green (strict mode; `noUnusedLocals`).
- Out of scope (ignore silently if options are passed): editing, clipboard, master/detail, pivot chrome, floating filters, side bar, pagination, tree data, calc columns, format DSL strings (`ColDef.format`), cell spanning, full-width rows.
- Follow core's code style: JSDoc on exported symbols, comments explain constraints not mechanics.

---

### Task 1: Core re-exports

**Files:**
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: existing core modules (no changes to them).
- Produces (used by every later task):
  - `RowModel<TData>` — `new RowModel(getRowId?: (d: TData) => string)`; members used later: `setRowData(rows)`, `refresh(cols, valueOf, external?, groupOpts?, treeOpts?)`, `applyTransaction(tx): CellChange[]`, `displayedNodes: DisplayedNode<TData>[]`, `displayedIds: string[]`, `hasGroupRows: boolean`, `getDisplayedNode(i)`, `getId(row)`, `displayedIndexOf(id)`, `quickFilter`, `filterModel`, `setGroupExpanded(groupId, expanded)`, `applyWorkerModel(output)`, `patchGroupAggregates(updates)`, `dataMirrorActive`, `restoreDataMirror(rows)`.
  - `ColumnModel<TData>` — constructor `(defs, defaultColDef?, columnHeaderHeight?, floatingFilterHeight?, floatingFiltersEnabled?, treeMode?, autoGroupColumnDef?, selectionMode?, selectionColumnDef?)`; members used later: `left/center/right: Region<TData>` (`{ cols, offsets, width }`), `all`, `displayed()`, `getColumn(colId)`, `setViewportWidth(w)`, `totalWidth`, `setSort(colId, sort, additive)`, `sortModel()`, `rowGroupColumns()`.
  - Types: `InternalColumn<TData>`, `Region<TData>`, `CellChange`, `WorkerCoordinator`, `WorkerPipelineConfig`, `WorkerModelOutput`, `GroupAggUpdate`.

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

Before committing, verify each exported name exists with that exact spelling (`grep -n "export interface RowModelOptions" packages/core/src/rowModel.ts`, `grep -n "export interface WorkerCoordinatorHost" packages/core/src/worker/coordinator.ts`, `grep -n "GroupAggUpdate" packages/core/src/worker/protocol.ts`). If a type has a different name in source (e.g. the host interface), use the source's name and update later tasks' imports to match.

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p packages/core`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): re-export compute internals for alternate renderers"
```

---

### Task 2: Package scaffold + viewport window math (TDD)

**Files:**
- Create: `packages/dom/package.json`
- Create: `packages/dom/tsconfig.json`
- Create: `packages/dom/src/window.ts`
- Create: `packages/dom/src/index.ts` (placeholder export, grows in Task 5)
- Create: `scripts/dom-window-math.ts` (test)
- Modify: `package.json` (root — add to typecheck chain)

**Interfaces:**
- Produces:
  - `computeWindow(scrollTop: number, viewportH: number, rowHeight: number, rowCount: number, overscan?: number): { firstRow: number; lastRow: number }`
  - `poolSize(viewportH: number, rowHeight: number, rowCount: number, overscan?: number): number`
  - `poolSlot(rowIndex: number, size: number): number` — stable slot: a row keeps its element while it stays in the window; the slot freed by the row leaving one edge is exactly the slot needed by the row entering the other edge.

- [ ] **Step 1: Scaffold package**

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
  "dependencies": {
    "@tabular/core": "*"
  }
}
```

`packages/dom/tsconfig.json` (copy the shape of `packages/renderers/tsconfig.json`, adjusting the path — verify with `cat packages/renderers/tsconfig.json` and mirror it exactly, including `references` if present).

`packages/dom/src/index.ts`:

```ts
export { computeWindow, poolSize, poolSlot } from './window';
```

Root `package.json` typecheck script: insert `tsc -p packages/dom && ` immediately before `tsc -p packages/react`.

Run `npm install` once so the workspace links `@tabular/dom`.

- [ ] **Step 2: Write the failing test**

`scripts/dom-window-math.ts`:

```ts
import assert from 'node:assert/strict';
import { computeWindow, poolSize, poolSlot } from '../packages/dom/src/window';

// viewport 500px, 20px rows, 100k rows, overscan 8
{
  const w = computeWindow(0, 500, 20, 100_000, 8);
  assert.equal(w.firstRow, 0);
  assert.equal(w.lastRow, 25 + 8 - 1 + 8); // ceil(500/20)=25 visible + trailing overscan; leading clamped
}
{
  const w = computeWindow(10_000, 500, 20, 100_000, 8);
  assert.equal(w.firstRow, 500 - 8);
  assert.equal(w.lastRow, 500 + 24 + 8);
}
{
  // bottom clamp
  const w = computeWindow(100_000 * 20, 500, 20, 100_000, 8);
  assert.ok(w.lastRow === 99_999);
  assert.ok(w.firstRow <= w.lastRow);
}
{
  // tiny model: window never exceeds rowCount
  const w = computeWindow(0, 500, 20, 3, 8);
  assert.equal(w.firstRow, 0);
  assert.equal(w.lastRow, 2);
}
// pool size fixed by viewport, capped by rowCount
assert.equal(poolSize(500, 20, 100_000, 8), 25 + 1 + 16);
assert.equal(poolSize(500, 20, 3, 8), 3);
// slot stability: consecutive windows share slots for overlapping rows
{
  const size = poolSize(500, 20, 100_000, 8);
  for (let r = 492; r <= 533; r++) {
    assert.equal(poolSlot(r, size), poolSlot(r, size)); // deterministic
    assert.ok(poolSlot(r, size) >= 0 && poolSlot(r, size) < size);
  }
  // rows exactly `size` apart share a slot (the recycle invariant)
  assert.equal(poolSlot(500, size), poolSlot(500 + size, size));
  // no two rows inside one window collide
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

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx scripts/dom-window-math.ts`
Expected: FAIL (module has no implementation yet / export missing).

- [ ] **Step 4: Implement `packages/dom/src/window.ts`**

```ts
/**
 * Pure viewport-window math for the recycled row pool. Kept DOM-free so it
 * is testable with a plain tsx script (repo convention — no test framework).
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
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(rowCount - 1, Math.floor(scrollTop / rowHeight) + visible - 1 + overscan);
  return { firstRow: Math.min(first, last), lastRow: last };
}

/**
 * Fixed element count: enough for every window the viewport can produce.
 * +1 covers a partially visible row at each end sharing the viewport.
 */
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
 * Stable slot assignment: row → element. Rows `size` apart share a slot, so
 * when the window advances by one row, exactly one element is rebound (the
 * DOM analog of the canvas scroll blit).
 */
export function poolSlot(rowIndex: number, size: number): number {
  return rowIndex % size;
}
```

If the test's expected numbers disagree with the implementation on edge rows, trust the invariants (no collision inside a window; recycle stability; clamped to rowCount) and fix whichever side is wrong.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx scripts/dom-window-math.ts`
Expected: `dom-window-math OK`

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` — expected exit 0.

```bash
git add packages/dom scripts/dom-window-math.ts package.json package-lock.json
git commit -m "feat(dom): scaffold @tabular/dom with tested viewport window math"
```

---

### Task 3: Stylesheet + theme CSS variables

**Files:**
- Create: `packages/dom/src/styles.ts`
- Modify: `packages/dom/src/index.ts` (add export)

**Interfaces:**
- Consumes: `ResolvedTheme` from `@tabular/core` (already exported).
- Produces:
  - `ensureDomGridStyles(): void` — injects the stylesheet once per document (`<style id="tabular-dom-styles">`; same guard pattern as `ensureOverlayKeyframes` in core's grid.ts).
  - `applyThemeVars(root: HTMLElement, t: ResolvedTheme): void` — writes `--td-*` custom properties onto the grid root.
  - Class name constants: `CLS` object (`root`, `header`, `headerCell`, `scroller`, `spacer`, `layer`, `row`, `cell`, `num`, `group`, `footer`, `selected`, `focusCell`, `flashUp`, `flashDown`, `sortAsc`, `sortDesc`).

- [ ] **Step 1: Implement `styles.ts`**

```ts
import type { ResolvedTheme } from '@tabular/core';

/** Class names for the DOM renderer; every visual state is a class toggle. */
export const CLS = {
  root: 'td-root',
  header: 'td-header',
  headerCell: 'td-hcell',
  scroller: 'td-scroller',
  spacer: 'td-spacer',
  layer: 'td-layer',
  row: 'td-row',
  cell: 'td-cell',
  num: 'td-num',
  group: 'td-group',
  footer: 'td-footer',
  selected: 'td-selected',
  focusCell: 'td-focus',
  flashUp: 'td-flash-up',
  flashDown: 'td-flash-down',
  sortAsc: 'td-sort-asc',
  sortDesc: 'td-sort-desc',
} as const;

/** Map theme tokens to CSS custom properties on the grid root. */
export function applyThemeVars(root: HTMLElement, t: ResolvedTheme): void {
  const v: Record<string, string> = {
    '--td-base': t.base,
    '--td-raised': t.raised,
    '--td-header-bg': t.headerBg,
    '--td-text': t.textPrimary,
    '--td-text-2': t.textSecondary,
    '--td-accent': t.accent,
    '--td-accent-dim': t.accentDim,
    '--td-up': t.up,
    '--td-down': t.down,
    '--td-gridline': t.gridlineColor ?? t.raised,
    '--td-font': t.fontSans,
    '--td-font-mono': t.fontMono,
    '--td-font-size': `${t.fontSize}px`,
    '--td-header-font-size': `${t.headerFontSize}px`,
    '--td-row-h': `${t.rowHeight}px`,
    '--td-header-h': `${t.headerHeight}px`,
    '--td-pad-x': `${t.paddingX}px`,
  };
  for (const [k, val] of Object.entries(v)) root.style.setProperty(k, val);
}
```

**Note:** verify each token name against `packages/core/src/theme.ts` (`ResolvedTheme extends ThemeTokens, DensitySpec`). If a token used above doesn't exist (e.g. `gridlineColor`), check how `renderer.ts`'s `gridlineColor(t)` derives it and inline the same derivation. Do not invent tokens.

Then the stylesheet (same file):

```ts
const STYLE_ID = 'tabular-dom-styles';

/** Inject the renderer stylesheet once per document. */
export function ensureDomGridStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.${CLS.root} { position: relative; height: 100%; display: flex; flex-direction: column;
  background: var(--td-base); color: var(--td-text);
  font: var(--td-font-size) var(--td-font); user-select: none; }
.${CLS.header} { display: flex; flex: none; height: var(--td-header-h);
  background: var(--td-header-bg); border-bottom: 1px solid var(--td-gridline);
  overflow: hidden; position: relative; z-index: 1; }
.${CLS.headerCell} { flex: none; display: flex; align-items: center;
  padding: 0 var(--td-pad-x); font-size: var(--td-header-font-size);
  color: var(--td-text-2); font-weight: 500; cursor: pointer; position: relative;
  border-right: 1px solid var(--td-gridline); }
.${CLS.headerCell}.${CLS.num} { justify-content: flex-end; }
.${CLS.headerCell}.${CLS.sortAsc}::after { content: ' \\2191'; color: var(--td-accent); }
.${CLS.headerCell}.${CLS.sortDesc}::after { content: ' \\2193'; color: var(--td-accent); }
.${CLS.scroller} { flex: 1; overflow: auto; position: relative; }
.${CLS.spacer} { position: absolute; top: 0; left: 0; width: 1px; visibility: hidden; }
.${CLS.layer} { position: absolute; top: 0; left: 0; right: 0; }
.${CLS.row} { position: absolute; left: 0; width: 100%; height: var(--td-row-h);
  border-bottom: 1px solid var(--td-gridline); will-change: transform; contain: strict; }
.${CLS.row}[data-odd="1"] { background: var(--td-raised); }
.${CLS.row}.${CLS.group} { background: color-mix(in srgb, var(--td-accent-dim) 8%, transparent); font-weight: 500; }
.${CLS.row}.${CLS.footer} { background: color-mix(in srgb, var(--td-accent-dim) 14%, transparent); color: var(--td-text-2); }
.${CLS.row}.${CLS.selected} { background: color-mix(in srgb, var(--td-accent-dim) 18%, var(--td-base)); }
.${CLS.cell} { position: absolute; top: 0; height: 100%; display: flex; align-items: center;
  padding: 0 var(--td-pad-x); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.${CLS.cell}.${CLS.num} { justify-content: flex-end;
  font-family: var(--td-font-mono); font-variant-numeric: tabular-nums; }
.${CLS.cell}.${CLS.focusCell} { outline: 1px solid var(--td-accent); outline-offset: -1px; }
@keyframes td-flash-up { 0% { background: color-mix(in srgb, var(--td-up) 22%, transparent); }
  15% { background: color-mix(in srgb, var(--td-up) 22%, transparent); } 100% { background: transparent; } }
@keyframes td-flash-down { 0% { background: color-mix(in srgb, var(--td-down) 22%, transparent); }
  15% { background: color-mix(in srgb, var(--td-down) 22%, transparent); } 100% { background: transparent; } }
.${CLS.cell}.${CLS.flashUp} { animation: td-flash-up 590ms ease-out; }
.${CLS.cell}.${CLS.flashDown} { animation: td-flash-down 590ms ease-out; }
`;
  document.head.appendChild(style);
}
```

Add to `packages/dom/src/index.ts`: `export { CLS, ensureDomGridStyles, applyThemeVars } from './styles';`

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc -p packages/dom` — expected exit 0 (fix any theme-token type errors by checking `theme.ts`, not by casting).

```bash
git add packages/dom/src
git commit -m "feat(dom): stylesheet + theme CSS variables"
```

---

### Task 4: Row pool

**Files:**
- Create: `packages/dom/src/rowPool.ts`
- Modify: `packages/dom/src/index.ts` (add export)

**Interfaces:**
- Consumes: `CLS` from `./styles`; `poolSlot` from `./window`; types `InternalColumn`, `DisplayedNode` from `@tabular/core`.
- Produces:

```ts
export interface BindContext<TData> {
  cols: InternalColumn<TData>[];          // ColumnModel.displayed()
  colLeft: (i: number) => number;         // absolute x of column i
  format: (node: DisplayedNode<TData>, col: InternalColumn<TData>, rowIndex: number) => string;
  cellClass: (node: DisplayedNode<TData>, col: InternalColumn<TData>) => string; // extra classes ('' if none)
  isSelected: (node: DisplayedNode<TData>) => boolean;
  focused: { rowIndex: number; colId: string } | null;
  groupIndent: number;
  rowHeight: number;
}
export class RowPool<TData> {
  constructor(layer: HTMLElement);
  setSize(size: number, colCount: number): void;   // (re)build row divs + cell divs
  bindRow(rowIndex: number, node: DisplayedNode<TData> | undefined, ctx: BindContext<TData>): void;
  bindWindow(firstRow: number, lastRow: number, getNode: (i: number) => DisplayedNode<TData> | undefined, ctx: BindContext<TData>): void;
  rebindVisibleCell(rowIndex: number, colId: string, ctx: BindContext<TData>, getNode: (i: number) => DisplayedNode<TData> | undefined, flashDir?: 1 | -1 | 0): boolean;
  clear(): void;
}
```

- [ ] **Step 1: Implement `rowPool.ts`**

Core logic (complete — adjust only if a name from Task 1/2/3 differs):

```ts
import type { DisplayedNode, InternalColumn } from '@tabular/core';
import { CLS } from './styles';
import { poolSlot } from './window';

interface Slot<TData> {
  el: HTMLDivElement;
  cells: HTMLDivElement[];
  boundRow: number;            // -1 when unbound
  boundNode: DisplayedNode<TData> | null;
}

export class RowPool<TData> {
  private slots: Slot<TData>[] = [];
  private size = 0;
  constructor(private readonly layer: HTMLElement) {}

  setSize(size: number, colCount: number): void {
    // Rebuild wholesale on size/column-shape change; this happens on layout
    // changes, never during scroll.
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
      this.slots.push({ el, cells, boundRow: -1, boundNode: null });
    }
  }

  bindRow(rowIndex: number, node: DisplayedNode<TData> | undefined, ctx: BindContext<TData>): void {
    const slot = this.slots[poolSlot(rowIndex, this.size)];
    if (!slot) return;
    if (!node) {
      if (slot.boundRow === rowIndex) { slot.el.style.display = 'none'; slot.boundRow = -1; slot.boundNode = null; }
      return;
    }
    const rebindAll = slot.boundRow !== rowIndex || slot.boundNode !== node;
    slot.el.style.display = '';
    slot.el.style.transform = `translate3d(0, ${rowIndex * ctx.rowHeight}px, 0)`;
    slot.el.dataset.row = String(rowIndex);
    slot.el.dataset.odd = rowIndex % 2 === 1 ? '1' : '0';
    // Row-level state classes.
    slot.el.classList.toggle(CLS.group, !!node.group && !node.footer);
    slot.el.classList.toggle(CLS.footer, node.footer === true);
    slot.el.classList.toggle(CLS.selected, ctx.isSelected(node));
    if (rebindAll) {
      for (let c = 0; c < ctx.cols.length; c++) this.bindCell(slot, c, rowIndex, node, ctx);
      slot.boundRow = rowIndex;
      slot.boundNode = node;
    } else {
      // Same row/node (e.g. selection/focus change): refresh state classes only.
      for (let c = 0; c < ctx.cols.length; c++) {
        const col = ctx.cols[c];
        slot.cells[c]?.classList.toggle(
          CLS.focusCell,
          ctx.focused?.rowIndex === rowIndex && ctx.focused.colId === col.colId,
        );
      }
    }
  }

  private bindCell(slot: Slot<TData>, c: number, rowIndex: number, node: DisplayedNode<TData>, ctx: BindContext<TData>): void {
    const col = ctx.cols[c];
    const cell = slot.cells[c];
    if (!col || !cell) return;
    cell.style.left = `${ctx.colLeft(c)}px`;
    cell.style.width = `${col.width}px`;
    const isNum = col.def.type === 'number';
    const extra = ctx.cellClass(node, col);
    cell.className = `${CLS.cell}${isNum ? ` ${CLS.num}` : ''}${extra ? ` ${extra}` : ''}`;
    cell.classList.toggle(
      CLS.focusCell,
      ctx.focused?.rowIndex === rowIndex && ctx.focused.colId === col.colId,
    );
    // Group indent on the first visible column of group rows.
    cell.style.paddingLeft = node.group && c === 0
      ? `${node.level * ctx.groupIndent + 20}px`
      : '';
    const text = ctx.format(node, col, rowIndex);
    if (cell.textContent !== text) cell.textContent = text;
  }

  bindWindow(firstRow: number, lastRow: number, getNode: (i: number) => DisplayedNode<TData> | undefined, ctx: BindContext<TData>): void {
    for (let r = firstRow; r <= lastRow; r++) this.bindRow(r, getNode(r), ctx);
    // Hide any slot still bound outside the window (jump scroll / shrink).
    for (const slot of this.slots) {
      if (slot.boundRow !== -1 && (slot.boundRow < firstRow || slot.boundRow > lastRow)) {
        slot.el.style.display = 'none';
        slot.boundRow = -1;
        slot.boundNode = null;
      }
    }
  }

  rebindVisibleCell(rowIndex: number, colId: string, ctx: BindContext<TData>, getNode: (i: number) => DisplayedNode<TData> | undefined, flashDir: 1 | -1 | 0 = 0): boolean {
    const slot = this.slots[poolSlot(rowIndex, this.size)];
    if (!slot || slot.boundRow !== rowIndex) return false;
    const node = getNode(rowIndex);
    if (!node) return false;
    const c = ctx.cols.findIndex((x) => x.colId === colId);
    if (c < 0) return false;
    this.bindCell(slot, c, rowIndex, node, ctx);
    slot.boundNode = node;
    if (flashDir !== 0) {
      const cell = slot.cells[c]!;
      const cls = flashDir > 0 ? CLS.flashUp : CLS.flashDown;
      // Retrigger the CSS animation even if the class is already present.
      cell.classList.remove(CLS.flashUp, CLS.flashDown);
      void cell.offsetWidth;
      cell.classList.add(cls);
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

Add `export { RowPool } from './rowPool'; export type { BindContext } from './rowPool';` to index.ts.

**Known cost note for the implementer:** `bindRow` on an unchanged row is a handful of `classList.toggle` calls; the full-rebind path runs only when `boundRow`/`boundNode` changed. Don't "optimize" by skipping state-class refresh — selection changes rely on it.

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc -p packages/dom` — expected exit 0.

```bash
git add packages/dom/src
git commit -m "feat(dom): recycled row pool with per-cell binding and CSS flash"
```

---

### Task 5: TabularDom main class (main-thread mode)

**Files:**
- Create: `packages/dom/src/domGrid.ts`
- Modify: `packages/dom/src/index.ts`

**Interfaces:**
- Consumes: everything above, plus from `@tabular/core`: `RowModel`, `ColumnModel`, `resolveTheme`, types `GridOptions`, `AnyColDef`, `DisplayedNode`, `InternalColumn`, `CellChange`.
- Produces:

```ts
export class TabularDom<TData = unknown> {
  constructor(root: HTMLElement, options: GridOptions<TData>);
  readonly scrollerElement: HTMLElement;       // bench drives scrollTop on this
  setRowData(rows: TData[]): void;
  applyTransactionAsync(tx: { add?: TData[]; update?: TData[]; remove?: TData[] }): void;
  refreshModel(): void;                        // re-run filter/sort/group + full rebind
  destroy(): void;
}
```

- [ ] **Step 1: Implement `domGrid.ts`**

Responsibilities and exact behavior (implementer writes the class following this contract; all building blocks exist from prior tasks):

1. **Construction.** `ensureDomGridStyles()`; `resolveTheme(options.theme, options.density)` — check `resolveTheme`'s real signature in `packages/core/src/theme.ts:117` and call it the way `grid.ts` does (grep `resolveTheme(` in grid.ts). `applyThemeVars(root, theme)`. Build DOM: `root.classList.add(CLS.root)` → header div + scroller div (+`spacer`, +`layer`). Instantiate `ColumnModel` exactly as `grid.ts:365-375` does (same argument order; pass `options.columnDefs`, `options.defaultColDef`, theme header height; leave floating filters/tree/selection defaults). Instantiate `RowModel` as `grid.ts:376` does. `rows.quickFilter`/`filterModel` from options if present.
2. **valueOf.** Local helper, mirroring core semantics for the subset: `col.def.valueGetter?.({ data: row }) ?? row[col.def.field]` with dot-path support copied from how `grid.ts` reads fields (grep `split('.')` in grid.ts; reuse the same fallback: dotted paths read nested, missing → undefined).
3. **format.** `col.def.valueFormatter?.({ value, data }) ?? (value == null ? '' : String(value))`. For group auto-column cells use `node.key` + ` (${node.childCount})`; for footer rows `Total ${node.key}`; for aggregated cells on group rows read `node.aggData[col.colId] ?? node.aggData[col.def.field]` — verify which key `grid.ts` uses for aggData lookup (grep `aggData[` in grid.ts/renderer.ts) and use the same.
4. **refreshModel.** Call `this.rows.refresh(this.cols, this.valueOf, undefined, groupOpts, null)` where `groupOpts` mirrors the construction in `grid.ts`'s `refreshModel` (find it: grep `groupOpts` in grid.ts; copy the fields relevant to the subset: groupCols from `cols.rowGroupColumns()`, aggCols from columns with `def.aggFunc`, `groupDefaultExpanded`, `groupTotalRow`, `grandTotalRow`; omit tree/master options). Then `syncViewport(true)`.
5. **Layout & scroll.** `ResizeObserver` on root → recompute `viewWidth/viewHeight`, `cols.setViewportWidth(viewWidth)`, `poolSize(...)`, `pool.setSize(size, cols.displayed().length)`, spacer height = `rows.displayedNodes.length * rowH` (cap at 15_000_000 like core's `MAX_SPACER_HEIGHT`; below the cap scrollRatio is 1 — the subset does not implement ratio scrolling, and the bench dataset stays under the cap: 100k × 20px = 2M px). Scroll listener (passive) → rAF-coalesced `syncViewport(false)`.
6. **syncViewport(full: boolean).** `computeWindow(scroller.scrollTop, viewHeight, rowH, rows.displayedNodes.length)`; if `full`, `pool.bindWindow(first, last, …)`; else bind only rows not already bound (RowPool.bindRow is idempotent-cheap, so calling `bindWindow` every frame is acceptable — measure before optimizing further). Header: rebuild header cells only when column set/sort changed (keep a simple `headerDirty` flag).
7. **Horizontal.** Cells are absolutely positioned at `colLeft(i) = cols.left.width-relative offsets` — for the subset, treat all columns as one region (`cols.displayed()` with `region.offsets`-equivalent computed by accumulating widths; pinned columns out of scope). Row width = `cols.totalWidth`; the scroller scrolls horizontally natively because the layer width exceeds the viewport (set `layer.style.width = totalWidth + 'px'`).
8. **Sort.** Delegated `click` on header: find `data-col-id`, cycle `null→'asc'→'desc'→null` via `cols.setSort(colId, next, e.shiftKey)`, then `refreshModel()`. Toggle `CLS.sortAsc/sortDesc` on header cells from `col.sort`.
9. **Selection/focus.** Delegated `mousedown` on scroller: resolve `data-row` from the row element and column from `e.offsetX`-independent approach — put `data-col-id` on each cell at bind time is too costly; instead compute column from `e.clientX - layerRect.left + scrollLeft` against accumulated offsets (binary search). Toggle selection set (single-click select row, ctrl/cmd toggles), track `focused`, then `syncViewport(true)` (cheap: pool-size bound).
10. **Transactions.** `applyTransactionAsync(tx)`: coalesce into a pending batch flushed on a 60ms timer (mirror the batching the canvas grid does — grep `txTimer` in grid.ts and copy the flush interval). On flush: `const changes = rows.applyTransaction(batch)`. If the transaction was update-only: for each `CellChange` (`{ rowId, colId, dir }` — check the real shape at `rowModel.ts:38`) call `pool.rebindVisibleCell(rows.displayedIndexOf(rowId), colId, ctx, getNode, dir)`; skip rows returning -1 (not displayed). If adds/removes present: `refreshModel()`.
11. **destroy().** Disconnect RO, cancel rAF, clear timer, `pool.clear()`, remove listeners (use one `AbortController` for all listeners — pass `{ signal }` to every `addEventListener`), `root.innerHTML = ''`, remove root class.

Export from index.ts: `export { TabularDom } from './domGrid';`

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck` — expected exit 0.

- [ ] **Step 3: Browser smoke test**

Add a temporary block to any existing showcase page? No — go straight to the real page: create the minimal version of the comparison page now (Task 7 fleshes it out): `apps/showcase/src/pages/DomVsCanvas.tsx` with just the DOM grid, 100k generated rows, one numeric column formatted. Register in `App.tsx` `PAGES` as `{ id: 'domvs', label: 'DOM vs Canvas', component: DomVsCanvasPage }`. Run `npm run dev:showcase`, open the page, verify: rows render, scrolling works end-to-end (top → bottom → jump), sort by header click works, no console errors. Fix until true.

- [ ] **Step 4: Commit**

```bash
git add packages/dom/src apps/showcase/src
git commit -m "feat(dom): TabularDom main-thread renderer (virtualized pool, sort, selection, ticks)"
```

---

### Task 6: Worker data-plane feed

**Files:**
- Create: `packages/dom/src/workerFeed.ts`
- Modify: `packages/dom/src/domGrid.ts` (wire coordinator when `rowDataMode !== 'main'`)

**Interfaces:**
- Consumes: `WorkerCoordinator`, `WorkerCoordinatorHost`, `WorkerPipelineConfig` from core (Task 1); `RowModel.applyWorkerModel`, `patchGroupAggregates`.
- Produces: `buildWorkerConfig(cols: ColumnModel<TData>, rows: RowModel<TData>, options: GridOptions<TData>): WorkerPipelineConfig | null` — null means ineligible → stay on main-thread compute.

- [ ] **Step 1: Implement `buildWorkerConfig`**

Mirror the mapping in `grid.ts`'s `workerDataPlaneConfig()` (locate: grep `workerDataPlaneConfig` in grid.ts, read the whole function) but **only** for the subset: filterCols/sortCols from displayed columns with plain `field`s; sortModel from `cols.sortModel()`; filterModel/quickFilterTerms from RowModel state; groupCols from `cols.rowGroupColumns()`; aggCols from columns with a built-in string `aggFunc`; `calcCols: []`, no pivot, no tree. Return `null` (ineligible) when any displayed column has `valueGetter`, `comparator`, a function `aggFunc`, or when `options.isExternalFilterPresent` is set — same bail conditions grid.ts uses, minus the features the subset doesn't support.

- [ ] **Step 2: Wire the coordinator in `domGrid.ts`**

Construct `new WorkerCoordinator(host)` with a host whose members map to TabularDom (copy the shape from `grid.ts:379-411`; `updateStatusBar`/`onRulesResult`/`syncWorkerRulesConfig` are no-ops, `workerOwnsRowData` false, `enableCellFlash` from options, `applyWorkerModel: (o) => { this.rows.applyWorkerModel(o); this.syncViewport(true); }`, `flashCellChange: (c) => this.flashFromChange(c)`, `fallbackToMain: () => { this.rowDataMode = 'main'; this.refreshModel(); }`). In `refreshModel()`: when mode is worker and `buildWorkerConfig` returns non-null, call `this.workerCoord.syncDataPlane(config, ids, rows)` exactly as `grid.ts:2483` does (read the surrounding 30 lines to copy the ids/rows arguments correctly); otherwise run the main-thread path from Task 5. In the transaction flush: when the worker is active, also `this.workerCoord.forwardTransaction(...)` — copy the payload construction from grid.ts's `workerTransactionPayload` (grep it; the subset needs only add/update/remove arrays and ids).

- [ ] **Step 3: Browser verification**

On the DomVsCanvas page set the DOM grid to worker mode (default). In DevTools → Sources confirm a `dataWorker` is running; sort a column and confirm order changes; check console for `[tabular]` fallback warnings (none expected). Then force `rowDataMode:'main'` and confirm identical rendering (spot-check first 5 rows for equal text).

- [ ] **Step 4: Typecheck + commit**

```bash
git add packages/dom/src
git commit -m "feat(dom): worker data-plane feed via shared WorkerCoordinator"
```

---

### Task 7: Comparison page + bench API

**Files:**
- Modify: `apps/showcase/src/pages/DomVsCanvas.tsx` (full version)
- Modify: `apps/showcase/package.json` (add `"@tabular/dom": "*"` dependency; run `npm install`)

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

Layout: two panels side by side (CSS flex, 50% each, full height), left = canvas `<TabularGrid>` (from `@tabular/react`), right = `TabularDom` mounted in a ref div via `useEffect` (create once, destroy on unmount — StrictMode-safe: symmetric create/destroy). Both get: the same generated dataset (60k rows × 14 cols: id, name, group + 11 numeric metrics; module-level `makeRows()` so both grids share one array), same `columnDefs` (numeric cols `type:'number'` with the same `valueFormatter: (p) => p.value.toFixed(2)` — explicit formatter so both renderers run identical format code), same theme/density, `rowDataMode` from a page-level toggle (buttons: "worker / main", applied to both, remount on change). Tick generator: one `setInterval(16ms)` building a batch of N random-row updates (2 numeric fields each), calling `applyTransactionAsync` on **both** grids with the same batch; rate slider (0 / 1k / 5k / 20k updates/s). Controls row shows current fps per side (rAF counter chips).

`scroll()` implementation: drive `scrollTop += pxPerFrame` per rAF on that grid's scroller (`document.querySelector` the canvas grid's scroller inside its root vs `domGrid.scrollerElement`), collect frame deltas, return percentiles — same math as the session's `__bench_scroll`.

`tickLatency()`: for n samples: `const t0 = performance.now(); applyTransactionAsync(single-cell update); await double-rAF; push(performance.now() - t0)` per side, ticks paused during the run.

- [ ] **Step 2: Verify in browser**

`npm run dev:showcase` → DOM vs Canvas page: both grids render identically (eyeball first 20 rows), both scroll smoothly, ticks flash on both sides at 5k/s without console errors. Run `window.__benchDomVsCanvas.canvas.scroll()` and `.dom.scroll()` from DevTools; both return numbers.

- [ ] **Step 3: Commit**

```bash
git add apps/showcase package.json package-lock.json
git commit -m "feat(showcase): DOM vs Canvas side-by-side comparison page with bench API"
```

---

### Task 8: Measure, record, push

**Files:**
- Modify: `docs/superpowers/specs/2026-07-11-dom-renderer-design.md` (results addendum)

- [ ] **Step 1: Run the three scenarios**

Using chrome-devtools MCP (or manually): (a) normal Chrome, (b) `cpuThrottlingRate: 6`, (c) OpenFin (`npm run openfin:showcase`, drive via CDP port 9092 as done earlier this session). For each: `scroll()` and `tickLatency()` on both sides, ticks at 5k/s, note numbers.

- [ ] **Step 2: Append results table to the spec**

Markdown table: scenario × renderer × {scroll p50/p90, avgFps, tick p50/p95}. One short paragraph of interpretation (which renderer wins where, by how much).

- [ ] **Step 3: Full verification + push**

Run: `npm run typecheck` (exit 0), `npx tsx scripts/dom-window-math.ts` (OK), screenshots of the page in both throttle states saved to `.shots/`.

```bash
git add docs .shots
git commit -m "docs: DOM vs canvas benchmark results"
git push origin main
```

---

## Self-review notes

- Spec coverage: package/API (T2,T5), pool renderer (T4,T5), styling/theme parity (T3), shared compute main+worker (T5,T6), comparison page + bench (T7), scenarios + results (T8), destroy/error handling (T5 §11, T6 fallback). Selection/focus display (T5 §9), flash (T3/T4), group display (T4 bindCell + T5 format §3).
- Deliberate deviations from spec: none in scope; ratio-scrolling for >15M px content is explicitly bounded out in T5 §5 (bench dataset stays under the cap) — spec's "reuse spacer/scroll-ratio math" is satisfied by the cap + documented limit.
- Names verified against source this session: `RowModel` members (rowModel.ts), `ColumnModel` constructor/members (columnModel.ts:114, 849), `WorkerCoordinator(host)` (coordinator.ts:84, grid.ts:379), `WorkerPipelineConfig` (protocol.ts:117), `resolveTheme` export (index.ts:65). Task 1 Step 1 double-checks the two type names not directly read (`RowModelOptions`, `WorkerCoordinatorHost`).
