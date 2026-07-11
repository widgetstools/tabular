import { useMemo, useRef, useState } from 'react';
import type { Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';

export function FloatingFiltersPage() {
  const rowData = useMemo(() => makeBonds(15_000), []);
  const columnDefs = useMemo(
    () =>
      bondColumns().map((c) =>
        // Categorical columns get AG-style set filters (checkbox dropdowns).
        c.field === 'sector' || c.field === 'rating' || c.field === 'desk'
          ? { ...c, filter: 'set' as const }
          : c,
      ),
    [],
  );
  const apiRef = useRef<Tabular<Bond> | null>(null);
  const [quick, setQuick] = useState('');
  const [displayed, setDisplayed] = useState(15_000);
  const [modified, setModified] = useState('—');
  const [hideHy, setHideHy] = useState(false);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Floating filters</h2>
        <p>
          Filter row sits below column headers on <code>surface.raised</code> with a structural
          underline. Canvas shows the active filter; click a cell to open a DOM input.{' '}
          <b>Sector, Rating and Desk are set filters</b> — click their filter cell for a checkbox
          dropdown; typing in the filter box searches the values. Quick filter tokenizes on
          whitespace (all tokens must match). External filter example hides HY-rated bonds.
        </p>
      </div>
      <div className="controls">
        <input
          type="text"
          placeholder="Quick filter (tokenized)…"
          value={quick}
          onChange={(e) => {
            setQuick(e.target.value);
            apiRef.current?.setQuickFilter(e.target.value);
          }}
        />
        <label>
          <input
            type="checkbox"
            checked={hideHy}
            onChange={(e) => {
              setHideHy(e.target.checked);
            }}
          />{' '}
          External: hide HY ratings
        </label>
        <button
          onClick={() => {
            setQuick('');
            apiRef.current?.setQuickFilter('');
            apiRef.current?.setFilterModel({});
          }}
        >
          Clear filters
        </button>
      </div>
      <div className="grid-wrap">
        <TabularGrid<Bond>
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => p.data.id}
          floatingFilter
          defaultColDef={{ filter: true, floatingFilter: true }}
          density="compact"
          isExternalFilterPresent={() => hideHy}
          doesExternalFilterPass={(row) => !row.rating.startsWith('HY')}
          onReady={(api) => {
            apiRef.current = api;
            api.on('modelUpdated', (e) => setDisplayed(e.displayedRowCount));
            api.on('filterModified', (e) =>
              setModified(e.filter ? `${e.colId}: ${JSON.stringify(e.filter)}` : `${e.colId}: cleared`),
            );
          }}
        />
      </div>
      <div className="status">
        <span>
          Displayed <b>{displayed.toLocaleString()}</b> of <b>15,000</b>
        </span>
        <span>
          Last filter edit <b>{modified}</b>
        </span>
      </div>
    </main>
  );
}
