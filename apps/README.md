# tabular apps

Demo applications for `@tabular/core` and `@tabular/react`. Each app is a standalone Vite project wired to workspace packages.

## Running

From the repo root:

```bash
npm run dev:showcase   # http://localhost:5173
npm run dev:blotter    # http://localhost:5174
```

## showcase

React gallery with a sidebar — one page per feature:

| Page | Feature |
|------|---------|
| Basic grid | Sort, resize, pin, 500 rows |
| 100k rows | 100,000 × 43 columns, dense mode |
| Live ticks & flash | `applyTransactionAsync`, decaying flash |
| Sorting & filtering | Multi-sort, column filters, quick filter |
| Editing | Type-to-replace, F2, Tab/Enter commit |
| Selection | Single/multi, shift-extend, Ctrl toggle |
| Theming & density | Dark/light, comfortable/compact/dense |

Entry: `apps/showcase/src/App.tsx`

## blotter

Vanilla TypeScript — no React. Reference integration for OpenFin/browser hosts that mount the grid directly:

```ts
import { Tabular } from '@tabular/core';
const grid = new Tabular(container, { columnDefs, rowData, getRowId });
grid.applyTransactionAsync({ update: batch });
```

20,000 FI bonds with live bid/ask/yield/spread ticks, toolbar controls, status bar with weighted spread on selection.

Entry: `apps/blotter/src/main.ts`
