import { useEffect, useMemo, useState } from 'react';
import type { ColDef } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { fetchOlympicData, type OlympicRow } from '../olympic';

type SpanMode = 'colspan' | 'rowspan';

const COUNTRY_BG = 'rgba(43, 108, 176, 0.35)';

/**
 * Mirrors AG Grid column-spanning + row-spanning docs.
 * https://www.ag-grid.com/react-data-grid/column-spanning/
 * https://www.ag-grid.com/react-data-grid/row-spanning/
 */
export function SpanningPage() {
  const [rowData, setRowData] = useState<OlympicRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<SpanMode>('colspan');

  useEffect(() => {
    fetchOlympicData()
      .then(setRowData)
      .catch((e) => setLoadError(String(e)));
  }, []);

  const colSpanDefs = useMemo<ColDef<OlympicRow>[]>(
    () => [
      { field: 'athlete', pinned: 'left', width: 150 },
      { field: 'age', pinned: 'left', type: 'number', width: 90 },
      {
        field: 'country',
        width: 150,
        // AG docs example: Russia spans 2 columns, United States spans 4.
        colSpan: (p) => {
          const country = p.data?.country;
          if (country === 'Russia') return 2;
          if (country === 'United States') return 4;
          return 1;
        },
        cellStyle: { backgroundColor: COUNTRY_BG },
      },
      {
        field: 'year',
        type: 'number',
        width: 90,
        valueFormatter: (p) => (p.value == null ? '' : String(p.value)),
      },
      { field: 'date', width: 110 },
      { field: 'sport', width: 150 },
      { field: 'gold', type: 'number', width: 90 },
      { field: 'silver', type: 'number', width: 90 },
      { field: 'bronze', type: 'number', width: 90 },
      { field: 'total', type: 'number', width: 90 },
    ],
    [],
  );

  const rowSpanDefs = useMemo<ColDef<OlympicRow>[]>(
    () => [
      {
        field: 'country',
        width: 150,
        sort: 'asc',
        // Custom merge (AG docs): Algeria never merges.
        spanRows: ({ valueA, valueB }) => valueA !== 'Algeria' && valueA === valueB,
      },
      {
        field: 'year',
        type: 'number',
        width: 90,
        spanRows: true,
        valueFormatter: (p) => (p.value == null ? '' : String(p.value)),
      },
      { field: 'sport', width: 150, spanRows: true },
      { field: 'athlete', width: 150 },
      { field: 'age', type: 'number', width: 90 },
      { field: 'gold', type: 'number', width: 90 },
      { field: 'silver', type: 'number', width: 90 },
      { field: 'bronze', type: 'number', width: 90 },
      { field: 'total', type: 'number', width: 90 },
    ],
    [],
  );

  const colspan = mode === 'colspan';

  return (
    <main className="page">
      <div className="page-head">
        <h2>Cell spanning</h2>
        <p>
          <b>Column spanning</b>: <code>colSpan</code> — Russia spans 2 columns, United States
          spans 4; spans stop at the pinned-region boundary (drag Country into the pinned area to
          see it constrained). <b>Row spanning</b>: <code>enableCellSpan</code> +{' '}
          <code>spanRows</code> — contiguous equal values merge; Algeria is excluded via a custom
          callback. Click a merged cell to focus its anchor; arrows skip covered cells.
        </p>
      </div>
      <div className="controls">
        <button type="button" className={colspan ? 'active' : ''} onClick={() => setMode('colspan')}>
          Column spanning
        </button>
        <button type="button" className={!colspan ? 'active' : ''} onClick={() => setMode('rowspan')}>
          Row spanning
        </button>
      </div>
      {loadError ? (
        <div className="status">Failed to load Olympic data: {loadError}</div>
      ) : (
        <div className="grid-wrap">
          <TabularGrid<OlympicRow>
            key={mode}
            columnDefs={colspan ? colSpanDefs : rowSpanDefs}
            rowData={rowData}
            enableCellSpan={!colspan}
            cellSelection
            density="compact"
          />
        </div>
      )}
    </main>
  );
}
