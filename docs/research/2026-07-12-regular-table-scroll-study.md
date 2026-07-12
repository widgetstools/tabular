# regular-table scrolling — deep dive

**Date:** 2026-07-12 · **Source:** `regular-table` (npm, as shipped with
`@finos/perspective-viewer-datagrid` 3.8), original sources recovered from the
dist sourcemap (`dist/esm/regular-table.js.map`, `sourcesContent`). Paths cited
as `src/js/<file>`. Companion to the engine study
(`2026-07-11-perspective-engine-study.md`) and the pgrid phase-1 spec §6.

## TL;DR

regular-table **never scrolls content natively**. The `<table>` is clipped in
place inside the component; a hidden "virtual panel" div provides the scroll
range; and *every* scroll event triggers an async redraw that re-stamps the
visible cells in place. Smoothness comes from four properties: (1) the table is
glued to the viewport **by construction**, so a slow data listener shows the
complete previous window rather than blankness; (2) a same-window scroll does
no stamping at all — just two CSS-variable writes for the fractional row/column
offset; (3) draws are strictly serialized and coalesced per element; (4) scroll
position maps to rows **proportionally** (percent-of-scrollable), so any row
count fits a browser-height-capped panel.

## 1. DOM architecture (`scroll_panel.js:17–56`)

```
<regular-table>                      ← overflow:auto; the actual scroller
  #shadow-root
    <div .rt-virtual-panel>          ← invisible; sized to virtual content
    <div .rt-scroll-table-clip>      ← pinned at top/left, clips the table
      <slot> → <table>               ← the ONLY painted content, re-stamped per draw
```

- `.rt-virtual-panel` gets `height = min(BROWSER_MAX_HEIGHT, nrows*row_height + header)`
  (`_update_virtual_panel_height`, `scroll_panel.js:392–404`) and an analogous
  estimated width. Its only job is to make the scrollbars real.
- `.rt-scroll-table-clip` is positioned at the scroll origin (`top:0/left:0`
  in virtual modes, `_setup_virtual_scroll`) — so the table never moves with
  the scroll; the scroller scrolls an *empty* panel while the clip + table
  stay put in the viewport.

Consequence: there is no "content in scroll space" to blank out. Whatever the
table last painted remains fully visible until the next draw replaces it. This
is the root of the "rows never fall off" behavior.

## 2. The scroll → draw pipeline (`events.js:40–58`, `scroll_panel.js:413–421,446–538`)

`scroll` (passive) → `await this.draw({invalid_viewport: false})` →
`throttle_tag(this, internal_draw)`.

- **`throttle_tag` (`utils.js:91–108`)**: per-element async mutex + coalescer.
  If a draw is running, the next caller waits for it, then for at most one
  more, then *returns without drawing* — an arbitrarily fast scroll stream
  degrades to back-to-back serialized draws with everything in between
  dropped. No queue growth, no stampede.
- **`internal_draw`** each time: reads `num_rows` (a data-listener "phantom"
  call with a 0×0 viewport), re-sizes the virtual panel, computes the viewport
  (§3), then **validates** it (`_validate_viewport`, `scroll_panel.js:308–323`):
  the floored/ceiled row+column window is compared against the previous draw's.
  - **Window unchanged** → the `else` branch (`scroll_panel.js:531–533`): only
    `update_sub_cell_offset` runs — two CSS custom properties
    (`--regular-table--transform-y`, `--clip-y`; `scroll_panel.js:427–443`)
    that translate + clip the whole table by the fractional row offset
    (`sub-cell-scrolling.less:9–19`). **No DOM stamping, no data read.**
  - **Window changed** → `table_model.draw(...)` (an async generator) awaits
    the data listener for the *whole new window* and re-stamps the table. The
    sub-cell offset is applied on the generator's first yield, "before the
    next event loop so there is no scroll jitter" (`scroll_panel.js:500–506`).

While the awaited listener is slow, the old table (clip-pinned) just sits
there, complete. When data arrives, the whole window swaps at once — draws are
**atomic**; there is never a half-stamped viewport.

## 3. Viewport math (`_calculate_row_range`, `scroll_panel.js:174–197`)

Rows map to scroll position **proportionally**, not pixel-linearly:

```
total_scroll_height = virtual_panel.offsetHeight − container_height
percent_scroll      = ceil(scrollTop) / total_scroll_height
scrollable_rows     = nrows − container_height/row_height
start_row           = scrollable_rows * percent_scroll        // fractional!
end_row             = start_row + container_height/row_height
```

- `start_row` is fractional; `floor(start_row)` picks the window,
  `start_row % 1` drives the sub-cell offset. Same scheme for columns
  (`_calc_start_column`, fractional via accumulated widths).
- Because the panel is capped at `BROWSER_MAX_HEIGHT`, the percent mapping is
  also the row-count-compression mechanism — identical in spirit to pgrid's
  `MAX_PANEL_PX` percent-scroll (`windowMath.ts`), except regular-table uses
  it at *every* size, not just past the cap.
- **No overscan.** The window is exactly the visible rows; recycling relies on
  draw speed, not buffered rows.
- Column widths are *learned*: unknown columns are assumed 60px until
  rendered, and the virtual panel width is re-estimated as the user scrolls
  (`_max_scroll_column`, `_calc_scrollable_column_width`,
  `scroll_panel.js:247–383`) — the scrollbar breathes slightly on first
  horizontal pass. pgrid avoids this entirely with authoritative ColDef widths.

## 4. Ancillary mechanisms

- **Double buffering** (`scroll_panel.js:46–52`): optionally, on
  column-scroll/schema changes the table is `cloneNode()`d, the clone is
  swapped in as a static picture, the real table updates offscreen, then swaps
  back — trading latency for zero draw-in. The datagrid enables it for schema
  changes.
- **Safari/iOS glitch handlers** (`events.js:70–140`): wheel/touch events are
  re-dispatched with clamped scroll positions to defeat inertial overscroll
  artifacts around the fixed-position table.
- **`flush_tag`/`_draw_flush`** (`utils.js:86–89`): "await one rAF then the
  in-flight draw" — the datagrid uses it after engine updates to avoid
  stacking redraws.
- The datagrid's own listener adds the engine specifics on top (see the
  2026-07-12 datagrid study): windowed `to_columns_string`, `columns[path] ||
  fill(null)`, per-window `column_paths` refresh.

## 5. What pgrid adopted, and where it deliberately differs

| Mechanism | regular-table | pgrid (post `2a6515b`/`146c3c3`/`d8fb249`) |
|---|---|---|
| Content placement | Clip-pinned table; every scroll = redraw | Rows live in scroll space (translated layer) — native compositor scrolling when data is present |
| Same-window scroll | 2 CSS-var writes | 1 layer-transform write; in uncompressed mode literally zero JS (layer position is scroll-invariant) |
| Slow-data behavior | Old table sits pinned (whole window, stale) | Stale window rides natively at true coordinates; its edge **pins** to the viewport edge when escaped (continuous clamp → no rubberband, no blank) |
| Paint atomicity | Whole-window await, then swap | Same: swap gated on `rowMeta(firstRow) && rowMeta(lastRow)` |
| Draw serialization | `throttle_tag` mutex+coalescer | rAF-coalesced `sync` + materializer in-flight refetch coalescing |
| Scroll→row mapping | Percent-of-scrollable always | Pixel-exact until 10M px, percent after (`MAX_PANEL_PX`) |
| Overscan | None | 4 rows/cols each side (buffers small scrolls entirely) |
| Column widths | Learned at render, panel re-estimated | Authoritative from ColDefs, single-pass |
| Fractional offset | CSS vars + `clip-path` on the table | Folded into the layer transform |

The net effect: pgrid now has regular-table's two load-bearing guarantees
(viewport never blank, paints atomic) while keeping native scrolling — which
regular-table structurally cannot do — so within-window and small scrolls are
compositor-smooth with zero JS, and the stale-window path only engages when
the engine genuinely lags the scroll.

## 5b. Addendum (same day): why clip-pinning is load-bearing — async scroll

Follow-up user reports (flicker/jerk/blank persisting under real input)
exposed the one regular-table property the first pass under-weighted:
**content must not live in scroll space at all.** Real wheel/trackpad
scrolling is asynchronous compositor scrolling — the compositor moves
scroll-space content and paints *before* any main-thread rAF handler runs, so
a scroll-space row layer is displaced for at least one painted frame per
input, no matter how fast the sync is. Synthetic `scrollTop` writes commit in
the same frame as the correcting sync and can never reproduce this; only
`mouse.wheel` (real input) shows it. pgrid adopted the equivalent of the
clip-pin: the row layer is `position: sticky` (compositor-pinned), rows are
viewport-relative, and all motion — both axes — is written by the sync
(`7169cf1`). Row overscan was raised to 12 (columns keep 4) since vertical
windows move every 26px vs ~120px per column. Verified with real
`mouse.wheel` in an isolated tab under the full feed: vertical 763 frames,
0 backward movements, 100% min/avg viewport coverage; horizontal identical
coverage.

## 6. Verification snapshots (pgrid, 20k×372 @ ~10k updates/s, warm)

- Sustained wheel scroll (80px/50ms, 4s): **0 backward row movements** in 485
  observed frames (pre-fix: 144, max 80px — the rubberband).
- Half-viewport steps / flicks / wheel / full-range sweep: **100% viewport
  coverage, worst and average**.
- Sub-cell steps (4px): rows move exactly 4px per step; no engine reads, no
  re-stamps within an unchanged window.
