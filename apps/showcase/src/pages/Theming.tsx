import { useEffect, useMemo, useRef, useState } from 'react';
import type { Density, Tabular, ThemeName } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { makeBonds, type Bond } from '../data';
import { bondColumns } from '../columns';
import { FI_COLUMNS, FI_GET_ROW_ID } from '../stomp/fiColumns';
import type { FiPosition } from '../stomp/fiPositionsSource';
import { useFiFeed, useFiUpdates } from '../stomp/sharedFeed';
import { FeedBadge } from '../stomp/FeedBadge';

const DENSITIES: Density[] = ['comfortable', 'compact', 'dense'];

export function ThemingPage() {
  const { rows, status } = useFiFeed();
  const live = status === 'ready' && rows;
  const liveApiRef = useRef<Tabular<FiPosition> | null>(null);
  useFiUpdates(
    (batch) => liveApiRef.current?.applyTransactionAsync({ update: batch }),
    !!live,
  );
  const rowData = useMemo(() => makeBonds(1000), []);
  const columnDefs = useMemo(() => bondColumns(), []);
  const [theme, setTheme] = useState<ThemeName>('dark');
  const [density, setDensity] = useState<Density>('compact');

  useEffect(() => {
    document.body.classList.toggle('light', theme === 'light');
    return () => document.body.classList.remove('light');
  }, [theme]);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Theming &amp; density</h2>
        <p>
          Cursor Dark and Cursor Light — token sets lifted from the installed Cursor IDE color
          themes, resolved into a flat palette consumed directly by paint(). One density control
          drives row height, font size, padding, and gridlines: at dense, gridlines vanish and
          zebra striping alone separates rows. Theme and density switches are one full repaint —
          never animated.
        </p>
      </div>
      <div className="controls">
        <label>Theme</label>
        <button className={theme === 'dark' ? 'on' : ''} onClick={() => setTheme('dark')}>
          Cursor Dark
        </button>
        <button className={theme === 'light' ? 'on' : ''} onClick={() => setTheme('light')}>
          Cursor Light
        </button>
        <span style={{ width: 16 }} />
        <label>Density</label>
        {DENSITIES.map((d) => (
          <button key={d} className={density === d ? 'on' : ''} onClick={() => setDensity(d)}>
            {d}
          </button>
        ))}
      </div>
      <div className="grid-wrap">
        {live ? (
          <TabularGrid<FiPosition>
            key="stomp"
            columnDefs={FI_COLUMNS}
            rowData={rows}
            getRowId={FI_GET_ROW_ID}
            theme={theme}
            density={density}
            rowSelection="multiple"
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
            theme={theme}
            density={density}
            rowSelection="multiple"
          />
        )}
      </div>
      <div className="status">
        <span>
          Gridlines: <b>both</b> (horizontal + vertical)
        </span>
        <FeedBadge status={status} />
      </div>
    </main>
  );
}
