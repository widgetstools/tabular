/**
 * ag-grid (SSRM) over a headless FinOS Perspective engine, fed by the STOMP
 * server: 20k positions, every flattened column group-able and pivot-able
 * via the row-group/pivot panels. Perspective answers each block request
 * (grouping, aggregation, pivot, sort) in its WASM worker; a periodic
 * refreshServerSide() re-fetches loaded blocks so aggregates tick.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type {
  ColDef,
  GetRowIdParams,
  GridApi,
  IServerSideDatasource,
  SideBarDef,
} from 'ag-grid-community';
import type { Table } from '@finos/perspective';
import { gridTheme } from '../theme';
import {
  buildSchema,
  ensurePerspective,
  flatten,
  PerspectiveSsrmServer,
  type FlatRow,
} from '../perspectiveSsrm';
import { connectFiPositions, type FiPosition } from '../stomp/fiPositionsSource';

const SNAPSHOT_ROWS = 20000;
const LOAD_CHUNK = 2500;

/** Columns given an aggFunc up front so default grouping shows aggregates. */
const DEFAULT_VALUE_COLS: Record<string, string> = {
  marketValue: 'sum',
  notionalAmount: 'sum',
  pnl: 'sum',
  dailyPnl: 'sum',
  dv01: 'sum',
  currentPrice: 'avg',
  yield: 'avg',
};

type Phase = 'connecting' | 'snapshot' | 'loading' | 'live' | 'offline';

// Grid object props MUST be referentially stable: the page re-renders on the
// update counter, and a fresh defaultColDef/sideBar object makes ag-grid
// reprocess column defs — silently resetting runtime column state (grouping
// chips vanish ~50ms after applyColumnState).
const DEFAULT_COL_DEF: ColDef = { sortable: true, filter: false, resizable: true };
const AUTO_GROUP_COL_DEF: ColDef = { minWidth: 240 };
const SIDE_BAR: SideBarDef = { toolPanels: ['columns'], defaultToolPanel: '' };

/** Stable row ids so applyServerSideTransactionAsync can target leaf rows. */
function getRowId(p: GetRowIdParams): string {
  const data = p.data as Record<string, unknown>;
  if (typeof data.positionId === 'string') return data.positionId;
  return [...(p.parentKeys ?? []), String(data.__group ?? '?')].join('|');
}

export function PerspectiveSsrmPage() {
  const apiRef = useRef<GridApi | null>(null);
  const runningRef = useRef(true);
  const totalRef = useRef(0);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [snapProgress, setSnapProgress] = useState(0);
  const [ready, setReady] = useState<{
    server: PerspectiveSsrmServer;
    columnDefs: ColDef[];
    colCount: number;
  } | null>(null);
  const [updates, setUpdates] = useState(0);
  const [running, setRunning] = useState(true);
  const [refreshMs, setRefreshMs] = useState(2000);

  useEffect(() => {
    let cancelled = false;
    let gotData = false;
    let table: Table | null = null;
    const tableRef = { current: null as Table | null };

    const offlineTimer = setTimeout(() => {
      if (!gotData) setPhase('offline');
    }, 4000);

    async function loadSnapshot(rows: FiPosition[]): Promise<void> {
      setPhase('loading');
      const client = await ensurePerspective();
      const flatRows: FlatRow[] = new Array<FlatRow>(rows.length);
      for (let i = 0; i < rows.length; i += LOAD_CHUNK) {
        const end = Math.min(i + LOAD_CHUNK, rows.length);
        for (let j = i; j < end; j++) flatRows[j] = flatten(rows[j]);
        await new Promise((r) => setTimeout(r));
        if (cancelled) return;
      }
      const schema = buildSchema(flatRows);
      table = await client.table(
        schema as unknown as Record<string, unknown[]>,
        { index: 'positionId' },
      );
      if (cancelled) {
        await table.delete();
        table = null;
        return;
      }
      for (let i = 0; i < flatRows.length; i += LOAD_CHUNK) {
        if (cancelled) return;
        await table.update(flatRows.slice(i, i + LOAD_CHUNK));
      }
      if (cancelled) return;

      const columnDefs: ColDef[] = Object.entries(schema).map(([field, type]) => ({
        field,
        colId: field,
        headerName: field,
        width: 130,
        enableRowGroup: true,
        enablePivot: true,
        enableValue: type === 'float',
        allowedAggFuncs: ['sum', 'avg', 'min', 'max', 'count'],
        aggFunc: DEFAULT_VALUE_COLS[field] ?? null,
        rowGroup: field === 'desk',
        rowGroupIndex: field === 'desk' ? 0 : undefined,
        type: type === 'float' ? 'rightAligned' : undefined,
        valueFormatter:
          type === 'float'
            ? (p) => (typeof p.value === 'number' ? p.value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : p.value ?? '')
            : undefined,
      }));

      tableRef.current = table;
      setReady({
        server: new PerspectiveSsrmServer(table, schema),
        columnDefs,
        colCount: Object.keys(schema).length,
      });
      setPhase('live');
    }

    const dispose = connectFiPositions(
      {
        rows: SNAPSHOT_ROWS,
        rate: 200,
        updatesPerTick: 50,
        clientId: `ag-ssrm-${Math.floor(Math.random() * 1e6)}`,
      },
      {
        onStatus: (text) => {
          if (
            !gotData &&
            (text.startsWith('error') ||
              text.startsWith('disconnected') ||
              text.includes('is the server running'))
          ) {
            setPhase('offline');
          }
        },
        onSnapshotProgress: (received) => {
          gotData = true;
          setPhase((p) => (p === 'connecting' ? 'snapshot' : p));
          setSnapProgress(received);
        },
        onReady: (rows) => {
          gotData = true;
          loadSnapshot(rows).catch((err) =>
            console.error('[ag-ssrm] load failed', err),
          );
        },
        onUpdates: (batch) => {
          if (!runningRef.current) return;
          const t = tableRef.current;
          if (!t) return;
          const flat = batch.map(flatten);
          void t.update(flat);
          // Flat view: push the same rows straight into loaded SSRM blocks as
          // an async transaction — cells tick live, no block re-fetch. Grouped
          // or pivoted views can't take transactions for aggregates; the
          // periodic refreshServerSide covers those.
          const api = apiRef.current;
          if (
            api &&
            api.getRowGroupColumns().length === 0 &&
            !api.getGridOption('pivotMode')
          ) {
            api.applyServerSideTransactionAsync({ update: flat });
          }
          totalRef.current += batch.length;
        },
      },
    );

    return () => {
      cancelled = true;
      clearTimeout(offlineTimer);
      dispose();
      tableRef.current = null;
      void table?.delete().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch loaded blocks on a cadence so group aggregates tick. Flat views
  // skip this — transactions already stream cell updates into loaded blocks.
  useEffect(() => {
    if (!ready || refreshMs === 0 || !running) return;
    const iv = setInterval(() => {
      const api = apiRef.current;
      if (!api) return;
      const flat = api.getRowGroupColumns().length === 0 && !api.getGridOption('pivotMode');
      if (!flat) api.refreshServerSide({ purge: false });
    }, refreshMs);
    return () => clearInterval(iv);
  }, [ready, refreshMs, running]);

  // Update counter: flush at 2Hz instead of per-batch — per-batch setState
  // re-rendered the grid ~200×/s for no visual benefit.
  useEffect(() => {
    const iv = setInterval(() => setUpdates(totalRef.current), 500);
    return () => clearInterval(iv);
  }, []);

  // Quick view presets — same effect as dragging chips into the panels.
  const applyPreset = (preset: 'flat' | 'desk' | 'desk-rating' | 'pivot-ccy'): void => {
    const api = apiRef.current;
    if (!api) return;
    const groups: Record<typeof preset, string[]> = {
      flat: [],
      desk: ['desk'],
      'desk-rating': ['desk', 'rating.composite'],
      'pivot-ccy': ['desk'],
    };
    api.setGridOption('pivotMode', preset === 'pivot-ccy');
    api.applyColumnState({
      state: [
        ...groups[preset].map((colId, i) => ({ colId, rowGroup: true, rowGroupIndex: i })),
        ...(preset === 'pivot-ccy' ? [{ colId: 'currency', pivot: true, pivotIndex: 0 }] : []),
      ],
      defaultState: { rowGroup: false, pivot: false },
    });
  };

  const datasource = useMemo<IServerSideDatasource | null>(
    () =>
      ready
        ? {
            getRows: (params) => {
              ready.server
                .getRows(params.request)
                .then((r) => params.success(r))
                .catch((err) => {
                  console.error('[ag-ssrm] getRows failed', err);
                  params.fail();
                });
            },
          }
        : null,
    [ready],
  );

  return (
    <main className="page">
      <div className="page-head">
        <h2>Perspective SSRM — ag-grid view, FinOS engine, STOMP data</h2>
        <p>
          ag-grid's Server-Side Row Model with a headless FinOS Perspective WASM
          engine as the "server": every block request (group level, leaf slice,
          pivot) becomes a short-lived Perspective view over the 20k-row STOMP
          snapshot, ticking underneath at ~10k updates/s. Drag any of the{' '}
          {ready?.colCount ?? '~372'} columns into the group/pivot panels — all are
          enabled. Aggregates re-fetch every {refreshMs === 0 ? '∞' : `${refreshMs / 1000}s`}{' '}
          (loaded blocks only, no purge). Column filters are off in this build;
          sorting is engine-side.
        </p>
      </div>
      <div className="controls">
        <button
          type="button"
          className={running ? 'active' : ''}
          onClick={() =>
            setRunning((r) => {
              runningRef.current = !r;
              return !r;
            })
          }
        >
          {running ? 'Pause feed' : 'Resume feed'}
        </button>
        <label>
          Aggregate refresh
          <select
            value={refreshMs}
            onChange={(e) => setRefreshMs(Number(e.target.value))}
            style={{ marginLeft: 8 }}
          >
            <option value={1000}>1s</option>
            <option value={2000}>2s</option>
            <option value={5000}>5s</option>
            <option value={0}>Off</option>
          </select>
        </label>
        <button type="button" onClick={() => applyPreset('flat')}>Flat</button>
        <button type="button" onClick={() => applyPreset('desk')}>Group: desk</button>
        <button type="button" onClick={() => applyPreset('desk-rating')}>
          Group: desk → rating
        </button>
        <button type="button" onClick={() => applyPreset('pivot-ccy')}>
          Pivot: currency
        </button>
      </div>
      <div className="grid-wrap">
        {phase === 'live' && ready && datasource ? (
          <AgGridReact
            theme={gridTheme}
            columnDefs={ready.columnDefs}
            rowModelType="serverSide"
            serverSideDatasource={datasource}
            cacheBlockSize={100}
            maxBlocksInCache={20}
            rowGroupPanelShow="always"
            pivotPanelShow="always"
            sideBar={SIDE_BAR}
            suppressFieldDotNotation
            serverSidePivotResultFieldSeparator="|"
            suppressAggFuncInHeader
            defaultColDef={DEFAULT_COL_DEF}
            autoGroupColumnDef={AUTO_GROUP_COL_DEF}
            getRowId={getRowId}
            onGridReady={(e) => {
              apiRef.current = e.api;
              // Dev handle for driving the demo from the console/tests.
              (window as unknown as Record<string, unknown>).__agApi = e.api;
            }}
          />
        ) : (
          <div className="ssrm-empty">
            {phase === 'connecting' ? 'Connecting to STOMP…' : null}
            {phase === 'snapshot'
              ? `Snapshot ${snapProgress.toLocaleString()} / ${SNAPSHOT_ROWS.toLocaleString()} rows…`
              : null}
            {phase === 'loading' ? 'Loading engine (flatten + schema + 20k rows)…' : null}
            {phase === 'offline' ? (
              <>
                STOMP server offline — start it with <code>npm run dev:stomp</code> and
                reload.
              </>
            ) : null}
          </div>
        )}
      </div>
      <div className="status">
        <span>
          Rows <b>{phase === 'live' ? SNAPSHOT_ROWS.toLocaleString() : '—'}</b>
        </span>
        <span>
          Columns <b>{ready ? ready.colCount : '—'}</b>
        </span>
        <span>
          Updates applied <b>{updates.toLocaleString()}</b>
        </span>
        <span style={{ color: phase === 'live' ? '#7CB88C' : phase === 'offline' ? '#8E8E8E' : '#C9A86A' }}>
          ● {phase === 'live' ? 'STOMP live (:8081)' : phase === 'offline' ? 'STOMP offline' : 'STOMP connecting…'}
        </span>
      </div>
    </main>
  );
}
