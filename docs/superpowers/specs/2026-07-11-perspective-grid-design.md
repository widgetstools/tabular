# FinOS Perspective showcase page — design

**Date:** 2026-07-11
**Status:** Approved by default (autonomous session — user requested the feature and was not available for interactive review; defaults chosen to match existing showcase conventions.)

## Goal

Add a showcase page that embeds a FinOS Perspective grid (`<perspective-viewer>`),
populated from the existing STOMP positions feed, with row grouping and
aggregations that re-compute live as ticks arrive. This gives the showcase a
side-by-side reference for grouped-aggregate behavior under ticking load
(useful contrast for the parked tabular worker `dataOnly` staleness bug).

## Decisions

- **Packages:** `@finos/perspective`, `@finos/perspective-viewer`,
  `@finos/perspective-viewer-datagrid` (v3.8.0). No d3fc charts plugin — grid only.
- **WASM init (Perspective 3.x):** `perspective.init_server(fetch(SERVER_WASM))` +
  `perspective_viewer.init_client(fetch(CLIENT_WASM))` with Vite `?url` imports;
  `perspective.worker()` then spawns its inline-blob web worker. Requires
  `build.target: 'esnext'` in `vite.config.ts`; the three packages are excluded
  from `optimizeDeps` so esbuild pre-bundling can't break asset resolution.
- **Data flow:** reuse the shared feed singleton — `useFiFeed()` snapshot →
  `worker.table(slimRows, { index: 'positionId' })`; `useFiUpdates(batch =>
  table.update(slimBatch))`. Feed updates are full-row replacements keyed by
  `positionId`, which matches Perspective indexed-table update semantics, so
  grouped aggregates tick natively.
- **Slim schema, not 1500 columns:** rows are mapped to a flat ~16-column record
  (ids, desk/trader/region/currency/sector/rating groupables, and the numeric
  measures: quantity, notionalAmount, marketValue, currentPrice, pnl, dailyPnl,
  yield, dv01, spread). The table is created with an explicit schema so types
  are stable regardless of the first batch's values.
- **Default view:** `group_by: ['desk', 'currency']`, sum aggregates for
  notional/MV/PnL/DV01, avg for price/yield; `settings` panel available so the
  user can regroup interactively. Theme follows the app (Pro Dark / Pro via a
  `body.light` check, same convention as `Theming.tsx`).
- **Offline behavior:** when the STOMP server isn't running the feed reports
  `offline`; the page shows the standard `FeedBadge` and an empty-state note
  (no synthetic fallback — this page exists to demo the live feed; other pages
  already cover synthetic data).
- **Lifecycle:** WASM init is a module-level singleton promise (pages remount
  on nav; init must run once). Table/viewer are created per mount and deleted
  on unmount (`viewer.delete()`, `table.delete()`).

## Files

- `apps/showcase/src/pages/PerspectiveGrid.tsx` — new page (id `perspective`,
  label "Perspective (FinOS)").
- `apps/showcase/src/App.tsx` — register page after `rtagg`.
- `apps/showcase/vite.config.ts` — esnext target + optimizeDeps exclude.
- `apps/showcase/src/styles.css` — minimal sizing for the embedded viewer.

## Testing

Typecheck (`tsc -p apps/showcase`), then live verification: run
`npm run dev:stomp` + `npm run dev:showcase`, open the page in a browser,
confirm snapshot loads, groups render, and grouped aggregate cells tick.
