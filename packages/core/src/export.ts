/**
 * CSV + Excel (SpreadsheetML) export helpers (plan §4.10).
 */
import type { ColDef } from './types';
import type { BaseExportParams, CsvExportParams, ExcelExportParams } from './types';

export interface ExportColumn<TData = unknown> {
  colId: string;
  def: ColDef<TData>;
}

export interface ExportRowNode<TData = unknown> {
  rowIndex: number;
  data: TData | undefined;
  group: boolean;
}

export interface ExportContext<TData = unknown> {
  columns(params?: BaseExportParams<TData>): ExportColumn<TData>[];
  rows(params?: BaseExportParams<TData>): ExportRowNode<TData>[];
  rawValue(row: ExportRowNode<TData>, col: ExportColumn<TData>): unknown;
  formattedValue(row: ExportRowNode<TData>, col: ExportColumn<TData>): string;
  headerName(col: ExportColumn<TData>): string;
}

function resolveFileName<TData>(
  params: BaseExportParams<TData> | undefined,
  fallback: string,
  api?: unknown,
): string {
  const name = params?.fileName;
  if (typeof name === 'function') return name({ api: api as never }) ?? fallback;
  return name ?? fallback;
}

function cellOut<TData>(
  ctx: ExportContext<TData>,
  row: ExportRowNode<TData>,
  col: ExportColumn<TData>,
  params: BaseExportParams<TData> | undefined,
  api: unknown,
): string {
  const proc = params?.processCellCallback;
  if (proc) {
    return proc({
      value: ctx.rawValue(row, col),
      node: { data: row.data, rowIndex: row.rowIndex },
      column: { colId: col.colId, colDef: col.def },
      api: api as never,
      type: 'export',
    });
  }
  return ctx.formattedValue(row, col);
}

function headerOut<TData>(
  ctx: ExportContext<TData>,
  col: ExportColumn<TData>,
  params: BaseExportParams<TData> | undefined,
  api: unknown,
): string {
  const proc = params?.processHeaderCallback;
  if (proc) {
    return proc({
      column: { colId: col.colId, colDef: col.def },
      api: api as never,
    });
  }
  return ctx.headerName(col);
}

export function buildExportMatrix<TData>(
  ctx: ExportContext<TData>,
  params: BaseExportParams<TData> | undefined,
  api: any,
): string[][] {
  const cols = ctx.columns(params);
  const rows = ctx.rows(params).filter((row) => {
    if (params?.skipRowGroups && row.group) return false;
    if (params?.shouldRowBeSkipped?.({ rowIndex: row.rowIndex, data: row.data, api: api as never })) return false;
    return true;
  });
  const matrix: string[][] = [];
  if (!params?.skipColumnHeaders) {
    matrix.push(cols.map((c) => headerOut(ctx, c, params, api)));
  }
  for (const row of rows) {
    matrix.push(cols.map((c) => cellOut(ctx, row, c, params, api)));
  }
  return matrix;
}

function escCsv(value: string, sep: string, suppressQuotes: boolean): string {
  if (suppressQuotes) return value;
  if (/[",\n\r]/.test(value) || value.includes(sep)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function matrixToCsv(matrix: string[][], params?: CsvExportParams): string {
  const sep = params?.columnSeparator ?? ',';
  const suppressQuotes = params?.suppressQuotes === true;
  return matrix.map((row) => row.map((c) => escCsv(c, sep, suppressQuotes)).join(sep)).join('\n');
}

function xmlEsc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cellType(value: string): 'String' | 'Number' {
  return value !== '' && !Number.isNaN(Number(value)) && /^-?\d+(\.\d+)?$/.test(value) ? 'Number' : 'String';
}

export function matrixToSpreadsheetXml(matrix: string[][], sheetName = 'Sheet1'): string {
  const rows = matrix
    .map(
      (row) =>
        `<Row>${row
          .map((cell) => {
            const v = xmlEsc(cell);
            const t = cellType(cell);
            return `<Cell><Data ss:Type="${t}">${v}</Data></Cell>`;
          })
          .join('')}</Row>`,
    )
    .join('');
  const name = xmlEsc(sheetName.slice(0, 31));
  return (
    `<?xml version="1.0"?>\n` +
    `<?mso-application progid="Excel.Sheet"?>\n` +
    `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ` +
    `xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n` +
    `<Worksheet ss:Name="${name}"><Table>${rows}</Table></Worksheet>\n` +
    `</Workbook>`
  );
}

export function downloadText(content: string, fileName: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadBytes(content: Uint8Array, fileName: string, mime: string): void {
  const copy = Uint8Array.from(content);
  const blob = new Blob([copy], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function resolveCsvFileName<TData = unknown>(
  params?: CsvExportParams<TData>,
  api?: unknown,
): string {
  return resolveFileName(params, 'export.csv', api);
}

export function resolveExcelFileName<TData = unknown>(
  params?: ExcelExportParams<TData>,
  api?: unknown,
): string {
  return resolveFileName(params, 'export.xls', api);
}
