import { useMemo, useRef, useState } from 'react';
import type { Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';

export function SortFilterPage() {
  const rowData = useMemo(() => makeBonds(20_000), []);
  const columnDefs = useMemo(() => bondColumns(), []);
  const apiRef = useRef<Tabular<Bond> | null>(null);
  const [quick, setQuick] = useState('');
  const [minSpread, setMinSpread] = useState('');
  const [issuer, setIssuer] = useState('');
  const [displayed, setDisplayed] = useState(20_000);
  const [sortDesc, setSortDesc] = useState('none');

  const applySpread = (v: string) => {
    setMinSpread(v);
    const n = Number(v);
    apiRef.current?.setColumnFilter(
      'spread',
      v.trim() !== '' && !Number.isNaN(n) ? { type: 'greaterThan', filter: n } : null,
    );
  };
  const applyIssuer = (v: string) => {
    setIssuer(v);
    apiRef.current?.setColumnFilter('issuer', v.trim() ? { type: 'contains', filter: v } : null);
  };

  return (
    <main className="page">
      <div className="page-head">
        <h2>Sorting &amp; filtering</h2>
        <p>
          20,000 rows. Quick filter scans every displayed column; column filters combine with AND.
          A filtered column shows a 2px accent bar under its header — state drawn as a property of
          the column edge, not an icon. Click headers to sort; shift-click adds a secondary sort
          with a superscript index.
        </p>
      </div>
      <div className="controls">
        <input
          type="text"
          placeholder="Quick filter…"
          value={quick}
          onChange={(e) => {
            setQuick(e.target.value);
            apiRef.current?.setQuickFilter(e.target.value);
          }}
        />
        <label>
          Issuer contains{' '}
          <input type="text" value={issuer} onChange={(e) => applyIssuer(e.target.value)} />
        </label>
        <label>
          Spread &gt;{' '}
          <input
            type="number"
            value={minSpread}
            style={{ width: 90 }}
            onChange={(e) => applySpread(e.target.value)}
          />
        </label>
        <button
          onClick={() => {
            setQuick('');
            setMinSpread('');
            setIssuer('');
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
          density="compact"
          rowSelection="single"
          onReady={(api) => {
            apiRef.current = api;
            api.on('modelUpdated', (e) => setDisplayed(e.displayedRowCount));
            api.on('sortChanged', (e) =>
              setSortDesc(
                e.sortModel.length
                  ? e.sortModel.map((s) => `${s.colId} ${s.sort}`).join(', ')
                  : 'none',
              ),
            );
          }}
        />
      </div>
      <div className="status">
        <span>
          Displayed <b>{displayed.toLocaleString()}</b> of <b>20,000</b>
        </span>
        <span>
          Sort <b>{sortDesc}</b>
        </span>
      </div>
    </main>
  );
}
