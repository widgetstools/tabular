import { useMemo, useState } from 'react';
import type { CellValueChangedEvent, ColDef } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, TRADERS, type Bond } from '../data';
import { bondColumns } from '../columns';

export function EditingPage() {
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
        </p>
      </div>
      <div className="grid-wrap">
        <TabularGrid<Bond>
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
      </div>
      <div className="status" style={{ flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
        {log.length === 0 ? (
          <span>No edits yet — double-click a Price cell.</span>
        ) : (
          log.map((l, i) => (
            <span key={i} style={{ opacity: 1 - i * 0.18 }}>
              {l}
            </span>
          ))
        )}
      </div>
    </main>
  );
}
