/**
 * Worker-side clipboard serialize / deserialize (W6).
 */
export interface WorkerClipboardRange {
  rowStart: number;
  rowEnd: number;
  colIds: string[];
}

export interface SerializeColumnRef {
  field?: string;
}

const DEFAULT_DELIMITER = '\t';

export function serializeRanges(
  rows: ReadonlyArray<Record<string, unknown> | undefined>,
  columnsById: ReadonlyMap<string, SerializeColumnRef>,
  ranges: ReadonlyArray<WorkerClipboardRange>,
  delimiter: string = DEFAULT_DELIMITER,
): string {
  if (ranges.length === 0) return '';
  const rangeBlocks: string[] = new Array(ranges.length);
  for (let ri = 0; ri < ranges.length; ri++) {
    const range = ranges[ri]!;
    const { rowStart, rowEnd, colIds } = range;
    const rowCount = rowEnd - rowStart + 1;
    const rowBuf: string[] = new Array(Math.max(0, rowCount));
    const fields: Array<string | undefined> = new Array(colIds.length);
    for (let c = 0; c < colIds.length; c++) {
      fields[c] = columnsById.get(colIds[c]!)?.field;
    }
    const cellBuf: string[] = new Array(colIds.length);
    for (let r = 0; r < rowCount; r++) {
      const rowIndex = rowStart + r;
      const row = rows[rowIndex];
      for (let c = 0; c < colIds.length; c++) {
        const field = fields[c];
        const raw =
          row !== undefined && field !== undefined
            ? (row as Record<string, unknown>)[field]
            : undefined;
        cellBuf[c] = formatCell(raw, delimiter);
      }
      rowBuf[r] = cellBuf.join(delimiter);
    }
    rangeBlocks[ri] = rowBuf.join('\n');
  }
  return rangeBlocks.join('\n\n');
}

export function deserializeTsv(text: string, delimiter: string = DEFAULT_DELIMITER): string[][] {
  if (text === '') return [];
  const delim = delimiter.charCodeAt(0);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuoted = false;
  let cellStarted = false;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const ch = text.charCodeAt(i);
    if (inQuoted) {
      if (ch === 0x22) {
        if (i + 1 < len && text.charCodeAt(i + 1) === 0x22) {
          cell += '"';
          i++;
          continue;
        }
        inQuoted = false;
        continue;
      }
      cell += text[i];
      continue;
    }
    if (ch === delim) {
      row.push(cell);
      cell = '';
      cellStarted = false;
      continue;
    }
    if (ch === 0x0a) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      cellStarted = false;
      continue;
    }
    if (ch === 0x0d) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      cellStarted = false;
      if (i + 1 < len && text.charCodeAt(i + 1) === 0x0a) i++;
      continue;
    }
    if (ch === 0x22 && !cellStarted) {
      inQuoted = true;
      cellStarted = true;
      continue;
    }
    cell += text[i];
    cellStarted = true;
  }
  if (cell.length > 0 || row.length > 0 || cellStarted || inQuoted) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function formatCell(value: unknown, delimiter: string): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  if (s.length === 0) return '';
  let needsQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 0x22 || ch === 0x0a || ch === 0x0d) {
      needsQuote = true;
      break;
    }
  }
  if (!needsQuote && s.indexOf(delimiter) !== -1) needsQuote = true;
  if (!needsQuote) return s;
  return `"${s.replace(/"/g, '""')}"`;
}
