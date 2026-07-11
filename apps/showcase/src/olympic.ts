/** AG Grid Olympic winners dataset (same URL as official pivot examples). */
export interface OlympicRow {
  athlete: string;
  age: number;
  country: string;
  year: number;
  date: string;
  sport: string;
  gold: number;
  silver: number;
  bronze: number;
  total: number;
}

const OLYMPIC_URL = 'https://www.ag-grid.com/example-assets/olympic-winners.json';

export async function fetchOlympicData(): Promise<OlympicRow[]> {
  const res = await fetch(OLYMPIC_URL);
  if (!res.ok) throw new Error(`Olympic data fetch failed: ${res.status}`);
  return res.json() as Promise<OlympicRow[]>;
}
