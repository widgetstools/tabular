/**
 * Worker-side OOXML `.xlsx` writer (W6). Minimal shared-strings workbook
 * without external dependencies; defensive against bad cell values.
 */
import type { CsvWriteColumn } from './csv';
import { writeZip } from './zipWriter';

export interface XlsxWriteOptions {
  sheetName?: string;
  columnKeys?: string[];
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function colName(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function cellRef(col: number, row: number): string {
  return `${colName(col)}${row + 1}`;
}

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

function cellXml(ref: string, value: unknown, strings: string[], stringIndex: Map<string, number>): string {
  if (value == null || value === '') return `<c r="${ref}"/>`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  const s = String(value);
  let idx = stringIndex.get(s);
  if (idx == null) {
    idx = strings.length;
    strings.push(s);
    stringIndex.set(s, idx);
  }
  return `<c r="${ref}" t="s"><v>${idx}</v></c>`;
}

export function writeXlsxBytes(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: CsvWriteColumn[],
  opts?: XlsxWriteOptions,
): Uint8Array {
  const cols = resolveColumns(columns, opts?.columnKeys);
  const sheetName = xmlEscape(opts?.sheetName ?? 'Sheet1');
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();

  let sheetRows = '';
  const headerCells: string[] = [];
  for (let c = 0; c < cols.length; c++) {
    const label = cols[c]!.headerName ?? cols[c]!.colId;
    headerCells.push(cellXml(cellRef(c, 0), label, strings, stringIndex));
  }
  sheetRows += `<row r="1">${headerCells.join('')}</row>`;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    const cells: string[] = [];
    for (let c = 0; c < cols.length; c++) {
      const field = cols[c]!.field;
      const raw = field ? row[field] : '';
      cells.push(cellXml(cellRef(c, r + 1), raw, strings, stringIndex));
    }
    sheetRows += `<row r="${r + 2}">${cells.join('')}</row>`;
  }

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${sheetRows}</sheetData></worksheet>`;

  const sharedItems = strings.map((s) => `<si><t>${xmlEscape(s)}</t></si>`).join('');
  const sharedXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">` +
    `${sharedItems}</sst>`;

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const relsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const wbRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    `</Relationships>`;

  const contentTypesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
    `</Types>`;

  const enc = new TextEncoder();
  return writeZip([
    { name: '[Content_Types].xml', data: enc.encode(contentTypesXml) },
    { name: '_rels/.rels', data: enc.encode(relsXml) },
    { name: 'xl/workbook.xml', data: enc.encode(workbookXml) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(wbRelsXml) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheetXml) },
    { name: 'xl/sharedStrings.xml', data: enc.encode(sharedXml) },
  ]);
}
