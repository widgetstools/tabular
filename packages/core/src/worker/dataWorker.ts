/**
 * Unified data-plane worker (W1–W6): mirrors the row store, runs
 * filter → sort → group, serves viewport chunks and worker services.
 */
import { measureColumnWidths } from './autosize';
import { collectViewportTransferables } from './chunkFormat';
import { writeCsvBytes } from './export/csv';
import { writeXlsxBytes } from './export/xlsx';
import { MeasureCache, offscreenMeasurer } from './measureText';
import { deserializeTsv, serializeRanges } from './passes/clipboardPass';
import { RulesPass } from './passes/rulesPass';
import { DataPipeline } from './pipeline';
import type {
  DataWorkerPush,
  DataWorkerRequest,
  DataWorkerResponse,
  ReqId,
  WorkerCsvExportPayload,
} from './protocol';

const pipeline = new DataPipeline();
const rulesPass = new RulesPass();
const measureCache = new MeasureCache();

const workerScope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', cb: (e: MessageEvent<DataWorkerRequest>) => void): void;
};

function reply(id: ReqId): void {
  const msg: DataWorkerResponse = { id, type: 'ok' };
  workerScope.postMessage(msg);
}

function replyError(id: ReqId, error: string): void {
  const msg: DataWorkerResponse = { id, type: 'error', error };
  workerScope.postMessage(msg);
}

function pushModel(): void {
  const output = pipeline.rebuild();
  const rules = rulesPass.evaluate(pipeline) ?? undefined;
  const msg: DataWorkerPush = { type: 'modelUpdated', output, rules };
  workerScope.postMessage(msg);
}

function leafRowsForExport(payload: WorkerCsvExportPayload): Record<string, unknown>[] {
  const displayed = pipeline.displayed;
  const selected = payload.selectedIds ? new Set(payload.selectedIds) : null;
  const out: Record<string, unknown>[] = [];
  for (const entry of displayed) {
    if (payload.skipRowGroups && entry.kind !== 'leaf') continue;
    if (entry.kind !== 'leaf') continue;
    if (selected && !selected.has(entry.id)) continue;
    const row = pipeline.getRow(entry.id);
    if (row) out.push(row);
  }
  return out;
}

function rowsByDisplayedIndex(): Array<Record<string, unknown> | undefined> {
  const displayed = pipeline.displayed;
  const out: Array<Record<string, unknown> | undefined> = new Array(displayed.length);
  for (let i = 0; i < displayed.length; i++) {
    const entry = displayed[i]!;
    if (entry.kind !== 'leaf') continue;
    out[i] = pipeline.getRow(entry.id);
  }
  return out;
}

self.addEventListener('message', (e: MessageEvent<DataWorkerRequest>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'setPipelineConfig':
        pipeline.setConfig(msg.payload);
        reply(msg.id);
        break;
      case 'setRowData':
        pipeline.setRowData(
          msg.payload.ids,
          msg.payload.rows as Record<string, unknown>[],
        );
        reply(msg.id);
        break;
      case 'applyTransaction': {
        rulesPass.noteTransaction(msg.payload);
        const result = pipeline.applyAndResolve(msg.payload);
        reply(msg.id);
        if (result.kind === 'aggregates') {
          const push: DataWorkerPush = { type: 'aggregatesUpdated', updates: result.updates };
          workerScope.postMessage(push);
        } else if (result.kind === 'model') {
          const rules = rulesPass.evaluate(pipeline) ?? undefined;
          const push: DataWorkerPush = { type: 'modelUpdated', output: result.output, rules };
          workerScope.postMessage(push);
        }
        // dataOnly: store updated; main invalidates viewport — no model push
        break;
      }
      case 'setRulesConfig':
        rulesPass.setConfig(msg.payload);
        reply(msg.id);
        break;
      case 'rebuildModel':
        reply(msg.id);
        pushModel();
        break;
      case 'getViewport': {
        const chunk = pipeline.getViewport(msg.payload);
        const transfer = collectViewportTransferables(chunk);
        const response: DataWorkerResponse = { id: msg.id, type: 'viewport', chunk };
        workerScope.postMessage(response, transfer as Transferable[]);
        break;
      }
      case 'clipboardSerialize': {
        const colsById = new Map<string, { field?: string }>();
        for (const [colId, spec] of pipeline.getColumnFields()) {
          colsById.set(colId, { field: spec.field });
        }
        const tsv = serializeRanges(
          rowsByDisplayedIndex(),
          colsById,
          msg.payload.ranges,
          msg.payload.delimiter,
        );
        const response: DataWorkerResponse = {
          id: msg.id,
          type: 'clipboardSerializeResult',
          tsv,
        };
        workerScope.postMessage(response);
        break;
      }
      case 'clipboardDeserialize': {
        const rows = deserializeTsv(msg.payload.text, msg.payload.delimiter);
        const response: DataWorkerResponse = {
          id: msg.id,
          type: 'clipboardDeserializeResult',
          rows,
        };
        workerScope.postMessage(response);
        break;
      }
      case 'exportCsv': {
        const bytes = writeCsvBytes(leafRowsForExport(msg.payload), msg.payload.columns, {
          columnKeys: msg.payload.columnKeys,
          columnSeparator: msg.payload.columnSeparator,
          skipColumnHeaders: msg.payload.skipColumnHeaders,
          suppressQuotes: msg.payload.suppressQuotes,
          withBOM: msg.payload.withBOM,
        });
        const response: DataWorkerResponse = { id: msg.id, type: 'exportCsvResult', bytes };
        workerScope.postMessage(response, [bytes.buffer]);
        break;
      }
      case 'exportXlsx': {
        const bytes = writeXlsxBytes(leafRowsForExport(msg.payload), msg.payload.columns, {
          columnKeys: msg.payload.columnKeys,
          sheetName: msg.payload.sheetName,
        });
        const response: DataWorkerResponse = { id: msg.id, type: 'exportXlsxResult', bytes };
        workerScope.postMessage(response, [bytes.buffer]);
        break;
      }
      case 'autosize': {
        const displayed = pipeline.displayed;
        const colFields = pipeline.getColumnFields();
        const measureFor = (font: string) => {
          const off = offscreenMeasurer(font);
          return off ?? ((s: string) => s.length * 7);
        };
        const specs = msg.payload.columns.map((c) => {
          const field = colFields.get(c.colId)?.field;
          return {
            colId: c.colId,
            headerName: c.headerName,
            font: c.font,
            padding: c.padding,
            headerPadding: c.headerPadding,
            minWidth: c.minWidth,
            maxWidth: c.maxWidth,
            textOf: (rowIndex: number): string => {
              const entry = displayed[rowIndex];
              if (!entry || entry.kind !== 'leaf' || !field) return '';
              const row = pipeline.getRow(entry.id);
              if (!row) return '';
              const v = row[field];
              return v == null ? '' : String(v);
            },
          };
        });
        const widthsMap = measureColumnWidths({
          cols: specs,
          rowCount: displayed.length,
          skipHeader: msg.payload.skipHeader,
          measureFor,
          cache: measureCache,
          maxSampleSize: msg.payload.maxSampleSize,
        });
        const widths: Record<string, number> = {};
        for (const [colId, w] of widthsMap.entries()) widths[colId] = w;
        const response: DataWorkerResponse = { id: msg.id, type: 'autosizeResult', widths };
        workerScope.postMessage(response);
        break;
      }
      default:
        replyError((msg as { id: ReqId }).id, 'unknown request type');
    }
  } catch (err) {
    replyError(msg.id, err instanceof Error ? err.message : String(err));
  }
});
