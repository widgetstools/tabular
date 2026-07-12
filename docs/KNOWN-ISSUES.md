# Known issues / follow-ups

Working list of confirmed-or-suspected defects found during reviews, soaks,
and the STOMP datasource migration. Newest first. Remove entries when fixed.

## From the STOMP datasource migration (2026-07-11)

1. **Calc columns — CONFIRMED core bug.** A calc column referencing a field
   with no plain sibling column fails `CalcResolver.isWorkerEligible()` and
   silently falls back to main-thread mode, where aggregate-scope calc
   (`SUM`/`AVG` with scope) evaluates against an empty `aggValues` array.
   Observed symptoms before workaround: one calc column showing a neighbor's
   value; full-grid blank-out when ungrouping (not fully explained — open
   gap). Evidence: `.superpowers/sdd/stomp-batch-b-report.md` (executed the
   real pipeline code in isolation).
2. **Pagination footer** shows `0 to 0 of 0` / `Page 1 of 1` on first mount
   when rowData arrives asynchronously (setRowData after mount); corrects on
   the first navigation click. Footer isn't refreshed on `modelUpdated`.
3. **Rules — UNCONFIRMED.** Delta-based (`relativeChange`) rules never
   visibly fired over 2+ minutes of ~10k updates/s streaming while a
   non-delta style rule fired continuously. Needs focused investigation
   (threshold/config vs. delta-ref starvation).
4. **React wrapper** re-applies the `rowData` prop by identity — an inline
   `[]`/literal prop silently wipes api-streamed rows on any re-render.
   Pages use stable constants as a workaround; wrapper should document or
   dampen this (part of the known frozen-props family).

## From the OpenFin freeze investigation (2026-07-11)

5. **`prevByRow` PREV-capture grows unbounded under ticking** (plateaus at
   distinct-rows × ticked-fields; ~+0.6–1GB at 1M rows). Measured: 24-min
   OpenFin soak — idle heap flat at 528MB; under 1k updates/s heap tracks
   prevByRow (~478k bags in 12 min). Fix direction: capture PREV only when
   an expression actually uses `PREV` (registration-time flag) and prune on
   row removal. `grid.ts` `capturePrevFromChanges` / `snapshotPrevBeforeTransaction`.
6. **`FlashManager.entries` never evicts** and `hasActive()` scans the full
   map every frame while any flash is active. Harmless in owns-mode
   (measured flash=0) but a growth + O(n)-per-frame hazard for ordinary
   ticking pages over long sessions. Fix direction: lazy eviction of expired
   entries (keep dir-persistence via a separate bounded structure) or
   periodic sweep.

## Earlier (see also docs/superpowers/specs/2026-07-11-dom-renderer-design.md follow-ups)

7. Core worker `pendingTx` drop on rebuild + `dataOnly` aggregate gaps
   (tracked; affects canvas and @tabular/dom identically).
8. Editing: editors anchor by display index — model refresh while an editor
   is open commits into the wrong row (why the STOMP Editing page defaults
   live updates OFF).
