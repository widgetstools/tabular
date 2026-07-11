# tabular

A canvas-first data grid engine for fixed-income blotters — vanilla TypeScript core with a thin React wrapper. Implements the [cggrid plan](./CGGRID-IMPLEMENTATION-PLAN%20(1).md) as **tabular**: AG Grid–shaped API, canvas hot path, DOM for editors and chrome.

## Monorepo layout

```
tabular/
├── packages/
│   ├── core/          @tabular/core   — Tabular engine (canvas, row model, API)
│   └── react/           @tabular/react  — <TabularGrid /> mount/prop-diff shim
└── apps/
    ├── showcase/        Feature gallery (React) — one page per capability
    └── blotter/         FI trading blotter (vanilla TS) — live ticks, no framework
```

### Packages

| Package | Import | Role |
|---------|--------|------|
| `@tabular/core` | `import { Tabular } from '@tabular/core'` | Canvas grid: scroll virtualization, sort/filter, selection, editing, tick flash |
| `@tabular/react` | `import { TabularGrid } from '@tabular/react'` | React wrapper; core never depends on React |

### Apps

| App | Command | Port | Demonstrates |
|-----|---------|------|--------------|
| **showcase** | `npm run dev:showcase` | 5173 | Basic grid, 100k rows, live ticks, sort/filter, editing, selection, theming |
| **blotter** | `npm run dev:blotter` | 5174 | Vanilla `new Tabular()`, 20k bonds, async tick batching, density/theme toolbar, CSV export |

## Quick start

```bash
npm install
npm run dev:showcase   # React feature gallery
npm run dev:blotter    # vanilla FI blotter
npm run build          # typecheck + production builds
```

## Worker data plane

Default `rowDataMode` is worker. Force main with `rowDataMode: 'main'`.
Verify: `npm run test:worker`

## Framework agnostic

`@tabular/core` has **zero runtime dependencies** — it is plain TypeScript
against the DOM/canvas APIs, so it mounts in any framework (or none):

```ts
// Vanilla / any framework
import { Tabular } from '@tabular/core';
const grid = new Tabular(document.getElementById('grid')!, { columnDefs, rowData });
grid.destroy(); // teardown
```

```ts
// Angular — same lifecycle mapped to component hooks
@Component({ selector: 'app-grid', template: '<div #host class="grid-host"></div>' })
export class GridComponent implements AfterViewInit, OnDestroy {
  @ViewChild('host') host!: ElementRef<HTMLDivElement>;
  private grid?: Tabular<Bond>;
  ngAfterViewInit() { this.grid = new Tabular(this.host.nativeElement, options); }
  ngOnDestroy() { this.grid?.destroy(); }
}
```

`@tabular/react` is a thin mount/prop-diff shim over the same core; an Angular
or Vue wrapper would be equally small (mount on init, `api.*` for updates,
`destroy()` on teardown).

### Icons

All grid iconography (sort arrows, group chevrons, clear ×, menu check) uses
[Lucide](https://lucide.dev) path data embedded in `@tabular/core` — no icon
library dependency, no framework components. Canvas paints them via `Path2D`;
DOM overlays use inline `<svg>`. Swap in another set (e.g. Phosphor) at
runtime:

```ts
import { registerIcons } from '@tabular/core';
// 24×24 viewBox stroke paths, same names used across the grid
registerIcons({ 'chevron-down': ['M4 9l8 7 8-7'], x: ['M5 5l14 14', 'M19 5L5 19'] });
```

## Implemented

- Canvas body + header, native-scroll virtualization
- Prefix-sum column offsets; pinned left/right regions
- Client-side row model: filter → sort → group/tree → display
- Column groups (expand/collapse, `columnGroupShow`, pin-boundary aware)
- Sorting (multi via shift), column filters (full AG simple-operator set incl.
  `notContains`, `endsWith`, `notEqual`, `>=`, `<=`, `blank`), quick filter,
  floating filters (text / number / set)
- Row grouping + aggregation (incl. weighted average), drag-to-group panel, sticky
  expand state, agg func in headers (`sum(Notional)`, `suppressAggFuncInHeader`),
  `groupTotalRow` / `grandTotalRow` footers, sticky group headers (`groupSticky`)
- Tree data (`treeData` + `getDataPath` or `treeDataChildrenField`): filler nodes,
  leaf-only aggregation, two-pass filtering with `excludeChildrenWhenTreeDataFiltering`
- Decaying tick flash (`applyTransaction` / `applyTransactionAsync`)
- DOM editor overlay, pixel-registered to canvas cells; `editable` callbacks,
  `singleClickEdit`, `startEditingCell` / `stopEditing`,
  `cellEditingStarted/Stopped` events
- Undo/redo (`⌘Z` / `⇧⌘Z`) — opt-in via `undoRedoCellEditing` (AG default,
  limit 10)
- Cell range selection (`cellSelectionChanged`); clipboard copy / cut / TSV
  paste (`⌘C` / `⌘X` / `⌘V`), `copyHeadersToClipboard`, `clipboardDelimiter`
- Row selection: legacy strings or AG v32.2+ `{ mode: 'multiRow',
  enableClickSelection, enableSelectionWithoutKeys, checkboxes, headerCheckbox }`;
  injected `ag-Grid-SelectionColumn` when checkboxes are on
- Client-side pagination (`pagination`, `paginationPageSize`, panel + full API)
- Context menus (cells + headers, customizable via `getContextMenuItems`;
  AG built-in items `'copy'`, `'copyWithHeaders'`, `'export'`)
- Status bar (`statusBar: true` or AG-shaped `{ statusPanels }`): row counts,
  selection count, live range aggregates (numeric cells, AG semantics)
- Overlays: `loading` grid option (+ `setGridOption('loading', …)`), auto
  no-rows / no-matching-rows (`overlay*Template` overrides)
- Clipboard hooks: `processCellForClipboard`, `processCellFromClipboard`,
  `processDataFromClipboard`; events `pasteStart/End`, `undoStarted/Ended`,
  `redoStarted/Ended`
- Themes: `dark` / `light`; density: `comfortable` / `compact` / `dense`
- Keyboard nav, CSV export (`exportCsv` / `getDataAsCsv` / `exportDataAsCsv`)
- AG-named API aliases: `setColumnsPinned/Visible`, `moveColumns`,
  `autoSizeAllColumns`, `clearCellSelection`, `getCellRanges`, `getQuickFilter`

## Roadmap → future apps

As kernel features land, add focused demos under `apps/`:

| Planned app | Kernel feature |
|-------------|----------------|
| `apps/column-groups` | `ColGroupDef`, pin-boundary split instances |
| `apps/grouping` | Row grouping, aggregation, sticky group headers |
| `apps/pivot` | Pivot mode, secondary columns |
| `apps/master-detail` | Punch-out detail rows, nested grids |

StarUI (`surface="cgrid"`) will consume `@tabular/core` via translators once parity milestones are met.

## Design reference

See [CGGRID-IMPLEMENTATION-PLAN (1).md](./CGGRID-IMPLEMENTATION-PLAN%20(1).md) for the full architecture spec (rendering layers, column group model, phased delivery, UX tokens).
