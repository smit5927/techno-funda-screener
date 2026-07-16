import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { appConfig } from "../src/config.js";
import { updateTradeJournal } from "../src/trade-journal.js";

test("full-capital quality rotation reuses sell cash in the same exact 09:17 slot", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "techno-funda-rotation-"));
  const original = {
    dataDir: appConfig.dataDir,
    tradesPath: appConfig.tradesPath,
    tradeSheetPath: appConfig.tradeSheetPath,
    tradeCsvPath: appConfig.tradeCsvPath
  };
  Object.assign(appConfig, {
    dataDir: temp,
    tradesPath: path.join(temp, "trades.json"),
    tradeSheetPath: path.join(temp, "trades.xlsx"),
    tradeCsvPath: path.join(temp, "trades.csv")
  });

  try {
    fs.writeFileSync(appConfig.tradesPath, `${JSON.stringify(seedJournal(), null, 2)}\n`);
    const config = testConfig();
    const journal = await updateTradeJournal(scanFixture(), config);
    const sold = journal.trades.find((trade) => trade.symbol === "WEAK");
    const bought = journal.trades.find((trade) => trade.symbol === "STRONG");

    assert.ok(sold, JSON.stringify(journal.trades, null, 2));
    assert.ok(bought, JSON.stringify({ trades: journal.trades, candidates: journal.candidates }, null, 2));
    assert.equal(sold.status, "CLOSED");
    assert.equal(sold.exitType, "QUALITY_ROTATION");
    assert.equal(sold.exitDate, "2026-07-13");
    assert.equal(sold.exitTime, "09:17 IST");
    assert.equal(bought.status, "OPEN");
    assert.equal(bought.entryDate, sold.exitDate);
    assert.equal(bought.entryTime, sold.exitTime);
    assert.equal(bought.entryActualFillTime, "09:17 IST");
    assert.equal(bought.rotationSourceSymbol, "WEAK");
    assert.equal(bought.rotationExecution.rule, "SELL_THEN_BUY_SAME_0917_SLOT");
    assert.equal(bought.quantity, 9);
    assert.equal(bought.investedValue, 900);
    assert.equal(bought.currentValue, 900);
  } finally {
    Object.assign(appConfig, original);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("rotation does not sell the weak holding when replacement fails the 09:17 trend preflight", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "techno-funda-rotation-guard-"));
  const original = {
    dataDir: appConfig.dataDir,
    tradesPath: appConfig.tradesPath,
    tradeSheetPath: appConfig.tradeSheetPath,
    tradeCsvPath: appConfig.tradeCsvPath
  };
  Object.assign(appConfig, {
    dataDir: temp,
    tradesPath: path.join(temp, "trades.json"),
    tradeSheetPath: path.join(temp, "trades.xlsx"),
    tradeCsvPath: path.join(temp, "trades.csv")
  });

  try {
    fs.writeFileSync(appConfig.tradesPath, `${JSON.stringify(seedJournal(), null, 2)}\n`);
    const journal = await updateTradeJournal(scanFixture(), testConfig({ strongPrice: 90 }));
    const weak = journal.trades.find((trade) => trade.symbol === "WEAK");
    const replacement = journal.trades.find((trade) => trade.symbol === "STRONG");
    const candidate = journal.candidates.find((item) => item.symbol === "STRONG");

    assert.equal(weak.status, "OPEN");
    assert.equal(replacement, undefined);
    assert.ok(weak.rotationCancellations?.length > 0);
    assert.match(weak.rotationCancellations.at(-1).reason, /below daily Supertrend/i);
    assert.equal(candidate.status, "WAITING_RECONFIRMATION");
    assert.ok(journal.events.some((event) => event.type === "ROTATION_CANCELLED"));
  } finally {
    Object.assign(appConfig, original);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("a stale pending quality rotation is cancelled before its 09:17 sell", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "techno-funda-stale-rotation-"));
  const original = {
    dataDir: appConfig.dataDir,
    tradesPath: appConfig.tradesPath,
    tradeSheetPath: appConfig.tradeSheetPath,
    tradeCsvPath: appConfig.tradeCsvPath
  };
  Object.assign(appConfig, {
    dataDir: temp,
    tradesPath: path.join(temp, "trades.json"),
    tradeSheetPath: path.join(temp, "trades.xlsx"),
    tradeCsvPath: path.join(temp, "trades.csv")
  });

  try {
    const seeded = seedJournal();
    const weak = seeded.trades[0];
    weak.status = "PENDING_EXIT";
    weak.exitType = "QUALITY_ROTATION";
    weak.exitSignalDate = "2026-07-10";
    weak.exitReason = ["Legacy optional rotation signal."];
    weak.replacementCandidateSymbol = "STRONG";
    seeded.candidates[0].rotation = { sourceTradeId: weak.id };
    fs.writeFileSync(appConfig.tradesPath, `${JSON.stringify(seeded, null, 2)}\n`);

    const config = testConfig();
    config.trade.minimumManagementCloses = 5;
    config.trade.rotationConfirmationCloses = 3;
    config.trade.rotationCooldownCloses = 3;
    const journal = await updateTradeJournal(scanFixture(), config);
    const restored = journal.trades.find((trade) => trade.symbol === "WEAK");

    assert.equal(restored.status, "OPEN");
    assert.equal(restored.exitType, null);
    assert.equal(restored.replacementCandidateSymbol, null);
    assert.equal(restored.cancelledExitSignals.length, 1);
    assert.match(restored.riskActionNote, /rotation cancelled before execution/i);
  } finally {
    Object.assign(appConfig, original);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

function seedJournal() {
  return {
    updatedAt: "2026-07-10T04:00:00.000Z",
    portfolioEngineStartedAt: "2026-07-01T02:30:00.000Z",
    pyramidingStartedAt: "2026-07-01T02:30:00.000Z",
    liveModeStartedAt: "2026-07-01T02:30:00.000Z",
    signalState: {
      "all-market:STRONG.NS": { status: "ENTRY", asOf: "2026-07-10" }
    },
    candidates: [{
      id: "strong-candidate",
      symbol: "STRONG",
      yahooSymbol: "STRONG.NS",
      name: "Strong Ltd",
      industry: "Technology",
      tradeScope: "all-market",
      firstSignalDate: "2026-07-09",
      firstSignalClose: 100,
      peakRank: 231,
      entryCloseDates: ["2026-07-09"],
      rank: 231,
      status: "WAITING_CAPITAL"
    }],
    trades: [{
      id: "weak-open-trade",
      symbol: "WEAK",
      yahooSymbol: "WEAK.NS",
      name: "Weak Ltd",
      industry: "Industrials",
      listId: "all-market",
      listLabel: "All NSE Market",
      sourceLists: ["All NSE Market"],
      tradeScope: "all-market",
      status: "OPEN",
      entrySignalDate: "2026-06-30",
      entryDate: "2026-07-01",
      entryTime: "09:17 IST",
      entryPrice: 1000,
      initialEntryPrice: 1000,
      quantity: 1,
      originalQuantity: 1,
      initialQuantity: 1,
      investedValue: 1000,
      originalInvestedValue: 1000,
      initialStopPrice: 900,
      trailingStopPrice: 900,
      initialRiskAmount: 100,
      realizedPnlToDate: 0,
      partialExits: [],
      partialExitTags: [],
      addOns: [],
      entrySnapshot: { fundamentalScore: 2 },
      rotationReview: {
        qualificationVersion: 2,
        lastObservedAsOf: "2026-07-09",
        weakCloseDates: ["2026-07-09"]
      }
    }]
  };
}

function scanFixture() {
  const rows = [weakRow(), strongRow()];
  return {
    scannedAt: "2026-07-13T04:00:00.000Z",
    marketContext: { asOf: "2026-07-10" },
    lists: {
      "all-market": {
        id: "all-market",
        label: "All NSE Market",
        results: rows
      }
    }
  };
}

function testConfig({ strongPrice = 100 } = {}) {
  return {
    ...appConfig,
    trade: {
      ...appConfig.trade,
      totalCapital: 1000,
      minimumInitialAllocation: 100,
      autoPositionBreadth: false,
      maxOpenPositions: 1,
      maxPositionPct: 100,
      riskPerTradePct: 100,
      maxPortfolioRiskPct: 100,
      maxSectorExposurePct: 100,
      rotationMinRankAdvantage: 1,
      rotationMinimumHoldingDays: 0,
      minimumManagementCloses: 1,
      rotationConfirmationCloses: 1,
      rotationCooldownCloses: 1,
      pyramidingEnabled: false,
      scopeListId: "all-market",
      qualityMode: "BEST_ONLY",
      onlyNewSignals: true,
      executionPriceFetcher: async (symbol) => ({
        date: "2026-07-13",
        timeLabel: "09:17 IST",
        window: "09:17 IST",
        source: "test 09:17 one-minute candle open",
        price: symbol === "WEAK.NS" ? 990 : strongPrice
      })
    }
  };
}

function weakRow() {
  return {
    symbol: "WEAK",
    yahooSymbol: "WEAK.NS",
    name: "Weak Ltd",
    industry: "Industrials",
    listId: "all-market",
    listLabel: "All NSE Market",
    sourceLists: ["All NSE Market"],
    asOf: "2026-07-10",
    status: "WATCH",
    close: 990,
    dailyRsi: 45,
    weeklyRsi: 55,
    weeklyRs: 0.01,
    dailyLongRs: 0.01,
    dailyShortRs: -0.01,
    dailySupertrend: 995,
    setupGrade: "B",
    setupStrengthScore: 1,
    fundamentalScore: 1,
    conceptCoverage: { applicable: 10, passed: 2, dataGaps: 0 },
    institutionalContext: { score: 0 },
    setupStrength: {
      checks: { marketRegimeStrong: false },
      values: { smaFast: 1000, twoCandleLow: 950, fourCandleLow: 940 }
    },
    gtfContext: { rankAdjustment: 0, supplyBlocked: false, checks: { roomForTwoR: true } }
  };
}

function strongRow() {
  return {
    symbol: "STRONG",
    yahooSymbol: "STRONG.NS",
    name: "Strong Ltd",
    industry: "Technology",
    listId: "all-market",
    listLabel: "All NSE Market",
    sourceLists: ["All NSE Market"],
    asOf: "2026-07-10",
    status: "ENTRY",
    close: 100,
    dailyRsi: 68,
    weeklyRsi: 70,
    weeklyRs: 0.4,
    dailyLongRs: 0.3,
    dailyShortRs: 0.2,
    dailySupertrend: 96,
    setupGrade: "A+",
    setupStrengthScore: 20,
    fundamentalScore: 5,
    score: 30,
    entryStyle: { type: "BREAKOUT_BUY", label: "Breakout buy" },
    conceptCoverage: { applicable: 10, passed: 10, dataGaps: 0 },
    institutionalContext: { score: 5 },
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
        marketRegimeStrong: true
      },
      values: { smaFast: 95, smaSlow: 90, twoCandleLow: 97, fourCandleLow: 96, atrPct: 2 }
    },
    gtfContext: { rankAdjustment: 3, supplyBlocked: false, checks: { roomForTwoR: true } },
    signalReason: ["All six compulsory video-derived entry checks pass."]
  };
}
