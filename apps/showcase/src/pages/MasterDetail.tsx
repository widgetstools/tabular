import { useMemo, useState } from 'react';
import type { ColDef, GridOptions } from '@tabular/core';
import { TabularGrid } from '@tabular/react';

type Mode = 'default' | 'autoHeight' | 'dynamic';

export interface CallRecord {
  callId: number;
  direction: 'Out' | 'In';
  number: string;
  duration: number;
  switchCode: string;
}

export interface AccountRow {
  id: number;
  name: string;
  account: number;
  calls: number;
  minutes: number;
  callRecords: CallRecord[];
}

const NAMES = ['Nora Thomas', 'Mig Jerez', 'Isabelle Black', 'Bilal Awan', 'Kenji Sato', 'Amelia Braxton', 'Sophie Beckham', 'Tor Hansen', 'Lucia Ortiz', 'Omar Farah'];
const SWITCHES = ['SW1', 'SW2', 'SW3', 'SW4', 'SW5'];

/** Deterministic dataset shared with the agref page for side-by-side parity. */
export function makeAccounts(n: number): AccountRow[] {
  const rows: AccountRow[] = [];
  for (let i = 0; i < n; i++) {
    const callCount = i % 5 === 4 ? 0 : 2 + ((i * 7) % 9);
    const callRecords: CallRecord[] = [];
    let minutes = 0;
    for (let c = 0; c < callCount; c++) {
      const duration = 20 + ((i * 31 + c * 17) % 180);
      minutes += duration;
      callRecords.push({
        callId: 500 + i * 20 + c,
        direction: (i + c) % 3 === 0 ? 'In' : 'Out',
        number: `(0${(i % 9) + 1}) ${String(10000000 + ((i * 977 + c * 131071) % 89999999))}`,
        duration,
        switchCode: SWITCHES[(i + c) % SWITCHES.length],
      });
    }
    rows.push({
      id: i,
      name: `${NAMES[i % NAMES.length]} ${i}`,
      account: 177000 + i * 13,
      calls: callCount,
      minutes: Math.round(minutes / 60),
    callRecords,
    });
  }
  return rows;
}

export function MasterDetailPage() {
  const [mode, setMode] = useState<Mode>('default');
  const rowData = useMemo(() => makeAccounts(40), []);

  const columnDefs = useMemo<ColDef<AccountRow>[]>(
    () => [
      { field: 'name', cellRenderer: 'agGroupCellRenderer', width: 200 },
      { field: 'account', width: 140 },
      { field: 'calls', width: 110 },
      { field: 'minutes', width: 120, valueFormatter: (p) => `${p.value}m` },
    ],
    [],
  );

  const detailParams = useMemo(
    () => ({
      detailGridOptions: {
        columnDefs: [
          { field: 'callId', width: 110 },
          { field: 'direction', width: 110 },
          { field: 'number', width: 180 },
          { field: 'duration', width: 120, valueFormatter: (p: { value: unknown }) => `${p.value}s` },
          { field: 'switchCode', headerName: 'Switch', width: 110 },
        ],
      },
      getDetailRowData: (params: { data: AccountRow; successCallback: (rows: CallRecord[]) => void }) => {
        params.successCallback(params.data.callRecords);
      },
    }),
    [],
  );

  const modeOptions = useMemo<Partial<GridOptions<AccountRow>>>(() => {
    if (mode === 'autoHeight') return { detailRowAutoHeight: true };
    if (mode === 'dynamic') return { isRowMaster: (data) => data.callRecords.length > 0 };
    return { detailRowHeight: 220 };
  }, [mode]);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Master / Detail</h2>
        <p>
          <code>masterDetail</code>: expanding a master row reveals a nested detail grid configured
          via <code>detailCellRendererParams</code> (<code>detailGridOptions</code> +{' '}
          <code>getDetailRowData</code>). <b>Fixed height</b> uses <code>detailRowHeight</code>;{' '}
          <b>Auto height</b> sizes each detail row to its rows; <b>Dynamic masters</b> uses{' '}
          <code>isRowMaster</code> so accounts without calls get no chevron.
        </p>
      </div>
      <div className="controls">
        {(['default', 'autoHeight', 'dynamic'] as const).map((m) => (
          <button key={m} type="button" className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
            {m === 'default' ? 'Fixed height' : m === 'autoHeight' ? 'Auto height' : 'Dynamic masters'}
          </button>
        ))}
      </div>
      <div className="grid-wrap">
        <TabularGrid<AccountRow>
          key={mode}
          columnDefs={columnDefs}
          rowData={rowData}
          getRowId={(p) => String(p.data.id)}
          masterDetail
          detailCellRendererParams={detailParams}
          {...modeOptions}
        />
      </div>
    </main>
  );
}
