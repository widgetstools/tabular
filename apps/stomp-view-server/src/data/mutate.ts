import type { PositionRecord, TradeRecord } from "./fiRecords.js";

function updateDatesPosition(record: PositionRecord): PositionRecord {
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const u = structuredClone(record);
  if (typeof u.asOfDate === "string") u.asOfDate = now;
  const meta = u.metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object") meta.modifiedDate = now;
  const reporting = u.reporting as Record<string, unknown> | undefined;
  if (reporting && typeof reporting === "object")
    reporting.reportingDate = today;
  const md = u.marketData as Record<string, unknown> | undefined;
  if (md && typeof md === "object") md.lastTradeTime = now;
  return u;
}

function updateDatesTrade(record: TradeRecord): TradeRecord {
  const now = new Date().toISOString();
  const u = structuredClone(record);
  if (typeof u.tradeDate === "string") u.tradeDate = now;
  const ex = u.execution as Record<string, unknown> | undefined;
  if (ex && typeof ex === "object") ex.executionTime = now;
  const meta = u.lifecycle as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object") meta.modifiedDate = now;
  const rep = u.reporting as Record<string, unknown> | undefined;
  if (rep && typeof rep === "object") {
    rep.reportingTimestamp = now;
    rep.lastUpdateTime = now;
  }
  return u;
}

export function mutatePosition(base: PositionRecord): PositionRecord {
  const update = structuredClone(base);
  const notional = Number(update.notionalAmount) || 1;
  const price =
    Number(update.currentPrice) * (1 + (Math.random() - 0.5) * 0.02);
  update.currentPrice = price;
  update.marketValue = notional * price / 100;
  update.totalValue =
    Number(update.marketValue) +
    Number(update.accruedInterest ?? 0);
  update.bookValue = Number(update.bookValue ?? update.marketValue);
  update.pnl = Math.round(
    Number(update.marketValue) - Number(update.bookValue),
  );
  update.unrealizedPnl = Math.round(Number(update.pnl) * 0.8);
  update.realizedPnl = Number(update.realizedPnl ?? 0);
  update.dailyPnl = Math.round(
    (Math.random() - 0.5) * Math.abs(Number(update.pnl)) * 0.1,
  );
  update.mtdPnl = Math.round(
    Number(update.mtdPnl ?? 0) + Number(update.dailyPnl),
  );
  update.ytdPnl = Math.round(
    Number(update.ytdPnl ?? 0) + Number(update.dailyPnl),
  );

  const rm = update.riskMetrics as Record<string, number> | undefined;
  if (rm) {
    rm.var95 = Math.round(
      Number(rm.var95) * (1 + (Math.random() - 0.5) * 0.1),
    );
    rm.var99 = Math.round(
      Number(rm.var99) * (1 + (Math.random() - 0.5) * 0.1),
    );
    rm.expectedShortfall = Math.round(Number(rm.var99) * 1.2);
    rm.sharpeRatio =
      ((Number(update.pnl) / notional) / 0.16) * 252;
  }

  update.dv01 = Number(update.dv01) * (1 + (Math.random() - 0.5) * 0.05);
  update.pv01 = Number(update.pv01) * (1 + (Math.random() - 0.5) * 0.05);
  update.cs01 = Number(update.cs01) * (1 + (Math.random() - 0.5) * 0.05);
  update.convexity =
    Number(update.convexity) * (1 + (Math.random() - 0.5) * 0.03);

  update.spread = Math.round(
    Number(update.spread) + (Math.random() - 0.5) * 10,
  );
  update.assetSwapSpread = Math.round(
    Number(update.assetSwapSpread) + (Math.random() - 0.5) * 10,
  );
  update.zSpread = Math.round(
    Number(update.zSpread) + (Math.random() - 0.5) * 10,
  );
  update.oas = Math.round(Number(update.oas) + (Math.random() - 0.5) * 10);

  const md = update.marketData as Record<string, unknown> | undefined;
  if (md) {
    md.lastTradeTime = new Date().toISOString();
    md.lastTradePrice = price;
    md.bidPrice = price - Math.random() * 0.5;
    md.askPrice = price + Math.random() * 0.5;
    md.midPrice =
      (Number(md.bidPrice) + Number(md.askPrice)) / 2;
    md.volume = Math.round(
      Number(md.volume) * (0.8 + Math.random() * 0.4),
    );
  }

  const an = update.analytics as Record<string, unknown> | undefined;
  const greeks = an?.greeks as Record<string, number> | undefined;
  if (greeks) {
    greeks.delta *= 1 + (Math.random() - 0.5) * 0.1;
    greeks.gamma = Math.abs(
      greeks.gamma * (1 + (Math.random() - 0.5) * 0.2),
    );
    greeks.theta = -Math.abs(
      greeks.theta * (1 + (Math.random() - 0.5) * 0.1),
    );
    greeks.vega *= 1 + (Math.random() - 0.5) * 0.15;
    greeks.rho *= 1 + (Math.random() - 0.5) * 0.1;
  }

  const scen = an?.scenarioAnalysis as Record<string, number> | undefined;
  if (scen && md) {
    const pnlChange = Number(update.pnl) - Number(base.pnl);
    scen.parallelShiftUp100 = Math.round(
      -Math.abs(Number(update.dv01)) * 100,
    );
    scen.parallelShiftDown100 = Math.round(
      Math.abs(Number(update.dv01)) * 100,
    );
    scen.steepening50 = Math.round(pnlChange * (Math.random() - 0.5) * 2);
    scen.flattening50 = Math.round(pnlChange * (Math.random() - 0.5) * 2);
  }

  const liq = update.liquidity as Record<string, unknown> | undefined;
  if (liq && md) {
    liq.bidAskSpread = Math.abs(
      Number(md.askPrice) - Number(md.bidPrice),
    );
    liq.liquidityScore = Math.max(
      1,
      Math.min(
        10,
        Number(liq.liquidityScore) + (Math.random() - 0.5) * 2,
      ),
    );
    liq.marketDepth = Math.round(
      Number(liq.marketDepth) * (0.8 + Math.random() * 0.4),
    );
  }

  const perf = update.performance as Record<string, number> | undefined;
  if (perf) {
    const dailyReturn = Number(update.dailyPnl) / notional;
    perf.dailyReturn = dailyReturn * 100;
    perf.mtdReturn = Number(update.mtdPnl) / notional * 100;
    perf.ytdReturn = Number(update.ytdPnl) / notional * 100;
  }

  const comp = update.compliance as Record<string, unknown> | undefined;
  if (comp && rm) {
    comp.regulatoryCapital = Math.round(Number(update.marketValue) * 0.08);
    comp.rwa = Math.round(
      (Number(update.marketValue) * Number(rm.var95)) / notional,
    );
    comp.concentrationLimit = Math.abs(
      Number(update.marketValue) / 1e9 * 100,
    );
    comp.breachStatus = Number(comp.concentrationLimit) > 95;
  }

  const meta = update.metadata as Record<string, unknown> | undefined;
  if (meta) meta.modifiedDate = new Date().toISOString();

  update.positionId = base.positionId;
  return updateDatesPosition(update);
}

export function mutateTrade(base: TradeRecord): TradeRecord {
  const update = structuredClone(base);
  const basePrice = Number(update.price);
  const currentMarketPrice =
    basePrice * (1 + (Math.random() - 0.5) * 0.02);
  const currentYield =
    Number(update.yield) * (1 + (Math.random() - 0.5) * 0.02);
  const priceMovement = currentMarketPrice - basePrice;
  const positionMultiplier = update.side === "BUY" ? 1 : -1;
  const qty = Number(update.quantity);

  const an = update.analytics as Record<string, Record<string, number>> | undefined;
  const pnlBlock = an?.pnl;
  if (pnlBlock) {
    pnlBlock.unrealizedPnl = Math.round(
      qty * 1000 * priceMovement * positionMultiplier,
    );
    pnlBlock.tradePnl = Math.round(
      Number(pnlBlock.realizedPnl) + Number(pnlBlock.unrealizedPnl),
    );
    pnlBlock.dayOnePnl = Math.round(
      (Math.random() - 0.5) *
        Math.abs(Number(pnlBlock.unrealizedPnl)) *
        0.1,
    );
  }

  const md = update.marketData as Record<string, unknown> | undefined;
  if (md) {
    md.bidPriceAtExecution = currentMarketPrice - Math.random() * 0.5;
    md.askPriceAtExecution = currentMarketPrice + Math.random() * 0.5;
    md.midPriceAtExecution = currentMarketPrice;
    md.vwap = currentMarketPrice + (Math.random() - 0.5) * 0.2;
    md.marketVolume = Math.round(
      Number(md.marketVolume) * (0.8 + Math.random() * 0.4),
    );
  }

  const pr = update.pricing as Record<string, unknown> | undefined;
  if (pr) {
    pr.markupMarkdown =
      (currentMarketPrice - basePrice) * positionMultiplier;
    pr.benchmarkPrice = currentMarketPrice - (Math.random() - 0.5) * 0.1;
    const bench = Number(pr.benchmarkPrice) || 1;
    pr.slippage =
      ((Number(pr.executedPrice) - bench) / bench) * 10000;
  }

  const rm = update.riskMetrics as Record<string, number> | undefined;
  if (rm && pnlBlock) {
    rm.var = Math.round(
      Number(rm.var) * (1 + (Math.random() - 0.5) * 0.1),
    );
    rm.creditExposure = Math.round(
      Math.abs(Number(pnlBlock.unrealizedPnl)) * 0.1,
    );
    rm.dv01 *= 1 + (Math.random() - 0.5) * 0.05;
    rm.duration *= 1 + (Math.random() - 0.5) * 0.02;
    rm.convexity *= 1 + (Math.random() - 0.5) * 0.03;
  }

  const tca = an?.tca;
  if (tca) {
    tca.implementationShortfall = Math.round(
      (currentMarketPrice - Number(tca.arrivalPrice)) *
        positionMultiplier *
        10000,
    );
    tca.marketImpact = Math.round((Math.random() - 0.5) * 50);
    tca.timingCost = Math.round((Math.random() - 0.5) * 20);
    tca.participationRate = Math.min(
      100,
      Math.max(
        0,
        Number(tca.participationRate) + (Math.random() - 0.5) * 10,
      ),
    );
  }

  update.spread = Math.round(
    Number(update.spread) + (Math.random() - 0.5) * 10,
  );
  update.yield = currentYield;

  const fees = update.fees as Record<string, number> | undefined;
  if (fees) {
    const notionalChange =
      Math.abs(priceMovement * qty * 1000 / 100);
    fees.marketImpactCost = Math.round(notionalChange * 0.0001);
    fees.totalFees =
      Number(fees.brokerCommission) +
      Number(fees.exchangeFee) +
      Number(fees.clearingFee) +
      Number(fees.settlementFee) +
      Number(fees.regulatoryFee) +
      Number(fees.marketImpactCost);
  }

  update.tradeId = base.tradeId;
  return updateDatesTrade(update);
}
