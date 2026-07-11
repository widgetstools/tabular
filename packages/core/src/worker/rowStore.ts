/**
 * Worker-side row store (W1). Mirrors the main-thread source set keyed by
 * stable row id; insertion order is preserved for stable sort tie-breaks.
 * Captures PREV snapshots on update transactions.
 */
import { PrevStore } from './prevStore';

export interface RowTransactionPayload {
  addIds?: string[];
  add?: unknown[];
  updateIds?: string[];
  update?: unknown[];
  removeIds?: string[];
}

export type Row = Record<string, unknown>;

export class RowStore {
  private rows = new Map<string, Row>();
  /** Insertion order — stable tie-break for sort. */
  private order: string[] = [];
  readonly prev = new PrevStore();

  get size(): number {
    return this.rows.size;
  }

  getRow(id: string): Row | undefined {
    return this.rows.get(id);
  }

  /** All row ids in insertion order. */
  ids(): string[] {
    return this.order.slice();
  }

  /** All rows in insertion order. */
  values(): Row[] {
    return this.order.map((id) => this.rows.get(id)!);
  }

  setAll(ids: string[], rows: Row[]): void {
    this.rows.clear();
    this.order.length = 0;
    this.prev.clear();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      this.rows.set(id, rows[i]);
      this.order.push(id);
    }
  }

  /** Apply a transaction batch; returns whether insertion order changed. */
  applyTransaction(tx: RowTransactionPayload): boolean {
    let structural = false;

    for (const id of tx.removeIds ?? []) {
      if (this.rows.delete(id)) {
        const i = this.order.indexOf(id);
        if (i >= 0) this.order.splice(i, 1);
        this.prev.removeRow(id);
        structural = true;
      }
    }

    const adds = tx.add ?? [];
    const addIds = tx.addIds ?? [];
    for (let i = 0; i < adds.length; i++) {
      const id = addIds[i];
      if (!id || this.rows.has(id)) continue;
      this.rows.set(id, adds[i] as Row);
      this.order.push(id);
      structural = true;
    }

    const updates = tx.update ?? [];
    const updateIds = tx.updateIds ?? [];
    for (let i = 0; i < updates.length; i++) {
      const id = updateIds[i];
      if (!id || !this.rows.has(id)) continue;
      const next = updates[i] as Row;
      this.prev.captureBeforeUpdate(id, next, this.rows.get(id));
      this.rows.set(id, next);
    }

    return structural;
  }
}
