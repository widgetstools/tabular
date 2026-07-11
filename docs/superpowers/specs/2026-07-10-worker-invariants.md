# Worker data plane — invariants

## Authority
1. When `dataWorkerActive`, the worker RowStore is authoritative for row
   field values after the last acknowledged transaction.
2. Main may keep a mirror only when `workerOwnsRowData === false` or
   compare mode is on.
3. Displayed model (`displayed` ids + kinds + aggData) comes from the
   worker `modelUpdated` push, except during incremental agg patch
   windows (aggregatesUpdated) which mutate aggData only.

## Transaction ordering
4. Main must not apply a second tx to the worker until the previous
   applyTransaction reply has resolved OR the protocol documents
   unordered fire-and-forget with sequence numbers (pick one; prefer
   await-reply for structural, fire-and-forget for update-only with seq).

## Fallback
5. Construction failure / worker `error` push → `fallbackDataWorker`:
   restore mirror from `workerSeedRows` if needed, `rowDataMode='main'`,
   `refreshModel()`.
6. Ineligibility is evaluated in `workerDataPlaneConfig()`; default
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
7. After Phase C, `workerAggregation` is ignored (warn once if set).
8. Incremental aggregation is an internal pipeline mode, not a second Worker.
