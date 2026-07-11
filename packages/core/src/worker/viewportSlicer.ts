/**
 * Viewport slicer (W5): pack a window of displayed rows into typed-array
 * column buffers the main thread can paint without touching row objects.
 */
import { encodeText } from './chunkFormat';
import type { ViewportChunk, ViewportRequest, WorkerDisplayEntry } from './protocol';

export interface ViewportColSpec {
  colId: string;
  field: string;
  type?: 'number' | 'text' | 'date';
}

function rowKindOf(entry: WorkerDisplayEntry): number {
  switch (entry.kind) {
    case 'group':
      return 1;
    case 'grandTotal':
      return 2;
    case 'footer':
      return 3;
    default:
      return 0;
  }
}

export function sliceViewport(
  getRow: (id: string) => Record<string, unknown> | undefined,
  displayed: readonly WorkerDisplayEntry[],
  colSpecs: Map<string, ViewportColSpec>,
  req: ViewportRequest,
): ViewportChunk {
  const rowStart = Math.max(0, req.rowStart);
  const rowEnd = Math.min(displayed.length, req.rowEnd);
  const count = Math.max(0, rowEnd - rowStart);

  const rowIds = new Array<string>(count);
  const rowKinds = new Uint8Array(count);
  const levels = new Uint8Array(count);
  const heights = new Float32Array(count);
  const groupValue = new Array<string>(count).fill('');
  const groupChildCount = new Uint32Array(count);
  const isExpanded = new Uint8Array(count);
  const groupKey = new Array<string>(count).fill('');
  isExpanded.fill(1);

  for (let i = 0; i < count; i++) {
    const entry = displayed[rowStart + i]!;
    rowIds[i] = entry.id;
    rowKinds[i] = rowKindOf(entry);
    levels[i] = entry.level;
    heights[i] = 0;
    if (entry.kind === 'group' || entry.kind === 'grandTotal' || entry.kind === 'footer') {
      groupValue[i] = entry.key;
      groupChildCount[i] = entry.childCount;
      groupKey[i] = entry.kind === 'group' ? entry.id : '';
      if (entry.kind === 'group') isExpanded[i] = entry.expanded ? 1 : 0;
    }
  }

  const numericCols: Record<string, Float64Array> = {};
  const textCols: Record<string, { offsets: Uint32Array; bytes: Uint8Array }> = {};

  for (const colId of req.columns) {
    const spec = colSpecs.get(colId);
    if (!spec) continue;
    const field = spec.field;
    if (spec.type === 'number') {
      const arr = new Float64Array(count);
      for (let i = 0; i < count; i++) {
        const entry = displayed[rowStart + i]!;
        if (entry.kind !== 'leaf') continue;
        const row = getRow(entry.id);
        if (!row) continue;
        const v = row[field];
        arr[i] = typeof v === 'number' ? v : Number(v);
      }
      numericCols[colId] = arr;
    } else {
      const values = new Array<string>(count);
      for (let i = 0; i < count; i++) {
        const entry = displayed[rowStart + i]!;
        if (entry.kind !== 'leaf') {
          values[i] = '';
          continue;
        }
        const row = getRow(entry.id);
        const v = row?.[field];
        values[i] = v == null ? '' : String(v);
      }
      textCols[colId] = encodeText(values);
    }
  }

  return {
    rowStart,
    rowCount: count,
    rowIds,
    rowKinds,
    levels,
    heights,
    numericCols,
    textCols,
    groupValue,
    groupChildCount,
    isExpanded,
    groupKey,
  };
}
