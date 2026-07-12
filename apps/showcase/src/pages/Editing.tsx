import { useMemo, useRef, useState } from 'react';
import type { CellValueChangedEvent, ColDef, Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, TRADERS, type Bond } from '../data';
import { bondColumns } from '../columns';
import { FI_ID, FI_DESC, FI_NESTED, FI_GET_ROW_ID } from '../stomp/fiColumns';
import type { FiPosition } from '../stomp/fiPositionsSource';
import { useFiFeed, useFiUpdates } from '../stomp/sharedFeed';
import { FeedBadge } from '../stomp/FeedBadge';

// Matches apps/stomp-view-server/src/data/fiRecords.ts TRADERS so the
// select editor's options include the values already on the wire.
const FI_TRADERS = ['John Smith', 'Jane Doe', 'Mike Johnson', 'Sarah Williams', 'Tom Brown', 'Lisa Davis'];

/**
 * Live columns: only FLAT, physically-writable fields are editable
 * (quantity/notionalAmount/currentPrice as numbers, trader as a select,
 * maturityDate as a date, instrumentName as large text). The dotted
 * nested columns (rating.*, issuer.*, riskMetrics.*, analytics.*) are
 * read-only display columns — they're computed/derived server-side and
 * aren't meant to be edited in place.
 */
const liveColumnDefs: ColDef<FiPosition>[] = [
  { ...FI_ID, pinned: 'left' },
  ...FI_DESC.map((c): ColDef<FiPosition> => {
    if (c.field === 'instrumentName') {
      return {
        ...c,
        editable: true,
        cellEditor: 'agLargeTextCellEditor',
        cellEditorParams: { maxLength: 120, rows: 4, cols: 40 },
      };
    }
    if (c.field === 'trader') {
      return { ...c, editable: true, cellEditor: 'agSelectCellEditor', cellEditorParams: { values: FI_TRADERS } };
    }
    return c;
  }),
  { field: 'maturityDate', headerName: 'Maturity', width: 104, editable: true, cellEditor: 'agDateStringCellEditor' },
  ...FI_NESTED,
  { field: 'quantity', headerName: 'Qty', type: 'number', width: 90, format: '#,##0', editable: true, cellEditor: 'agNumberCellEditor', cellEditorParams: { min: 0, precision: 0 } },
  { field: 'currentPrice', headerName: 'Price', type: 'number', width: 90, format: '#,##0.0000', editable: true, cellEditor: 'agNumberCellEditor', cellEditorParams: { min: 0, precision: 4 } },
  { field: 'notionalAmount', headerName: 'Notional', type: 'number', width: 120, format: '#,##0', editable: true }, // default text-input editor
  { field: 'marketValue', headerName: 'Mkt Value', type: 'number', width: 130, format: '#,##0.00' },
  { field: 'pnl', headerName: 'PnL', type: 'number', width: 110, format: '#,##0' },
  { field: 'dailyPnl', headerName: 'Day PnL', type: 'number', width: 100, format: '#,##0' },
];

export function EditingPage() {
  const { rows, status } = useFiFeed();
  const live = status === 'ready' && rows;
  const liveApiRef = useRef<Tabular<FiPosition> | null>(null);
  // SAFETY: live ticks replacing rows out from under an open cell editor can
  // corrupt the edit — the editor anchors by display index, and a
  // concurrent applyTransactionAsync can shift what that index points at.
  // Default OFF; the user opts in knowing edits may be interrupted.
  const [liveUpdatesOn, setLiveUpdatesOn] = useState(false);
  useFiUpdates(
    (batch) => liveApiRef.current?.applyTransactionAsync({ update: batch }),
    !!live && liveUpdatesOn,
  );
  const [liveLog, setLiveLog] = useState<string[]>([]);
  const onLiveChange = (e: CellValueChangedEvent<FiPosition>) => {
    setLiveLog((prev) =>
      [`${e.data.cusip} · ${e.colId}: ${String(e.oldValue)} → ${String(e.newValue)}`, ...prev].slice(0, 5),
    );
  };

  const rowData = useMemo(() => makeBonds(300), []);
  const columnDefs = useMemo<ColDef<Bond>[]>(
    () =>
      bondColumns().map((c): ColDef<Bond> => {
        switch (c.field) {
          case 'price':
            return {
              ...c,
              editable: true,
              cellEditor: 'agNumberCellEditor',
              cellEditorParams: { min: 0, precision: 2 },
            };
          case 'yld':
            return {
              ...c,
              editable: true,
              cellEditor: 'agNumberCellEditor',
              cellEditorParams: { precision: 2 },
            };
          case 'spread':
            return { ...c, editable: true }; // default text-input editor
          case 'trader':
            return {
              ...c,
              editable: true,
              cellEditor: 'agSelectCellEditor',
              cellEditorParams: { values: TRADERS },
            };
          case 'maturity':
            return { ...c, editable: true, cellEditor: 'agDateStringCellEditor' };
          case 'issuer':
            return {
              ...c,
              editable: true,
              cellEditor: 'agLargeTextCellEditor',
              cellEditorParams: { maxLength: 120, rows: 4, cols: 40 },
            };
          default:
            return c;
        }
      }),
    [],
  );
  const [log, setLog] = useState<string[]>([]);

  const onChange = (e: CellValueChangedEvent<Bond>) => {
    setLog((prev) =>
      [
        `${e.data.cusip} · ${e.colId}: ${String(e.oldValue)} → ${String(e.newValue)}`,
        ...prev,
      ].slice(0, 5),
    );
  };

  return (
    <main className="page">
      <div className="page-head">
        <h2>Editing</h2>
        <p>
          Built-in editors, AG names: Price/Yield use <code>agNumberCellEditor</code> (min/precision),
          Trader uses <code>agSelectCellEditor</code>, Maturity uses <code>agDateStringCellEditor</code>,
          Issuer uses <code>agLargeTextCellEditor</code> (popup textarea), Spread keeps the default
          text input. Editors are DOM, pixel-registered over the canvas cell. <span className="kbd">Enter</span>{' '}
          or <span className="kbd">F2</span> edits (all selected), typing a character replaces,{' '}
          <span className="kbd">Tab</span> commits and moves right, <span className="kbd">Esc</span>{' '}
          reverts. A committed numeric edit flashes exactly like a market tick — to the book they
          are the same event. Copy a range with <span className="kbd">⌘C</span> and paste TSV with{' '}
          <span className="kbd">⌘V</span>; <span className="kbd">⌘Z</span> undoes edits and pastes,{' '}
          <span className="kbd">⇧⌘Z</span> redoes.
          {live ? (
            <>
              {' '}
              Live FI positions: only flat, physically-writable fields are editable (Qty/Price use{' '}
              <code>agNumberCellEditor</code>, Trader uses <code>agSelectCellEditor</code>, Maturity
              uses <code>agDateStringCellEditor</code>, Instrument uses{' '}
              <code>agLargeTextCellEditor</code>, Notional keeps the default text input); the nested{' '}
              <code>rating.*</code>/<code>issuer.*</code>/<code>riskMetrics.*</code> columns are
              read-only. <b>Live updates are paused by default</b> — a tick replacing a row while its
              cell editor is open can corrupt the edit (editors anchor by on-screen row index, and a
              concurrent update can shift what that index points at). Flip the toggle below only when
              you&apos;re not mid-edit.
            </>
          ) : null}
        </p>
      </div>
      {live ? (
        <div className="controls">
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={liveUpdatesOn}
              onChange={(e) => setLiveUpdatesOn(e.target.checked)}
            />
            Live updates (off by default — see warning above)
          </label>
        </div>
      ) : null}
      <div className="grid-wrap">
        {live ? (
          <TabularGrid<FiPosition>
            key="stomp"
            columnDefs={liveColumnDefs}
            rowData={rows}
            getRowId={FI_GET_ROW_ID}
            density="comfortable"
            rowSelection="single"
            cellSelection
            suppressRowClickSelection
            statusBar
            undoRedoCellEditing
            undoRedoCellEditingLimit={100}
            onCellValueChanged={onLiveChange}
            onReady={(api) => {
              liveApiRef.current = api;
            }}
          />
        ) : (
          <TabularGrid<Bond>
            key="synthetic"
            columnDefs={columnDefs}
            rowData={rowData}
            getRowId={(p) => p.data.id}
            density="comfortable"
            rowSelection="single"
            cellSelection
            suppressRowClickSelection
            statusBar
            undoRedoCellEditing
            undoRedoCellEditingLimit={100}
            onCellValueChanged={onChange}
          />
        )}
      </div>
      <div className="status" style={{ flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
        {(live ? liveLog : log).length === 0 ? (
          <span>No edits yet — double-click a Price cell.</span>
        ) : (
          (live ? liveLog : log).map((l, i) => (
            <span key={i} style={{ opacity: 1 - i * 0.18 }}>
              {l}
            </span>
          ))
        )}
        <FeedBadge status={status} />
      </div>
    </main>
  );
}
