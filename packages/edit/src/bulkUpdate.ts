/**
 * Bulk update: set/replace a column over a filtered set of rows.
 */
export interface BulkUpdateRequest<T = Record<string, unknown>> {
  field: string;
  /** New value, or a mapper from old → new. */
  value: unknown | ((old: unknown, row: T) => unknown);
  rows: T[];
}

export interface BulkUpdatePreviewCell {
  rowId: string;
  field: string;
  before: unknown;
  after: unknown;
}

export function previewBulkUpdate<T extends Record<string, unknown>>(
  req: BulkUpdateRequest<T>,
  getRowId: (row: T) => string,
): BulkUpdatePreviewCell[] {
  return req.rows.map((row) => {
    const before = row[req.field];
    const after =
      typeof req.value === 'function'
        ? (req.value as (old: unknown, row: T) => unknown)(before, row)
        : req.value;
    return { rowId: getRowId(row), field: req.field, before, after };
  });
}

export function bulkUpdateToRows<T extends Record<string, unknown>>(
  preview: BulkUpdatePreviewCell[],
  getRow: (rowId: string) => T | undefined,
): T[] {
  const out: T[] = [];
  for (const cell of preview) {
    const base = getRow(cell.rowId);
    if (!base) continue;
    out.push({ ...base, [cell.field]: cell.after });
  }
  return out;
}
