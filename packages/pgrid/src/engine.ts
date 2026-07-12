/**
 * Headless Perspective engine bootstrap + indexed-table factory.
 * This module (with viewHost.ts) is the only place `@finos/perspective`
 * types may appear — the P4 engine-swap seam (spec §9).
 */
import perspective from '@finos/perspective';
import type { Client, Table } from '@finos/perspective';

/** Rows per table.update() call — keeps single messages to the engine bounded. */
const UPDATE_CHUNK = 2500;

let clientPromise: Promise<Client> | null = null;

/**
 * Headless engine bootstrap; browser callers must have wasm reachable via
 * import.meta.url resolution (Vite: exclude '@finos/perspective' from optimizeDeps).
 */
export function ensureEngine(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      if (typeof window !== 'undefined') {
        const [{ default: SERVER_WASM }, { default: CLIENT_WASM }] = await Promise.all([
          import(/* @vite-ignore */ '@finos/perspective/dist/wasm/perspective-server.wasm?url' as string),
          import(/* @vite-ignore */ '@finos/perspective/dist/wasm/perspective-js.wasm?url' as string),
        ]);
        perspective.init_client(fetch(CLIENT_WASM));
        perspective.init_server(fetch(SERVER_WASM));
        return perspective.worker();
      }
      // Node: the package's `node` export condition boots the engine in-process
      // at import time (top-level await) and exposes a module-level client facade
      // ({table, websocket, ...}) as the default export — there is no worker()
      // factory. Structurally sufficient for a Client here (we only call .table).
      return perspective as unknown as Client;
    })();
  }
  return clientPromise;
}

/** Table wrapper that hides Perspective from callers above the seam. */
export interface TableHandle {
  /** Chunked internally (2500 rows per engine call); fire-and-forget. */
  update(rows: Record<string, unknown>[]): void;
  /** viewHost-only escape hatch. */
  raw(): Table;
  delete(): Promise<void>;
}

/** Create an indexed table: rows sharing `indexField` values replace in place. */
export async function createIndexedTable(
  schema: Record<string, string>,
  indexField: string,
): Promise<TableHandle> {
  const client = await ensureEngine();
  const table = await client.table(schema as never, { index: indexField });
  return {
    update(rows: Record<string, unknown>[]): void {
      for (let i = 0; i < rows.length; i += UPDATE_CHUNK) {
        void table.update(rows.slice(i, i + UPDATE_CHUNK));
      }
    },
    raw(): Table {
      return table;
    },
    delete(): Promise<void> {
      return table.delete();
    },
  };
}
