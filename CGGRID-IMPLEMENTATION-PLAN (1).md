# cggrid — Canvas-Based AG Grid Clone: Implementation Plan

A vanilla-TypeScript, canvas-first data grid engine targeting AG Grid API/behavior parity, engineered for fixed-income blotters: 250 columns, 100k+ rows, high-frequency tick updates.

---

## 0. Design Principles

1. **Canvas for the hot path, DOM for structure.** The scrollable cell viewport is a layered `<canvas>` stack. Chrome (menus, dialogs, floating filters, tool panel) is DOM. Cell editors are DOM overlays mounted transiently over the canvas.
2. **API compatibility, not source compatibility.** Mirror AG Grid's `GridOptions`, `ColDef`, `GridApi`, `ColumnApi`, and event surface so existing configs and integration code port with minimal change. Internally the implementation is unrelated.
3. **Immutable row model contracts, mutable render state.** Row data flows through a row model (client-side, infinite, server-side, viewport). Rendering reads a derived, mutable `RenderState`.
4. **Dirty-rect layered repaint.** Never clear-and-redraw the whole canvas. Track dirty regions per layer; repaint only invalidated tiles.
5. **Zero per-frame allocation on the tick path.** Object pools for cell paint descriptors; prefix-sum arrays for offsets; typed arrays for hot numeric state.

---

## 1. Object Model & Public API Surface

### 1.1 Core configuration types (AG Grid parity)

```ts
interface GridOptions<TData = any> {
  columnDefs: (ColDef<TData> | ColGroupDef<TData>)[];
  rowData?: TData[] | null;
  defaultColDef?: ColDef<TData>;
  rowModelType?: 'clientSide' | 'infinite' | 'serverSide' | 'viewport';
  // pagination
  pagination?: boolean;
  paginationPageSize?: number;
  // selection
  rowSelection?: 'single' | 'multiple';
  suppressRowClickSelection?: boolean;
  // grouping / pivot / aggregation
  groupDefaultExpanded?: number;
  autoGroupColumnDef?: ColDef<TData>;
  pivotMode?: boolean;
  // editing
  editType?: 'fullRow' | undefined;
  singleClickEdit?: boolean;
  stopEditingWhenCellsLoseFocus?: boolean;
  // rendering
  rowHeight?: number;
  headerHeight?: number;
  rowBuffer?: number;
  // callbacks (full event map, see 1.4)
  onGridReady?: (e: GridReadyEvent) => void;
  getRowId?: (params: GetRowIdParams<TData>) => string;
  // ...~200 more options
}

interface ColDef<TData = any> {
  field?: string;
  colId?: string;
  headerName?: string;
  width?: number; minWidth?: number; maxWidth?: number; flex?: number;
  pinned?: 'left' | 'right' | boolean | null;
  hide?: boolean;
  sortable?: boolean; sort?: 'asc' | 'desc' | null; sortIndex?: number;
  resizable?: boolean;
  editable?: boolean | ((p: EditableCallbackParams) => boolean);
  cellEditor?: string | CellEditorComp;
  cellRenderer?: string | CellRendererComp;
  valueGetter?: (p: ValueGetterParams) => any;
  valueFormatter?: (p: ValueFormatterParams) => string;
  valueSetter?: (p: ValueSetterParams) => boolean;
  cellStyle?: CellStyle | ((p) => CellStyle);
  cellClassRules?: { [css: string]: (p) => boolean };
  filter?: string | boolean | FilterComp;
  floatingFilter?: boolean;
  aggFunc?: string | ((p) => any);
  rowGroup?: boolean; rowGroupIndex?: number;
  pivot?: boolean; pivotIndex?: number;
  enableRowGroup?: boolean; enablePivot?: boolean; enableValue?: boolean;
  headerCheckboxSelection?: boolean; checkboxSelection?: boolean;
  // ...
}
```

### 1.2 GridApi (behavioral parity — key methods)

```ts
class GridApi<TData = any> {
  // data
  setGridOption<K>(key: K, value: GridOptions[K]): void;
  applyTransaction(tx: RowDataTransaction): RowNodeTransaction;
  applyTransactionAsync(tx, cb?): void;
  setRowData(rows: TData[]): void; // legacy
  getRowNode(id: string): IRowNode | undefined;
  forEachNode(cb): void; forEachNodeAfterFilterAndSort(cb): void;
  // rendering / refresh
  refreshCells(params?: RefreshCellsParams): void;
  redrawRows(params?: RedrawRowsParams): void;
  refreshHeader(): void;
  // selection
  selectAll(): void; deselectAll(): void;
  getSelectedRows(): TData[]; getSelectedNodes(): IRowNode[];
  setNodesSelected(params): void;
  // editing
  startEditingCell(params): void; stopEditing(cancel?: boolean): void;
  getEditingCells(): CellPosition[];
  // navigation / focus
  setFocusedCell(row, col): void; getFocusedCell(): CellPosition | null;
  ensureIndexVisible(index, position?): void;
  ensureColumnVisible(colKey, position?): void;
  // scrolling
  getVerticalPixelRange(): { top: number; bottom: number };
  getHorizontalPixelRange(): { left: number; right: number };
  // clipboard / export
  copySelectedRangeToClipboard(params?): void;
  exportDataAsCsv(params?): string;
  exportDataAsExcel(params?): void;
  // columns (or a separate ColumnApi in older API)
  getColumnState(): ColumnState[]; applyColumnState(params): boolean;
  setColumnsVisible(keys, visible): void;
  moveColumns(keys, toIndex): void;
  autoSizeColumns(keys, skipHeader?): void;
  sizeColumnsToFit(params?): void;
  // column groups (see §1.5)
  getColumnGroup(name: string, instanceId?: number): ColumnGroup | null;
  getProvidedColumnGroup(name: string): ProvidedColumnGroup | null;
  getDisplayedColGroups(): ColumnGroup[];
  getLeftDisplayedColGroups(): ColumnGroup[];
  getCenterDisplayedColGroups(): ColumnGroup[];
  getRightDisplayedColGroups(): ColumnGroup[];
  getColumnGroupState(): { groupId: string; open: boolean }[];
  setColumnGroupState(state: { groupId: string; open: boolean }[]): void;
  resetColumnGroupState(): void;
  setColumnGroupOpened(group: ProvidedColumnGroup | string, open: boolean): void;
  // EXTENSION beyond AG Grid parity — see §1.5.6
  addColumnGroup?(def: ColGroupDef, atIndex?: number): void;
  removeColumnGroup?(groupId: string, keepChildren?: boolean): void;
  // filter
  setFilterModel(model): void; getFilterModel(): FilterModel;
  getColumnFilterInstance(colKey): Promise<IFilterComp>;
  onFilterChanged(): void;
  // grouping / pivot
  expandAll(): void; collapseAll(): void;
  setRowGroupColumns(keys): void;
  // overlays
  showLoadingOverlay(): void; showNoRowsOverlay(): void; hideOverlay(): void;
  // ~300 methods total
}
```

### 1.3 RowNode / IRowNode model

```ts
interface IRowNode<TData = any> {
  id?: string;
  data?: TData;
  rowIndex: number | null;
  displayed: boolean;
  level: number;              // group depth
  group: boolean;
  expanded: boolean;
  parent: IRowNode | null;
  childrenAfterGroup?: IRowNode[];
  childrenAfterFilter?: IRowNode[];
  childrenAfterSort?: IRowNode[];
  allLeafChildren?: IRowNode[];
  aggData?: any;              // aggregated values for group rows
  key?: string | null;        // group key
  rowPinned?: 'top' | 'bottom' | null;
  selected?: boolean;
  rowHeight?: number;
  setDataValue(colKey, newValue): void;
  setExpanded(expanded: boolean): void;
  setSelected(selected, clearSelection?): void;
  // event dispatch on mutation
}
```

### 1.4 Event surface

Full AG Grid event map, dispatched through a typed `EventService`:
`gridReady`, `firstDataRendered`, `modelUpdated`, `cellClicked`, `cellDoubleClicked`, `cellContextMenu`, `cellValueChanged`, `cellEditingStarted`, `cellEditingStopped`, `rowClicked`, `rowSelected`, `selectionChanged`, `sortChanged`, `filterChanged`, `filterModified`, `columnMoved`, `columnResized`, `columnVisible`, `columnPinned`, `columnGroupOpened`, `rowGroupOpened`, `paginationChanged`, `bodyScroll`, `bodyScrollEnd`, `viewportChanged`, `rangeSelectionChanged`, `pasteStart`, `pasteEnd`, `dragStarted`, `dragStopped`, etc.

### 1.5 Column Group Model

Column groups are the one place where AG Grid's public API and its internal model diverge sharply, and getting this wrong makes the header canvas unimplementable. The plan previously referenced `ColGroupDef` without defining it; this section is the contract.

#### 1.5.1 The definition type

```ts
interface ColGroupDef<TData = any> {
  groupId?: string;                                    // stable identity; auto-generated if omitted
  headerName?: string;
  children: (ColDef<TData> | ColGroupDef<TData>)[];    // RECURSIVE — groups nest arbitrarily
  openByDefault?: boolean;
  marryChildren?: boolean;        // children cannot be separated by moves or pinning
  suppressStickyLabel?: boolean;  // don't pin the label while scrolling a wide group
  columnGroupShow?: 'open' | 'closed';  // this group's visibility within its PARENT group
  headerClass?: string | string[] | ((p) => string | string[]);
  headerGroupComponent?: string | HeaderGroupComp;     // DOM escape hatch
  headerGroupComponentParams?: any;
  tooltipComponent?: ...; toolPanelClass?: ...;
  suppressColumnsToolPanel?: boolean; suppressFiltersToolPanel?: boolean;
}
```

`columnGroupShow` on a **child `ColDef`** controls whether that column is visible when its parent group is open, closed, or always. `columnGroupShow` on a **nested `ColGroupDef`** does the same for the whole subgroup. The default (`undefined`) means "always visible."

#### 1.5.2 The two-tier model — `ProvidedColumnGroup` vs `ColumnGroup`

**This is the design's load-bearing distinction.** A group as *declared* is not a group as *rendered*.

```ts
// One per ColGroupDef. The definition, instantiated once. Owns open/closed state.
interface ProvidedColumnGroup {
  groupId: string;
  colGroupDef: ColGroupDef | null;
  children: (Column | ProvidedColumnGroup)[];  // the declared tree
  level: number;
  expandable: boolean;   // true iff any child has columnGroupShow set
  expanded: boolean;     // THE open/closed state — single source of truth
  padding: boolean;      // synthetic filler for depth alignment (see 1.5.4)
}

// One per (ProvidedColumnGroup × pinned region × contiguous run). Ephemeral, rebuilt on layout.
interface ColumnGroup {
  groupId: string;
  instanceId: number;             // disambiguates the split instances
  providedColumnGroup: ProvidedColumnGroup;   // shared parent
  displayedChildren: (Column | ColumnGroup)[];  // only what's visible, in THIS region
  pinned: 'left' | 'right' | null;
  parent: ColumnGroup | null;
  // computed layout
  left: number; width: number;    // x-offset and span WITHIN its region
}
```

Why the split exists: **a group can be rendered more than once.** If a group has five children and the trader pins two of them left, AG Grid draws the group header twice — once above the two pinned columns, once above the three in the body. Both instances share one `ProvidedColumnGroup` (so opening either opens both), but each is a separate `ColumnGroup` with its own `left`, `width`, and `instanceId`.

For cggrid this is not an abstraction; it is the header canvas layout algorithm. §2.1's three canvases mean **each region independently walks the `ColumnGroup` tree scoped to itself**, painting group headers at region-local x-offsets. `getColumnGroup(id, instanceId?)` returns a specific instance; omitting `instanceId` returns the first.

`marryChildren: true` forbids the split: children cannot be moved out of the group, and pinning one child pins the whole group. Enforced in the move/pin reducers, not at paint time.

#### 1.5.3 The column tree pipeline

```
columnDefs (ColDef | ColGroupDef)[]
 → [balanceTree]      insert `padding` ProvidedColumnGroups so all leaves sit at equal depth
 → [buildProvidedTree] ProvidedColumnGroup tree + Column leaves; assign groupIds; seed `expanded`
 → [applyGroupState]   restore open/closed from columnGroupState
 → [resolveVisibility] apply columnGroupShow × expanded → displayed leaf set
 → [partitionByPin]    split displayed leaves into left | center | right
 → [buildColumnGroups] per region: walk contiguous runs → ColumnGroup instances (instanceId++)
 → [layout]            per region: prefix-sum widths → ColumnGroup.left/.width, headerRowCount
```

`buildColumnGroups` re-runs on any move, pin, resize, visibility, or group open/close. `buildProvidedTree` re-runs only on `columnDefs` replacement — which is why open/closed state survives everything short of a full column-def swap.

#### 1.5.4 Padding groups and header depth

If one column sits at depth 0 and another at depth 2, the header has ragged rows. `balanceTree` inserts synthetic `padding: true` `ProvidedColumnGroup`s above shallow leaves until all leaves are at `maxDepth`. Padding groups render as empty header cells — no label, no border, `surface.raised` — so the header row grid stays rectangular.

Consequence: **`headerRowCount = maxGroupDepth + 1`** (group rows + the leaf column row), `+1` again if `floatingFilter` is enabled. §7.3's flat `headerHeight` is insufficient — corrected in §1.5.5.

#### 1.5.5 Header height math (supersedes the flat `headerHeight` in §7.3)

```ts
totalHeaderHeight =
    (maxGroupDepth * groupHeaderHeight)   // one row per group level
  + columnHeaderHeight                     // the leaf row
  + (floatingFilter ? floatingFilterHeight : 0);
```

Per density (`groupHeaderHeight = round(columnHeaderHeight * 0.7)`, per §7.4's "groups recede"):

| | Comfortable | Compact | Dense |
|---|---|---|---|
| `columnHeaderHeight` | 40px | 34px | 28px |
| `groupHeaderHeight` | 28px | 24px | 20px |
| `floatingFilterHeight` | 32px | 26px | 20px |

A 3-deep group hierarchy at comfortable density with floating filters: `3×28 + 40 + 32 = 156px` of header. That is a quarter of a laptop viewport, and it is why **`maxGroupDepth` should be soft-capped at 3** with a dev-mode warning beyond it. AG Grid's `groupHeaderHeight`, `headerHeight`, and `floatingFiltersHeight` options map directly onto these.

#### 1.5.6 Runtime mutation — parity vs. extension

**AG Grid parity: groups are immutable at runtime.** There is no `addColumnGroup()`. To change grouping you rebuild `columnDefs` and call `setGridOption('columnDefs', newDefs)`, which re-runs `buildProvidedTree` and discards open/closed state for any group whose `groupId` changed. Only `setColumnGroupOpened` / `setColumnGroupState` mutate a group at runtime, and they mutate *state*, not *structure*.

**cggrid extension (explicitly beyond parity, marked optional in `GridApi`):** `addColumnGroup(def, atIndex?)` and `removeColumnGroup(groupId, keepChildren?)`. The blotter use case is real — a trader assembling an ad-hoc "Risk" group from scattered columns, or the tool panel offering drag-to-group. Implementation is a surgical splice into the `ProvidedColumnGroup` tree followed by `resolveVisibility` onward, preserving sibling open state.

**Decision required.** This is a fork in the API contract and should be made deliberately, not drifted into:

- *Ship it.* Genuine blotter value; the tool panel becomes far more useful; cost is a non-portable API surface and a `columnDefs` round-trip that no longer reproduces the live state (a serialized `columnDefs` won't contain the ad-hoc group unless `getColumnDefs()` is extended to synthesize it).
- *Don't.* Strict parity; ad-hoc grouping is achieved by the host app rebuilding `columnDefs`, which is what AG Grid users already do. Zero new surface.
- *Recommendation:* **defer to Phase 8, ship parity first.** Model the tree so the splice is possible (`ProvidedColumnGroup.children` is already mutable), but do not expose the methods until the parity suite is green. Mark them optional (`?:`) in the interface so their absence is type-legal.

#### 1.5.7 Interaction & rendering notes

- **Open/close** is a click on the group header's expand glyph (`◂`/`▸` at the label's trailing edge), present only when `expandable`. Toggling sets `ProvidedColumnGroup.expanded`, which re-runs `resolveVisibility` → `buildColumnGroups` → `layout`, and fires `columnGroupOpened`. Both split instances update, because both point at the same provided group. Full header invalidate + body invalidate (column offsets moved); one frame, not animated.
- **Dragging a group header** moves all its displayed children as a block (respecting `marryChildren` for the non-displayed ones).
- **Sticky group labels:** when a group is wider than the viewport, its label pins to the left edge of its visible span rather than scrolling off — the trader must always know which group they're under. Disabled by `suppressStickyLabel`. The label's paint x is `max(group.left, viewport.left) + padding`, clamped to `group.left + group.width - labelWidth`.
- **`ColumnGroup` instances are rebuilt, not diffed.** They are ephemeral layout objects; pool them (§5) to avoid per-frame allocation on resize drags.
- Group headers are `text.tertiary` with a hairline bracket spanning their children (§7.4). Padding groups paint nothing.

---

## 2. Rendering Architecture

### 2.1 Canvas layer stack

Composited DOM-positioned `<canvas>` elements (single-context per layer), plus DOM overlay:

```
┌─ container (DOM, position:relative) ───────────────┐
│  header-canvas        (sticky top, own ctx)        │
│  ┌─ viewport (DOM, overflow:hidden) ──────────────┐│
│  │  pinned-left-canvas   body-canvas   pinned-right││
│  │  (frozen)             (scrolls)     (frozen)    ││
│  │  overlay-layer (selection/focus/range, own ctx) ││
│  │  editor-mount (DOM, transient inputs)           ││
│  └─────────────────────────────────────────────────┘│
│  pinned-top-canvas  / pinned-bottom-canvas          │
│  horizontal-scrollbar (native or synthetic)         │
└─────────────────────────────────────────────────────┘
```

Rationale: separate canvases for pinned regions avoid per-cell clip/translate churn and let each region be invalidated independently. The overlay layer holds ephemeral chrome (focus ring, selection wash, range fill) so cell repaints don't disturb it and vice versa.

### 2.2 Viewport & virtualization

- **Vertical:** compute `firstVisibleRow`/`lastVisibleRow` via binary search over a **prefix-sum row-offset array** (supports variable row heights). Render `rowBuffer` extra rows above/below.
- **Punch-out rows.** Detail rows, full-width rows, and auto-height cells make row height dynamic and mutable *after* layout. The offset array must therefore support **O(k) suffix rewrite** on a single row-height change (k = rows after the mutation), or — for 100k rows with frequent expand/collapse — a **Fenwick tree (BIT)** giving O(log n) update and O(log n) prefix query at the cost of a slower initial build. Design decision: build the flat `Float64Array` prefix-sum for the static case, and switch to the Fenwick backing when `masterDetail || detailRowAutoHeight || any(colDef.autoHeight)` is enabled. Both expose the same `offsetOf(rowIndex)` / `rowAtY(y)` interface so the viewport code is unaware. See §4.15.
- **Horizontal:** same prefix-sum approach over column widths; only paint columns intersecting the horizontal pixel range.
- **Scroll model:** a tall/wide **spacer element** in a native-overflow container drives scroll; `scroll` events update a scroll offset and schedule a repaint via `requestAnimationFrame`. Canvas is redrawn at the new offset (no DOM node per row). Optionally a synthetic scrollbar for pixel-perfect control and to decouple from browser scroll anchoring.

### 2.3 Dirty-rect repaint pipeline

```
invalidate(region | cell | row | col | 'all')
   → accumulate dirty rects per layer (merge overlapping)
   → schedule rAF flush (coalesce multiple invalidations per frame)
flush(frameTime):
   for each layer with dirty rects:
      ctx.save(); clip to merged dirty region
      repaint only intersecting cells via paint(ctx, RenderState)
      ctx.restore()
   swap overlay if focus/selection changed
```

### 2.4 Renderer model

```ts
interface RenderState {
  ctx: CanvasRenderingContext2D;
  x: number; y: number; width: number; height: number; // cell rect (device px)
  value: any; formattedValue: string;
  rowNode: IRowNode; column: Column;
  theme: ResolvedTheme; dpr: number;
  selected: boolean; focused: boolean; rangeSelected: boolean;
  editing: boolean;
}

interface CellRenderer {
  paint(ctx: CanvasRenderingContext2D, s: RenderState): void;
  // optional hit regions for interactive renderers (checkbox, group toggle, link)
  hitTest?(localX: number, localY: number, s: RenderState): HitRegion | null;
}
```

Built-in renderers: `TextRenderer`, `NumberRenderer` (right-aligned, locale/format), `CheckboxRenderer`, `GroupCellRenderer` (indent + expand chevron + agg value), `AgGroupCellRenderer` parity, `LoadingCellRenderer`, `AnimateShowChangeRenderer` / `AnimateSlideRenderer` (flash on tick — critical for blotters), sparkline renderer.

Custom renderers: support (a) canvas `paint()` for hot cells, and (b) a **DOM-renderer escape hatch** that mounts an absolutely-positioned DOM node over the cell for rich/interactive content, reconciled on scroll. Framework component renderers (React) route through the DOM escape hatch.

### 2.5 Text & DPR handling

- Scale backing store by `devicePixelRatio`; set CSS size separately. Re-scale on DPR change (monitor moves).
- Cache text metrics (`measureText`) per (font, string) with an LRU; cache column-level truncation/ellipsis decisions.
- Pre-resolve fonts (`document.fonts.ready`) before first paint to avoid reflow-free but wrong metrics.
- Baseline: `textBaseline = 'middle'`, vertical center at `y + rowHeight/2`.

---

## 3. Row Models

Implement the four AG Grid row models behind a common `IRowModel` interface so the rest of the engine is agnostic.

### 3.1 ClientSideRowModel (pipeline)

Deterministic stage pipeline, each stage memoized and re-run only from its invalidation point:

```
rowData
 → [filterStage]          (quick filter + column filters)
 → [sortStage]            (multi-column, stable, comparator per col)
 → [groupStage]           (build group hierarchy from rowGroup cols)
 → [aggregationStage]     (bottom-up agg incl. weighted-avg for yield/spread)
 → [pivotStage]           (pivot columns + secondary col generation)
 → [flattenStage]         (tree → displayed rows honoring expand/collapse)
 → rowsToDisplay (indexed, prefix-sum heights computed)
```

`applyTransaction` performs surgical add/update/remove into the tree and re-runs only affected stages (delta path), preserving group open state and selection by row id.

### 3.2 InfiniteRowModel

Block-based cache (`blockSize`), lazy-load blocks via `datasource.getRows({ startRow, endRow, sortModel, filterModel })`. Cache eviction (`maxBlocksInCache`), overflow placeholder rows, purge on sort/filter change.

### 3.3 ServerSideRowModel (SSRM)

Store tree of lazy blocks per group level; server does grouping/agg/pivot/sort/filter. Supports infinite scroll within groups. **cggrid pairing: a wasm-sqlite / DuckDB-WASM SharedWorker acts as the local query engine** answering `getRows` — SQL translated from sort/filter/group model, snapshot + delta merged.

### 3.4 ViewportRowModel

Server pushes only the visible window; grid reports `viewportChanged(firstRow, lastRow)`; datasource streams row updates for that window (natural fit for a ViewServer/AMPS-style subscription returning snapshot + real-time deltas).

---

## 4. Feature Implementation Plan (194-feature parity, by category)

### 4.1 Columns
- Column definitions, colId resolution, `defaultColDef` merge.
- **Column groups** (`ColGroupDef`, §1.5): recursive nesting, `columnGroupShow: 'open'|'closed'` on both child columns and nested subgroups, `openByDefault`, `marryChildren`, padding groups for depth balancing, `columnGroupState` round-trip, split instances across pin boundaries, `suppressStickyLabel`, custom `headerGroupComponent` via DOM escape hatch.
- Pinned left/right; pinned region canvases.
- Resize (drag handle hit region on header canvas; live or deferred), auto-size to content (measure via cached metrics), `sizeColumnsToFit` (flex distribution).
- Move (drag header, insertion indicator on overlay), lock position, lock visible, lock pinned.
- Show/hide; column state get/apply (round-trips width, sort, pin, order, visibility, group, pivot, agg).
- Flex sizing; min/max constraints.

### 4.2 Header
- Header canvas: group header row(s) + column header row + optional floating filter row.
- Sort indicators (asc/desc/none + multi-sort index badge), sort on click, multi-sort with shift.
- Header checkbox selection (select-all honoring filter).
- Header menu button (opens DOM menu), header tooltips.
- Custom header components via DOM overlay.

### 4.3 Sorting
- Multi-column, stable merge sort, per-column comparator, `sortingOrder`, `accentedSort`, null ordering, `postSortRows`. Group-aware sorting (sort within groups).

### 4.4 Filtering
- Quick filter (tokenized, cached quick-filter text per row).
- Column filters: **Text**, **Number**, **Date**, **Set filter** (async value loading, mini-filter, select-all), boolean. Combined conditions (AND/OR, two conditions).
- Floating filters (compact editors rendered in header floating row; canvas display + DOM editor on focus).
- External filter hooks (`isExternalFilterPresent` / `doesExternalFilterPass`).
- `filterModel` get/set for persistence.
- Custom filter components via DOM.

### 4.5 Selection
- Row selection single/multiple; ctrl/shift multi; click, checkbox, header checkbox.
- **Range selection** (cell ranges): drag to select, shift-click extend, multi-range with ctrl, fill handle, range aggregation status bar (sum/avg/count/min/max). Painted on overlay layer.
- Selection persistence by row id across data updates.

### 4.6 Editing
- Cell editors mounted as **DOM inputs over the canvas** at the cell rect (canvas can't host live text input). Built-ins: text, large-text (popup), number, date, select, rich-select (async), checkbox.
- **Edit state machine (Excel/AG parity):** navigate → (Enter or F2 or type char or single/double-click) → edit → commit (Enter/Tab/click-away) or cancel (Esc). "Type-to-replace" vs "F2-to-append-at-end." Tab moves to next editable cell continuing edit.
- Full-row editing (`editType:'fullRow'`), popup editors, value parser/setter, `valueSetter` returning changed-or-not, `cellValueChanged` dispatch, undo/redo stack (`undoRedoCellEditing`).

### 4.7 Grouping & Aggregation
- Row grouping (single/multi column), group panel drop zone (DOM), auto group column with expand chevrons + counts.
- Expand/collapse (single/all), `groupDefaultExpanded`. (Tree data is a distinct model — see §4.14, not a grouping variant.)
- Aggregation functions: sum, min, max, avg, count, first, last, and **weighted-average** (for yield/spread rollups over notional). Custom aggFuncs. Group footers / grand total row (pinned bottom).
- **Sticky group headers** while scrolling within a group.

### 4.8 Pivoting
- Pivot mode, pivot columns generate secondary columns; pivot row totals / column totals; `PIVOT-SPEC.md` 16-area coverage; pivot result column defs, pivot comparator, expandable pivot column groups.

### 4.9 Pagination
- Client and server pagination, page size selector, page navigation, `paginationAutoPageSize`, footer summary. Row index math routes through page offset.

### 4.10 Clipboard & Export
- Copy (cells/ranges/rows) with headers, TSV to clipboard; paste (parse TSV, apply via transactions, `processDataFromClipboard`).
- CSV export, Excel export (SheetJS/xlsx or native XML with styles), custom cell/value processors.

### 4.11 Interaction & Navigation
- Keyboard: arrows, Home/End, Page Up/Down, Ctrl+arrows (jump), Tab/Shift-Tab, Enter/Shift-Enter, Ctrl+A, copy/paste keys.
- rAF-based adaptive throttling on rapid key repeat (scroll coalescing).
- Cell focus ring on overlay; `ensureVisible` scroll-into-view.
- Context menu (DOM), suppress/customize items.
- Tooltips (DOM, delay show, custom tooltip components).

### 4.12 Rendering Features
- Cell styling: `cellStyle`, `cellClassRules` (translated to canvas paint attributes — resolve class rules to a computed style object: bg, color, font-weight, border), row styling / row class rules, alternating rows.
- Conditional formatting for FI (rating buckets, pnl +/- coloring), heatmap cells.
- Value formatters (locale, currency, bp, price 32nds for MBS/CMBS), value getters (computed spreads).
- Cell flash on change (`flashCells`, `enableCellChangeFlash`) — decay animation on overlay driven by rAF.
- Column spanning (`colSpan`), row spanning (`rowSpan`), auto-height cells, text wrapping.
- Full-width rows (span all regions incl. pinned — same punch-out mechanics as detail rows, see §4.15).
- Overlays: loading, no-rows, custom.

### 4.13 Misc
- Status bar (agg, selected count, filtered count, total).
- Side tool panel (columns panel, filters panel) — DOM.
- Loading/skeleton cells, animated row transitions (insert/remove/reorder) — optional.
- RTL, accessibility (see §8), themes/params.

### 4.14 Tree Data

Tree data is **not** row grouping with a different key source, and modeling it as such is the standard way to get it wrong. The defining difference: **group nodes are synthetic and carry no data; tree nodes are real rows**. A folder *is* a record. This propagates into aggregation, filtering, selection, and transactions.

**Supply modes.** Two intake paths, one internal representation:
- *Flat + path:* `treeData: true` with `getDataPath(data) => string[]`. Grid synthesizes intermediate nodes for any path segment lacking a supplied row (a "filler" node — `node.data === undefined`, `node.group === true`).
- *Nested children:* `treeDataChildrenField: 'children'`. Hierarchy is intrinsic; no fillers.

Both normalize to a `TreeNode` tree where every node has `level`, `key` (its path segment), `parent`, `childrenAfterGroup`, and — critically — an **optional** `data`. Downstream stages branch on `node.data === undefined` (filler) vs populated (real row).

**Aggregation semantics.** Must distinguish:
- `groupIncludeOwnValues`-style behavior: does a parent's own row contribute to its aggregate, or only its leaves? For an FI position tree (desk → book → position), a book row may itself carry a hedge notional that must be summed alongside its children. Expose `aggregateOnlyChangedColumns` and an explicit `includeSelfInAgg` flag on the agg stage.
- `suppressAggFilteredOnly`, `groupAggFiltering` interact with tree filtering below.
- Weighted-average agg (yield/spread over notional) must weight by the *leaf* notional, not the parent's, or double-counting occurs at every level.

**Filtering semantics.** Distinct from grouping:
- `excludeChildrenWhenTreeDataFiltering: false` (default) — a matching node keeps **all** its descendants visible.
- `excludeChildrenWhenTreeDataFiltering: true` — only matching nodes survive; a matching child pulls its **ancestors** back into view as context, but siblings are dropped.
- Either way ancestors of a match are retained (otherwise the match is unreachable). Implement as a two-pass mark: bottom-up `hasMatchingDescendant`, top-down `retainForContext`.

**Transactions.** The hard case grouping never faces: **a node changing parent**. `applyTransaction({ update })` where `getDataPath` now returns a different path is a *move*, not an update. The delta path must:
1. Detach the node (and its subtree) from its old parent's `childrenAfterGroup`.
2. Re-attach under the new path, synthesizing fillers as needed.
3. Garbage-collect fillers left childless (unless `groupAllowUnbalanced`).
4. Re-run agg bottom-up along **both** the old and new ancestor chains only — not a full rebuild.
5. Preserve expand state and selection by row id across the move.

**Ragged paths.** `groupAllowUnbalanced: true` permits leaves at differing depths and paths that terminate early; the flatten stage must not assume uniform depth.

**SSRM tree data.** Lazy children per node via `isServerSideGroup(dataItem)` and `getServerSideGroupKey(dataItem)`. Each expandable node owns its own lazy block cache; expand triggers `getRows` scoped to that node's `groupKeys` path. Pairs with the wasm-sqlite/DuckDB SharedWorker: the path becomes a recursive-CTE predicate.

**Rendering.** Auto group column renders indent (`level * indentPx`) + chevron + the node's own `key` or a `field` value. Filler nodes render the key only. Chevron is a canvas `hitTest` region (§2.4), not a DOM node. Sticky ancestor headers reuse the §4.7 sticky-group machinery, but stack to arbitrary depth — cap rendered sticky depth and elide the middle if it exceeds the viewport budget.

**API.** `api.setGridOption('treeData', bool)`, `getDataPath`, `treeDataChildrenField`, `isServerSideGroup`, `getServerSideGroupKey`, `groupAllowUnbalanced`, `excludeChildrenWhenTreeDataFiltering`, `api.expandAll()/collapseAll()`, `node.setExpanded()`.

### 4.15 Master / Detail

The hardest canvas feature in the grid, because a detail row is **a fully independent grid instance occupying a variable-height hole in a canvas that has no DOM per row**.

**Rendering approach — punch-out + DOM overlay.** Rejected: nested canvas at the detail rect (forces the detail grid to reimplement its own layer stack, scroll, and hit-testing inside a clipped parent context; nested master/detail then nests contexts N deep). Chosen: the body canvas **skips painting** the detail row's rect entirely (punch-out), and a **DOM-mounted child `CgGrid` instance** is absolutely positioned over that rect, translated in lockstep with the parent's scroll offset each frame.

Consequences that must be designed for, not patched later:

1. **Full-width spanning across pinned regions.** A detail row spans pinned-left + body + pinned-right. This breaks the clean three-canvas split of §2.1: the detail overlay must render **above all three** canvases, and each of the three must punch out its slice of the detail row's Y-band. Introduce a dedicated `fullWidthLayer` DOM container stacked above the canvas trio; detail grids and full-width rows both mount into it. Horizontal scroll of the *parent* must not translate the detail overlay (it spans the full viewport width, pinned regions included) — only vertical scroll does.

2. **Row-height mutation.** `detailRowHeight` (fixed) or `detailRowAutoHeight` (measured after the detail grid lays out) changes a single row's height post-layout, on every expand/collapse. With a flat prefix-sum `Float64Array` this is an O(k) suffix rewrite; at 100k rows and interactive expand/collapse that is unacceptable. **This is why §2.2 specifies the Fenwick-tree offset backing** whenever `masterDetail` is enabled — O(log n) height update, O(log n) `rowAtY`. `detailRowAutoHeight` additionally requires a two-phase frame: mount detail → measure → write height → invalidate offsets → repaint. Guard against measure/layout feedback loops with a height-change epsilon.

3. **Detail instance lifecycle.** Naive destroy-on-scroll-out makes scrolling through expanded rows janky (each re-entry re-instantiates a grid and re-fetches). Implement AG Grid's contract:
   - `keepDetailRows: boolean`, `keepDetailRowsCount: number` (LRU of live detail instances).
   - Beyond the LRU, destroy the instance but **retain its collapsed/expanded state and scroll position** keyed by master row id, so re-entry restores rather than resets.
   - `getDetailRowData({ node, data, successCallback })` — async; render a loading skeleton in the punched-out rect until it resolves.
   - `detailGridOptions` may be a static object or `(params) => GridOptions` per master row.

4. **Custom detail renderers.** `detailCellRenderer` / `detailCellRendererParams` override the default nested grid entirely — mounts arbitrary DOM (a chart, a form, a React tree) into the punched-out rect. Same lifecycle rules apply.

5. **Nested master/detail.** A detail grid may itself be a master. Each nesting level adds a `fullWidthLayer`. Bound the depth (`maxDetailDepth`, default 2) and make offset-array updates propagate **outward**: an inner detail expanding changes the inner grid's height, which changes the outer detail row's auto-height, which rewrites the outer offset tree. Debounce this cascade to one flush per frame.

6. **Focus & keyboard traversal.** Tab/arrow navigation must cross the canvas→DOM→canvas boundary. On reaching the last cell above a detail row, `ArrowDown` moves focus *into* the detail grid's first cell; `Escape` or exhausting the detail grid returns focus to the master row below. The ARIA shadow (§8) must nest a `role="grid"` inside the master's row element so AT sees the real containment. Maintain a focus stack across grid instances.

7. **Selection & range.** Master and detail maintain independent selection models. Range selection does **not** cross the boundary (a drag from master into detail terminates at the detail's top edge). Copy of a range spanning a collapsed detail row omits it.

8. **Export.** Excel/CSV export of a master grid with expanded details: `getCustomContentBelowRow` equivalent — serialize detail rows as indented blocks beneath their master. CSV flattens; Excel can group rows into collapsible outline levels.

**API.** `masterDetail: true`, `isRowMaster(data) => boolean`, `detailCellRenderer`, `detailCellRendererParams`, `detailRowHeight`, `detailRowAutoHeight`, `keepDetailRows`, `keepDetailRowsCount`, `api.getDetailGridInfo(id)`, `api.forEachDetailGridInfo(cb)`, `api.addDetailGridInfo/removeDetailGridInfo`, `node.setExpanded()`, event `rowGroupOpened`.

---

## 5. Performance Engineering

- **Prefix-sum offset arrays** (`Float64Array`) for row-Y and column-X; O(log n) hit-testing and viewport calc; rebuilt incrementally on height/width change.
- **Object pooling** for `RenderState`/paint descriptors; reuse across cells within a frame — zero GC pressure on the tick path. Also pool `ColumnGroup` layout instances (§1.5.2) — they are rebuilt, not diffed, on every resize/move/pin frame.
- **Tick batching:** coalesce incoming updates within a frame; mark only changed cells dirty; repaint just those tiles + trigger flash. Target sustained 60fps with thousands of cell updates/sec across a 250×100k logical grid.
- **Metrics/style caches:** LRU for `measureText`; memoized resolved `cellStyle`/`cellClassRules` keyed by (col, value-bucket).
- **Off-main-thread data plane:** SharedWorker owns the row store + query engine (wasm-sqlite for transactional tick data, DuckDB-WASM for OLAP/pivot); MessagePort fan-out per window; Transferable ArrayBuffers (COOP/COEP-safe in OpenFin) carry snapshot/delta frames to the render thread.
- **Optional OffscreenCanvas:** move painting into a worker where supported; main thread only forwards scroll/input + dirty regions.
- **Layered invalidation:** cell edits touch only body layer; focus/range touch only overlay; header sort touches only header — no full redraws.

---

## 6. Framework & Theming Integration

- **Vanilla core, thin adapters.** React wrapper (`<CgGrid gridOptions={...} />`) is a mount/unmount + prop-diff shim; the core never depends on React. Angular wrapper mirrors it for the later port.
- Framework cell renderers/editors/filters run through the DOM escape hatch (portal-mounted at cell rect); human-speed structural UI only, never the hot path.
- **Theming via MDL tokens:** resolve design tokens (parchment-light, Binance-dark) into a flat `ResolvedTheme` (colors, fonts, paddings, border specs) consumed directly by `paint()`. Monospace numerics (JetBrains Mono) + sans labels (IBM Plex Sans). `themeQuartz.withParams`-style param API for compatibility. Theme switch = re-resolve tokens + full invalidate.

---

## 7. UX / UI Design Specification

### 7.0 The brief, stated plainly

**Subject:** a fixed-income trading blotter — credit, MBS, CMBS. **Audience:** a trader or desk analyst who has this grid open for nine hours and looks at nothing else. **The single job:** let them find the one row that matters, in a screen of 250 columns and a hundred thousand rows, while the numbers are still moving.

Two design consequences follow, and everything below derives from them.

**First: this is not a website, it's an instrument.** The user is not being persuaded, onboarded, or delighted. They are reading. A blotter is closer to a Bloomberg terminal, a mixing console, or an aircraft primary flight display than to a SaaS dashboard. Instruments earn their character through *density, legibility, and the absence of anything that moves without meaning* — not through hero moments. Every pixel of chrome is a pixel not showing a bond.

**Second: motion is signal, and therefore motion is scarce.** In most products animation is decoration and its cost is taste. Here, a moving pixel is a claim that something changed. If the UI animates for its own reasons — a hover glow, an easing transition on a menu, a shimmer — it is lying, and it competes with the one animation that carries information: a price tick. **The tick flash is the only animation in this grid that is allowed to be beautiful.** Everything else is instantaneous or absent.

**The templated answer — and why we reject it.** The default trading UI is near-black, with a vermilion/acid-green up-down accent and a blue focus ring. It is the look of every screenshot in every trading-tech marketing deck. Its problems are real, not aesthetic: (a) pure black + pure green is the highest-contrast pair available, so it screams at the user for *every* tick, flattening the difference between a 1bp drift and a 40bp gap; (b) red/green as the sole encoding of direction fails ~8% of male traders (deuteranopia), a population that is not small on a trading floor; (c) saturated accents on near-black produce chromatic aberration and halation at small type sizes, which is precisely the size all the numbers are.

We keep the dark theme — it's correct for a dim trading floor and for nine-hour sessions — and change what carries meaning within it.

---

### 7.1 Design tokens

Two themes, one token contract. `Binance-dark` is the working default; `parchment-light` exists for daylight desks, printing, and screen-sharing into a bright conference room. Both resolve into the same flat `ResolvedTheme` consumed by `paint()` (§6).

#### Palette — Binance-dark

The surface is not black. It is a **desaturated blue-grey**, which lowers the contrast floor so that *the data* becomes the brightest thing on screen rather than competing with the chrome.

| Token | Hex | Role |
|---|---|---|
| `surface.base` | `#12151C` | Grid background, even rows |
| `surface.raised` | `#171B24` | Odd rows (zebra), header base |
| `surface.overlay` | `#1E232E` | Menus, tool panel, popup editors |
| `surface.sunken` | `#0D1015` | Viewport gutter, scroll track |
| `border.hairline` | `#232834` | Cell gridlines |
| `border.structural` | `#2E3542` | Pinned-region edges, header underline |
| `text.primary` | `#E4E7EC` | Values, at rest |
| `text.secondary` | `#9BA3B0` | Headers, group counts, units |
| `text.tertiary` | `#5F6875` | Disabled, placeholder, filler nodes |
| `accent.lavender` | `#A99BE8` | Focus, selection, active sort — the single accent |
| `accent.lavender.dim` | `#6B5FA8` | Range fill, selection wash |

**The accent is lavender-grey, and it is the only accent.** This is the one real risk in the palette, and the justification is structural: lavender occupies the hue region that is *maximally distant from both red and green*, so the focus ring, the selection wash, and the sort indicator can never be confused with a price direction — even by a colorblind trader, even at 200ms glance. Every other trading grid spends its accent on direction and then has nothing left to say "you are here." We spend it on **location**, and encode direction elsewhere (§7.2). Chrome is chromatically silent; only data is colored.

#### Palette — parchment-light

| Token | Hex | Role |
|---|---|---|
| `surface.base` | `#F7F5F0` | Grid background |
| `surface.raised` | `#EFEBE3` | Zebra, header |
| `surface.overlay` | `#FFFEFB` | Menus, popups |
| `border.hairline` | `#DED8CC` | Gridlines |
| `border.structural` | `#C4BCAA` | Structural edges |
| `text.primary` | `#1F2229` | Values |
| `text.secondary` | `#5A6070` | Headers |
| `text.tertiary` | `#8F95A3` | Disabled |
| `accent.lavender` | `#6A5AC4` | Focus, selection, sort |

Parchment is warm-neutral, not white: `#F7F5F0` reduces the luminance delta against dark text, which is the single biggest driver of eye strain in long light-mode sessions.

#### Direction encoding — three channels, never one

Price direction is encoded **redundantly** so that it survives colorblindness, glance-reading, and grayscale screen-share:

| Channel | Up | Down | Unchanged |
|---|---|---|---|
| **Hue** | `#4FB286` (desaturated teal-green) | `#D9736A` (desaturated clay-red) | inherit |
| **Glyph** | `▲` prefix (or `+`) | `▼` prefix (or `−`) | none |
| **Weight** | 500 → 600 during flash | 500 → 600 during flash | 500 |

The hues are deliberately **desaturated** relative to the trading-UI default. At 11px, `#00FF88` on `#000` halates; `#4FB286` on `#12151C` stays crisp. Contrast ratio against `surface.base` is ≥ 4.5:1 for both.

`gainColor` / `lossColor` remain configurable — a desk with a house convention (or a Japanese desk, where the convention is *inverted*) overrides the tokens, never the code.

#### Type

| Role | Face | Usage |
|---|---|---|
| **Numeric** | JetBrains Mono, 500 | All numeric cells, tabular figures, `font-feature-settings: 'tnum' 1, 'zero' 1` |
| **Label** | IBM Plex Sans, 450 | Headers, group keys, text cells, menus |
| **Display** | IBM Plex Sans, 600 | Dialog titles, status bar aggregates |

**Numerals are monospaced and slashed-zero. This is non-negotiable and it is the typographic thesis of the grid.** A column of prices is a column of *place values*, and proportional figures destroy the vertical alignment of the decimal point, which is the single most-scanned visual feature in a blotter. The trader reads the column as a shape — a ragged right edge means a wide market — and that shape only exists with tabular figures. The slashed zero disambiguates `0` from `O` in CUSIPs and tickers, where a misread is a mis-trade.

Type scale (density-dependent, see §7.3): `11 / 12 / 13 / 15 / 18px`. No sizes between. Line-height is always `rowHeight`, never a multiplier.

#### Space & radius

4px base unit. Cell padding `0 8px` (comfortable) → `0 6px` (compact) → `0 4px` (dense). **Border radius is `0` everywhere in the grid body**, `2px` on overlays and buttons. A rounded cell is a cell that wastes its corners; the grid is a lattice, and lattices meet at right angles.

---

### 7.2 Cell states — the visual hierarchy

Six states can coexist on one cell. They must compose without becoming mud. Rendering order, back to front, is fixed:

```
1. row background        (base | zebra | rowClassRules | group | pinned-row)
2. range selection wash  accent.lavender.dim @ 12% alpha
3. row selection wash    accent.lavender.dim @ 18% alpha
4. cellClassRules fill   (conditional formatting — heatmap, rating bucket)
5. tick flash fill       gain/loss @ decaying alpha  ← the only animated layer
6. cell content          text, glyphs, renderer paint()
7. focus ring            1px accent.lavender, inset, drawn on OVERLAY layer
```

**The rule that makes this legible:** *backgrounds compose by alpha; foregrounds never compose.* Text is `text.primary` in every state except direction-colored numerics. A cell that is focused *and* selected *and* flashing shows all three, because they occupy different layers and different alphas. A cell never changes its text color to indicate selection — that would collide with direction encoding.

**Focus lives on the overlay layer** (§2.1), which is why it can be drawn *last* and repainted at 60fps during arrow-key navigation without touching the body canvas. This is a rendering fact that becomes a design affordance: the focus ring can be crisper and more responsive than anything else on screen, and it should be. It is the user's cursor.

#### The tick flash — the one place we spend beauty

Anatomy of a flash, on a price change:

```
t=0ms      fill = gainColor @ 22% alpha, text weight 500→600
t=0-90ms   hold (perceptual floor: below ~80ms a flash is missed at peripheral vision)
t=90-500ms alpha 22% → 0%, cubic-bezier(0.2, 0, 0.4, 1)   [fast-out, slow-settle]
t=500ms    text weight 600→500, cell at rest
```

Three design decisions inside that curve:

- **Fill, not text color.** The number's *direction hue* persists after the flash decays (until the next tick); the *flash* is a background pulse. Direction is state, flash is event. Conflating them means a stale price looks like a live one.
- **Decay, not blink.** A blink (on/off) draws the eye but conveys nothing about recency. A decay means the trader can see, in one glance across the blotter, a gradient of *how long ago* each cell moved. The screen becomes a heat map of activity without any additional encoding. **This is the grid's signature.**
- **Coalesce, don't queue.** If a cell ticks again mid-decay, reset alpha to 22% — do not stack fills or queue animations. A fast-ticking cell sits at a high plateau; a slow one fades. The plateau *is* the volatility display.

Flash decay is driven by the rAF flush (§2.3) writing only to the flash layer's dirty rects. `enableCellChangeFlash` and `cellFlashDuration` remain AG Grid-compatible; `prefers-reduced-motion` collapses the decay to a single 90ms hold with no ramp (the information is preserved; the motion is not).

---

### 7.3 Density — one control, everything follows

Three density modes, exposed as a single user-facing control. This is the highest-leverage UI affordance in the grid: a trader working a single deep book wants comfortable; a trader watching forty CUSIPs wants dense.

| | Comfortable | Compact | Dense |
|---|---|---|---|
| Row height | 32px | 26px | 20px |
| Font size | 13px | 12px | 11px |
| Cell padding-x | 8px | 6px | 4px |
| Column header height | 40px | 34px | 28px |
| Group header height (per level) | 28px | 24px | 20px |
| Floating filter height | 32px | 26px | 20px |
| Checkbox | 16px | 14px | 12px |
| Chevron | 16px | 14px | 12px |
| Gridlines | horizontal + vertical | horizontal only | **none** |

**Gridlines disappear as density increases**, which is counterintuitive and correct. At 20px rows, horizontal rules and the text baselines they separate are close enough to create a moiré that makes the column vibrate. Rows at dense are separated by zebra striping alone (Δ luminance ≈ 3%), which the eye resolves as separation without adding a competing horizontal line. This is Tufte's data-ink argument applied literally: at high density the gridline *is* the noise.

**Total header height is depth-dependent, not a constant** — `maxGroupDepth × groupHeaderHeight + columnHeaderHeight + floatingFilterHeight` (§1.5.5). A 3-deep hierarchy at comfortable density with floating filters consumes 156px. Soft-cap `maxGroupDepth` at 3.

Density changes `rowHeight`, which rewrites the offset backing (§2.2) — one full invalidate, one frame. Not animated.

---

### 7.4 Header

The header is the grid's control surface, and it is under permanent pressure: 250 columns, each wanting a name, a sort state, a filter state, a menu, and a resize handle, in 28–40px.

**Layout, left to right within a header cell:**

```
┌──────────────────────────────────────────────┬───┬───┐
│ [group indent] HEADER NAME          ▲²       │ ⋮ │ ║ │
└──────────────────────────────────────────────┴───┴───┘
   label (Plex Sans 450, text.secondary,        menu  resize
   uppercase-off, truncate w/ ellipsis)         (hover) (hover)
                                       sort indicator
```

- **Header labels are sentence case, not uppercase.** Uppercase costs ~12% horizontal width and destroys word-shape recognition, which is how a trader finds "Wtd Avg Spread" among 250 columns without reading it.
- **Sort indicator is a filled triangle plus a superscript index** (`▲²`) when multi-sorting. The index is the information; the triangle is the direction. Both are `accent.lavender` when active, `text.tertiary` on hover-preview.
- **Menu and resize affordances appear on hover only**, at `text.tertiary`, going `text.secondary` on their own hover. Persistent affordances × 250 columns = a header made of icons. On touch/coarse pointers they are always visible (media query on `pointer: coarse`).
- **Active filter is indicated on the header itself** — the label goes `text.primary` and a 2px `accent.lavender` bar is drawn along the header cell's bottom edge. A funnel icon is not used: it costs 14px of a scarce 100px, and a colored underline is readable in peripheral vision at a glance across 250 columns. Filtering is a *state of the column*, so it is drawn as a property of the column's edge.

**Column groups** get a shallower row (`groupHeaderHeight`, ≈70% of the column header), `text.tertiary`, and a hairline bracket spanning their children — they are structure, not data, and must recede. An expand glyph (`◂`/`▸`) sits at the label's trailing edge, only when the group is `expandable`. **Padding groups** (synthetic fillers that keep the header rectangular when leaves sit at unequal depth, §1.5.4) paint nothing at all — no label, no bracket, `surface.raised` only. **Sticky group labels** pin to the left edge of a group's visible span when it exceeds the viewport, so the trader always knows which group they are under.

**Floating filter row**, when enabled, sits below the header at `rowHeight` (compact), `surface.raised`, with borderless inputs that only reveal their border on focus. It reads as part of the header, not as a first data row — this is enforced by a `border.structural` underline beneath it, not above it.

---

### 7.5 Sorting, filtering, selection — interaction grammar

Consistency of *gesture* across the grid is what makes 194 features learnable. The grammar:

| Gesture | Meaning, everywhere |
|---|---|
| **Click** | Set (replace) |
| **Ctrl/Cmd + Click** | Add to set (toggle membership) |
| **Shift + Click** | Extend from anchor |
| **Double-click** | Enter / edit / autosize |
| **Drag** | Reorder or extend a range |
| **Right-click** | Context menu for the thing under the cursor |

Applied: click a header → sort by it alone. Ctrl+click → add it as a secondary sort. Click a row → select it alone. Ctrl+click → toggle it into the selection. Shift+click → select the span. The user learns this once.

**Sort cycles** `asc → desc → none` by default (`sortingOrder` overridable). Never `asc → desc → asc`: a trader must be able to return to natural/insertion order, which for a blotter is *time*, and time order is meaningful.

**Range selection** paints on the overlay: a `accent.lavender.dim @ 12%` fill, a 1px `accent.lavender` border on the range's outer perimeter only (not per-cell), and a **fill handle** — a 6px filled square at the bottom-right corner, the one place where a 6px target is acceptable because it has a 12px invisible hit-slop. Multi-range (Ctrl+drag) draws each range's perimeter independently.

**Selection checkboxes** are opt-in and pinned-left. A checkbox column costs 40px permanently; most blotters should use click-selection and a **status bar count** instead. When present, the header checkbox is tri-state (none / some / all) and its "all" scope respects the active filter — selecting "all" when a filter is active selects the filtered set, and the status bar says so explicitly: `Selected 47 of 1,204 filtered (100,000 total)`.

---

### 7.6 Editing — the state machine, made visible

The edit state machine (§4.6) has four states. Each gets exactly one visual signature, and the signatures do not overlap.

| State | Signature |
|---|---|
| **Navigate** | 1px `accent.lavender` focus ring, inset, on overlay |
| **Edit (type-to-replace)** | Cell becomes `surface.overlay`, 2px `accent.lavender` ring, text replaced, caret at end, **all selected** |
| **Edit (F2 / dbl-click — append)** | Same chrome, existing text retained, caret at end, **nothing selected** |
| **Invalid** | Ring goes `#D9736A`, a 3px left bar in the same, tooltip on hover |

The DOM editor input (§4.6) must be **pixel-registered** to the canvas cell it replaces: same font, same size, same padding, same text alignment, same baseline. If the text jumps by even 1px when the editor mounts, the illusion breaks and the grid feels like a website. This is the highest-precision visual requirement in the entire spec, and it is a test case (§9): mount an editor over a cell, screenshot, diff against the canvas-painted cell — the glyph positions must be identical.

**Commit affordances are silent.** Enter commits and moves down. Tab commits and moves right. Escape reverts. There is no ✓/✗ button — a button in a cell is 20px of a 90px column, and the keyboard contract is universal. The *only* visible confirmation of a commit is the tick flash (§7.2), which is the same affordance the grid uses for a remote update. **This is deliberate: the trader's own edit and the market's update should look identical, because to the book they are.**

---

### 7.7 Grouping, tree data, master/detail

Three hierarchical features, one visual language for depth.

**Indentation is 20px per level**, and depth is *also* encoded by a hairline vertical rule at each ancestor's indent stop — the "tree spine." Without spines, a trader at depth 4 in a desk→book→strategy→position tree cannot tell which ancestor a row belongs to without scrolling up. Spines are `border.hairline`; the *current* row's own spine is `border.structural`.

**Chevrons** are `▸` / `▾`, 12–16px by density, `text.secondary`, `accent.lavender` on hover. They are canvas `hitTest` regions (§2.4) with a 24px hit-slop — the drawn glyph is small, the target is not. **Filler nodes** (§4.14, synthetic tree ancestors with no data) render their key at `text.tertiary` and italic, because they are inference, not record. This is the one italic in the grid.

**Group rows** carry `surface.raised`, a count in parentheses at `text.secondary` (`Investment Grade (1,204)`), and their aggregates in the normal data columns using the normal numeric treatment — an aggregate is a number and gets no special color. **Sticky group headers** cast no shadow; they are separated from the scrolling content by a single `border.structural` bottom edge. A shadow implies elevation, and a sticky header is not floating above the data, it *is* the data, held in place.

**Master/detail.** The detail row is punched out of the canvas and filled by a DOM child grid (§4.15). The design must make the containment unambiguous:

- The detail region is inset **20px from the left**, aligning with one indent step — it reads as a child.
- Its background is `surface.sunken`, one step *darker* than the grid. Nested content recedes; it does not rise. (This is the inverse of the common shadow-and-elevate pattern, and it's correct here: the master grid is the primary surface, and the detail is a well cut into it.)
- A 2px `accent.lavender.dim` bar runs the full height of the detail region's left edge, physically connecting it to its master row's chevron.
- The detail grid inherits the parent's **density and theme**, always. A nested grid with different row heights is visual chaos.

---

### 7.8 Chrome — status bar, tool panel, menus, overlays

**Status bar** (bottom, `28px`, `surface.raised`, `border.structural` top edge). Left: row counts and selection. Right: **range aggregates**, which appear only when a range is selected, and are the most-used feature in the grid after sorting:

```
Rows 100,000 · Filtered 1,204 · Selected 47        Sum 4,203,991  Avg 89,446  Min 12  Max 1,204,000  Count 47
```

Numbers here are JetBrains Mono; labels are Plex Sans `text.secondary`. The aggregates appear **without animation** — they are a readout, not an event.

**Tool panel** (right, collapsible, `280px`, `surface.overlay`). Columns panel and filters panel as tabs. Column list is virtualized (250 rows), drag-to-reorder, checkbox-to-toggle, with a search field pinned at top. The search field is the actual answer to 250 columns; it should be focused by default when the panel opens.

**Menus** (`surface.overlay`, `2px` radius, 1px `border.structural`, no shadow beyond a 1px `#00000040` hairline). Open **instantly** — no fade, no scale. A menu that animates in costs 120ms × every use × nine hours. Items are 28px, sentence case, with keyboard shortcuts right-aligned at `text.tertiary`.

**Overlays.** Loading is a skeleton — grey `surface.raised` bars at the width of each column's typical content, pulsing at 1.4s. Not a spinner: a spinner tells you nothing about shape, and the skeleton lets the trader's eye pre-load the layout. `No rows` is a single sentence at `text.secondary`, centered, with the active filter summarized beneath it and a **"Clear filters"** action — an empty screen is an invitation to act, and the reason it's empty is almost always a filter.

---

### 7.9 Copy, in the interface's voice

The grid speaks in **short, active, unapologetic** phrases. It does not say "Oops!" It does not say "Please try again."

| Situation | Text |
|---|---|
| No rows, no filter | `No rows to display.` |
| No rows, filter active | `No rows match the current filters.` + `Clear filters` |
| Load failed | `Could not load rows. Retry` |
| Edit rejected by `valueSetter` | `Price must be between 0 and 200.` (the *rule*, not "Invalid input") |
| Detail load failed | `Could not load allocations for this trade. Retry` |
| Export in progress | `Exporting 1,204 rows…` → `Exported 1,204 rows.` |

**An action keeps its name through its whole lifecycle.** The button says `Export`, the progress says `Exporting`, the toast says `Exported`. The menu item says `Group by Rating`, and the resulting group panel chip says `Rating`. Errors state the constraint that was violated, because the trader's next action is to satisfy it.

Never use "cell," "row model," "node," or "transaction" in user-facing copy. The user has bonds, positions, and trades.

---

### 7.10 Responsive, coarse-pointer, and reduced-motion floors

- **Coarse pointer** (`pointer: coarse`): density forced to comfortable minimum; hover-only affordances (menu, resize) become permanently visible; hit-slop on chevrons and fill handles increases to 44px; range-selection drag requires a long-press to disambiguate from scroll.
- **Reduced motion** (`prefers-reduced-motion: reduce`): tick flash collapses to a 90ms hold at full alpha, then cuts. No decay ramp. Row insert/remove transitions disabled. **Information is never removed — only the ramp is.**
- **Narrow viewport:** the grid does not reflow into cards. It scrolls. A blotter is a blotter. Pinned columns collapse to a single identifier column below `640px`, and the tool panel becomes a full-screen sheet.
- **Forced colors / high contrast:** `border.hairline` → `CanvasText`, focus ring → `Highlight`, direction encoding falls back entirely to the **glyph channel** (`▲`/`▼`), which is why the glyph channel exists.

---

### 7.11 The quality floor, and the one thing to remember

Non-negotiable, unannounced:

1. Visible keyboard focus at all times, on every interactive element, canvas or DOM.
2. Every pointer action has a keyboard equivalent.
3. `prefers-reduced-motion` respected without information loss.
4. Direction never encoded by color alone.
5. Numerals always tabular, always slashed-zero.
6. The DOM editor is pixel-registered to the canvas cell.
7. Nothing animates except the tick flash.

**The signature:** *the decaying tick flash.* One glance at a cggrid blotter, with no interaction, tells the trader which instruments are moving, how recently, and how hard — because the screen holds a fading gradient of every trade that just happened. No other grid does this, because no other grid can afford to repaint a thousand independently-decaying cells at 60fps. The rendering architecture (§2) is what makes the design possible; the design is what makes the architecture worth building.

Everything else is quiet.

---

## 8. Accessibility

Canvas is opaque to AT, so maintain a **parallel ARIA DOM shadow**: a visually-hidden `role="grid"` structure mirroring the visible viewport window (focused row/nearby rows), updated on scroll/focus; `aria-rowcount`/`aria-colcount` reflect logical totals; focus management routes real DOM focus to the shadow cell while the canvas paints the visual focus ring. Keyboard model fully operable without pointer.

---

## 9. Testing & Validation

- **Unit:** row-model pipeline stages, prefix-sum math, comparators, agg (incl. weighted-avg), value getter/setter/formatter, filter model round-trips. **Column group tree: `balanceTree` yields equal leaf depth; `columnGroupShow` × `expanded` resolves to the correct displayed set; `headerRowCount = maxGroupDepth + 1 (+1 floating filter)`; `columnGroupState` round-trips.**
- **Property-based:** transaction application converges to full-rebuild result; sort stability; group open-state preservation across updates. **Tree reparenting: a sequence of random path-changing updates converges to the same tree as a full rebuild, with expand state and selection preserved by row id. Tree agg: sum over any subtree equals sum over its leaves (+ own value iff `includeSelfInAgg`) — catches double-counting. Offset backing: flat prefix-sum and Fenwick return identical `offsetOf`/`rowAtY` under random height mutations.**
- **Lifecycle:** detail instance LRU evicts and restores scroll/expand state by master row id; `detailRowAutoHeight` reaches a fixed point (no measure→layout oscillation); nested cascade flushes once per frame.
- **Golden-image / visual regression:** render fixed datasets to canvas, snapshot pixels, diff (headless Chromium).
- **Design conformance (§7):** *editor pixel-registration* — mount a DOM editor over a cell, screenshot, diff glyph positions against the canvas-painted cell; must be identical. *Contrast* — every token pair (`text.*` on `surface.*`, gain/loss on base) asserted ≥ 4.5:1 programmatically, both themes. *Grayscale direction test* — desaturate a screenshot of gain/loss cells; direction must remain readable via glyph channel alone. *Reduced-motion* — flash conveys the same state with the ramp removed. *Density* — gridline suppression at dense; zebra Δ-luminance ≈ 3%.
- **Interaction/E2E:** Playwright via CDP (`@openfin/automation-helpers`) for edit state machine, keyboard nav, range selection, clipboard, scroll virtualization correctness.
- **Perf benchmarks:** frame time under N updates/sec at 250×100k; scroll jank; memory stability over long sessions; compare against AG Grid baseline on identical FI datasets.
- **API conformance suite:** port representative AG Grid configs, assert equivalent behavior/events.

---

## 10. Phased Delivery (Phases 0–8)

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Foundation** | Layer stack, DPR canvas, **pluggable offset backing (flat prefix-sum + Fenwick)**, `fullWidthLayer` stacked above the canvas trio, native-scroll virtualization, `TextRenderer`, `GridOptions`/`ColDef` intake,  `GridApi` skeleton, EventService, **MDL token resolution → `ResolvedTheme`, density modes (§7.1, §7.3)** | Scroll 100k×250 at 60fps; dirty-rect flush working; **single-row height mutation is O(log n) and repaints without full invalidate** |
| **1 — Columns & Header** | Column model, **column group tree pipeline (§1.5: balanceTree → ProvidedColumnGroup → ColumnGroup instances per region)**, pin, resize, move, autosize, sizeToFit, header canvas, sort indicators, column + column-group state | Full column manipulation + persistence; **a group split across the pin boundary renders two instances that open/close together; `marryChildren` prevents the split; header height derives from group depth** |
| **2 — Data pipeline** | ClientSideRowModel (filter→sort→flatten), quick filter, column filters, floating filters, filter model | Filter/sort parity on FI blotter |
| **3 — Selection & Editing** | Row select, range select + fill handle, DOM editor overlay, edit state machine, built-in editors, undo/redo, value setter, **decaying tick flash (§7.2 — the signature)** | Excel-parity editing; **editor is pixel-registered to the canvas cell (glyph-diff test passes)**; flash decays with coalescing, not queuing; `prefers-reduced-motion` preserves information |
| **4 — Grouping/Agg/Pivot/Tree** | Grouping, sticky group headers, agg (weighted-avg), auto group col, pivot mode, group footers. **Tree data (§4.14): both supply modes, filler nodes, self-vs-leaf agg, two-pass tree filtering, reparenting transactions, ragged paths** | Positions rollup by rating/sector with weighted spread; **desk→book→position tree survives a reparenting transaction with expand state and selection intact, no full rebuild** |
| **5 — Row models** | Infinite, SSRM (wasm-sqlite/DuckDB SharedWorker), Viewport (ViewServer subscription). **SSRM tree data: lazy children via `isServerSideGroup`/`getServerSideGroupKey`, recursive-CTE path predicates** | Server-driven blotter with snapshot+delta; lazy tree expansion |
| **6 — Master/Detail & full-width rows** | Punch-out rendering, DOM detail overlay above the canvas trio, `detailRowAutoHeight` two-phase measure, detail instance LRU (`keepDetailRows`), `getDetailRowData` async + skeleton, `detailCellRenderer`, nested master/detail with outward height cascade, cross-boundary focus traversal, independent selection models, detail-aware export | Trade → allocations detail grid; expand/collapse at 100k rows with no scroll jank; nested depth 2; keyboard traverses master↔detail |
| **7 — Clipboard/Export/Chrome** | Copy/paste, CSV/Excel export, context menu, tooltips, status bar, side panel, overlays, pagination | Full chrome + interop |
| **8 — A11y, theming, custom comps, perf hardening** | ARIA shadow (**incl. nested `role="grid"` for detail rows**), **parchment-light theme + forced-colors fallback**, React/DOM escape-hatch renderers, OffscreenCanvas, benchmark vs AG Grid. **Decision gate: ship or drop `addColumnGroup`/`removeColumnGroup` extension (§1.5.6)** | Parity sign-off + perf targets met; **§7 design-conformance suite green (contrast, grayscale-direction, reduced-motion)** |

Worklog tracked in `CLAUDE.md` / `WORKLOG.md`; each phase decomposed into the 28-task backlog.

---

## 11. Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Canvas text input impossible | DOM editor overlay mounted at cell rect (already core to design) |
| Accessibility on canvas | Parallel ARIA DOM shadow (§8) |
| Rich/interactive custom cells | DOM-renderer escape hatch; reserve canvas for hot cells |
| API surface is enormous (~300 methods) | Prioritize by blotter usage; stub-with-throw the long tail, fill per phase |
| DPR / multi-monitor blur | Re-scale backing store on DPR change; re-resolve metrics |
| Framework component perf | Route all framework comps through DOM escape hatch only; forbid on tick path |
| **Detail-row height mutation is O(k) on a flat prefix-sum array** | Pluggable offset backing; Fenwick tree when `masterDetail`/auto-height enabled — decided in **Phase 0**, not retrofitted (§2.2, §4.15.2) |
| **Detail row spans pinned regions, breaking the 3-canvas split** | Dedicated `fullWidthLayer` DOM container stacked above all three canvases; each canvas punches out its Y-band slice (§4.15.1) |
| **`detailRowAutoHeight` measure→layout feedback loop** | Two-phase frame with height-change epsilon; debounce nested cascade to one flush/frame (§4.15.2, §4.15.5) |
| **Detail instance churn on scroll** | LRU of live instances (`keepDetailRowsCount`); retain scroll/expand state by master row id beyond the LRU (§4.15.3) |
| **Tree reparenting transactions trigger full rebuilds** | Surgical detach/re-attach + agg recompute along old **and** new ancestor chains only; property-based test asserts convergence with full rebuild (§4.14, §9) |
| **Tree agg double-counts parent's own values** | Explicit `includeSelfInAgg`; weighted-avg weights by **leaf** notional, never parent (§4.14) |
| **Nested master/detail unbounded depth** | `maxDetailDepth` (default 2); outward height cascade debounced (§4.15.5) |
| **Group split across pin boundary modeled as one object** | Two-tier `ProvidedColumnGroup` (state) / `ColumnGroup` (per-region instance) split, designed in **Phase 1** — retrofitting this means rewriting header layout (§1.5.2) |
| **Deep group nesting eats the viewport** | Header height is `maxGroupDepth × groupHeaderHeight + …`; soft-cap depth at 3 with dev-mode warning (§1.5.5) |
| **`addColumnGroup` extension breaks `columnDefs` round-trip** | Explicit decision gate at Phase 8; methods optional (`?:`) so absence is type-legal; if shipped, `getColumnDefs()` must synthesize ad-hoc groups (§1.5.6) |
| **DOM editor doesn't align with canvas cell — grid "feels like a website"** | Pixel-registration is a hard requirement with a glyph-diff test in Phase 3 (§7.6, §9) |
| **Desk rejects lavender accent / has house color conventions** | Accent, gain, and loss are tokens, never constants; a desk overrides `ResolvedTheme`, never code. Direction survives override because it's triple-encoded (§7.1) |
| **Thousands of independently-decaying flash cells stall the frame** | Flash lives on its own layer with per-cell dirty rects; decay is a pure function of `now − lastTickAt` (no per-cell timers, no animation queue); coalesce on re-tick (§7.2) |
