/** Seeded fixed-income demo data. Deterministic so pages are reproducible. */

export interface Bond {
  id: string;
  cusip: string;
  issuer: string;
  sector: string;
  rating: string;
  coupon: number;
  maturity: string;
  price: number;
  yld: number;
  spread: number;
  dv01: number;
  notional: number;
  pnl: number;
  desk: string;
  trader: string;
}

const ISSUERS = [
  'Acme Industrial', 'Borealis Energy', 'Cascadia Rail', 'Dynamo Retail', 'Evergreen Health',
  'Fulcrum Media', 'Granite Utilities', 'Harbor Shipping', 'Ionis Telecom', 'Juniper Foods',
  'Keystone Materials', 'Lumen Aerospace', 'Meridian Banks', 'Northgate REIT', 'Oakline Auto',
  'Pinnacle Chem', 'Quarry Mining', 'Riverton Pharma', 'Summit Software', 'Tundra Airlines',
];
const SECTORS = ['Industrials', 'Energy', 'Transport', 'Retail', 'Healthcare', 'Media', 'Utilities', 'Financials', 'Telecom', 'Technology'];
const RATINGS = ['AAA', 'AA+', 'AA', 'AA-', 'A+', 'A', 'A-', 'BBB+', 'BBB', 'BBB-', 'BB+', 'BB', 'B+'];
const DESKS = ['IG Credit', 'HY Credit', 'EM Credit', 'Financials'];
export const TRADERS = ['akim', 'bchen', 'dmoss', 'ehale', 'jpark', 'lruiz', 'mvogl', 'nshah', 'tking'];
const CUSIP_CHARS = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export function makeBonds(n: number, seed = 42): Bond[] {
  const rnd = makeRng(seed);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
  const out: Bond[] = new Array(n);
  for (let i = 0; i < n; i++) {
    let cusip = '';
    for (let k = 0; k < 9; k++) cusip += CUSIP_CHARS[Math.floor(rnd() * CUSIP_CHARS.length)];
    const coupon = 1 + Math.round(rnd() * 28) / 4;
    const price = 78 + rnd() * 40;
    const notional = (1 + Math.floor(rnd() * 50)) * 250_000;
    out[i] = {
      id: `B${i}`,
      cusip,
      issuer: pick(ISSUERS),
      sector: pick(SECTORS),
      rating: pick(RATINGS),
      coupon,
      maturity: `20${27 + Math.floor(rnd() * 20)}-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-15`,
      price: round2(price),
      yld: round2(2 + rnd() * 7),
      spread: Math.round(40 + rnd() * 420),
      dv01: round2(notional * (0.5 + rnd() * 9) / 10_000),
      notional,
      pnl: Math.round((rnd() - 0.48) * 250_000),
      desk: pick(DESKS),
      trader: pick(TRADERS),
    };
  }
  return out;
}

/** Mutate `count` random rows; returns updated copies (new objects). */
export function tick(rows: Bond[], count: number, rnd: () => number): Bond[] {
  const updates: Bond[] = [];
  for (let i = 0; i < count; i++) {
    const row = rows[Math.floor(rnd() * rows.length)];
    const drift = (rnd() - 0.5) * 0.6;
    const next: Bond = {
      ...row,
      price: round2(Math.max(40, row.price + drift)),
      yld: round2(Math.max(0.1, row.yld - drift * 0.08)),
      spread: Math.max(5, row.spread - Math.round(drift * 6)),
      pnl: Math.round(row.pnl + drift * row.notional * 0.001),
    };
    updates.push(next);
  }
  return updates;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Hierarchical positions for the tree-data page (same seed as showcase). */
export interface TreeRow {
  id: string;
  path: string[];
  instrument: string;
  notional: number;
  pnl: number;
  dv01: number;
  trader: string;
}

export function makeTreeRows(seed = 11): TreeRow[] {
  const rnd = makeRng(seed);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
  const out: TreeRow[] = [];
  let id = 0;
  for (const desk of DESKS) {
    // The desk row itself is a real record; book levels are filler nodes.
    out.push({
      id: `T${id++}`,
      path: [desk],
      instrument: '',
      notional: 0,
      pnl: Math.round((rnd() - 0.5) * 40_000),
      dv01: 0,
      trader: pick(TRADERS),
    });
    const books = 2 + Math.floor(rnd() * 3);
    for (let b = 0; b < books; b++) {
      const book = `${desk.split(' ')[0]}-BK${b + 1}`;
      const positions = 3 + Math.floor(rnd() * 5);
      for (let p = 0; p < positions; p++) {
        const issuer = pick(ISSUERS);
        const notional = (1 + Math.floor(rnd() * 40)) * 250_000;
        out.push({
          id: `T${id++}`,
          path: [desk, book, `${issuer} ${round2(1 + rnd() * 7)}%`],
          instrument: pick(SECTORS),
          notional,
          pnl: Math.round((rnd() - 0.48) * 120_000),
          dv01: round2((notional * (0.5 + rnd() * 9)) / 10_000),
          trader: pick(TRADERS),
        });
      }
    }
  }
  return out;
}

/** Generic wide dataset for the 100k × wide-columns page. */
export interface WideRow {
  id: string;
  name: string;
  group: string;
  [metric: string]: string | number;
}

export function makeWide(rows: number, metricCols: number, seed = 7): WideRow[] {
  const rnd = makeRng(seed);
  const out: WideRow[] = new Array(rows);
  for (let i = 0; i < rows; i++) {
    const r: WideRow = {
      id: `R${i}`,
      name: `Instrument ${i}`,
      group: `G${i % 25}`,
    };
    for (let m = 0; m < metricCols; m++) {
      r[`m${m}`] = Math.round(rnd() * 100_000) / 100;
    }
    out[i] = r;
  }
  return out;
}
