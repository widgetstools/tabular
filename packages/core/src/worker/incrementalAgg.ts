/**
 * Incremental group aggregation engine. Mirrors the row store and maintains
 * per-group accumulators:
 *
 *  - sum / count / avg / weightedAverage — O(1) delta per changed row
 *    (subtract old value, add new value).
 *  - min / max / first / last — the touched group is marked dirty and its
 *    members rescanned (bounded by group size, only for dirty groups).
 */
import type {
  AggModel,
  AggTransactionPayload,
  AggWorkerAggCol,
  GroupAggUpdate,
} from './protocol';
import { workerGroupKey } from './protocol';

interface ColAcc {
  sum: number;
  numCount: number; // numeric values only (avg denominator)
  wNum: number; // Σ value×weight (weightedAverage)
  wDen: number; // Σ weight
}

interface NodeState {
  id: string;
  /** Leaf rowIds under this node (all descendant leaves). Insertion-ordered. */
  members: Set<string>;
  acc: Map<string, ColAcc>;
}

type Row = Record<string, unknown>;

export class AggEngine {
  private rows = new Map<string, Row>();
  private model: AggModel = { groupCols: [], aggCols: [], grandTotal: false };
  /** rowId → node ids it contributes to (one per group level + grand total). */
  private nodesByRow = new Map<string, string[]>();
  private nodes = new Map<string, NodeState>();

  setAggModel(model: AggModel): void {
    this.model = model;
    this.rebuildAll();
  }

  setRowData(ids: string[], rows: Row[]): void {
    this.rows.clear();
    for (let i = 0; i < ids.length; i++) this.rows.set(ids[i], rows[i]);
    this.rebuildAll();
  }

  /** Returns the dirty-group updates produced by this batch. */
  applyTransaction(tx: AggTransactionPayload): GroupAggUpdate[] {
    const dirty = new Set<string>();

    for (const id of tx.removeIds ?? []) {
      const row = this.rows.get(id);
      if (!row) continue;
      this.detachRow(id, row, dirty);
      this.rows.delete(id);
    }

    const adds = tx.add ?? [];
    const addIds = tx.addIds ?? [];
    for (let i = 0; i < adds.length; i++) {
      const id = addIds[i];
      if (this.rows.has(id)) continue;
      const row = adds[i] as Row;
      this.rows.set(id, row);
      this.attachRow(id, row, dirty);
    }

    const updates = tx.update ?? [];
    const updateIds = tx.updateIds ?? [];
    for (let i = 0; i < updates.length; i++) {
      const id = updateIds[i];
      const oldRow = this.rows.get(id);
      if (!oldRow) continue;
      const newRow = updates[i] as Row;
      const oldNodes = this.nodesByRow.get(id) ?? [];
      const newNodes = this.nodeIdsFor(newRow);
      if (sameIds(oldNodes, newNodes)) {
        // Fast path: same groups — delta the accumulators in place.
        for (const nodeId of oldNodes) {
          const node = this.nodes.get(nodeId);
          if (!node) continue;
          for (const agg of this.model.aggCols) {
            const acc = node.acc.get(agg.colId);
            if (!acc) continue;
            accSub(acc, agg, oldRow);
            accAdd(acc, agg, newRow);
          }
          dirty.add(nodeId);
        }
        this.rows.set(id, newRow);
      } else {
        // Group membership changed — move the row.
        this.detachRow(id, oldRow, dirty);
        this.rows.set(id, newRow);
        this.attachRow(id, newRow, dirty);
      }
    }

    return this.emitUpdates(dirty);
  }

  // ── internals ───────────────────────────────────────────────────

  /** Node ids a row contributes to: one per group level, plus grand total. */
  private nodeIdsFor(row: Row): string[] {
    const out: string[] = [];
    let path = '';
    for (const spec of this.model.groupCols) {
      const key = workerGroupKey(row[spec.field]);
      path = path ? `${path}/${key}` : key;
      out.push(`g:${spec.colId}:${path}`);
    }
    if (this.model.grandTotal) out.push('grand-total');
    return out;
  }

  private nodeFor(id: string): NodeState {
    let node = this.nodes.get(id);
    if (!node) {
      node = { id, members: new Set(), acc: new Map() };
      for (const agg of this.model.aggCols) {
        node.acc.set(agg.colId, { sum: 0, numCount: 0, wNum: 0, wDen: 0 });
      }
      this.nodes.set(id, node);
    }
    return node;
  }

  private attachRow(id: string, row: Row, dirty: Set<string>): void {
    const nodeIds = this.nodeIdsFor(row);
    this.nodesByRow.set(id, nodeIds);
    for (const nodeId of nodeIds) {
      const node = this.nodeFor(nodeId);
      node.members.add(id);
      for (const agg of this.model.aggCols) accAdd(node.acc.get(agg.colId)!, agg, row);
      dirty.add(nodeId);
    }
  }

  private detachRow(id: string, row: Row, dirty: Set<string>): void {
    const nodeIds = this.nodesByRow.get(id) ?? [];
    this.nodesByRow.delete(id);
    for (const nodeId of nodeIds) {
      const node = this.nodes.get(nodeId);
      if (!node) continue;
      node.members.delete(id);
      for (const agg of this.model.aggCols) accSub(node.acc.get(agg.colId)!, agg, row);
      dirty.add(nodeId);
    }
  }

  private rebuildAll(): void {
    this.nodes.clear();
    this.nodesByRow.clear();
    if (!this.model.aggCols.length) return;
    const dirty = new Set<string>();
    for (const [id, row] of this.rows) this.attachRow(id, row, dirty);
  }

  /** Materialize agg records for the dirty groups. */
  private emitUpdates(dirty: Set<string>): GroupAggUpdate[] {
    const out: GroupAggUpdate[] = [];
    for (const nodeId of dirty) {
      const node = this.nodes.get(nodeId);
      if (!node) continue;
      if (!node.members.size) continue; // group emptied; structural refresh removes it
      const agg: Record<string, unknown> = {};
      for (const spec of this.model.aggCols) {
        const value = this.aggValue(node, spec);
        agg[spec.colId] = value;
        if (spec.field && spec.field !== spec.colId) agg[spec.field] = value;
      }
      out.push({ groupId: nodeId, agg });
    }
    return out;
  }

  private aggValue(node: NodeState, spec: AggWorkerAggCol): unknown {
    const acc = node.acc.get(spec.colId)!;
    switch (spec.aggFunc) {
      case 'sum':
        return acc.numCount ? acc.sum : null;
      case 'count':
        return node.members.size;
      case 'avg':
        return acc.numCount ? acc.sum / acc.numCount : null;
      case 'weightedAverage':
        return acc.wDen ? acc.wNum / acc.wDen : acc.numCount ? acc.sum / acc.numCount : null;
      case 'min':
      case 'max': {
        let m = spec.aggFunc === 'min' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
        let any = false;
        for (const id of node.members) {
          const v = this.rows.get(id)?.[spec.field];
          if (typeof v === 'number' && !Number.isNaN(v)) {
            m = spec.aggFunc === 'min' ? Math.min(m, v) : Math.max(m, v);
            any = true;
          }
        }
        return any ? m : null;
      }
      case 'first':
      case 'last': {
        let firstId: string | null = null;
        let lastId: string | null = null;
        for (const id of node.members) {
          if (firstId === null) firstId = id;
          lastId = id;
        }
        const id = spec.aggFunc === 'first' ? firstId : lastId;
        return id !== null ? (this.rows.get(id)?.[spec.field] ?? null) : null;
      }
    }
  }
}

function accAdd(acc: ColAcc, agg: AggWorkerAggCol, row: Row): void {
  const v = row[agg.field];
  if (typeof v === 'number' && !Number.isNaN(v)) {
    acc.sum += v;
    acc.numCount++;
    if (agg.weightField) {
      const w = row[agg.weightField];
      if (typeof w === 'number' && !Number.isNaN(w)) {
        acc.wNum += v * w;
        acc.wDen += w;
      }
    }
  }
}

function accSub(acc: ColAcc, agg: AggWorkerAggCol, row: Row): void {
  const v = row[agg.field];
  if (typeof v === 'number' && !Number.isNaN(v)) {
    acc.sum -= v;
    acc.numCount--;
    if (agg.weightField) {
      const w = row[agg.weightField];
      if (typeof w === 'number' && !Number.isNaN(w)) {
        acc.wNum -= v * w;
        acc.wDen -= w;
      }
    }
  }
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
