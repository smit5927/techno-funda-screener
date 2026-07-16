import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPositionPlan,
  buildPyramidAddPlan,
  candidateEntryDecision,
  candidateRank,
  nextTrailingStop,
  portfolioConfig,
  portfolioSummary,
  postEntryPyramidState,
  positionExitDecision,
  positionTrendRide,
  pyramidAddDecision,
  rotationDecision,
  structuralStop
} from "../src/portfolio-engine.js";
import { buildPyramidStructure } from "../src/screener.js";

test("portfolio defaults use ten lakh capital with institutional limits", () => {
  const rules = portfolioConfig({ trade: {} });
  assert.equal(rules.totalCapital, 1_000_000);
  assert.equal(rules.maxOpenPositions, 15);
  assert.equal(rules.maxPositionPct, 10);
  assert.equal(rules.riskPerTradePct, 1);
  assert.equal(rules.maxPortfolioRiskPct, 6);
  assert.equal(rules.pyramidMaxAddOns, 2);
  assert.equal(rules.pyramidMaxPositionPct, 15);
});

test("only a protected A-grade winner on a fresh breakout can be scaled up", () => {
  const row = strongRow({ close: 112 });
  row.setupStrength.checks.recentHighBreakout = true;
  row.setupStrength.checks.yearHighBreakout = false;
  row.setupStrength.checks.weeklyRsRising = true;
  row.setupStrength.checks.dailyLongRsRising = true;
  row.setupStrength.checks.marketRegimeStrong = true;
  row.setupStrength.values.priorRecentHigh = 110;
  row.setupStrength.values.riskToSupertrendPct = 5;
  attachPyramidStructure(row);
  const trade = openTrade({ trailingStopPrice: 101, investedValue: 100_000 });
  const decision = pyramidAddDecision(
    trade,
    row,
    {
      availableCash: 900_000,
      availableRisk: 60_000,
      sectorExposure: { Industrials: 100_000 }
    },
    { trade: {} }
  );
  assert.equal(decision.eligible, true);
  assert.equal(decision.quantity, 223);
  assert.equal(decision.breakout.type, "POST_ENTRY_PULLBACK_SWING_HIGH_CLOSE_BREAK");
  assert.equal(decision.breakout.swingHighDate, "2026-06-27");
  assert.equal(decision.breakout.pullbackLowDate, "2026-07-03");
});

test("generic 55-day breakout alone cannot pyramid without a post-entry pullback swing", () => {
  const row = strongRow({ close: 112 });
  row.setupStrength.checks.recentHighBreakout = true;
  row.setupStrength.values.priorRecentHigh = 110;
  const decision = pyramidAddDecision(
    openTrade({ trailingStopPrice: 101 }),
    row,
    { availableCash: 900_000, availableRisk: 60_000, sectorExposure: {} },
    { trade: {} }
  );
  assert.equal(decision.eligible, false);
  assert.match(decision.reasons.join(" "), /post-entry advance/i);
});

test("pyramid signal requires a fresh daily close cross above the confirmed swing high", () => {
  const row = strongRow({ close: 112 });
  attachPyramidStructure(row, { previousClose: 111 });
  const state = postEntryPyramidState(openTrade({ trailingStopPrice: 101 }), row, { trade: {} });
  assert.equal(state.setupReady, true);
  assert.equal(state.breakout, false);
  assert.equal(state.level, 110);
});

test("a prior swing cannot be reused after the latest pyramid fill", () => {
  const row = strongRow({ close: 112 });
  attachPyramidStructure(row);
  const state = postEntryPyramidState(
    openTrade({
      trailingStopPrice: 101,
      lastAddDate: "2026-07-05",
      lastAddPrice: 108,
      addOns: [{ number: 1 }]
    }),
    row,
    { trade: {} }
  );
  assert.equal(state.setupReady, false);
  assert.equal(state.breakout, false);
});

test("a deep pullback is damage, not a pyramid continuation setup", () => {
  const row = strongRow({ close: 112 });
  attachPyramidStructure(row, {
    points: [
      { date: "2026-06-27", type: "HIGH", price: 110 },
      { date: "2026-07-03", type: "LOW", price: 90 }
    ]
  });
  const state = postEntryPyramidState(openTrade({ trailingStopPrice: 101 }), row, { trade: {} });
  assert.equal(state.setupReady, false);
  assert.equal(state.breakout, false);
});

test("scanner stores only confirmed two-sided daily swing pivots", () => {
  const candles = [
    candle("2026-07-01", 10, 8, 9),
    candle("2026-07-02", 11, 9, 10),
    candle("2026-07-03", 15, 12, 14),
    candle("2026-07-04", 12, 10, 11),
    candle("2026-07-05", 11, 9, 10),
    candle("2026-07-06", 14, 11, 13),
    candle("2026-07-07", 16, 13, 15)
  ];
  const structure = buildPyramidStructure(candles, {
    pyramidPivotBars: 2,
    pyramidSwingLookback: 20,
    pyramidMaximumPoints: 6
  });
  assert.deepEqual(structure.points, [
    { date: "2026-07-03", type: "HIGH", price: 15 },
    { date: "2026-07-05", type: "LOW", price: 9 }
  ]);
  assert.equal(structure.previousClose, 13);
});

test("pyramiding never averages down or adds before stop protects cost", () => {
  const row = strongRow({ close: 99 });
  row.setupStrength.checks.recentHighBreakout = true;
  const decision = pyramidAddDecision(
    openTrade({ trailingStopPrice: 94 }),
    row,
    { availableCash: 900_000, availableRisk: 60_000, sectorExposure: {} },
    { trade: {} }
  );
  assert.equal(decision.eligible, false);
  assert.match(decision.reasons.join(" "), /averaging down/i);
  assert.match(decision.reasons.join(" "), /protected/i);
});

test("pyramid add plan respects total stock, incremental risk and sector caps", () => {
  const row = strongRow({ close: 112, dailySupertrend: 101 });
  const trade = openTrade({
    entryPrice: 100,
    trailingStopPrice: 101,
    investedValue: 140_000,
    quantity: 1400
  });
  const plan = buildPyramidAddPlan(
    trade,
    row,
    112,
    {
      availableCash: 500_000,
      availableRisk: 30_000,
      sectorExposure: { Industrials: 140_000 }
    },
    { trade: {} }
  );
  assert.equal(plan.eligible, true);
  assert.ok(plan.allocation <= 10_000);
  assert.ok(plan.plannedRisk <= 5_000);
  assert.ok(140_000 + plan.allocation <= 150_000);
});

test("maximum add-on count blocks further pyramiding", () => {
  const row = strongRow({ close: 112 });
  row.setupStrength.checks.recentHighBreakout = true;
  row.setupStrength.values.priorRecentHigh = 110;
  const trade = openTrade({
    trailingStopPrice: 101,
    addOns: [{ number: 1 }, { number: 2 }]
  });
  const decision = pyramidAddDecision(
    trade,
    row,
    { availableCash: 900_000, availableRisk: 60_000, sectorExposure: {} },
    { trade: {} }
  );
  assert.equal(decision.eligible, false);
  assert.match(decision.reasons.join(" "), /maximum 2/i);
});

test("pending winner add reserves cash, risk and sector capacity", () => {
  const trade = openTrade({
    pendingAdd: { plannedAllocation: 25_000, plannedRisk: 2_000 },
    industry: "Industrials"
  });
  const summary = portfolioSummary([trade], [], { trade: {} });
  assert.equal(summary.reservedCapital, 25_000);
  assert.equal(summary.deployedCapital, 125_000);
  assert.equal(summary.availableCash, 875_000);
  assert.equal(summary.portfolioRisk, 8_000);
  assert.equal(summary.pendingAdds, 1);
  assert.equal(summary.sectorExposure.Industrials, 125_000);
});

test("structural trailing stop never moves downward", () => {
  const trade = openTrade({ trailingStopPrice: 105 });
  const row = strongRow({ close: 120, dailySupertrend: 100 });
  assert.equal(nextTrailingStop(trade, row, { trade: {} }), 105);
});

test("position sizing respects capital cap and one-percent risk budget", () => {
  const row = strongRow({ close: 100, dailySupertrend: 94 });
  const plan = buildPositionPlan(
    row,
    100,
    {
      availableCash: 1_000_000,
      availableRisk: 60_000,
      openSlots: 10,
      sectorExposure: {}
    },
    { trade: {} }
  );
  assert.equal(plan.eligible, true);
  assert.equal(plan.stopPrice, 94);
  assert.equal(plan.quantity, 1000);
  assert.equal(plan.allocation, 100_000);
  assert.equal(plan.plannedRisk, 6_000);
});

test("position sizing blocks entries when portfolio capital is full", () => {
  const plan = buildPositionPlan(
    strongRow(),
    100,
    { availableCash: 0, availableRisk: 20_000, openSlots: 2, sectorExposure: {} },
    { trade: {} }
  );
  assert.equal(plan.eligible, false);
  assert.match(plan.reason, /cash/i);
});

test("sector exposure cap cannot be bypassed", () => {
  const row = strongRow({ industry: "Banks" });
  const plan = buildPositionPlan(
    row,
    100,
    {
      availableCash: 500_000,
      availableRisk: 30_000,
      openSlots: 5,
      sectorExposure: { Banks: 250_000 }
    },
    { trade: {} }
  );
  assert.equal(plan.eligible, false);
  assert.match(plan.reason, /sector/i);
});

test("unclassified custom-list stocks do not create a false sector cap", () => {
  const row = strongRow({ industry: "My List" });
  const plan = buildPositionPlan(
    row,
    100,
    {
      availableCash: 500_000,
      availableRisk: 30_000,
      openSlots: 5,
      sectorExposure: { Unclassified: 400_000 }
    },
    { trade: {} }
  );
  assert.equal(plan.eligible, true);
  assert.equal(plan.sector, "Unclassified");
});

test("weekly RS below zero creates a full exit", () => {
  const row = strongRow({ weeklyRs: -0.01 });
  const decision = positionExitDecision(openTrade(), row, { trade: {} });
  assert.equal(decision.action, "FULL_EXIT");
  assert.match(decision.reasons.join(" "), /week.*RS/i);
});

test("early multi-factor weakness creates a partial exit", () => {
  const row = strongRow({
    dailyShortRs: -0.02,
    dailyRsi: 47,
    close: 99,
    dailySupertrend: 95
  });
  const decision = positionExitDecision(openTrade({
    rotationReview: {
      qualificationVersion: 3,
      weakCloseDates: ["2026-07-08", "2026-07-09", "2026-07-10"]
    }
  }), row, { trade: {} });
  assert.equal(decision.action, "PARTIAL_EXIT");
  assert.equal(decision.partialPct, 50);
});

test("RAIN-like minor RS21 weakness with WATCH and GTF context stays wait/watch", () => {
  const row = strongRow({
    dailyShortRs: -0.02,
    setupGrade: "WATCH",
    gtfContext: { checks: { roomForTwoR: false } }
  });
  const decision = positionExitDecision(openTrade({
    rotationReview: {
      qualificationVersion: 2,
      weakCloseDates: ["2026-07-09", "2026-07-10"]
    }
  }), row, { trade: {} });

  assert.equal(decision.action, "HOLD");
  assert.match(decision.reasons.join(" "), /one primary weakness is not enough/i);
  assert.match(decision.reasons.join(" "), /GTF is secondary context only/i);
  assert.match(decision.reasons.join(" "), /TREND RIDE/i);
});

test("healthy winner above 2R keeps riding instead of taking an automatic profit partial", () => {
  const row = strongRow({ close: 120, dailySupertrend: 105 });
  row.setupStrength.values.smaFast = 108;
  row.setupStrength.values.smaSlow = 95;
  row.setupStrength.values.atr = 4;
  const trade = openTrade({ entryPrice: 100, initialStopPrice: 94 });

  assert.equal(positionTrendRide(row).protected, true);
  const decision = positionExitDecision(trade, row, { trade: {} });
  assert.equal(decision.action, "HOLD");
  assert.match(decision.reasons.join(" "), /TREND RIDE/i);
});

test("an exhausted 2R winner may use the one-time profit lock", () => {
  const row = strongRow({ close: 120, dailyRsi: 78, dailySupertrend: 105 });
  row.setupStrength.values.smaFast = 108;
  row.setupStrength.values.smaSlow = 95;
  row.setupStrength.values.atr = 3;
  const trade = openTrade({ entryPrice: 100, initialStopPrice: 94 });

  assert.equal(positionTrendRide(row).exhausted, true);
  const decision = positionExitDecision(trade, row, { trade: {} });
  assert.equal(decision.action, "PARTIAL_EXIT");
  assert.equal(decision.tag, "PROFIT_LOCK");
});

test("multi-factor weakness waits for three completed deterioration closes", () => {
  const row = strongRow({ dailyShortRs: -0.02, dailyRsi: 47 });
  const decision = positionExitDecision(openTrade({
    rotationReview: { qualificationVersion: 3, weakCloseDates: ["2026-07-10"] }
  }), row, { trade: {} });

  assert.equal(decision.action, "HOLD");
  assert.match(decision.reasons.join(" "), /1\/3 completed deterioration closes/i);
});

test("fundamental deterioration alone cannot trigger a partial exit", () => {
  const row = strongRow({ fundamentalScore: 1 });
  const decision = positionExitDecision(openTrade({
    entrySnapshot: { fundamentalScore: 4 },
    rotationReview: { qualificationVersion: 2, weakCloseDates: [] }
  }), row, { trade: {} });

  assert.equal(decision.action, "HOLD");
});

test("completed weekly close below EMA13 creates a momentum-break full exit", () => {
  const row = strongRow({
    weeklyAsOf: "2026-07-10",
    weeklyClose: 92,
    weeklyEma13: 95,
    weeklyPriceAboveEma13: false
  });
  const decision = positionExitDecision(openTrade(), row, { trade: {} });
  assert.equal(decision.action, "FULL_EXIT");
  assert.match(decision.reasons.join(" "), /completed weekly candle.*below EMA13/i);
});

test("fundamental deterioration cannot repeat an already-booked technical partial exit", () => {
  const row = strongRow({
    dailyShortRs: -0.02,
    dailyRsi: 47,
    fundamentalScore: 1
  });
  const decision = positionExitDecision(openTrade({
    partialExitTags: ["EARLY_WEAKNESS"],
    entrySnapshot: { fundamentalScore: 4 },
    rotationReview: {
      qualificationVersion: 3,
      weakCloseDates: ["2026-07-08", "2026-07-09", "2026-07-10"]
    }
  }), row, { trade: {} });

  assert.equal(decision.action, "HOLD");
});

test("materially stronger challenger rotates only a weak position", () => {
  const weak = strongRow({
    symbol: "WEAK",
    yahooSymbol: "WEAK.NS",
    setupGrade: "B",
    dailyShortRs: -0.03,
    dailyRsi: 46,
    close: 90,
    dailySupertrend: 95,
    asOf: "2026-07-10"
  });
  const strong = strongRow({ symbol: "BEST", yahooSymbol: "BEST.NS", setupGrade: "A+" });
  const trade = openTrade({
    symbol: "WEAK",
    yahooSymbol: "WEAK.NS",
    entryDate: "2026-06-20",
    rotationReview: {
      qualificationVersion: 3,
      weakCloseDates: ["2026-07-08", "2026-07-09", "2026-07-10"]
    }
  });
  const rows = new Map([["WEAK.NS", weak]]);
  const candidate = {
    firstSignalDate: "2026-07-09",
    firstSignalClose: 100,
    peakRank: candidateRank(strong),
    entryCloseDates: ["2026-07-09", "2026-07-10"]
  };
  const decision = rotationDecision(strong, [trade], rows, { trade: {} }, candidate);
  assert.equal(decision.rotate, true);
  assert.ok(candidateRank(strong) > candidateRank(weak));
});

test("waiting candidate run-up remains buyable when current structure is still entry-ready", () => {
  const row = strongRow({ close: 110, dailySupertrend: 104 });
  row.setupStrength.values.smaFast = 105;
  row.setupStrength.values.atr = 3;
  const decision = candidateEntryDecision(
    {
      firstSignalDate: "2026-07-01",
      firstSignalClose: 100,
      peakRank: candidateRank(row),
      entryCloseDates: ["2026-07-01", "2026-07-02"]
    },
    row,
    { trade: {} },
    { qualityPass: true }
  );
  assert.equal(decision.actionable, true);
  assert.equal(decision.disposition, "ACTIONABLE");
  assert.match(decision.warnings.join(" "), /informational/i);
});

test("actual 09:17 gap remains buyable when execution-price structure is still safe", () => {
  const row = strongRow({ close: 100, dailySupertrend: 99 });
  row.setupStrength.values.smaFast = 102;
  row.setupStrength.values.atr = 2;
  const decision = candidateEntryDecision(
    {
      firstSignalDate: "2026-07-09",
      firstSignalClose: 100,
      peakRank: candidateRank(row),
      entryCloseDates: ["2026-07-09", "2026-07-10"]
    },
    row,
    { trade: {} },
    { qualityPass: true, executionPrice: 104 }
  );
  assert.equal(decision.actionable, true);
  assert.equal(decision.disposition, "ACTIONABLE");
  assert.match(decision.warnings.join(" "), /09:17.*informational/i);
});

test("rotation waits for both candidate and weakness confirmation", () => {
  const strong = strongRow({ symbol: "BEST", yahooSymbol: "BEST.NS" });
  const weak = strongRow({
    symbol: "WEAK",
    yahooSymbol: "WEAK.NS",
    setupGrade: "B",
    dailyRsi: 45
  });
  const trade = openTrade({
    symbol: "WEAK",
    yahooSymbol: "WEAK.NS",
    rotationReview: { weakCloseDates: ["2026-07-10"] }
  });
  const decision = rotationDecision(
    strong,
    [trade],
    new Map([["WEAK.NS", weak]]),
    { trade: {} },
    {
      firstSignalDate: "2026-07-10",
      firstSignalClose: 100,
      entryCloseDates: ["2026-07-10"]
    }
  );
  assert.equal(decision.rotate, false);
  assert.match(decision.reason, /not rotation-ready|distinct/i);
});

test("same-close partial risk action prevents an immediate second rotation sell", () => {
  const strong = strongRow({ symbol: "BEST", yahooSymbol: "BEST.NS" });
  const weak = strongRow({
    symbol: "WEAK",
    yahooSymbol: "WEAK.NS",
    setupGrade: "B",
    dailyRsi: 45
  });
  const trade = openTrade({
    symbol: "WEAK",
    yahooSymbol: "WEAK.NS",
    lastRiskActionSignalDate: weak.asOf,
    rotationReview: { weakCloseDates: ["2026-07-09", "2026-07-10"] }
  });
  const candidate = {
    firstSignalDate: "2026-07-09",
    firstSignalClose: 100,
    peakRank: candidateRank(strong),
    entryCloseDates: ["2026-07-09", "2026-07-10"]
  };
  const decision = rotationDecision(
    strong,
    [trade],
    new Map([["WEAK.NS", weak]]),
    { trade: {} },
    candidate
  );
  assert.equal(decision.rotate, false);
});

test("portfolio summary reserves pending capital and reports cash", () => {
  const trades = [
    openTrade({ investedValue: 100_000, quantity: 1000 }),
    {
      status: "PENDING_ENTRY",
      plannedAllocation: 80_000,
      plannedRisk: 4_000,
      industry: "IT"
    }
  ];
  const summary = portfolioSummary(trades, [], { trade: {} });
  assert.equal(summary.deployedCapital, 180_000);
  assert.equal(summary.availableCash, 820_000);
  assert.equal(summary.openSlots, 13);
});

test("portfolio summary separates gross booked P&L from realized charges", () => {
  const trade = openTrade({
    realizedPnlToDate: -120,
    chargeSummary: { realizedCharges: 20 }
  });
  const summary = portfolioSummary([trade], [], { trade: { chargesEnabled: true } });

  assert.equal(summary.realizedPnl, -120);
  assert.equal(summary.realizedCharges, 20);
  assert.equal(summary.grossRealizedPnl, -100);
});

test("portfolio realized P&L includes partial bookings without double-counting closed trades", () => {
  const trades = [
    openTrade({ realizedPnlToDate: -125 }),
    { status: "CLOSED", pnl: 300, realizedPnlToDate: 80 }
  ];
  const summary = portfolioSummary(trades, [], { trade: {} });

  assert.equal(summary.realizedPnl, 175);
});

test("range-bound benchmark caps new deployment without forcing existing exits", () => {
  const summary = portfolioSummary(
    [openTrade({ investedValue: 100_000, quantity: 1000 })],
    [],
    { trade: {}, marketContext: { riskMode: "RANGE", exposureCapPct: 25 } }
  );
  assert.equal(summary.effectiveExposureCapPct, 25);
  assert.equal(summary.availableCash, 150_000);
  assert.equal(summary.actualCash, 900_000);
});

test("GTF confirmation alone cannot originate a partial or full exit", () => {
  const row = strongRow({
    gtfContext: { supplyBlocked: true, checks: { roomForTwoR: false } }
  });
  const decision = positionExitDecision(openTrade(), row, { trade: {} });
  assert.equal(decision.action, "HOLD");
});

test("a normal post-breakout retest gets management grace without hiding a large loss", () => {
  const row = strongRow({
    asOf: "2026-07-13",
    close: 97,
    dailyShortRs: -0.01,
    dailyRsi: 48,
    dailySupertrend: 94
  });
  const trade = openTrade({
    entryDate: "2026-07-10",
    managementCloseDates: [],
    rotationReview: {
      qualificationVersion: 3,
      weakCloseDates: ["2026-07-13"]
    }
  });

  const decision = positionExitDecision(trade, row, { trade: {} });
  assert.equal(decision.action, "HOLD");
  assert.match(decision.reasons.join(" "), /ENTRY RETEST GRACE: 1\/5/i);
});

test("severe multi-factor damage can reduce risk during entry grace", () => {
  const row = strongRow({
    asOf: "2026-07-14",
    close: 95,
    dailyShortRs: -0.02,
    dailyRsi: 47,
    dailySupertrend: 97
  });
  const trade = openTrade({
    entryDate: "2026-07-13",
    managementCloseDates: ["2026-07-13", "2026-07-14"],
    rotationReview: {
      qualificationVersion: 3,
      weakCloseDates: ["2026-07-13", "2026-07-14"]
    }
  });

  const decision = positionExitDecision(trade, row, { trade: {} });
  assert.equal(decision.action, "PARTIAL_EXIT");
  assert.equal(decision.tag, "EARLY_WEAKNESS");
});

test("original structural stop exits immediately even during entry grace", () => {
  const row = strongRow({ asOf: "2026-07-13", close: 93.5 });
  const decision = positionExitDecision(openTrade({
    entryDate: "2026-07-10",
    managementCloseDates: []
  }), row, { trade: {} });

  assert.equal(decision.action, "FULL_EXIT");
  assert.match(decision.reasons.join(" "), /original structural stop/i);
});

test("daily long RS55 failure exits immediately even during entry grace", () => {
  const row = strongRow({ asOf: "2026-07-13", dailyLongRs: -0.01 });
  const decision = positionExitDecision(openTrade({
    entryDate: "2026-07-10",
    managementCloseDates: []
  }), row, { trade: {} });

  assert.equal(decision.action, "FULL_EXIT");
  assert.match(decision.reasons.join(" "), /RS55 is below zero/i);
});

test("a raised trailing stop needs two confirmed closes before full exit", () => {
  const row = strongRow({ asOf: "2026-07-10", close: 104, dailySupertrend: 100 });
  const trade = openTrade({
    trailingStopPrice: 105,
    trailingStopBreachDates: ["2026-07-10"]
  });
  const first = positionExitDecision(trade, row, { trade: {} });
  assert.equal(first.action, "HOLD");

  const second = positionExitDecision({
    ...trade,
    trailingStopBreachDates: ["2026-07-09", "2026-07-10"]
  }, row, { trade: {} });
  assert.equal(second.action, "FULL_EXIT");
  assert.match(second.reasons.join(" "), /raised trailing stop/i);
});

test("structural stop remains inside configured risk band", () => {
  const stop = structuralStop(strongRow({ dailySupertrend: 50 }), 100, { trade: {} });
  assert.equal(stop, 95);
  assert.ok(stop >= 92 && stop <= 98.5);
});

test("weekly EMA13 reclaim and breakout use a wider structural stop with the same risk cap", () => {
  const row = strongRow({ weeklyEma13: 95 });
  row.entryStyle = { type: "BREAKOUT_RECLAIM_BUY", label: "Breakout after weekly EMA13 reclaim" };
  row.setupStrength.values.recentBaseLow = 93;
  row.setupStrength.values.fourCandleLow = 97;
  assert.equal(structuralStop(row, 100, { trade: {} }), 94);
});

function strongRow(overrides = {}) {
  return {
    symbol: "STRONG",
    yahooSymbol: "STRONG.NS",
    industry: "Industrials",
    status: "ENTRY",
    asOf: "2026-07-10",
    close: 100,
    weeklyRs: 0.2,
    dailyLongRs: 0.12,
    dailyShortRs: 0.08,
    dailyRsi: 62,
    weeklyRsi: 65,
    weeklyAsOf: "2026-07-06",
    weeklyClose: 100,
    weeklyEma13: 95,
    weeklyPriceAboveEma13: true,
    dailySupertrend: 94,
    setupGrade: "A+",
    setupStrengthScore: 14,
    fundamentalScore: 4,
    entryStyle: { type: "BREAKOUT_BUY", label: "Breakout buy" },
    conceptCoverage: { passed: 18, applicable: 24, dataGaps: 1 },
    institutionalContext: { score: 3 },
    sectorStrength: { ok: true },
    setupStrength: {
      checks: {
        weeklyRsRising: true,
        dailyLongRsRising: true,
        closeAboveSmaFast: true,
        closeAboveSmaSlow: true,
        smaFastAboveSlow: true,
        volumeExpansion: true,
        bullishCandleConfirmation: true,
        marketRegimeStrong: true,
        recentHighBreakout: false,
        yearHighBreakout: false
      },
      values: {
        fourCandleLow: 92,
        twoCandleLow: 93,
        smaFast: 90,
        smaSlow: 80,
        atrPct: 3,
        riskToSupertrendPct: 6
      }
    },
    ...overrides
  };
}

function openTrade(overrides = {}) {
  return {
    id: "trade-1",
    symbol: "STRONG",
    yahooSymbol: "STRONG.NS",
    status: "OPEN",
    entryDate: "2026-06-20",
    entryPrice: 100,
    quantity: 1000,
    originalQuantity: 1000,
    investedValue: 100_000,
    originalInvestedValue: 100_000,
    initialStopPrice: 94,
    trailingStopPrice: 94,
    partialExitTags: [],
    partialExits: [],
    managementCloseDates: [
      "2026-07-03",
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
      "2026-07-09"
    ],
    trailingStopBreachDates: [],
    realizedPnlToDate: 0,
    entrySnapshot: { fundamentalScore: 4 },
    ...overrides
  };
}

function attachPyramidStructure(row, overrides = {}) {
  row.setupStrength.pyramidStructure = {
    pivotBars: 2,
    latestDate: row.asOf,
    latestClose: row.close,
    previousDate: "2026-07-09",
    previousClose: 109,
    points: [
      { date: "2026-06-27", type: "HIGH", price: 110 },
      { date: "2026-07-03", type: "LOW", price: 104 }
    ],
    ...overrides
  };
  return row;
}

function candle(date, high, low, close) {
  return { date, open: close, high, low, close, volume: 1000 };
}
