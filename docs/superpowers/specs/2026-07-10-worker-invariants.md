# Worker data plane — invariants

## Authority
1. When `dataWorkerActive`, the worker RowStore is authoritative for row
   field values after the last acknowledged transaction.
2. Main **keeps** a full row mirror by default (API, rules, paint fallback).
   Mirror may be dropped only when `workerOwnsRowData === true` (Extreme /
   memory mode) after a warm viewport chunk. Compare mode always keeps the
   mirror.
3. Displayed model (`displayed` ids + kinds + aggData) comes from the
   worker `modelUpdated` push, except during incremental agg patch
   windows (aggregatesUpdated) which mutate aggData only.
4. Paint prefers the current `viewportChunk` when it covers a cell; otherwise
   falls back to the main mirror. Never clear the chunk on tick/dataOnly
   updates — replace atomically on prefetch, or clear only when the displayed
   id list changes.

## Transaction ordering
5. Update-only ticks are fire-and-forget (coalesced). Structural
   setPipelineConfig + rebuildModel are serialised ahead of tick flushes so
   expand/collapse is not starved. Prefer await-reply for structural ops.

## Fallback
6. Construction failure / worker `error` push → `fallbackDataWorker`:
   restore mirror from `workerSeedRows` if needed, `rowDataMode='main'`,
   `refreshModel()`.
7. Ineligibility is evaluated in `workerDataPlaneConfig()`; default
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
| Active quick filter with any valueGetter/no-field displayed col | full plane fallback | yes |
| External filter present | full plane fallback | yes |
| Custom function aggFunc | full plane fallback | yes |

## Dual-worker retirement
8. After Phase C, `workerAggregation` is ignored (warn once if set).
9. Incremental aggregation is an internal pipeline mode, not a second Worker.
