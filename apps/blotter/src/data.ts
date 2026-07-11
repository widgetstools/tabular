/** Seeded FI blotter data (vanilla app copy — apps stay self-contained). */

export interface Bond {
  id: string;
  cusip: string;
  issuer: string;
  sector: string;
  rating: string;
  coupon: number;
  maturity: string;
  bid: number;
  ask: number;
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
const TRADERS = ['akim', 'bchen', 'dmoss', 'ehale', 'jpark', 'lruiz', 'mvogl', 'nshah', 'tking'];
const CUSIP_CHARS = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

export function makeBonds(n: number, seed = 90210): Bond[] {
  const rnd = makeRng(seed);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
  const out: Bond[] = new Array(n);
  for (let i = 0; i < n; i++) {
    let cusip = '';
    for (let k = 0; k < 9; k++) cusip += CUSIP_CHARS[Math.floor(rnd() * CUSIP_CHARS.length)];
    const mid = 78 + rnd() * 40;
    const half = 0.05 + rnd() * 0.3;
    const notional = (1 + Math.floor(rnd() * 50)) * 250_000;
    out[i] = {
      id: `B${i}`,
      cusip,
      issuer: pick(ISSUERS),
      sector: pick(SECTORS),
      rating: pick(RATINGS),
      coupon: 1 + Math.round(rnd() * 28) / 4,
      maturity: `20${27 + Math.floor(rnd() * 20)}-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-15`,
      bid: round2(mid - half),
      ask: round2(mid + half),
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

export function tick(rows: Bond[], count: number, rnd: () => number): Bond[] {
  const updates: Bond[] = [];
  for (let i = 0; i < count; i++) {
    const row = rows[Math.floor(rnd() * rows.length)];
    const drift = (rnd() - 0.5) * 0.5;
    updates.push({
      ...row,
      bid: round2(Math.max(40, row.bid + drift)),
      ask: round2(Math.max(40.1, row.ask + drift)),
      yld: round2(Math.max(0.1, row.yld - drift * 0.08)),
      spread: Math.max(5, row.spread - Math.round(drift * 6)),
      pnl: Math.round(row.pnl + drift * row.notional * 0.001),
    });
  }
  return updates;
}
