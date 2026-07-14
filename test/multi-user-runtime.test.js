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
