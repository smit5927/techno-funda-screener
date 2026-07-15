import assert from "node:assert/strict";
import test from "node:test";
import { summarizeTrades, visiblePortfolioSummary } from "../src/screener.js";

const visibleTrades = [
  { status: "OPEN", investedValue: 10_000, unrealizedPnl: 400, realizedPnlToDate: 100 },
  { status: "PENDING_PARTIAL_EXIT", investedValue: 5_000, unrealizedPnl: -50, realizedPnlToDate: -20 },
  { status: "CLOSED", investedValue: 0, unrealizedPnl: null, realizedPnlToDate: 100, pnl: 300 }
];

test("booked partial and full exits stay realized while only active remainder stays unrealized", () => {
  const summary = summarizeTrades(visibleTrades);
  assert.equal(summary.realizedPnl, 380);
  assert.equal(summary.unrealizedPnl, 350);
});

test("visible portfolio accounting excludes hidden trades from another scope", () => {
  const hiddenTrade = { status: "CLOSED", pnl: 999, realizedPnlToDate: 999 };
  const summary = visiblePortfolioSummary(
    { trades: [...visibleTrades, hiddenTrade], visibleTrades, candidates: [], visibleCandidates: [] },
    { trade: { totalCapital: 1_000_000 } }
  );
  assert.equal(summary.realizedPnl, 380);
  assert.equal(summary.unrealizedPnl, 350);
  assert.equal(summary.totalEquity - summary.totalCapital, 730);
});
