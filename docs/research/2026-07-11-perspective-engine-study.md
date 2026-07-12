# Perspective engine study — where a bespoke Rust/WASM engine can win

**Date:** 2026-07-11 · **Source:** FINOS Perspective @ master (shallow clone), v3.8-era.
Paths cited as `file:line` under `rust/perspective-server/cpp/perspective/src/` unless noted.
Context: evaluating (a) Perspective as a drop-in engine behind a tabular data-pipeline
seam, and (b) a specialized Rust→WASM engine as a competing implementation of that seam.

## TL;DR

Perspective's **structural** incrementality (which rows/tree-nodes/traversal entries are
touched per tick) is excellent and worth mirroring. Its **aggregate value** maintenance is
only incremental for SUM/COUNT — MEAN/MIN/MAX/MEDIAN/VARIANCE/DISTINCT are full-subtree
rescans per touched ancestor per tick. Its **read path** pays a heavy location-transparency
tax: two disjoint WASM heaps, protobuf + JSON-string serialization, ~10 copy/transform
stages per viewport read, and the datagrid ignores the engine's delta capability entirely —
every update tick re-fetches and re-parses the whole visible window. A specialized engine
(fixed schema, one view config, keyed full-row-replacement updates, SharedArrayBuffer
viewport) attacks exactly the parts that are not incremental today.

## Write path (C++ engine core)

### What's genuinely incremental (steal these)

- **Batch flatten/coalesce**: N same-key updates in a batch collapse to one row before any
  processing (`gnode.cpp:309`).
- **Cell-level transition flags**: each batch row is diffed old-vs-new per cell against the
  master table (`gnode.cpp:653-655`, `calc_transition` `gnode.cpp:183-218`); downstream
  deltas fire only on genuinely-changed cells (`context_zero.cpp:592-610`).
- **Strand-table topology maintenance**: a tiny delta-tree of only the changed rows is built
  and unified into the sparse aggregate tree — only ancestors of changed rows are revisited
  (`tree_context_common.cpp:30-163`, `sparse_tree.cpp:836-953`).
- **Incremental merge-sort** in the flat traversal: sort only the batch's rows, merge into
  the sorted index, early-out when nothing changed (`flat_traversal.cpp:283-352`).
- **Filter re-eval batch-scoped only** (`context_zero.cpp:109-147`).
- Aggregate column topo-sort + dedup (`sparse_tree.cpp:1016-1050`); agg-row freelist
  (`sparse_tree.cpp:1111-1128`).

### What's NOT incremental (the opening)

Per touched tree node, `update_agg_table` (`sparse_tree.cpp:1131`):

| Aggregate | Behavior |
|---|---|
| SUM, COUNT | Incremental (signed strand add; nstrands) `sparse_tree.cpp:1195,1200` |
| SUM w/ NaN or expression col | **Falls back to full subtree rescan — one NaN poisons a subtree's update cost permanently** `sparse_tree.cpp:1160-1193` |
| MEAN | **Stores a running (sum,count) pair but ignores it — full column re-read per node per tick** `sparse_tree.cpp:1209-1236` |
| MIN / MAX | **Full rescan + std::min/max_element over the subtree every tick; no retraction structure** `sparse_tree.cpp:1596-1675` |
| MEDIAN, Q1/Q3, VARIANCE, STDDEV, DISTINCT, UNIQUE, JOIN, DOMINANT, … | **Full-subtree rescans** `sparse_tree.cpp:1290-2106` |

Touched nodes include all ancestors of a changed row, so one changed row costs
~O(subtree × depth) for rescan-class aggregates. `get_pkeys` allocates a fresh vector and
does one hash lookup per pkey on every call (`sparse_tree.cpp:2343-2355`,
`gnode_state.cpp:525-533`).

### Generality tax (a fixed-schema engine deletes all of this)

- String interning on every pkey and string cell (`gnode_state.cpp:103`,
  `context_zero.cpp:116+`, `sparse_tree.cpp:881+`).
- `t_dtype` runtime switches at every layer; all arithmetic through the `t_tscalar` tagged
  union (`gnode.cpp:402-561`, `gnode_state.cpp:366+`).
- Five context kinds fan-out-dispatched per tick (`gnode.cpp:1279-1303`).
- ExprTK expression recompute per context per tick (`gnode.cpp:1311-1478`).
- Six transitional tables (FLATTENED/DELTA/PREV/CURRENT/TRANSITIONS/EXISTED) cleared,
  reserved, written every tick (`gnode.cpp:357-376`).
- History of O(n²) hotspots in context row-mapping, recently patched
  (`context_one.cpp:534`, `context_two.cpp:1150`).

## Read path (protocol, WASM boundary, datagrid)

Architecture: client/server protocol even in-tab. The engine WASM (worker) and the client
WASM (main thread) have **disjoint linear memories**; all traffic is protobuf bytes over
`postMessage` (`rust/perspective-client/perspective.proto`,
`rust/perspective-js/src/ts/wasm/browser.ts:70-114`).

### Viewport read (`to_columns_string`) — the datagrid's actual data path

The datagrid fetches viewport slices as **JSON strings**
(`packages/viewer-datagrid/src/ts/data_listener/index.ts:80-86`), not Arrow. A byte of
cell data undergoes ~10 stages: columnar store → `t_data_slice` copy (`view.cpp:790`) →
JSON text (`view.cpp:2593-2772`) → protobuf wrap (`server.cpp:838`) → wasm-heap `.slice()`
copy → postMessage → copy into client-wasm heap → protobuf decode → wasm-bindgen string
marshal → `JSON.parse` → format → DOM. Plus parallel `num_columns()` / `schema()` side
round-trips per fetch.

### Streaming updates — deltas are computed but never used

The engine can emit precise changed-row **Arrow deltas** (`get_row_delta`,
`view.cpp:1699-1733`; `server.cpp:3168-3193`), but delta mode is opt-in and **the viewer
subscribes without it** (`perspective-viewer/src/rust/session/view_subscription.rs:131-134`).
Every update is a bare "changed" signal + a `dimensions()` round-trip; the datagrid then
re-runs the full viewport JSON fetch (`viewer-datagrid/src/ts/plugin/draw.ts:37-39`).
**Per tick: full visible-window re-serialize + re-parse, regardless of how few cells
changed.**

### Batching, threading

- Updates between polls are coalesced well (single pending poll via setTimeout,
  `engine.ts:52-86`; dirty-table early-out `server.cpp:3198-3209`).
- No backpressure: unbounded futures channel (`local_poll_loop.rs:13-45`); redraws coalesce
  only via requestAnimationFrame.
- **Single-threaded WASM, no pthreads, no SharedArrayBuffer anywhere in the data path**
  (CMakeLists.txt:591-611; repo-wide grep: zero SAB/COOP/COEP hits outside a telemetry
  type alias).

## Where a specialized engine wins (mechanisms, not vibes)

1. **Retract-and-apply aggregate maintenance.** With keyed full-row replacement the old row
   is known: SUM/COUNT/MEAN/VARIANCE become O(1) per group per changed row; MIN/MAX need a
   per-group ordered multiset / value→count map (O(log n)) — vs Perspective's per-ancestor
   subtree rescans. This directly targets the rescan-class aggregates (our showcase page
   uses `avg` on price/yield — rescan class).
2. **SharedArrayBuffer zero-copy viewport.** Engine writes typed columnar viewport slices
   into a SAB; the canvas renderer reads synchronously mid-frame (atomics for dirty-range
   signaling). Deletes ~9 of the 10 read-path stages and the per-tick full-window JSON
   churn; repaint becomes dirty-cell-driven. Cost: requires same-origin +
   cross-origin-isolation; forfeits Perspective's remote-server transparency.
3. **Monomorphized fixed schema.** No interning, no tagged-scalar dispatch, no context
   polymorphism, no transitional-table materialization, no expression stage unless used.
4. **Keep their good ideas**: batch flatten, strand-style ancestor-only topology
   maintenance, incremental merge-sort traversal, agg dependency topo-sort, freelists.

## Sequencing decision (from the wider discussion)

1. Define an engine-agnostic async seam in `@tabular/core` (`createView(config)` →
   deltas + slice reads + expand/collapse).
2. Ship Perspective behind the seam first (weeks; fixes grouped-agg-under-ticks with a
   battle-tested engine; validates the async-viewport renderer architecture).
3. Rust engine as a competing seam implementation; Perspective stays as fallback and
   as the **correctness oracle for differential testing** (same STOMP stream into both,
   diff every aggregate every tick).

Related: `docs/superpowers/specs/2026-07-11-perspective-grid-design.md` (showcase page),
parked tabular bug `docs/KNOWN-ISSUES.md` item 7 (grouped aggregates stale while ticking).
