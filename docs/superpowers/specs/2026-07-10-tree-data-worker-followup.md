# Tree data on worker — follow-up

## Why deferred
treeData.ts / worker tree pass need path encoding, async children,
and excludeChildrenWhenTreeDataFiltering parity with AG.

## Entry criteria before starting
- Pivot worker (Task 7) merged
- WorkerCoordinator stable
- Compare harness supports tree fixtures

## Approach sketch
Port cgrid tree handling + Tabular `treeData.ts` into `passes/treePass.ts`,
same flatten contract as GroupPass displayed entries.
