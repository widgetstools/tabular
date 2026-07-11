import { useMemo, useRef, useState } from 'react';
import type { Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';

export function ClipboardExportPage() {
  const rowData = useMemo(() => makeBonds(120), []);
  const columnDefs = useMemo(() => bondColumns(), []);
  const apiRef = useRef<Tabular<Bond> | null>(null);
  const [csvPreview, setCsvPreview] = useState('');

  return (
    <main className="page">
      <div className="page-head">
        <h2>Clipboard &amp; export</h2>
        <p>
          Copy/cut/paste (⌘C / ⌘X / ⌘V), <code>copySelectedRowsToClipboard</code>, CSV and Excel
          export with AG-shaped params. Select a cell range or rows, then copy — or export via the
          buttons / context menu.
        </p>
      </div>
      <div className="controls">
        <button type="button" onClick={() => apiRef.current?.copyToClipboard({ includeHeaders: true })}>
          Copy with headers
        </button>
        <button type="button" onClick={() => apiRef.current?.copySelectedRowsToClipboard({ includeHeaders: true })}>
          Copy selected rows
        </button>
        <button
          type="button"
          onClick={() => {
            const csv = apiRef.current?.getDataAsCsv({ onlySelected: true }) ?? '';
            setCsvPreview(csv.slice(0, 400) + (csv.length > 400 ? '…' : ''));
          }}
        >
          Preview CSV (selected)
        </button>
        <button type="button" onClick={() => apiRef.current?.exportDataAsCsv({ fileName: 'bonds.csv' })}>
          Download CSV
        </button>
        <button type="button" onClick={() => apiRef.current?.exportDataAsExcel({ fileName: 'bonds.xls' })}>
          Download Excel
        </button>
      </div>
      {csvPreview ? (
        <pre className="csv-preview" style={{ margin: '0 16px', fontSize: 12, opacity: 0.85 }}>
          {csvPreview}
        </pre>
      ) : null}
      <div className="grid-wrap">
        <TabularGrid<Bond>
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
          density="compact"
          rowSelection={{ mode: 'multiRow', checkboxes: true, headerCheckbox: true }}
          copyHeadersToClipboard
          onReady={(api) => {
            apiRef.current = api;
          }}
        />
      </div>
    </main>
  );
}
