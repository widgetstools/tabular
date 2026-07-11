import { useMemo, useRef } from 'react';
import type { ColDef, Tabular } from '@tabular/core';
import { registerToolPanel } from '@tabular/core';
import { registerEditToolPanels } from '@tabular/edit';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';

registerEditToolPanels(registerToolPanel);

export function EditOpsPage() {
  const rowData = useMemo(() => makeBonds(400), []);
  const columnDefs = useMemo<ColDef<Bond>[]>(
    () =>
      bondColumns().map((c): ColDef<Bond> => {
        if (c.field === 'price' || c.field === 'yld' || c.field === 'notional' || c.field === 'spread') {
          return {
            ...c,
            editable: true,
            cellEditor: 'agNumberCellEditor',
            cellEditorParams: c.field === 'price' || c.field === 'yld' ? { precision: 2 } : undefined,
          };
        }
        return c;
      }),
    [],
  );
  const apiRef = useRef<Tabular<Bond> | null>(null);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Edit ops</h2>
        <p>
          Phase 6 smart edit and bulk update tool panels. Enable a cell range (drag or shift+arrows),
          open <strong>Smart edit</strong> in the side bar, pick × ÷ + − and an operand (
          <code>1.5k</code>, <code>2M</code> ok), then Preview / Apply as one transaction. Use{' '}
          <strong>Bulk update</strong> to set a column across all filtered leaf rows. Number cells
          also accept magnitude suffixes when editing inline.
        </p>
      </div>
      <div className="controls">
        <button type="button" onClick={() => apiRef.current?.openToolPanel('smartEdit')}>
          Open Smart edit
        </button>
        <button type="button" onClick={() => apiRef.current?.openToolPanel('bulkUpdate')}>
          Open Bulk update
        </button>
      </div>
      <div className="grid-wrap">
        <TabularGrid<Bond>
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
          density="compact"
          cellSelection
          floatingFilter
          sideBar={{
            toolPanels: [
              {
                id: 'smartEdit',
                labelDefault: 'Smart edit',
                labelKey: 'smartEdit',
                iconKey: 'smartEdit',
                toolPanel: 'smartEdit',
                width: 280,
              },
              {
                id: 'bulkUpdate',
                labelDefault: 'Bulk update',
                labelKey: 'bulkUpdate',
                iconKey: 'bulkUpdate',
                toolPanel: 'bulkUpdate',
                width: 280,
              },
              {
                id: 'filters',
                labelDefault: 'Filters',
                labelKey: 'filters',
                iconKey: 'filter',
                toolPanel: 'agFiltersToolPanel',
              },
            ],
            defaultToolPanel: 'smartEdit',
          }}
          statusBar
          undoRedoCellEditing
          onReady={(api) => {
            apiRef.current = api;
            registerEditToolPanels((name, factory) => {
              api.registerToolPanel(name, factory);
            });
          }}
        />
      </div>
    </main>
  );
}
