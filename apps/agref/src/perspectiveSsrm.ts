/**
 * FinOS Perspective as an ag-grid Server-Side Row Model server.
 *
 * The engine runs headless (Table/View API only, no <perspective-viewer>):
 * every SSRM getRows request is translated into a short-lived Perspective
 * view — group levels become `group_by` + equality filters on the group
 * keys, pivot mode becomes `split_by` (ag-grid rebuilds pivot result
 * columns from the engine's `a|b|col` field names), leaf blocks become a
 * sorted/filtered viewport slice. The STOMP feed updates the indexed table
 * underneath; a periodic refreshServerSide() re-fetches loaded blocks so
 * group aggregates tick.
 */
import perspective from '@finos/perspective';
import type { Client, Table } from '@finos/perspective';
import CLIENT_WASM from '@finos/perspective/dist/wasm/perspective-js.wasm?url';
import SERVER_WASM from '@finos/perspective/dist/wasm/perspective-server.wasm?url';
import type { IServerSideGetRowsRequest, LoadSuccessParams, SortModelItem } from 'ag-grid-community';
import type { FiPosition } from './stomp/fiPositionsSource';

// ---------------------------------------------------------------------------
// Headless engine bootstrap (no viewer package: init_client takes the
// perspective-js wasm instead of the viewer wasm).
let clientPromise: Promise<Client> | null = null;
export function ensurePerspective(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      await Promise.all([
        perspective.init_client(fetch(CLIENT_WASM)),
        perspective.init_server(fetch(SERVER_WASM)),
      ]);
      return perspective.worker();
    })();
  }
  return clientPromise;
}

// ---------------------------------------------------------------------------
// Row flattening + union schema (same approach as the showcase stress page:
// the FI payload nests objects and the leaf-path set varies by instrument
// type — 361 per row, ~372 across a snapshot).
export type FlatRow = Record<string, string | number | boolean | null>;

export function flatten(row: FiPosition): FlatRow {
  const out: FlatRow = {};
  const walk = (obj: Record<string, unknown>, prefix: string): void => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        walk(v as Record<string, unknown>, key);
      } else if (
        typeof v === 'string' ||
        typeof v === 'number' ||
        typeof v === 'boolean'
      ) {
        out[key] = v;
      } else {
        out[key] = null;
      }
    }
  };
  walk(row, '');
  return out;
}

/** Union schema over all rows; type conflicts degrade to string. */
export function buildSchema(rows: FlatRow[]): Record<string, string> {
  const schema: Record<string, string> = {};
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (v === null || schema[k] === 'string') continue;
      const t =
        typeof v === 'number' ? 'float' : typeof v === 'boolean' ? 'boolean' : 'string';
      if (!(k in schema)) schema[k] = t;
      else if (schema[k] !== t) schema[k] = 'string';
    }
  }
  return schema;
}

// ---------------------------------------------------------------------------
// SSRM → Perspective translation.

/** Group-key label used when the underlying value is null (union schema). */
export const NULL_KEY = '(null)';

const AGG_MAP: Record<string, string> = {
  sum: 'sum',
  avg: 'avg',
  min: 'min',
  max: 'max',
  count: 'count',
  first: 'first',
  last: 'last',
};

type PspFilter = (string | number | boolean)[];
type PspViewConfig = {
  group_by?: string[];
  split_by?: string[];
  columns?: string[];
  aggregates?: Record<string, string>;
  sort?: string[][];
  filter?: PspFilter[];
};

export class PerspectiveSsrmServer {
  constructor(
    private readonly table: Table,
    private readonly schema: Record<string, string>,
  ) {}

  async getRows(request: IServerSideGetRowsRequest): Promise<LoadSuccessParams> {
    const groupFields = request.rowGroupCols.map((c) => c.field!);
    const level = request.groupKeys.length;
    const filter = this.keyFilters(groupFields, request.groupKeys);
    if (level < groupFields.length) {
      return this.getGroupRows(request, groupFields, level, filter);
    }
    return this.getLeafRows(request, filter);
  }

  /** One group level: group_by the next column, filtered to the parent keys. */
  private async getGroupRows(
    request: IServerSideGetRowsRequest,
    groupFields: string[],
    level: number,
    filter: PspFilter[],
  ): Promise<LoadSuccessParams> {
    const groupCol = groupFields[level];
    const valueFields = request.valueCols.map((c) => c.field!);
    const aggregates: Record<string, string> = {};
    for (const v of request.valueCols) {
      aggregates[v.field!] = AGG_MAP[v.aggFunc ?? 'sum'] ?? 'sum';
    }
    const pivotFields =
      request.pivotMode && request.pivotCols.length
        ? request.pivotCols.map((c) => c.field!)
        : [];
    const cfg: PspViewConfig = {
      group_by: [groupCol],
      split_by: pivotFields,
      columns: valueFields,
      aggregates,
      filter,
      // Aggregate-column sorts apply engine-side; group-name order is
      // handled below (perspective emits groups ascending by value).
      sort: this.sorts(request.sortModel, valueFields),
    };
    const view = await this.table.view(cfg as Parameters<Table['view']>[0]);
    try {
      const cols = (await view.to_columns()) as Record<string, unknown[]>;
      const paths = (cols['__ROW_PATH__'] ?? []) as unknown[][];
      const dataKeys = Object.keys(cols).filter((k) => k !== '__ROW_PATH__');
      const rows: Record<string, unknown>[] = [];
      for (let i = 0; i < paths.length; i++) {
        if (paths[i].length !== 1) continue; // skip the level-0 total row
        const groupValue = paths[i][0] === null ? NULL_KEY : paths[i][0];
        const row: Record<string, unknown> = {
          [groupCol]: groupValue,
          // Stable handle for ag-grid getRowId on group rows.
          __group: String(groupValue),
        };
        for (const k of dataKeys) row[k] = cols[k][i];
        rows.push(row);
      }
      const auto = request.sortModel.find((s) => s.colId.startsWith('ag-Grid-AutoColumn'));
      if (auto?.sort === 'desc') rows.reverse();
      const start = request.startRow ?? 0;
      const end = request.endRow ?? rows.length;
      const result: LoadSuccessParams = {
        rowData: rows.slice(start, end),
        rowCount: rows.length,
      };
      if (pivotFields.length) {
        // Engine names split columns "splitVal|…|valueCol"; ag-grid rebuilds
        // the pivot result column groups from these via
        // serverSidePivotResultFieldSeparator: '|'.
        result.pivotResultFields = dataKeys;
      }
      return result;
    } finally {
      await view.delete();
    }
  }

  /** Leaf blocks: sorted/filtered flat viewport slice across all columns. */
  private async getLeafRows(
    request: IServerSideGetRowsRequest,
    filter: PspFilter[],
  ): Promise<LoadSuccessParams> {
    const cfg: PspViewConfig = {
      columns: Object.keys(this.schema),
      filter,
      sort: this.sorts(request.sortModel, null),
    };
    const view = await this.table.view(cfg as Parameters<Table['view']>[0]);
    try {
      const rowCount = await view.num_rows();
      const start = request.startRow ?? 0;
      const end = Math.min(request.endRow ?? rowCount, rowCount);
      const cols = (await view.to_columns({
        start_row: start,
        end_row: end,
      })) as Record<string, unknown[]>;
      const dataKeys = Object.keys(cols).filter((k) => k !== '__ROW_PATH__' && k !== '__INDEX__');
      const n = end - start;
      const rows: Record<string, unknown>[] = new Array(n);
      for (let i = 0; i < n; i++) {
        const row: Record<string, unknown> = {};
        for (const k of dataKeys) row[k] = cols[k]?.[i] ?? null;
        rows[i] = row;
      }
      return { rowData: rows, rowCount };
    } finally {
      await view.delete();
    }
  }

  /** Equality filters pinning a request to its parent group keys. */
  private keyFilters(groupFields: string[], groupKeys: string[]): PspFilter[] {
    return groupKeys.map((key, i) => {
      const field = groupFields[i];
      if (key === NULL_KEY) return [field, 'is null'];
      const t = this.schema[field];
      if (t === 'float' || t === 'integer') return [field, '==', Number(key)];
      if (t === 'boolean') return [field, '==', key === 'true'];
      return [field, '==', key];
    });
  }

  /** ag-grid sortModel → perspective sort, restricted to known columns. */
  private sorts(model: SortModelItem[], allowed: string[] | null): string[][] {
    return model
      .filter((s) => this.schema[s.colId] && (allowed === null || allowed.includes(s.colId)))
      .map((s) => [s.colId, s.sort]);
  }
}
