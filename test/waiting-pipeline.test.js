import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcileUnapprovedEntryProposals,
  updateTradeJournal,
  visibleWaitingPipeline
} from "../src/trade-journal.js";

test("unapproved current entry is revalidated and shown as ready for the next 08:30 cycle", () => {
  const row = entryRow();
  const trade = pendingEntry();
  const candidates = reconcileUnapprovedEntryProposals({
    trades: [trade],
    candidates: [],
    scopeRowBySymbol: new Map([[row.yahooSymbol, row]]),
    scan: { scannedAt: "2026-07-23T13:30:00.000Z" },
    settings: { scopeListId: "custom", scopeLabel: "My List", qualityMode: "BEST_ONLY" },
    config: { trade: baseTradeConfig() }
  });

  assert.equal(candidates.length, 0);
  assert.equal(trade.status, "PENDING_ENTRY");
  assert.equal(trade.orderState, "WAITING_FOR_0830");
  const pipeline = visibleWaitingPipeline([trade], candidates);
  assert.equal(pipeline.length, 1);
  assert.equal(pipeline[0].status, "READY_FOR_0830");
  assert.equal(pipeline[0].queueKind, "ENTRY_PROPOSAL");
});

test("stale entry proposal is cancelled before alert and does not reserve an order", () => {
  const row = entryRow({ status: "WATCH" });
  const trade = pendingEntry();
  const candidates = reconcileUnapprovedEntryProposals({
    trades: [trade],
    candidates: [],
    scopeRowBySymbol: new Map([[row.yahooSymbol, row]]),
    scan: { scannedAt: "2026-07-23T13:30:00.000Z" },
    settings: { scopeListId: "custom", scopeLabel: "My List", qualityMode: "BEST_ONLY" },
    config: { trade: baseTradeConfig() }
  });

  assert.equal(trade.status, "SKIPPED_ENTRY");
  assert.equal(trade.orderState, "CANCELLED_BEFORE_ALERT");
  assert.equal(candidates.length, 0);
  assert.equal(visibleWaitingPipeline([trade], candidates).length, 0);
});

test("confirmed 09:17 order is kept out of the candidate pipeline", () => {
  const trade = pendingEntry({ orderState: "CONFIRMED_FOR_0917" });
  assert.equal(visibleWaitingPipeline([trade], []).length, 0);
});

test("cash-only portfolio never labels an unfunded candidate as a rotation wait", async () => {
  const row = entryRow();
  const journal = await updateTradeJournal(
    {
      scannedAt: "2026-07-23T13:30:00.000Z",
      marketContext: { asOf: row.asOf, riskMode: "BULL", exposureCapPct: 100 },
      lists: {
        custom: { id: "custom", label: "My List", results: [row] }
      }
    },
    {
      trade: {
        ...baseTradeConfig(),
        minimumInitialAllocation: 25_000,
        scopeListId: "custom",
        qualityMode: "BEST_ONLY"
      }
    },
    {
      journal: {
        portfolioEngineStartedAt: "2026-07-01T00:00:00.000Z",
        pyramidingStartedAt: "2026-07-01T00:00:00.000Z",
        pyramidSwingEngineStartedAt: "2026-07-01T00:00:00.000Z",
        controlledRetestEngineStartedAt: "2026-07-01T00:00:00.000Z",
        liveModeStartedAt: "2026-07-01T00:00:00.000Z",
        signalState: { "custom:STRONG.NS": { status: "ENTRY", asOf: "2026-07-22" } },
        candidates: [{
          id: "STRONG-candidate",
          symbol: row.symbol,
          yahooSymbol: row.yahooSymbol,
          firstSignalDate: "2026-07-22",
          firstSignalClose: row.close,
          peakRank: 190,
          rank: 190,
          entryCloseDates: ["2026-07-22", row.asOf]
        }],
        trades: []
      },
      persist: false,
      writeSheets: false
    }
  );

  const candidate = journal.candidates.find((item) => item.symbol === row.symbol);
  assert.ok(candidate);
  assert.equal(candidate.status, "WAITING_CAPITAL");
  assert.doesNotMatch(candidate.skipReason, /rotation|distinct valid entry closes/i);
  assert.match(candidate.skipReason, /minimum initial buy value/i);
});

function pendingEntry(overrides = {}) {
  return {
    id: "STRONG-proposal",
    symbol: "STRONG",
    yahooSymbol: "STRONG.NS",
    name: "Strong Ltd",
    industry: "Industrials",
    status: "PENDING_ENTRY",
    entrySignalDate: "2026-07-22",
    positionRank: 190,
    plannedQuantity: 100,
    plannedAllocation: 10_000,
    plannedRisk: 500,
    entrySnapshot: entryRow(),
    candidateContext: {
      firstSignalDate: "2026-07-22",
      firstSignalClose: 100,
      peakRank: 190,
      entryCloseDates: ["2026-07-22"]
    },
    ...overrides
  };
}

function entryRow(overrides = {}) {
  return {
    symbol: "STRONG",
    yahooSymbol: "STRONG.NS",
    name: "Strong Ltd",
    industry: "Industrials",
    status: "ENTRY",
    asOf: "2026-07-23",
    close: 100,
    weeklyClose: 100,
    weeklyEma13: 95,
    weeklyEma13Source: "low",
    weeklyPriceAboveEma13: true,
    weeklyRs: 0.2,
    dailyLongRs: 0.12,
    dailyShortRs: 0.08,
    weeklyRsi: 65,
    dailyRsi: 62,
    dailySupertrend: 94,
    setupGrade: "A+",
    setupStrengthScore: 14,
    setupStrength: {
      checks: { liquidEnough: true },
      values: {
        weeklyEma13: 95,
        weeklyEma13Source: "low",
        weeklyAtr: 2,
        averageTurnover: 50_000_000,
        smaFast: 95,
        atr: 2
      }
    },
    ...overrides
  };
}

function baseTradeConfig() {
  return {
    totalCapital: 200_000,
    minimumInitialAllocation: 10_000,
    riskPerTradePct: 1,
    maxPortfolioRiskPct: 6,
    maxPositionPct: 10,
    initialMaxPositionPct: 10,
    initialRiskPct: 1,
    maxSectorExposurePct: 25,
    maxOpenPositions: 20,
    maximumStructuralStopPct: 10,
    weeklyEmaStopBufferPct: 0.25,
    weeklyEmaStopAtrFraction: 0.2
  };
}
