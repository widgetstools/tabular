/**
 * Resolves calc aggregate-scope slots (SUM/AVG/… with all|visible|group|parent)
 * for worker-side calc evaluation. Defensive: unknown funcs yield null slots.
 */
import type { AggSpec, AggScope } from '@tabular/calc';
import { AGG_FUNCS } from '../../aggregation';
import { readField } from '../fieldRead';

const FN_MAP: Record<string, keyof typeof AGG_FUNCS> = {
  SUM: 'sum',
  AVG: 'avg',
  COUNT: 'count',
  MIN: 'min',
  MAX: 'max',
  FIRST: 'first',
  LAST: 'last',
};

/** Aggregate function names the worker calc pass can resolve. */
export function isWorkerCalcAggFn(fn: string): boolean {
  if (FN_MAP[fn]) return true;
  if (fn === 'COUNT_DISTINCT') return true;
  if (fn.startsWith('PERCENTILE(')) return false;
  return false;
}

export function isWorkerCalcAggSpec(spec: AggSpec): boolean {
  return isWorkerCalcAggFn(spec.fn);
}

function countDistinct(values: unknown[]): number | null {
  const seen = new Set<string>();
  let any = false;
  for (const v of values) {
    if (v == null) continue;
    any = true;
    seen.add(String(v));
  }
  return any ? seen.size : null;
}

function runAgg(fn: string, values: unknown[]): number | null {
  const key = FN_MAP[fn];
  if (key) {
    const out = AGG_FUNCS[key](values);
    return typeof out === 'number' && Number.isFinite(out) ? out : out == null ? null : Number(out);
  }
  if (fn === 'COUNT_DISTINCT') return countDistinct(values);
  return null;
}

function promoteScope(scope: AggScope, groupingActive: boolean): AggScope['kind'] {
  if (scope.kind === 'visible' && groupingActive) return 'group';
  return scope.kind;
}

function fieldValue(row: Record<string, unknown>, colId: string): unknown {
  return readField(row, colId);
}

export interface GroupRowIndex {
  /** Innermost group id for each leaf row id. */
  rowGroupId: Map<string, string>;
  /** Parent group id (one level up) for each leaf row id. */
  rowParentGroupId: Map<string, string | null>;
  /** Leaf row ids belonging to each group node id. */
  groupLeafIds: Map<string, string[]>;
}

/** Build a group index from flattened group descriptors + sorted leaf ids. */
export function buildGroupRowIndex(
  leafIds: string[],
  groupCols: Array<{ colId: string; field: string }>,
  readRow: (id: string) => Record<string, unknown>,
): GroupRowIndex {
  const rowGroupId = new Map<string, string>();
  const rowParentGroupId = new Map<string, string | null>();
  const groupLeafIds = new Map<string, string[]>();

  if (!groupCols.length) {
    return { rowGroupId, rowParentGroupId, groupLeafIds };
  }

  for (const rowId of leafIds) {
    const row = readRow(rowId);
    let parentPath = '';
    let parentId: string | null = null;
    for (let level = 0; level < groupCols.length; level++) {
      const spec = groupCols[level]!;
      const key = String(readField(row, spec.field) ?? '(Blank)');
      const path = parentPath ? `${parentPath}/${key}` : key;
      const id = `g:${spec.colId}:${path}`;
      if (level === groupCols.length - 1) {
        rowGroupId.set(rowId, id);
        rowParentGroupId.set(rowId, parentId);
        const list = groupLeafIds.get(id);
        if (list) list.push(rowId);
        else groupLeafIds.set(id, [rowId]);
      }
      parentId = id;
      parentPath = path;
    }
  }

  return { rowGroupId, rowParentGroupId, groupLeafIds };
}

export class AggScopeResolver {
  private slotValues = new Map<number, number | null>();
  private rowSlotValues = new Map<string, Map<number, number | null>>();

  constructor(
    private readonly specs: readonly AggSpec[],
    private readonly groupingActive: boolean,
    private readonly groupIndex: GroupRowIndex | null,
    private readonly readRow: (id: string) => Record<string, unknown>,
  ) {}

  static forPhase(
    specs: readonly AggSpec[],
    allIds: string[],
    visibleIds: string[],
    readRow: (id: string) => Record<string, unknown>,
    groupIndex: GroupRowIndex | null,
    groupingActive: boolean,
  ): AggScopeResolver {
    const resolver = new AggScopeResolver(specs, groupingActive, groupIndex, readRow);
    resolver.rebuildGlobal(allIds, visibleIds);
    resolver.rebuildPerRow(visibleIds);
    return resolver;
  }

  private rebuildGlobal(allIds: string[], visibleIds: string[]): void {
    for (const spec of this.specs) {
      const kind = promoteScope(spec.scope, this.groupingActive);
      if (kind === 'group' || kind === 'parent') continue;
      const ids = kind === 'all' ? allIds : visibleIds;
      const values = ids.map((id) => fieldValue(this.readRow(id), spec.colId));
      this.slotValues.set(spec.slot, runAgg(spec.fn, values));
    }
  }

  private rebuildPerRow(visibleIds: string[]): void {
    if (!this.groupIndex) return;
    for (const spec of this.specs) {
      const kind = promoteScope(spec.scope, this.groupingActive);
      if (kind !== 'group' && kind !== 'parent') continue;
      for (const rowId of visibleIds) {
        const targetGroup =
          kind === 'group'
            ? this.groupIndex.rowGroupId.get(rowId)
            : this.groupIndex.rowParentGroupId.get(rowId);
        if (!targetGroup) {
          this.setRowSlot(rowId, spec.slot, null);
          continue;
        }
        const leafIds = this.groupIndex.groupLeafIds.get(targetGroup) ?? [];
        const values = leafIds.map((id) => fieldValue(this.readRow(id), spec.colId));
        this.setRowSlot(rowId, spec.slot, runAgg(spec.fn, values));
      }
    }
  }

  private setRowSlot(rowId: string, slot: number, value: number | null): void {
    let bag = this.rowSlotValues.get(rowId);
    if (!bag) {
      bag = new Map();
      this.rowSlotValues.set(rowId, bag);
    }
    bag.set(slot, value);
  }

  valuesForRow(rowId: string): Array<number | null> {
    if (!this.specs.length) return [];
    const maxSlot = Math.max(...this.specs.map((s) => s.slot));
    const out = new Array<number | null>(maxSlot + 1).fill(null);
    for (const spec of this.specs) {
      const rowBag = this.rowSlotValues.get(rowId);
      if (rowBag?.has(spec.slot)) {
        out[spec.slot] = rowBag.get(spec.slot) ?? null;
        continue;
      }
      out[spec.slot] = this.slotValues.get(spec.slot) ?? null;
    }
    return out;
  }
}
