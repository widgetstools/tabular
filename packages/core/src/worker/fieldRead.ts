/**
 * Mirror of the main-thread field-read semantics (grid.ts `valueOf`): dotted
 * fields walk nested objects nil-safely; flat fields read the property
 * directly. Every worker pass that reads a row value by `field` MUST go
 * through this helper — a flat `row[field]` read on a dotted field returns
 * undefined and silently diverges the worker's sort/filter/group/agg results
 * from the main model (violates worker-invariants spec §1).
 */
export function readField(
  row: Record<string, unknown> | null | undefined,
  field: string,
): unknown {
  if (row == null) return undefined;
  if (field.indexOf('.') === -1) return row[field];
  let acc: unknown = row;
  for (const k of field.split('.')) {
    if (acc == null || typeof acc !== 'object') return undefined;
    acc = (acc as Record<string, unknown>)[k];
  }
  return acc;
}
