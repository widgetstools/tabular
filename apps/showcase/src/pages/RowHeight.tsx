import { useMemo, useState } from 'react';
import type { ColDef, GridOptions } from '@tabular/core';
import { TabularGrid } from '@tabular/react';

type Mode = 'getRowHeight' | 'autoHeight' | 'fullWidth' | 'headers';

export interface PersonRow {
  id: number;
  name: string;
  country: string;
  language: string;
  notes: string;
  /** px height used by the getRowHeight demo. */
  size: number;
  fullWidth: boolean;
}

const NAMES = ['Nora Thomas', 'Mig Jerez', 'Isabelle Black', 'Bilal Awan', 'Kenji Sato', 'Amelia Braxton', 'Sophie Beckham', 'Tor Hansen', 'Lucia Ortiz', 'Omar Farah'];
const COUNTRIES = ['United States', 'Spain', 'France', 'Pakistan', 'Japan', 'Germany', 'United Kingdom', 'Norway', 'Mexico', 'Somalia'];
const LANGUAGES = ['English', 'Spanish', 'French', 'Urdu', 'Japanese', 'German', 'English', 'Norwegian', 'Spanish', 'Somali'];
const LOREM =
  'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua Ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur'.split(' ');

export function makePeople(n: number): PersonRow[] {
  const rows: PersonRow[] = [];
  for (let i = 0; i < n; i++) {
    const words = 4 + ((i * 17) % 48);
    rows.push({
      id: i,
      name: `${NAMES[i % NAMES.length]} ${i}`,
      country: COUNTRIES[i % COUNTRIES.length],
      language: LANGUAGES[i % LANGUAGES.length],
      notes: LOREM.slice(0, words).join(' '),
      size: 28 + ((i * 13) % 5) * 14,
      fullWidth: i % 7 === 5,
    });
  }
  return rows;
}

export function RowHeightPage() {
  const [mode, setMode] = useState<Mode>('getRowHeight');
  const rowData = useMemo(() => makePeople(60), []);

  const baseCols = useMemo<ColDef<PersonRow>[]>(
    () => [
      { field: 'name', width: 160 },
      { field: 'country', width: 150 },
      { field: 'language', width: 130 },
      { field: 'notes', flex: 1, minWidth: 200 },
    ],
    [],
  );

  const autoHeightCols = useMemo<ColDef<PersonRow>[]>(
    () => [
      // AG docs auto-height example: A = wrapText + autoHeight, B = wrapText only (clipped).
      { field: 'notes', headerName: 'Auto height (wrapText + autoHeight)', wrapText: true, autoHeight: true, width: 320 },
      { field: 'notes', colId: 'notesClipped', headerName: 'Wrap only (clipped)', wrapText: true, width: 260 },
      { field: 'name', width: 160 },
      { field: 'country', width: 150 },
      { field: 'language', width: 130 },
    ],
    [],
  );

  const headerCols = useMemo<ColDef<PersonRow>[]>(
    () => [
      { field: 'name', headerName: 'Athlete full name (as registered with the committee)', width: 150 },
      { field: 'country', headerName: 'Country of national representation', width: 130 },
      { field: 'language', headerName: 'Primary spoken language', width: 120 },
      { field: 'id', headerName: 'Wrap only — no autoHeaderHeight', autoHeaderHeight: false, width: 110 },
      { field: 'notes', headerName: 'Notes', flex: 1, minWidth: 160 },
    ],
    [],
  );

  const modeOptions = useMemo<Partial<GridOptions<PersonRow>>>(() => {
    if (mode === 'headers') {
      return {
        defaultColDef: { wrapHeaderText: true, autoHeaderHeight: true, resizable: true },
      };
    }
    if (mode === 'getRowHeight') {
      return { getRowHeight: (p) => p.data?.size };
    }
    if (mode === 'fullWidth') {
      return {
        isFullWidthRow: (p) => p.rowNode.data?.fullWidth === true,
        fullWidthCellRenderer: (ctx, p) => {
          const t = p.theme;
          ctx.fillStyle = 'rgba(43, 108, 176, 0.14)';
          ctx.fillRect(p.x, p.y, p.width, p.height);
          ctx.font = `600 ${t.fontSize}px ${t.fontSans}`;
          ctx.fillStyle = t.textPrimary;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          const d = p.data;
          ctx.fillText(`★ ${d?.name} — ${d?.country} (${d?.language})`, p.x + 12, p.y + 18);
          ctx.font = `400 ${t.fontSize - 1}px ${t.fontSans}`;
          ctx.fillStyle = t.textSecondary;
          ctx.fillText(d?.notes ?? '', p.x + 12, p.y + 40, p.width - 24);
        },
        getRowHeight: (p) => (p.data?.fullWidth ? 56 : undefined),
      };
    }
    return {};
  }, [mode]);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Row height &amp; full-width rows</h2>
        <p>
          <b>getRowHeight</b>: per-row pixel heights from a callback. <b>Auto height</b>:{' '}
          <code>wrapText</code> + <code>autoHeight</code> size rows to the tallest wrapped column;
          the wrap-only column clips. <b>Full width</b>: <code>isFullWidthRow</code> +{' '}
          <code>fullWidthCellRenderer</code> paint one cell across the whole viewport.{' '}
          <b>Header sizing</b>: <code>wrapHeaderText</code> + <code>autoHeaderHeight</code> — drag a
          column edge and the header row re-measures.
        </p>
      </div>
      <div className="controls">
        {(['getRowHeight', 'autoHeight', 'fullWidth', 'headers'] as const).map((m) => (
          <button key={m} type="button" className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
            {m === 'getRowHeight'
              ? 'getRowHeight'
              : m === 'autoHeight'
                ? 'Auto height'
                : m === 'fullWidth'
                  ? 'Full width'
                  : 'Header sizing'}
          </button>
        ))}
      </div>
      <div className="grid-wrap">
        <TabularGrid<PersonRow>
          key={mode}
          {...modeOptions}
          columnDefs={mode === 'autoHeight' ? autoHeightCols : mode === 'headers' ? headerCols : baseCols}
          rowData={rowData}
        />
      </div>
    </main>
  );
}
