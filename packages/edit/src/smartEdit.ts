/**
 * Smart edit: range-targeted arithmetic applied as one journal batch.
 */
export type SmartEditOp = 'mul' | 'div' | 'add' | 'sub';

export interface SmartEditPreviewCell {
  rowId: string;
  colId: string;
  before: unknown;
  after: unknown;
}

export interface SmartEditRequest {
  op: SmartEditOp;
  operand: number;
  /** Cells to transform (range selection flattened). */
  cells: Array<{ rowId: string; colId: string; value: unknown }>;
}

export function applySmartOp(value: unknown, op: SmartEditOp, operand: number): unknown {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isFinite(operand)) return value;
  switch (op) {
    case 'mul':
      return n * operand;
    case 'div':
      return operand === 0 ? value : n / operand;
    case 'add':
      return n + operand;
    case 'sub':
      return n - operand;
  }
}

/** Build before/after preview without mutating. */
export function previewSmartEdit(req: SmartEditRequest): SmartEditPreviewCell[] {
  return req.cells.map((c) => ({
    rowId: c.rowId,
    colId: c.colId,
    before: c.value,
    after: applySmartOp(c.value, req.op, req.operand),
  }));
}

/**
 * Group preview cells into per-row update objects for applyTransaction.
 * `getRow` supplies the current row; only listed colIds are overwritten.
 */
export function smartEditToUpdates<T extends Record<string, unknown>>(
  preview: SmartEditPreviewCell[],
  getRow: (rowId: string) => T | undefined,
  fieldForColId: (colId: string) => string | undefined,
): T[] {
  const byRow = new Map<string, T>();
  for (const cell of preview) {
    let row = byRow.get(cell.rowId);
    if (!row) {
      const base = getRow(cell.rowId);
      if (!base) continue;
      row = { ...base };
      byRow.set(cell.rowId, row);
    }
    const field = fieldForColId(cell.colId) ?? cell.colId;
    (row as Record<string, unknown>)[field] = cell.after;
  }
  return [...byRow.values()];
}
