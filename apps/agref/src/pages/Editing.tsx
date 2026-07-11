import { useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { gridTheme } from '../theme';
import { makeBonds, TRADERS, type Bond } from '../data';
import { bondColumns } from '../columns';

export function EditingPage() {
  const rowData = useMemo(() => makeBonds(600), []);
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
            return { ...c, editable: true };
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
              cellEditorPopup: true,
              cellEditorParams: { maxLength: 120, rows: 4, cols: 40 },
            };
          default:
            return c;
        }
      }),
    [],
  );
  const [lastEdit, setLastEdit] = useState('—');

  return (
    <main className="page">
      <div className="page-head">
        <h2>Editing</h2>
        <p>
          Provided editors: Price/Yield agNumberCellEditor, Trader agSelectCellEditor, Maturity
          agDateStringCellEditor, Issuer agLargeTextCellEditor (popup), Spread default text.
          Delete/Backspace clears the selected range.
        </p>
      </div>
      <div className="grid-wrap">
        <AgGridReact<Bond>
          theme={gridTheme}
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
          onCellValueChanged={(e) =>
            setLastEdit(`${e.colDef.field}[${e.rowIndex}] ${String(e.oldValue)} → ${String(e.newValue)}`)
          }
        />
      </div>
      <div className="status">
        <span>
          Last edit <b>{lastEdit}</b>
        </span>
      </div>
    </main>
  );
}
