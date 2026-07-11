/**
 * Phase 4 exit criteria: 50 active rules over 100k rows with a high update
 * rate; alert storm stays bounded by the token bucket.
 *
 * Run: npx tsx scripts/rules-stress.ts
 */
import { AlertManager, compileRulesBundle, evaluateTransactionDelta } from '../packages/rules/src/index';
import type { AlertRule, StyleRule } from '../packages/rules/src/types';

const ROW_COUNT = 100_000;
const RULE_COUNT = 50;
const BATCH = 2000;
const ROUNDS = 100; // 200k updates total

function makeRows(n: number): Array<{ id: string; row: Record<string, unknown> }> {
  const out: Array<{ id: string; row: Record<string, unknown> }> = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      id: `R${i}`,
      row: {
        id: `R${i}`,
        pnl: (i % 200) - 100,
        price: 100 + (i % 50) * 0.1,
        spread: 50 + (i % 400),
      },
    };
  }
  return out;
}

function makeStyleRules(n: number): StyleRule[] {
  const out: StyleRule[] = [];
  for (let i = 0; i < n; i++) {
    const field = i % 3 === 0 ? 'pnl' : i % 3 === 1 ? 'price' : 'spread';
    out.push({
      id: `s${i}`,
      condition:
        field === 'pnl'
          ? `[pnl.new] < [pnl.old]`
          : field === 'price'
            ? `[price.new] > [price.old]`
            : `[spread] > ${100 + (i % 50)}`,
      style: { backgroundColor: 'rgba(255,0,0,0.1)' },
      field,
      priority: i,
      flash: i % 5 === 0 ? 'pulse' : undefined,
      activeDurationMs: i % 5 === 0 ? 400 : undefined,
    });
  }
  return out;
}

function makeAlertRules(n: number): AlertRule[] {
  const out: AlertRule[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `a${i}`,
      condition: `[pnl.new] != [pnl.old]`,
      message: `alert-${i}`,
      severity: 'warn',
      trigger: 'relativeChange',
      field: 'pnl',
      debounceMs: 0,
    });
  }
  return out;
}

function main(): void {
  const rows = makeRows(ROW_COUNT);
  const byId = new Map(rows.map((r) => [r.id, r.row]));
  const style = makeStyleRules(RULE_COUNT);
  const alerts = makeAlertRules(10); // storm candidates
  const bundle = compileRulesBundle({ style, alerts });
  const fieldToColId = { pnl: 'pnl', price: 'price', spread: 'spread' };
  const alertMgr = new AlertManager({ tokens: 20, perMs: 1000 }, 100);

  let fired = 0;
  let dropped = 0;
  let matches = 0;

  const t0 = performance.now();
  for (let round = 0; round < ROUNDS; round++) {
    const updates = [];
    for (let b = 0; b < BATCH; b++) {
      const idx = (round * BATCH + b) % ROW_COUNT;
      const id = `R${idx}`;
      const prev = byId.get(id)!;
      const next = {
        ...prev,
        pnl: (prev.pnl as number) + ((b % 5) - 2),
        price: (prev.price as number) + 0.01,
        spread: (prev.spread as number) + (b % 3),
      };
      byId.set(id, next);
      updates.push({
        rowId: id,
        data: next,
        changes: [
          { key: 'pnl', oldValue: prev.pnl, newValue: next.pnl },
          { key: 'price', oldValue: prev.price, newValue: next.price },
          { key: 'spread', oldValue: prev.spread, newValue: next.spread },
        ],
      });
    }
    const result = evaluateTransactionDelta(bundle, updates, [], [], (id) => byId.get(id), fieldToColId);
    matches += result.styleUpserts.length;
    for (const a of result.alertCandidates) {
      const ev = alertMgr.tryFire({
        ruleId: a.ruleId,
        rowId: a.rowId,
        data: a.data,
        message: a.message,
        severity: a.severity,
        debounceMs: a.debounceMs,
      });
      if (ev) fired++;
      else dropped++;
    }
  }
  const ms = performance.now() - t0;
  const updates = ROUNDS * BATCH;

  console.log(
    JSON.stringify(
      {
        rows: ROW_COUNT,
        styleRules: RULE_COUNT,
        updates,
        matches,
        alertsFired: fired,
        alertsDropped: dropped,
        historySize: alertMgr.getHistory().length,
        ms: Math.round(ms),
        updatesPerSec: Math.round(updates / (ms / 1000)),
        bounded: alertMgr.getHistory().length <= 100 && fired <= updates,
      },
      null,
      2,
    ),
  );

  if (alertMgr.getHistory().length > 100) {
    console.error('FAIL: history ring exceeded bound');
    process.exit(1);
  }
  if (fired > 5000 && dropped === 0) {
    console.error('FAIL: token bucket did not drop any alert storm candidates');
    process.exit(1);
  }
  console.log('OK');
}

main();
