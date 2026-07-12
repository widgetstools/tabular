import { useMemo, useRef, useState } from 'react';
import type { Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';
import { FI_COLUMNS, FI_GET_ROW_ID } from '../stomp/fiColumns';
import type { FiPosition } from '../stomp/fiPositionsSource';
import { useFiFeed, useFiUpdates } from '../stomp/sharedFeed';
import { FeedBadge } from '../stomp/FeedBadge';

export function ClipboardExportPage() {
  const { rows, status } = useFiFeed();
  const live = status === 'ready' && rows;
  const rowData = useMemo(() => makeBonds(120), []);
  const columnDefs = useMemo(() => bondColumns(), []);
  const apiRef = useRef<Tabular<Bond> | null>(null);
  const liveApiRef = useRef<Tabular<FiPosition> | null>(null);
  const [csvPreview, setCsvPreview] = useState('');

  useFiUpdates(
    (batch) => liveApiRef.current?.applyTransactionAsync({ update: batch }),
    !!live,
  );

  const activeApi = () => (live ? liveApiRef.current : apiRef.current);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Clipboard &amp; export</h2>
        <p>
          Copy/cut/paste (⌘C / ⌘X / ⌘V), <code>copySelectedRowsToClipboard</code>, CSV and Excel
          export with AG-shaped params. Select a cell range or rows, then copy — or export via the
          buttons / context menu. {live ? 'Live FI positions from the STOMP feed.' : ''}
        </p>
      </div>
      <div className="controls">
        <button type="button" onClick={() => activeApi()?.copyToClipboard({ includeHeaders: true })}>
          Copy with headers
        </button>
        <button
          type="button"
          onClick={() => activeApi()?.copySelectedRowsToClipboard({ includeHeaders: true })}
        >
          Copy selected rows
        </button>
        <button
          type="button"
          onClick={() => {
            const csv = activeApi()?.getDataAsCsv({ onlySelected: true }) ?? '';
            setCsvPreview(csv.slice(0, 400) + (csv.length > 400 ? '…' : ''));
          }}
        >
          Preview CSV (selected)
        </button>
        <button
          type="button"
          onClick={() =>
            activeApi()?.exportDataAsCsv({ fileName: live ? 'fi-positions.csv' : 'bonds.csv' })
          }
        >
          Download CSV
        </button>
        <button
          type="button"
          onClick={() =>
            activeApi()?.exportDataAsExcel({ fileName: live ? 'fi-positions.xls' : 'bonds.xls' })
          }
        >
          Download Excel
        </button>
        <FeedBadge status={status} />
      </div>
      {csvPreview ? (
        <pre className="csv-preview" style={{ margin: '0 16px', fontSize: 12, opacity: 0.85 }}>
          {csvPreview}
        </pre>
      ) : null}
      <div className="grid-wrap">
        {live ? (
          <TabularGrid<FiPosition>
            key="stomp"
            columnDefs={FI_COLUMNS}
            rowData={rows}
            getRowId={FI_GET_ROW_ID}
            density="compact"
            rowSelection={{ mode: 'multiRow', checkboxes: true, headerCheckbox: true }}
            copyHeadersToClipboard
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
            density="compact"
            rowSelection={{ mode: 'multiRow', checkboxes: true, headerCheckbox: true }}
            copyHeadersToClipboard
            onReady={(api) => {
              apiRef.current = api;
            }}
          />
        )}
      </div>
    </main>
  );
}
