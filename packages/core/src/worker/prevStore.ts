/**
 * Per-row previous-value snapshots for PREV([field]) calc expressions.
 * Updated on worker transactions before new values are written.
 */
export class PrevStore {
  private byRow = new Map<string, Map<string, unknown>>();

  clear(): void {
    this.byRow.clear();
  }

  /** Snapshot current field values before an update is applied. */
  captureBeforeUpdate(
    id: string,
    next: Record<string, unknown>,
    current: Record<string, unknown> | undefined,
  ): void {
    if (!current) return;
    let bag = this.byRow.get(id);
    if (!bag) {
      bag = new Map();
      this.byRow.set(id, bag);
    }
    for (const key of Object.keys(next)) {
      if (key in current) bag.set(key, current[key]);
    }
  }

  /** Read a previous value; returns null when unknown (PREV semantics). */
  get(rowId: string, field: string): unknown {
    const v = this.byRow.get(rowId)?.get(field);
    return v === undefined ? null : v;
  }

  lookup(rowId: string): (field: string) => unknown {
    return (field) => this.get(rowId, field);
  }

  removeRow(id: string): void {
    this.byRow.delete(id);
  }
}
