import { useMemo, useRef, useState } from 'react';
import type { ColDef, GridOptions, Tabular } from '@tabular/core';
import { TabularGrid } from '@tabular/react';
import { FI_ID, FI_GET_ROW_ID } from '../stomp/fiColumns';
import type { FiPosition } from '../stomp/fiPositionsSource';
import { useFiFeed, useFiUpdates } from '../stomp/sharedFeed';
import { FeedBadge } from '../stomp/FeedBadge';

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

/** Deterministic string hash — used on the live path to derive a per-row
 * pixel height / full-width flag from `cusip` (no synthetic `size`/
 * `fullWidth` fields exist on FI positions). */
function fiHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Live column sets: same four demos, over FI fields — `instrumentName`
 * stands in for the long-text `notes` column (wrapText/autoHeight target). */
const liveBaseCols: ColDef<FiPosition>[] = [
  { field: 'ticker', headerName: 'Ticker', width: 90 },
  { field: 'region', headerName: 'Region', width: 130 },
  { field: 'currency', headerName: 'Ccy', width: 90 },
  { field: 'instrumentName', headerName: 'Instrument', flex: 1, minWidth: 200 },
];

const liveAutoHeightCols: ColDef<FiPosition>[] = [
  { field: 'instrumentName', headerName: 'Auto height (wrapText + autoHeight)', wrapText: true, autoHeight: true, width: 320 },
  { field: 'instrumentName', colId: 'notesClipped', headerName: 'Wrap only (clipped)', wrapText: true, width: 260 },
  { field: 'ticker', headerName: 'Ticker', width: 90 },
  { field: 'region', headerName: 'Region', width: 130 },
  { field: 'currency', headerName: 'Ccy', width: 90 },
];

const liveHeaderCols: ColDef<FiPosition>[] = [
  { field: 'ticker', headerName: 'Ticker symbol (as registered with the exchange)', width: 150 },
  { field: 'region', headerName: 'Region of booking desk', width: 130 },
  { field: 'currency', headerName: 'Settlement currency', width: 120 },
  { ...FI_ID, headerName: 'Wrap only — no autoHeaderHeight', autoHeaderHeight: false, width: 110 },
  { field: 'instrumentName', headerName: 'Instrument', flex: 1, minWidth: 160 },
];

export function RowHeightPage() {
  const { rows, status } = useFiFeed();
  const live = status === 'ready' && rows;
  const liveApiRef = useRef<Tabular<FiPosition> | null>(null);
  useFiUpdates(
    (batch) => liveApiRef.current?.applyTransactionAsync({ update: batch }),
    !!live,
  );

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

  const liveModeOptions = useMemo<Partial<GridOptions<FiPosition>>>(() => {
    if (mode === 'headers') {
      return {
        defaultColDef: { wrapHeaderText: true, autoHeaderHeight: true, resizable: true },
      };
    }
    if (mode === 'getRowHeight') {
      return {
        getRowHeight: (p) => {
          const cusip = String(p.data?.cusip ?? '');
          return 28 + (fiHash(cusip) % 5) * 14;
        },
      };
    }
    if (mode === 'fullWidth') {
      return {
        isFullWidthRow: (p) => fiHash(String(p.rowNode.data?.cusip ?? '')) % 7 === 5,
        fullWidthCellRenderer: (ctx, p) => {
          const t = p.theme;
          ctx.fillStyle = 'rgba(43, 108, 176, 0.14)';
          ctx.fillRect(p.x, p.y, p.width, p.height);
          ctx.font = `600 ${t.fontSize}px ${t.fontSans}`;
          ctx.fillStyle = t.textPrimary;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          const d = p.data;
          ctx.fillText(`★ ${d?.ticker} — ${d?.region} (${d?.currency})`, p.x + 12, p.y + 18);
          ctx.font = `400 ${t.fontSize - 1}px ${t.fontSans}`;
          ctx.fillStyle = t.textSecondary;
          ctx.fillText(String(d?.instrumentName ?? ''), p.x + 12, p.y + 40, p.width - 24);
        },
        getRowHeight: (p) => (fiHash(String(p.data?.cusip ?? '')) % 7 === 5 ? 56 : undefined),
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
          {live ? (
            <>
              {' '}
              Live FI positions — <code>instrumentName</code> stands in for the wrapped-text column;
              per-row height/full-width flag derive from a hash of <code>cusip</code>.
            </>
          ) : null}
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
        {live ? (
          <TabularGrid<FiPosition>
            key={`stomp-${mode}`}
            {...liveModeOptions}
            columnDefs={mode === 'autoHeight' ? liveAutoHeightCols : mode === 'headers' ? liveHeaderCols : liveBaseCols}
            rowData={rows}
            getRowId={FI_GET_ROW_ID}
            onReady={(api) => {
              liveApiRef.current = api;
            }}
          />
        ) : (
          <TabularGrid<PersonRow>
            key={`synthetic-${mode}`}
            {...modeOptions}
            columnDefs={mode === 'autoHeight' ? autoHeightCols : mode === 'headers' ? headerCols : baseCols}
            rowData={rowData}
          />
        )}
      </div>
      <div className="status">
        <FeedBadge status={status} />
      </div>
    </main>
  );
}
