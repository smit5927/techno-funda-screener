import assert from "node:assert/strict";
import test from "node:test";
import { configForUser, marketOnlyState, scanForUser } from "../src/multi-user-runtime.js";

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
