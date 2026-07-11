import { useEffect, useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { gridTheme } from '../theme';
import { fetchOlympicData, type OlympicRow } from '../olympic';

type SpanMode = 'colspan' | 'rowspan';

const COUNTRY_BG = 'rgba(43, 108, 176, 0.35)';

/** AG Grid reference — column spanning + row spanning docs examples. */
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
      { field: 'age', pinned: 'left', type: 'rightAligned', width: 90 },
      {
        field: 'country',
        width: 150,
        colSpan: (p) => {
          const country = p.data?.country;
          if (country === 'Russia') return 2;
          if (country === 'United States') return 4;
          return 1;
        },
        cellStyle: { backgroundColor: COUNTRY_BG },
      },
      { field: 'year', type: 'rightAligned', width: 90 },
      { field: 'date', width: 110 },
      { field: 'sport', width: 150 },
      { field: 'gold', type: 'rightAligned', width: 90 },
      { field: 'silver', type: 'rightAligned', width: 90 },
      { field: 'bronze', type: 'rightAligned', width: 90 },
      { field: 'total', type: 'rightAligned', width: 90 },
    ],
    [],
  );

  const rowSpanDefs = useMemo<ColDef<OlympicRow>[]>(
    () => [
      {
        field: 'country',
        width: 150,
        sort: 'asc',
        spanRows: ({ valueA, valueB }) => valueA !== 'Algeria' && valueA === valueB,
      },
      { field: 'year', type: 'rightAligned', width: 90, spanRows: true },
      { field: 'sport', width: 150, spanRows: true },
      { field: 'athlete', width: 150 },
      { field: 'age', type: 'rightAligned', width: 90 },
      { field: 'gold', type: 'rightAligned', width: 90 },
      { field: 'silver', type: 'rightAligned', width: 90 },
      { field: 'bronze', type: 'rightAligned', width: 90 },
      { field: 'total', type: 'rightAligned', width: 90 },
    ],
    [],
  );

  const colspan = mode === 'colspan';

  return (
    <main className="page">
      <div className="page-head">
        <h2>Cell spanning</h2>
        <p>
          AG Grid reference — <code>colSpan</code> (Russia 2, United States 4) and{' '}
          <code>enableCellSpan</code> + <code>spanRows</code> (Algeria excluded via callback).
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
          <AgGridReact<OlympicRow>
            key={mode}
            theme={gridTheme}
            columnDefs={colspan ? colSpanDefs : rowSpanDefs}
            rowData={rowData}
            enableCellSpan={!colspan}
            cellSelection
          />
        </div>
      )}
    </main>
  );
}
