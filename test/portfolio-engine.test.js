import assert from "node:assert/strict";
import test from "node:test";
import {
  buildControlledRetestAddPlan,
  buildPositionPlan,
  buildPyramidAddPlan,
  candidateEntryDecision,
  candidateRank,
  controlledRetestAddDecision,
  legacyStructuralStopUpgradePlan,
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
import { approveMorningOrders, publishPortfolioActionEvents } from "../src/trade-journal.js";

test("portfolio defaults use ten lakh capital with institutional limits", () => {
  const rules = portfolioConfig({ trade: {} });
  assert.equal(rules.totalCapital, 1_000_000);
  assert.equal(rules.minimumInitialAllocation, 10_000);
  assert.equal(rules.maxOpenPositions, 15);
  assert.equal(rules.maxPositionPct, 10);
  assert.equal(rules.riskPerTradePct, 1);
  assert.equal(rules.initialMaxPositionPct, 7.5);
  assert.equal(rules.initialRiskPct, 0.7);
  assert.equal(rules.controlledRetestAddMaxPct, 2.5);
  assert.equal(rules.controlledRetestAddRiskPct, 0.3);
  assert.equal(rules.maxPortfolioRiskPct, 6);
  assert.equal(rules.pyramidMaxAddOns, 2);
  assert.equal(rules.pyramidMaxPositionPct, 15);
});

test("legacy daily stop migrates system-wide when weekly EMA13-low and RS leadership survive", () => {
  const plan = legacyStructuralStopUpgradePlan(
    {
      status: "OPEN",
      entryPrice: 1381.9,
      quantity: 72,
      initialStopPrice: 1361.17,
      trailingStopPrice: 1361.17
    },
    {
      close: 1341.3,
      weeklyClose: 1341.3,
      weeklyEma13: 1210.65,
      weeklyEma13Source: "low",
      weeklyPriceAboveEma13: true,
      weeklyRs: 0.33,
      dailyLongRs: 0.15,
      dailySupertrend: 1400,
      setupStrength: { values: { weeklyAtr: 58 } }
    },
    { trade: { totalCapital: 1_000_000, riskPerTradePct: 1 } }
  );

  assert.equal(plan.eligible, true);
  assert.equal(plan.policyVersion, "WEEKLY_EMA13_LOW_V2");
  assert.ok(plan.stopPrice < 1341.3);
  assert.match(plan.reason, /Weekly RS21 plus Daily RS55/i);
});

test("excess risk at the migrated weekly stop requests controlled sizing, not an old-stop full exit", () => {
  const plan = legacyStructuralStopUpgradePlan(
    { status: "OPEN", quantity: 100, initialStopPrice: 99, trailingStopPrice: 99 },
    {
      close: 100,
      weeklyClose: 100,
      weeklyEma13: 80,
      weeklyEma13Source: "low",
      weeklyPriceAboveEma13: true,
      weeklyRs: 0.2,
      dailyLongRs: 0.1,
      setupStrength: { values: { weeklyAtr: 5 } }
    },
    { trade: { totalCapital: 100_000, riskPerTradePct: 1 } }
  );

  assert.equal(plan.eligible, true);
  assert.equal(plan.riskWithinLimit, false);
  assert.ok(plan.suggestedRiskReductionQuantity > 0);
  assert.match(plan.reason, /instead of forcing a full exit/i);
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

test("one controlled retest tranche adds only after an A-grade reclaim inside the 0.25R to 0.75R band", () => {
  const row = strongRow({ close: 97, dailySupertrend: 92 });
  row.setupStrength.checks.retracementBuyZone = true;
  row.setupStrength.values.retracementSupportSource = "50-DMA";
  row.setupStrength.values.retracementSupportReference = 96;
  row.setupStrength.values.retracementPullbackDepthPct = 4;
  row.setupStrength.values.retracementPullbackVolumeRatio = 0.75;
  row.setupStrength.values.retracementCloseLocationPct = 72;
  const trade = openTrade({
    entryDate: "2026-07-09",
    initialEntryPrice: 100,
    entryPrice: 100,
    initialStopPrice: 94,
    trailingStopPrice: 94,
    quantity: 750,
    originalQuantity: 750,
    investedValue: 75_000,
    originalInvestedValue: 75_000
  });
  const decision = controlledRetestAddDecision(
    trade,
    row,
    { availableCash: 925_000, availableRisk: 55_500, sectorExposure: { Industrials: 75_000 } },
    { trade: {} }
  );
  assert.equal(decision.eligible, true);
  assert.equal(decision.state.drawdownR, 0.5);
  assert.equal(decision.quantity, 257);
  assert.ok(decision.allocation <= 25_000);
  assert.ok(decision.plannedRisk <= 3_000);
});

test("qualified GTF demand structure raises controlled retest confidence without replacing compulsory rules", () => {
  const row = strongRow({ close: 97, dailySupertrend: 92 });
  row.setupStrength.checks.retracementBuyZone = true;
  row.gtfContext = {
    checks: { dailyDemandQualified: true, demandRetest: true },
    supplyBlocked: false
  };
  const decision = controlledRetestAddDecision(
    openTrade({
      entryDate: "2026-07-09",
      initialEntryPrice: 100,
      entryPrice: 100,
      initialStopPrice: 94,
      trailingStopPrice: 94,
      quantity: 750,
      investedValue: 75_000
    }),
    row,
    { availableCash: 925_000, availableRisk: 55_500, sectorExposure: { Industrials: 75_000 } },
    { trade: {} }
  );
  assert.equal(decision.eligible, true);
  assert.equal(decision.state.gtfDemandConfidence, true);
  assert.equal(decision.state.confidenceGrade, "HIGH_GTF_CONFLUENCE");
  assert.match(decision.reasons.join(" "), /GTF confidence is high/i);
});

test("controlled retest never rescues a broken trend or permits a second averaging add", () => {
  const row = strongRow({ close: 97, dailyShortRs: -0.01 });
  row.setupStrength.checks.retracementBuyZone = true;
  const decision = controlledRetestAddDecision(
    openTrade({
      entryDate: "2026-07-09",
      addOns: [{ kind: "CONTROLLED_RETEST", number: 1 }]
    }),
    row,
    { availableCash: 900_000, availableRisk: 50_000, sectorExposure: {} },
    { trade: {} }
  );
  assert.equal(decision.eligible, false);
  assert.match(decision.reasons.join(" "), /one permitted|RS21/i);
});

test("actual retest sizing preserves the original stop and combined one-percent stock-risk cap", () => {
  const row = strongRow({ close: 97, dailySupertrend: 92 });
  const plan = buildControlledRetestAddPlan(
    openTrade({ quantity: 750, investedValue: 75_000, initialStopPrice: 94, trailingStopPrice: 94 }),
    row,
    97,
    { availableCash: 925_000, availableRisk: 55_500, sectorExposure: { Industrials: 75_000 } },
    { trade: {} }
  );
  assert.equal(plan.eligible, true);
  assert.equal(plan.trailingStop, 94);
  assert.ok(plan.plannedRisk <= 3_000);
  assert.ok(75_000 + plan.allocation <= 100_000);
});

test("pyramid add plan respects total stock, incremental risk and sector caps", () => {
  const row = strongRow({ close: 112, dailySupertrend: 101 });
  const trade = openTrade({
    entryPrice: 100,
    trailingStopPrice: 101,
    investedValue: 130_000,
    quantity: 1300
  });
  const plan = buildPyramidAddPlan(
    trade,
    row,
    112,
    {
      availableCash: 500_000,
      availableRisk: 30_000,
      sectorExposure: { Industrials: 130_000 }
    },
    { trade: {} }
  );
  assert.equal(plan.eligible, true);
  assert.ok(plan.allocation >= 10_000);
  assert.ok(plan.allocation <= 20_000);
  assert.ok(plan.plannedRisk <= 5_000);
  assert.ok(130_000 + plan.allocation <= 150_000);
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
    pendingAdd: { plannedAllocation: 25_000, plannedRisk: 2_000, orderState: "CONFIRMED_FOR_0917" },
    industry: "Industrials"
  });
  const summary = portfolioSummary([trade], [], { trade: {} });
  assert.equal(summary.reservedCapital, 25_000);
  assert.equal(summary.deployedCapital, 100_000);
  assert.equal(summary.committedCapital, 125_000);
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

test("initial position sizing reserves capital and risk for the controlled retest tranche", () => {
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
  assert.equal(plan.quantity, 750);
  assert.equal(plan.allocation, 75_000);
  assert.equal(plan.plannedRisk, 4_500);
  assert.equal(plan.riskBudget, 7_000);
  assert.equal(plan.maxAllocation, 75_000);
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

test("position sizing rejects an uneconomical residual allocation below ten thousand rupees", () => {
  const row = strongRow({ industry: "Banks" });
  const plan = buildPositionPlan(
    row,
    100,
    {
      availableCash: 500_000,
      availableRisk: 30_000,
      openSlots: 5,
      sectorExposure: { Banks: 249_500 }
    },
    { trade: {} }
  );
  assert.equal(plan.quantity, 5);
  assert.equal(plan.allocation, 500);
  assert.equal(plan.eligible, false);
  assert.match(plan.reason, /below the minimum initial buy value Rs 10000/i);
});

test("position sizing accepts an allocation at the ten thousand rupee floor", () => {
  const row = strongRow({ industry: "Banks" });
  const plan = buildPositionPlan(
    row,
    100,
    {
      availableCash: 500_000,
      availableRisk: 30_000,
      openSlots: 5,
      sectorExposure: { Banks: 240_000 }
    },
    { trade: {} }
  );
  assert.equal(plan.quantity, 100);
  assert.equal(plan.allocation, 10_000);
  assert.equal(plan.eligible, true);
});

test("weekly EMA13-Low break with positive weekly RS reduces risk without killing the trend", () => {
  const row = strongRow({
    weeklyAsOf: "2026-07-10",
    weeklyClose: 92,
    weeklyEma13: 95,
    weeklyPriceAboveEma13: false
  });
  const decision = positionExitDecision(openTrade(), row, { trade: {} });
  assert.equal(decision.action, "PARTIAL_EXIT");
  assert.equal(decision.tag, "WEEKLY_STRUCTURE_DEFENCE");
  assert.equal(decision.partialPct, 33);
  assert.match(decision.reasons.join(" "), /Weekly EMA13 calculated from weekly lows/i);
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
      orderState: "CONFIRMED_FOR_0917",
      plannedAllocation: 80_000,
      plannedRisk: 4_000,
      industry: "IT"
    }
  ];
  const summary = portfolioSummary(trades, [], { trade: {} });
  assert.equal(summary.deployedCapital, 100_000);
  assert.equal(summary.reservedCapital, 80_000);
  assert.equal(summary.committedCapital, 180_000);
  assert.equal(summary.actualCash, 900_000);
  assert.equal(summary.availableCash, 820_000);
  assert.equal(summary.openSlots, 13);
});

test("pending orders never inflate deployed capital above actual filled holdings", () => {
  const trades = [
    openTrade({ investedValue: 868_124.15, quantity: 1000 }),
    {
      status: "PENDING_ENTRY",
      orderState: "CONFIRMED_FOR_0917",
      plannedAllocation: 317_070.8,
      plannedRisk: 5_000,
      industry: "IT"
    }
  ];
  const summary = portfolioSummary(trades, [], { trade: { totalCapital: 1_000_000 } });

  assert.equal(summary.deployedCapital, 868_124.15);
  assert.equal(summary.reservedCapital, 317_070.8);
  assert.equal(summary.committedCapital, 1_185_194.95);
  assert.equal(summary.actualCash, 131_875.85);
  assert.equal(summary.availableCash, 0);
  assert.equal(summary.overallocatedCapital, 0);
  assert.equal(summary.capitalUtilizationPct, 86.81);
});

test("08:30 approval resizes the best buy to cash released by a confirmed exit and publishes both alerts", () => {
  const row = strongRow({ asOf: "2026-07-17" });
  const fundingTrade = openTrade({
    id: "EXIT-1",
    symbol: "WEAK",
    yahooSymbol: "WEAK.NS",
    status: "PENDING_EXIT",
    exitSignalDate: "2026-07-17",
    exitExecutionAfterDate: "2026-07-17",
    quantity: 100,
    investedValue: 10_000,
    lastPrice: 100
  });
  const capitalTrade = openTrade({ id: "CORE", quantity: 9_900, investedValue: 990_000 });
  const proposal = {
    id: "STRONG-PROPOSAL",
    symbol: row.symbol,
    yahooSymbol: row.yahooSymbol,
    industry: row.industry,
    status: "PENDING_ENTRY",
    entrySignalDate: "2026-07-17",
    entryExecutionAfterDate: "2026-07-17",
    plannedQuantity: 750,
    plannedAllocation: 75_000,
    plannedRisk: 4_500,
    positionRank: 200,
    candidateContext: {
      firstSignalDate: "2026-07-16",
      firstSignalClose: 98,
      peakRank: 200,
      entryCloseDates: ["2026-07-16", "2026-07-17"]
    },
    entryReason: [],
    entrySnapshot: row
  };
  const trades = [capitalTrade, fundingTrade, proposal];
  const events = [
    { type: "EXIT_SIGNAL_PENDING", trade: fundingTrade },
    { type: "ENTRY_SIGNAL_PENDING", trade: proposal }
  ];
  approveMorningOrders({
    trades,
    candidates: [],
    rowBySymbol: new Map([[row.yahooSymbol, row], [fundingTrade.yahooSymbol, strongRow({ symbol: "WEAK", yahooSymbol: "WEAK.NS" })]]),
    scan: { scannedAt: "2026-07-20T03:00:00.000Z" },
    settings: { scopeListId: "all-market", scopeLabel: "All Indian Market", qualityMode: "BEST_ONLY" },
    config: { trade: { totalCapital: 1_000_000 } },
    events
  });

  assert.equal(proposal.orderState, "APPROVED_FOR_0917");
  assert.equal(proposal.plannedAllocation, 10_000);
  assert.equal(proposal.plannedQuantity, 100);
  const published = publishPortfolioActionEvents(events, trades, "2026-07-20T03:00:00.000Z", { enabled: true });
  assert.deepEqual(published.map((event) => event.type).sort(), ["ENTRY_SIGNAL_PENDING", "EXIT_SIGNAL_PENDING"]);
  assert.equal(proposal.orderState, "CONFIRMED_FOR_0917");
  assert.equal(fundingTrade.exitOrderState, "CONFIRMED_FOR_0917");
});

test("08:30 publishes a standalone full exit even when there is no replacement buy", () => {
  const exitTrade = openTrade({
    id: "EXIT-ONLY",
    symbol: "WEAKONLY",
    yahooSymbol: "WEAKONLY.NS",
    status: "PENDING_EXIT",
    exitSignalDate: "2026-07-17",
    exitExecutionAfterDate: "2026-07-17",
    quantity: 50,
    investedValue: 50_000,
    lastPrice: 960
  });
  const events = [{ type: "EXIT_SIGNAL_PENDING", trade: exitTrade }];

  approveMorningOrders({
    trades: [exitTrade],
    candidates: [],
    scan: { scannedAt: "2026-07-20T03:00:00.000Z" },
    settings: { scopeListId: "all-market", scopeLabel: "All Indian Market", qualityMode: "BEST_ONLY" },
    config: { trade: { totalCapital: 1_000_000 } },
    events
  });

  assert.equal(exitTrade.exitOrderState, "APPROVED_FOR_0917");
  const published = publishPortfolioActionEvents(events, [exitTrade], "2026-07-20T03:00:00.000Z", { enabled: true });
  assert.deepEqual(published.map((event) => event.type), ["EXIT_SIGNAL_PENDING"]);
  assert.equal(exitTrade.exitOrderState, "CONFIRMED_FOR_0917");

  const duplicate = publishPortfolioActionEvents([], [exitTrade], "2026-07-20T03:01:00.000Z", { enabled: true });
  assert.equal(duplicate.length, 0);
});

test("one-stock one-action interlock cancels an add when risk reduction is the final decision", () => {
  const trade = openTrade({
    id: "CONFLICT",
    symbol: "CONFLICT",
    yahooSymbol: "CONFLICT.NS",
    status: "PENDING_EXIT",
    exitSignalDate: "2026-07-17",
    exitExecutionAfterDate: "2026-07-17",
    pendingAdd: {
      kind: "CONTROLLED_RETEST",
      signalDate: "2026-07-17",
      executionAfterDate: "2026-07-17",
      plannedQuantity: 100,
      plannedAllocation: 10_000,
      plannedRisk: 500,
      orderState: "CONFIRMED_FOR_0917"
    }
  });
  const events = [
    { type: "EXIT_SIGNAL_PENDING", trade },
    { type: "CONTROLLED_RETEST_ADD_PENDING", trade }
  ];

  approveMorningOrders({
    trades: [trade],
    candidates: [],
    scan: { scannedAt: "2026-07-20T03:00:00.000Z" },
    settings: { scopeListId: "all-market", scopeLabel: "All Indian Market", qualityMode: "BEST_ONLY" },
    config: { trade: { totalCapital: 1_000_000 } },
    events
  });

  assert.equal(trade.pendingAdd, null);
  assert.equal(trade.exitOrderState, "APPROVED_FOR_0917");
  assert.equal(portfolioSummary([trade], [], { trade: { totalCapital: 1_000_000 } }).reservedCapital, 0);
  const published = publishPortfolioActionEvents(events, [trade], "2026-07-20T03:00:00.000Z", { enabled: true });
  assert.deepEqual(published.map((event) => event.type), ["EXIT_SIGNAL_PENDING"]);
});

test("one-stock one-action interlock preserves a funded add when the final action is not risk reduction", () => {
  const row = strongRow({ symbol: "HEALTHY", yahooSymbol: "HEALTHY.NS", asOf: "2026-07-17" });
  const trade = openTrade({
    id: "HEALTHY",
    symbol: row.symbol,
    yahooSymbol: row.yahooSymbol,
    status: "OPEN",
    currentRank: 190,
    pendingAdd: {
      kind: "CONTROLLED_RETEST",
      signalDate: "2026-07-17",
      executionAfterDate: "2026-07-17",
      plannedQuantity: 100,
      plannedAllocation: 10_000,
      plannedRisk: 500,
      reason: ["Trend intact and the controlled retest reclaim is valid."]
    }
  });
  const events = [{ type: "CONTROLLED_RETEST_ADD_PENDING", trade }];

  approveMorningOrders({
    trades: [trade],
    candidates: [],
    rowBySymbol: new Map([[row.yahooSymbol, row]]),
    scan: { scannedAt: "2026-07-20T03:00:00.000Z" },
    settings: { scopeListId: "all-market", scopeLabel: "All Indian Market", qualityMode: "BEST_ONLY" },
    config: { trade: { totalCapital: 1_000_000 } },
    events
  });

  assert.equal(trade.status, "OPEN");
  assert.equal(trade.pendingAdd?.orderState, "APPROVED_FOR_0917");
  const published = publishPortfolioActionEvents(events, [trade], "2026-07-20T03:00:00.000Z", { enabled: true });
  assert.deepEqual(published.map((event) => event.type), ["CONTROLLED_RETEST_ADD_PENDING"]);
  assert.equal(trade.pendingAdd?.orderState, "CONFIRMED_FOR_0917");
});

test("08:30 approval removes an unfunded buy instead of leaving a pending order or alert", () => {
  const row = strongRow({ asOf: "2026-07-17" });
  const fullCapital = openTrade({ id: "CORE", quantity: 10_000, investedValue: 1_000_000 });
  const proposal = {
    id: "NO-CASH",
    symbol: row.symbol,
    yahooSymbol: row.yahooSymbol,
    industry: row.industry,
    status: "PENDING_ENTRY",
    entrySignalDate: "2026-07-17",
    entryExecutionAfterDate: "2026-07-17",
    plannedQuantity: 750,
    plannedAllocation: 75_000,
    plannedRisk: 4_500,
    positionRank: 200,
    candidateContext: { firstSignalDate: "2026-07-16", firstSignalClose: 98, peakRank: 200, entryCloseDates: ["2026-07-16", "2026-07-17"] },
    entryReason: [],
    entrySnapshot: row
  };
  const events = [{ type: "ENTRY_SIGNAL_PENDING", trade: proposal }];
  const candidates = approveMorningOrders({
    trades: [fullCapital, proposal],
    candidates: [],
    rowBySymbol: new Map([[row.yahooSymbol, row]]),
    scan: { scannedAt: "2026-07-20T03:00:00.000Z" },
    settings: { scopeListId: "all-market", scopeLabel: "All Indian Market", qualityMode: "BEST_ONLY" },
    config: { trade: { totalCapital: 1_000_000 } },
    events
  });

  assert.equal(proposal.status, "SKIPPED_ENTRY");
  assert.equal(proposal.orderState, "CANCELLED_BEFORE_ALERT");
  assert.equal(candidates[0]?.status, "WAITING_CAPITAL");
  const published = publishPortfolioActionEvents(events, [fullCapital, proposal], "2026-07-20T03:00:00.000Z", { enabled: true });
  assert.equal(published.some((event) => event.type === "ENTRY_SIGNAL_PENDING"), false);
});

test("illiquid candidate cannot become an automated entry", () => {
  const row = strongRow();
  row.setupStrength.checks.liquidEnough = false;
  row.setupStrength.values.averageTurnover = 20_875;
  const decision = candidateEntryDecision(
    { firstSignalDate: row.asOf, firstSignalClose: row.close, entryCloseDates: [row.asOf] },
    row,
    { trade: {} },
    { qualityPass: true }
  );
  assert.equal(decision.actionable, false);
  assert.equal(decision.disposition, "WAITING_RECONFIRMATION");
  assert.match(decision.reasons.join(" "), /compulsory liquidity/i);
});

test("cross-exchange fallback candidate cannot become an automated entry", () => {
  const row = strongRow({
    requestedYahooSymbol: "NEXUSSURGL.NS",
    yahooSymbol: "NEXUSSURGL.BO",
    exchangeFallback: true
  });
  const decision = candidateEntryDecision(
    { firstSignalDate: row.asOf, firstSignalClose: row.close, entryCloseDates: [row.asOf] },
    row,
    { trade: {} },
    { qualityPass: true }
  );
  assert.equal(decision.actionable, false);
  assert.match(decision.reasons.join(" "), /cross-exchange|resolved only through/i);
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

test("a marginal first daily long RS55 cross waits for confirmation", () => {
  const row = strongRow({ asOf: "2026-07-13", dailyLongRs: -0.01 });
  const decision = positionExitDecision(openTrade({
    entryDate: "2026-07-10",
    managementCloseDates: []
  }), row, { trade: {} });

  assert.equal(decision.action, "HOLD");
  assert.match(decision.reasons.join(" "), /RS55 EXIT CONFIRMATION.*1\/2/i);
});

test("daily RS55 below zero waits when price and short RS do not confirm damage", () => {
  const row = strongRow({ asOf: "2026-07-14", dailyLongRs: -0.02 });
  const decision = positionExitDecision(openTrade({
    entryDate: "2026-07-10",
    dailyLongRsBelowZeroDates: ["2026-07-13"]
  }), row, { trade: {} });

  assert.equal(decision.action, "HOLD");
  assert.match(decision.reasons.join(" "), /no second price\/RS weakness/i);
});

test("daily RS55 plus confirmed short-RS weakness creates a defensive partial exit", () => {
  const row = strongRow({
    asOf: "2026-07-14",
    dailyLongRs: -0.02,
    dailyShortRs: -0.01
  });
  const decision = positionExitDecision(openTrade({
    entryDate: "2026-07-10",
    dailyLongRsBelowZeroDates: ["2026-07-13"]
  }), row, { trade: {} });

  assert.equal(decision.action, "PARTIAL_EXIT");
  assert.equal(decision.tag, "RS55_DEFENCE");
  assert.equal(decision.partialPct, 33);
});

test("material daily long RS55 damage exits immediately", () => {
  const row = strongRow({ asOf: "2026-07-13", dailyLongRs: -0.11 });
  const decision = positionExitDecision(openTrade({ entryDate: "2026-07-10" }), row, { trade: {} });

  assert.equal(decision.action, "FULL_EXIT");
  assert.match(decision.reasons.join(" "), /materially below the hard-exit threshold/i);
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

test("initial stop uses Weekly EMA13-Low plus volatility buffer instead of Supertrend", () => {
  const stop = structuralStop(strongRow({ dailySupertrend: 50 }), 100, { trade: {} });
  assert.equal(stop, 94);
});

test("breakout and retracement styles share the same Weekly EMA13-Low structural anchor", () => {
  const row = strongRow({ weeklyEma13: 95 });
  row.entryStyle = { type: "BREAKOUT_RECLAIM_BUY", label: "Breakout after weekly EMA13 reclaim" };
  row.setupStrength.values.recentBaseLow = 93;
  row.setupStrength.values.fourCandleLow = 97;
  assert.equal(structuralStop(row, 100, { trade: {} }), 94);
});

test("an eight-to-ten percent Weekly EMA13-Low stop uses smaller capital and risk caps", () => {
  const row = strongRow({ weeklyEma13: 91.5, weeklyAtr: 5 });
  const plan = buildPositionPlan(
    row,
    100,
    { availableCash: 1_000_000, availableRisk: 60_000, openSlots: 10, sectorExposure: {} },
    { trade: {} }
  );

  assert.equal(plan.eligible, true);
  assert.equal(plan.stopPrice, 90.5);
  assert.equal(plan.wideStructuralStop, true);
  assert.equal(plan.maxAllocation, 50_000);
  assert.equal(plan.riskBudget, 5_000);
});

test("a structural stop wider than ten percent waits for retracement", () => {
  const row = strongRow({ weeklyEma13: 89, weeklyAtr: 5 });
  const plan = buildPositionPlan(
    row,
    100,
    { availableCash: 1_000_000, availableRisk: 60_000, openSlots: 10, sectorExposure: {} },
    { trade: {} }
  );

  assert.equal(plan.eligible, false);
  assert.equal(plan.stopPrice, 88);
  assert.match(plan.reason, /beyond the 10% entry limit/i);
});

test("a close-source weekly EMA cannot authorize a fresh position", () => {
  const row = strongRow({ weeklyEma13Source: "close" });
  const plan = buildPositionPlan(
    row,
    100,
    { availableCash: 1_000_000, availableRisk: 60_000, openSlots: 10, sectorExposure: {} },
    { trade: {} }
  );

  assert.equal(plan.eligible, false);
  assert.match(plan.reason, /Weekly EMA13 calculated from weekly lows/i);
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
    weeklyEma13Source: "low",
    weeklyAtr: 5,
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
        weeklyAtr: 5,
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
