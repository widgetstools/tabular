/**
 * Worker-side CSV writer (W6). Returns UTF-8 bytes without string concat.
 */
export interface CsvWriteColumn {
  colId: string;
  field?: string;
  headerName?: string;
}

export interface CsvWriteOptions {
  columnSeparator?: string;
  columnKeys?: string[];
  skipColumnHeaders?: boolean;
  suppressQuotes?: boolean;
  withBOM?: boolean;
}

const DEFAULT_SEPARATOR = ',';
const CRLF = '\r\n';
const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const INITIAL_BUFFER_BYTES = 64 * 1024;
const encoder = new TextEncoder();

function resolveColumns(columns: CsvWriteColumn[], columnKeys?: string[]): CsvWriteColumn[] {
  if (!columnKeys?.length) return columns;
  const byId = new Map(columns.map((c) => [c.colId, c]));
  const out: CsvWriteColumn[] = [];
  for (const id of columnKeys) {
    const col = byId.get(id);
    if (col) out.push(col);
  }
  return out;
}

function needsQuoting(value: string, sep: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    if (ch === 0x22 || ch === 0x0a || ch === 0x0d) return true;
  }
  return value.includes(sep);
}

function formatField(value: unknown, sep: string, suppressQuotes: boolean): string {
  if (value == null) return '';
  const s = typeof value === 'string' ? value : String(value);
  if (suppressQuotes || !needsQuoting(s, sep)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function writeCsvBytes(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: CsvWriteColumn[],
  opts?: CsvWriteOptions,
): Uint8Array {
  const sep = opts?.columnSeparator ?? DEFAULT_SEPARATOR;
  const cols = resolveColumns(columns, opts?.columnKeys);
  let buf = new Uint8Array(INITIAL_BUFFER_BYTES);
  let pos = 0;

  const ensure = (extra: number): void => {
    if (pos + extra <= buf.byteLength) return;
    let cap = buf.byteLength;
    while (cap < pos + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(buf);
    buf = next;
  };

  const writeRaw = (src: Uint8Array): void => {
    ensure(src.byteLength);
    buf.set(src, pos);
    pos += src.byteLength;
  };

  const writeStr = (s: string): void => {
    writeRaw(encoder.encode(s));
  };

  if (opts?.withBOM) writeRaw(BOM);

  if (!opts?.skipColumnHeaders) {
    for (let i = 0; i < cols.length; i++) {
      if (i > 0) writeStr(sep);
      writeStr(formatField(cols[i]!.headerName ?? cols[i]!.colId, sep, !!opts?.suppressQuotes));
    }
    writeStr(CRLF);
  }

  for (const row of rows) {
    for (let i = 0; i < cols.length; i++) {
      if (i > 0) writeStr(sep);
      const field = cols[i]!.field;
      const raw = field ? row[field] : '';
      writeStr(formatField(raw, sep, !!opts?.suppressQuotes));
    }
    writeStr(CRLF);
  }

  return buf.slice(0, pos);
}
