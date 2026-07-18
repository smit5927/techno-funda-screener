import assert from "node:assert/strict";
import test from "node:test";
import {
  configForUser,
  decodeMarketState,
  encodeMarketState,
  journalForUser,
  marketOnlyState,
  portfolioState,
  scanForUser
} from "../src/multi-user-runtime.js";

test("compressed market state round-trips without losing screener evidence", () => {
  const state = {
    scannedAt: "2026-07-16T08:15:30.047Z",
    lists: {
      "all-market": {
        results: [{
          symbol: "BLUESTARCO",
          status: "EXIT",
          setupStrength: { checks: { baseBreakout: false } },
          gtfContext: { score: 4 },
          institutionalContext: { score: 3 }
        }]
      }
    }
  };

  const encoded = encodeMarketState(state);
  assert.equal(encoded.encoding, "gzip-base64");
  assert.ok(encoded.compressedBytes < encoded.rawBytes);
  assert.deepEqual(decodeMarketState(encoded), state);
});

test("multi-user runtime derives a private custom list without changing common market data", () => {
  const scan = {
    lists: {
      "all-market": {
        results: [
          { symbol: "ABC", status: "ENTRY" },
          { symbol: "XYZ", status: "WATCH" }
        ]
      }
    },
    trades: [{ symbol: "GLOBAL" }],
    portfolioSummary: { totalCapital: 1000000 }
  };
  const userScan = scanForUser(scan, ["NSE:ABC"]);
  assert.deepEqual(userScan.lists.custom.results.map((row) => row.symbol), ["ABC"]);
  assert.equal(scan.lists.custom, undefined);
  const market = marketOnlyState(scan);
  assert.equal(market.trades, undefined);
  assert.equal(market.portfolioSummary, undefined);
  assert.deepEqual(market.lists.default.symbols, []);
  assert.equal(market.lists["all-market"].results[0].symbol, "ABC");
});

test("mobile market state keeps decision evidence but removes large execution internals", () => {
  const scan = {
    lists: {
      "all-market": {
        results: [{
          symbol: "ABC",
          status: "ENTRY",
          signalReason: Array.from({ length: 30 }, (_, index) => `Reason ${index}`),
          setupStrength: {
            score: 10,
            checks: { baseBreakout: true },
            values: { priorBaseHigh: 100, unusedRawSeries: Array(1000).fill(1) },
            pyramidStructure: { raw: Array(1000).fill(1) }
          }
        }]
      },
      default: { results: [{ symbol: "ABC" }] }
    }
  };
  const market = marketOnlyState(scan);
  const row = market.lists["all-market"].results[0];
  assert.equal(row.setupStrength.values.priorBaseHigh, 100);
  assert.equal(row.setupStrength.values.unusedRawSeries, undefined);
  assert.equal(row.setupStrength.pyramidStructure, undefined);
  assert.equal(row.signalReason.length, 14);
  assert.deepEqual(market.lists.default.symbols, ["ABC"]);
});

test("mobile market state keeps detail evidence for non-entry screener rows", () => {
  const scan = {
    lists: {
      "all-market": {
        results: [{
          symbol: "BLUESTARCO",
          status: "EXIT",
          fundamental: { available: false, reason: "Technical gate not met." },
          setupStrength: {
            score: 7,
            checks: { baseBreakout: false, weeklyCloseAboveEma13: true },
            values: { priorBaseHigh: 1800, weeklyEma13: 1700 }
          },
          sectorStrength: { ok: true, breadthPct: 63 },
          conceptCoverage: { summary: "Evidence retained", weakLabels: ["Daily RS55"] },
          gtfContext: {
            dataAvailable: true,
            score: 4,
            maxScore: 8,
            dailyTrend: "up",
            checks: { dailyDemandQualified: true }
          },
          institutionalContext: {
            score: 3,
            maxScore: 5,
            index: { supportsLongs: true, reason: "Broad market supportive" }
          }
        }]
      }
    }
  };

  const row = marketOnlyState(scan).lists["all-market"].results[0];
  assert.equal(row.fundamental.reason, "Technical gate not met.");
  assert.equal(row.setupStrength.values.priorBaseHigh, 1800);
  assert.equal(row.sectorStrength.breadthPct, 63);
  assert.equal(row.conceptCoverage.weakLabels[0], "Daily RS55");
  assert.equal(row.gtfContext.checks.dailyDemandQualified, true);
  assert.equal(row.institutionalContext.index.supportsLongs, true);
});

test("user capital and risk settings override defaults without mutating shared config", () => {
  const config = configForUser({
    totalCapital: 2500000,
    scopeListId: "custom",
    riskPerTradePct: 0.5,
    pyramidingEnabled: false
  });
  assert.equal(config.trade.totalCapital, 2500000);
  assert.equal(config.trade.scopeListId, "custom");
  assert.equal(config.trade.riskPerTradePct, 0.5);
  assert.equal(config.trade.pyramidingEnabled, false);
});

test("empty owner portfolio restores the existing live journal exactly once", () => {
  const current = { liveModeStartedAt: "2026-07-14T00:00:00.000Z", trades: [] };
  const legacy = { trades: [{ symbol: "ABC", status: "OPEN" }], candidates: [] };
  const restored = journalForUser(
    { role: "admin", journal: current },
    legacy,
    "2026-07-15T02:30:00.000Z"
  );
  assert.deepEqual(restored.trades, legacy.trades);
  assert.equal(restored.legacyOwnerJournalMigratedAt, "2026-07-15T02:30:00.000Z");
  const retained = journalForUser({ role: "admin", journal: restored }, { trades: [] });
  assert.deepEqual(retained, restored);
});

test("client portfolio never inherits the owner's legacy journal", () => {
  const current = { trades: [] };
  const legacy = { trades: [{ symbol: "OWNER", status: "OPEN" }] };
  assert.equal(journalForUser({ role: "member", journal: current }, legacy), current);
});

test("master-reset owner journal cannot reimport legacy open positions", () => {
  const resetJournal = {
    systemResetAt: "2026-07-18T07:00:00.000Z",
    legacyOwnerJournalMigratedAt: "2026-07-18T07:00:00.000Z",
    trades: []
  };
  const legacy = { trades: [{ symbol: "OLD", status: "OPEN" }] };
  assert.deepEqual(journalForUser({ role: "admin", journal: resetJournal }, legacy), resetJournal);
});

test("user portfolio summary uses only the selected visible trade book", () => {
  const visibleTrade = {
    status: "OPEN",
    investedValue: 100_000,
    unrealizedPnl: 2_000,
    realizedPnlToDate: -500,
    industry: "Industrials"
  };
  const hiddenTrade = { status: "CLOSED", pnl: 8_000 };
  const state = portfolioState(
    { scannedAt: "2026-07-15T04:00:00.000Z" },
    { visibleTrades: [visibleTrade], trades: [visibleTrade, hiddenTrade], visibleCandidates: [] },
    { scopeListId: "custom" },
    { trade: { totalCapital: 1_000_000 } }
  );

  assert.equal(state.tradeSummary.realizedPnl, -500);
  assert.equal(state.portfolioSummary.realizedPnl, -500);
});
