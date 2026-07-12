/**
 * Deterministic synthetic fixed-income positions & trades across major product buckets.
 * Wide nested payloads (~1500+ flattened paths) for view/grid testing.
 */

import { createRng, pick, randBetween, randInt } from "./rng.js";

const INSTRUMENT_TYPES = [
  "Treasury",
  "InflationLinkedGov",
  "Corporate",
  "HighYield",
  "Municipal",
  "AgencyPassthrough",
  "AgencyCMBS",
  "NonAgencyRMBS",
  "ABS_Auto",
  "ABS_Card",
  "CLO_Debt",
  "EM_Hard",
  "EM_Local",
  "Sovereign",
  "MoneyMarket",
  "Repo",
  "CD",
  "BankLoan",
  "Convertible",
  "InterestRateSwap",
] as const;

const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF"] as const;
const SECTORS = [
  "Financial",
  "Technology",
  "Healthcare",
  "Energy",
  "Consumer",
  "Industrial",
  "Utilities",
  "Real Estate",
] as const;
const RATINGS = [
  "AAA",
  "AA+",
  "AA",
  "AA-",
  "A+",
  "A",
  "A-",
  "BBB+",
  "BBB",
  "BBB-",
  "BB+",
  "BB",
  "BB-",
] as const;
const TRADERS = [
  "John Smith",
  "Jane Doe",
  "Mike Johnson",
  "Sarah Williams",
  "Tom Brown",
  "Lisa Davis",
] as const;
const BOOKS = ["BOOK001", "BOOK002", "BOOK003", "BOOK004", "BOOK005"] as const;
const DESKS = [
  "IG Credit",
  "HY Credit",
  "Govies",
  "EM Debt",
  "Structured Products",
  "Rates",
  "Securitized",
  "Inflation",
] as const;

function seedId(prefix: string, seed: number): string {
  const a = seed >>> 0;
  const b = Math.imul(a, 2246822519) >>> 0;
  return `${prefix}-${a.toString(16)}-${b.toString(16)}`;
}

function syntheticCusip(rng: () => number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let cusip = "";
  for (let i = 0; i < 9; i++) {
    cusip += chars.charAt(randInt(rng, 0, chars.length - 1));
  }
  return cusip;
}

function randomDateStr(
  rng: () => number,
  start: Date,
  end: Date,
): string {
  const t =
    start.getTime() + rng() * Math.max(1, end.getTime() - start.getTime());
  return new Date(t).toISOString().split("T")[0]!;
}

/** Bump scenarios — expands flattened column count for risk views */
function scenarioStressGrid(rng: () => number): Record<string, number> {
  const out: Record<string, number> = {};
  const shocks = [
    "parallel_-100bp",
    "parallel_-50bp",
    "parallel_-25bp",
    "parallel_-10bp",
    "parallel_+10bp",
    "parallel_+25bp",
    "parallel_+50bp",
    "parallel_+100bp",
    "steepener_25",
    "flattener_25",
    "twist_belly_up",
    "twist_wings_up",
    "vol_up_10pct",
    "vol_dn_10pct",
    "fx_usd_up_1pct",
    "fx_usd_dn_1pct",
    "credit_widen_25bp",
    "credit_tighten_25bp",
    "prepay_+10pctCC",
    "prepay_-10pctCC",
    "default_up_10bp",
    "recovery_dn_5pct",
  ];
  for (const k of shocks) {
    out[k] = randBetween(rng, -5e6, 5e6, 2);
  }
  for (let i = 0; i < 60; i++) {
    out[`bucket_${i}_pv`] = randBetween(rng, -250000, 250000, 2);
  }
  return out;
}

export interface PositionRecord {
  positionId: string;
  cusip: string;
  instrumentType: string;
  [key: string]: unknown;
}

export function generatePosition(seed: number): PositionRecord {
  const rng = createRng(seed);
  const index = seed;
  const cusip = syntheticCusip(rng);
  const notional = randBetween(rng, 100000, 50000000, 0);
  const price = randBetween(rng, 85, 115, 4);
  const marketValue = notional * price / 100;
  const instrumentType = pick(rng, INSTRUMENT_TYPES);

  const position: PositionRecord = {
    positionId: seedId("POS", seed),
    cusip,
    isin: `US${cusip.slice(0, 9)}`,
    sedol: seedId("SDL", seed).slice(0, 9),
    ticker: `TICK${index % 10000}`,
    instrumentName: `${pick(rng, SECTORS)} ${randInt(rng, 2025, 2050)} ${randBetween(rng, 1, 10, 3)}%`,
    instrumentType,
    productFamily: pick(rng, [
      "Gov",
      "Credit",
      "Securitized",
      "EM",
      "DerivativesOverlay",
      "MoneyMarket",
    ]),
    asOfDate: new Date().toISOString(),
    bookName: pick(rng, BOOKS),
    portfolio: `PORT${Math.floor(index / 100)}`,
    trader: pick(rng, TRADERS),
    desk: pick(rng, DESKS),
    region: pick(rng, ["Americas", "EMEA", "APAC"]),
    country: pick(rng, ["USA", "UK", "Germany", "France", "Japan", "Canada"]),
    currency: pick(rng, CURRENCIES),
    quantity: randBetween(rng, 100, 10000, 0),
    notionalAmount: notional,
    marketValue,
    bookValue: marketValue * randBetween(rng, 0.95, 1.05, 4),
    accruedInterest: randBetween(rng, 0, notional * 0.05, 2),
    totalValue: marketValue + randBetween(rng, 0, notional * 0.05, 2),
    costBasis: marketValue * randBetween(rng, 0.9, 1.1, 4),
    averagePrice: price,
    currentPrice: price,
    priceSource: pick(rng, ["Bloomberg", "Reuters", "ICE", "MarketAxess"]),
    pnl: randBetween(rng, -100000, 100000, 0),
    unrealizedPnl: randBetween(rng, -50000, 50000, 0),
    realizedPnl: randBetween(rng, -50000, 50000, 0),
    dailyPnl: randBetween(rng, -10000, 10000, 0),
    mtdPnl: randBetween(rng, -50000, 50000, 0),
    ytdPnl: randBetween(rng, -200000, 200000, 0),
    maturityDate: randomDateStr(
      rng,
      new Date(2025, 0, 1),
      new Date(2055, 0, 1),
    ),
    issueDate: randomDateStr(
      rng,
      new Date(2015, 0, 1),
      new Date(2024, 0, 1),
    ),
    couponRate: randBetween(rng, 0, 8, 3),
    couponFrequency: pick(rng, [1, 2, 4]),
    dayCountConvention: pick(rng, ["30/360", "ACT/360", "ACT/365", "ACT/ACT"]),
    nextCouponDate: randomDateStr(rng, new Date(), new Date(2026, 11, 31)),
    yield: randBetween(rng, 0, 8, 3),
    yieldToMaturity: randBetween(rng, 0, 8, 3),
    modifiedDuration: randBetween(rng, 0.1, 20, 2),
    effectiveDuration: randBetween(rng, 0.1, 20, 2),
    macaulayDuration: randBetween(rng, 0.1, 20, 2),
    convexity: randBetween(rng, 0, 500, 2),
    effectiveConvexity: randBetween(rng, 0, 500, 2),
    spread: randBetween(rng, -50, 500, 0),
    assetSwapSpread: randBetween(rng, -50, 500, 0),
    zSpread: randBetween(rng, -50, 500, 0),
    oas: randBetween(rng, -50, 500, 0),
    dv01: randBetween(rng, 10, 10000, 2),
    pv01: randBetween(rng, 10, 10000, 2),
    cs01: randBetween(rng, 1, 1000, 2),
    rating: {
      moody: pick(rng, RATINGS),
      sp: pick(rng, RATINGS),
      fitch: pick(rng, RATINGS),
      composite: pick(rng, RATINGS),
      internal: pick(rng, RATINGS),
    },
    issuer: {
      name: `${pick(rng, SECTORS)} Corp ${index}`,
      sector: pick(rng, SECTORS),
      industry: pick(rng, [
        "Banking",
        "Insurance",
        "Software",
        "Hardware",
        "Retail",
        "Manufacturing",
      ]),
      country: pick(rng, ["USA", "UK", "Germany", "France", "Japan"]),
      parentCompany: `Parent Corp ${Math.floor(index / 10)}`,
      marketCap: randBetween(rng, 1e9, 1e11, 0),
      creditRating: pick(rng, RATINGS),
    },
    riskMetrics: {
      var95: randBetween(rng, 10000, 1e6, 2),
      var99: randBetween(rng, 20000, 2e6, 2),
      cvar95: randBetween(rng, 15000, 1.5e6, 2),
      cvar99: randBetween(rng, 25000, 2.5e6, 2),
      expectedShortfall: randBetween(rng, 20000, 2e6, 2),
      beta: randBetween(rng, 0.5, 1.5, 3),
      correlation: randBetween(rng, -1, 1, 3),
      trackingError: randBetween(rng, 0, 5, 3),
      sharpeRatio: randBetween(rng, -2, 3, 3),
      informationRatio: randBetween(rng, -2, 3, 3),
    },
    analytics: {
      keyRateDuration: {
        "1M": randBetween(rng, -0.1, 0.1, 4),
        "3M": randBetween(rng, -0.2, 0.2, 4),
        "6M": randBetween(rng, -0.3, 0.3, 4),
        "1Y": randBetween(rng, -0.5, 0.5, 4),
        "2Y": randBetween(rng, -1, 1, 4),
        "3Y": randBetween(rng, -1.5, 1.5, 4),
        "5Y": randBetween(rng, -3, 3, 4),
        "7Y": randBetween(rng, -4, 4, 4),
        "10Y": randBetween(rng, -5, 5, 4),
        "20Y": randBetween(rng, -8, 8, 4),
        "30Y": randBetween(rng, -10, 10, 4),
      },
      scenarioAnalysis: {
        parallelShiftUp100: randBetween(rng, -10, -1, 2),
        parallelShiftDown100: randBetween(rng, 1, 10, 2),
        steepening50: randBetween(rng, -5, 5, 2),
        flattening50: randBetween(rng, -5, 5, 2),
        twist: randBetween(rng, -3, 3, 2),
      },
      scenarioStressGrid: scenarioStressGrid(rng),
      greeks: {
        delta: randBetween(rng, -1, 1, 4),
        gamma: randBetween(rng, -1, 1, 4),
        theta: randBetween(rng, -1, 0, 4),
        vega: randBetween(rng, 0, 1, 4),
        rho: randBetween(rng, -1, 1, 4),
      },
    },
    marketData: {
      lastTradeTime: new Date().toISOString(),
      lastTradePrice: price,
      bidPrice: price - rng() * 0.5,
      askPrice: price + rng() * 0.5,
      midPrice: price,
      volume: randBetween(rng, 1e6, 1e9, 0),
    },
    liquidity: {
      bidAskSpread: randBetween(rng, 0.01, 2, 4),
      liquidityScore: randBetween(rng, 1, 10, 2),
      marketDepth: randBetween(rng, 1e6, 5e8, 0),
    },
    performance: {
      dailyReturn: randBetween(rng, -2, 2, 4),
      mtdReturn: randBetween(rng, -5, 5, 4),
      ytdReturn: randBetween(rng, -15, 15, 4),
    },
    compliance: {
      regulatoryCapital: randBetween(rng, 1e6, 50e6, 0),
      rwa: randBetween(rng, 1e6, 80e6, 0),
      concentrationLimit: randBetween(rng, 0, 100, 2),
      breachStatus: rng() > 0.98,
    },
    metadata: {
      createdDate: new Date().toISOString(),
      modifiedDate: new Date().toISOString(),
      createdBy: pick(rng, TRADERS),
      modifiedBy: pick(rng, TRADERS),
      version: 1,
    },
    funding: {
      repoHaircut: randBetween(rng, 0, 15, 2),
      collateralValue: randBetween(rng, marketValue * 0.8, marketValue * 1.05, 2),
      fundingSpread: randBetween(rng, -5, 50, 2),
    },
    regulatoryTags: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `tag_${i}`,
        rng() > 0.5 ? pick(rng, ["Y", "N", "NA"]) : randBetween(rng, 0, 1000, 2),
      ]),
    ),
    additionalAttributes: Object.fromEntries(
      Array.from({ length: 120 }, (_, i) => {
        const k = `attribute${i + 1}`;
        if (i % 3 === 0) return [k, randBetween(rng, 0, 1000, 2)];
        if (i % 3 === 1) return [k, `Value_${k}_${index}`];
        return [k, rng() > 0.5];
      }),
    ),
  };

  /* Product-specific overlays (sparse realism) */
  if (
    instrumentType.includes("MBS") ||
    instrumentType.includes("AgencyPassthrough")
  ) {
    position.prepayment = {
      cpr: randBetween(rng, 0, 25, 3),
      psa: randBetween(rng, 50, 400, 2),
      wal: randBetween(rng, 0.5, 30, 2),
    };
  }
  if (instrumentType.includes("CLO")) {
    position.clo = {
      tranche: pick(rng, ["AAA", "AA", "A", "BBB", "EQ"]),
      warf: randInt(rng, 2000, 3500),
      was: randBetween(rng, 95, 110, 3),
      turbo: rng() > 0.7,
    };
  }
  if (instrumentType === "InterestRateSwap") {
    position.swapLegs = {
      payFixed: rng() > 0.5,
      fixedRate: randBetween(rng, 0, 6, 4),
      floatIndex: pick(rng, ["SOFR", "ESTR", "SONIA", "TONA"]),
      spreadBp: randBetween(rng, -50, 50, 2),
    };
  }

  return position;
}

export interface TradeRecord {
  tradeId: string;
  cusip: string;
  side: string;
  [key: string]: unknown;
}

export function generateTrade(seed: number): TradeRecord {
  const rng = createRng(seed + 1337);
  const index = seed;
  const cusip = syntheticCusip(rng);
  const side = pick(rng, ["BUY", "SELL"] as const);
  const quantity = randBetween(rng, 100, 10000, 0);
  const price = randBetween(rng, 85, 115, 4);
  const notional = quantity * 1000 * price / 100;

  const trade: TradeRecord = {
    tradeId: seedId("TRD", seed),
    cusip,
    isin: `US${cusip.slice(0, 9)}`,
    sedol: seedId("SDL", seed + 7).slice(0, 9),
    ticker: `TICK${index % 1000}`,
    instrumentName: `${pick(rng, SECTORS)} ${randInt(rng, 2025, 2050)} ${randBetween(rng, 1, 10, 3)}%`,
    instrumentType: pick(rng, INSTRUMENT_TYPES),
    tradeDate: new Date().toISOString(),
    settlementDate: randomDateStr(
      rng,
      new Date(),
      new Date(Date.now() + 10 * 86400000),
    ),
    valueDate: randomDateStr(
      rng,
      new Date(),
      new Date(Date.now() + 10 * 86400000),
    ),
    side,
    quantity,
    notionalAmount: notional,
    price,
    yield: randBetween(rng, 0, 8, 3),
    spread: randBetween(rng, -50, 500, 0),
    accruedInterest: randBetween(rng, 0, notional * 0.02, 2),
    totalConsideration: notional + randBetween(rng, 0, notional * 0.02, 2),
    principalAmount: notional,
    currency: pick(rng, CURRENCIES),
    fxRate: randBetween(rng, 0.8, 1.2, 4),
    baseCurrencyAmount: notional * randBetween(rng, 0.8, 1.2, 2),
    tradeType: pick(rng, ["MARKET", "LIMIT", "AGENCY", "PRINCIPAL"]),
    executionType: pick(rng, ["Electronic", "Voice", "RFQ"]),
    orderType: pick(rng, ["GTC", "IOC", "FOK", "Day"]),
    status: pick(rng, ["FILLED", "PARTIAL", "NEW"]),
    trader: pick(rng, TRADERS),
    salesperson: pick(rng, ["Alice Brown", "Bob Green", "Charlie White"]),
    book: pick(rng, BOOKS),
    portfolio: `PORT${Math.floor(index / 300)}`,
    desk: pick(rng, DESKS),
    strategy: pick(rng, [
      "Relative Value",
      "Directional",
      "Carry",
      "Arbitrage",
    ]),
    counterparty: {
      name: `Counterparty ${Math.floor(index / 100)}`,
      lei: seedId("LEI", seed).slice(0, 22),
      id: `CP-${Math.floor(index / 100)}`,
      type: pick(rng, [
        "Bank",
        "Asset Manager",
        "Hedge Fund",
        "Insurance",
        "Pension",
      ]),
      rating: pick(rng, RATINGS),
      country: pick(rng, ["USA", "UK", "Germany", "France", "Japan"]),
      sector: pick(rng, SECTORS),
    },
    broker: {
      name: pick(rng, ["Broker A", "Broker B", "Broker C", "Broker D"]),
      id: `BRK-${randInt(rng, 0, 9)}`,
      commission: randBetween(rng, 0, 100, 2),
      commissionType: pick(rng, ["Fixed", "Percentage", "PerMillion"]),
    },
    venue: {
      name: pick(rng, ["MarketAxess", "Tradeweb", "Bloomberg", "Direct"]),
      type: pick(rng, ["MTF", "OTF", "RFQ", "Voice"]),
      mic: pick(rng, ["XNAS", "XNYS", "XLON", "XETR"]),
      country: pick(rng, ["US", "UK", "DE", "FR"]),
    },
    clearing: {
      clearingHouse: pick(rng, ["DTCC", "LCH", "CME", "ICE"]),
      clearingBroker: `CLR-${randInt(rng, 0, 19)}`,
      clearingAccount: `CLRACC-${index}`,
      clearingStatus: pick(rng, ["Cleared", "Pending", "Rejected"]),
      clearingFee: randBetween(rng, 0, 50, 2),
    },
    settlement: {
      custodian: pick(rng, ["BNY Mellon", "State Street", "JPM", "Citi"]),
      settlementAccount: `SETTACC-${index}`,
      settlementInstructions: `Standard settlement for ${cusip}`,
      dvp: true,
      failureReason: rng() > 0.95 ? "Insufficient securities" : null,
    },
    fees: {
      brokerCommission: randBetween(rng, 0, 100, 2),
      exchangeFee: randBetween(rng, 0, 50, 2),
      clearingFee: randBetween(rng, 0, 30, 2),
      settlementFee: randBetween(rng, 0, 20, 2),
      regulatoryFee: randBetween(rng, 0, 10, 2),
      otherFees: randBetween(rng, 0, 20, 2),
      totalFees: randBetween(rng, 0, 250, 2),
    },
    compliance: {
      bestExecution: true,
      regulatoryReporting: true,
      mifidClass: pick(rng, ["BOND", "DERV", "EMAL"]),
      doddFrank: rng() > 0.3,
      volcker: rng() > 0.7,
      preTradeChecks: "Passed",
      postTradeChecks: "Passed",
    },
    pricing: {
      priceSource: pick(rng, ["Bloomberg", "Reuters", "ICE", "Internal"]),
      quotedPrice: price - randBetween(rng, 0, 0.5, 4),
      executedPrice: price,
      markupMarkdown: randBetween(rng, -0.5, 0.5, 4),
      benchmarkPrice: price - randBetween(rng, -0.2, 0.2, 4),
      slippage: randBetween(rng, -0.1, 0.1, 4),
    },
    execution: {
      executionTime: new Date().toISOString(),
      executionVenue: pick(rng, ["MarketAxess", "Tradeweb", "Bloomberg"]),
      executionMethod: pick(rng, ["Auction", "RFQ", "Streaming"]),
      orderTime: new Date(Date.now() - randBetween(rng, 60000, 600000, 0)).toISOString(),
      confirmationTime: new Date().toISOString(),
      latency: randBetween(rng, 10, 1000, 0),
    },
    reference: {
      clientOrderId: seedId("CLI", seed + 11),
      brokerOrderId: seedId("BRO", seed + 17),
      exchangeOrderId: seedId("EXC", seed + 19),
      allocationId: `ALC-${index}`,
    },
    marketData: {
      bidPriceAtExecution: price - randBetween(rng, 0.1, 0.5, 4),
      askPriceAtExecution: price + randBetween(rng, 0.1, 0.5, 4),
      midPriceAtExecution: price,
      vwap: price + randBetween(rng, -0.2, 0.2, 4),
      marketVolume: randBetween(rng, 1e7, 1e9, 0),
    },
    analytics: {
      tca: {
        implementationShortfall: randBetween(rng, -50, 50, 2),
        arrivalPrice: price - randBetween(rng, -0.1, 0.1, 4),
        participationRate: randBetween(rng, 0, 20, 2),
        marketImpact: randBetween(rng, -20, 20, 2),
        timingCost: randBetween(rng, -10, 10, 2),
      },
      pnl: {
        realizedPnl: side === "SELL" ? randBetween(rng, -10000, 50000, 0) : 0,
        unrealizedPnl: side === "BUY" ? randBetween(rng, -10000, 50000, 0) : 0,
        tradePnl: randBetween(rng, -5000, 5000, 0),
        dayOnePnl: randBetween(rng, -2000, 2000, 0),
      },
    },
    riskMetrics: {
      dv01: randBetween(rng, 10, 10000, 2),
      duration: randBetween(rng, 0.1, 20, 2),
      convexity: randBetween(rng, 0, 500, 2),
      var: randBetween(rng, 1000, 100000, 2),
      creditExposure: randBetween(rng, 0, notional * 0.1, 2),
    },
    lifecycle: {
      createdDate: new Date().toISOString(),
      modifiedDate: new Date().toISOString(),
      cancelledDate: null,
      amendmentHistory: [] as unknown[],
    },
    reporting: {
      reportingTimestamp: new Date().toISOString(),
      lastUpdateTime: new Date().toISOString(),
    },
    regulatoryTags: Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [
        `tag_${i}`,
        rng() > 0.5 ? pick(rng, ["Y", "N"]) : randBetween(rng, 0, 500, 2),
      ]),
    ),
    additionalAttributes: Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => {
        const k = `attribute${i + 1}`;
        if (i % 3 === 0) return [k, randBetween(rng, 0, 1000, 2)];
        if (i % 3 === 1) return [k, `Value_${k}_${index}`];
        return [k, rng() > 0.5];
      }),
    ),
  };

  return trade;
}

export function buildSnapshot(
  dataType: "positions" | "trades",
  rowCount: number,
  seedBase: number,
): (PositionRecord | TradeRecord)[] {
  const out: (PositionRecord | TradeRecord)[] = [];
  for (let i = 0; i < rowCount; i++) {
    const seed = seedBase + Math.imul(i, 1_000_003);
    out.push(
      dataType === "positions"
        ? generatePosition(seed)
        : generateTrade(seed),
    );
  }
  return out;
}
