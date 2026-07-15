import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatePositionMtm,
  summarizeLivePositions
} from "../supabase/functions/techno-funda-api/live-mtm.js";
import {
  calculatePositionMtm as calculateAppPositionMtm
} from "../supabase/functions/techno-funda-app-api/live-mtm.js";

const trade = {
  symbol: "TEST",
  yahooSymbol: "TEST.NS",
  status: "OPEN",
  entryPrice: 100,
  quantity: 100,
  lastPrice: 105,
  initialStopPrice: 94,
  trailingStopPrice: 98
};

test("near-live MTM calculates positional P&L and stop risk without changing status", () => {
  const result = calculatePositionMtm(trade, {
    ltp: 110,
    previousClose: 108,
    isLive: true,
    asOf: "2026-07-13T04:30:00.000Z",
    source: "Yahoo 1m"
  });

  assert.equal(result.status, "OPEN");
  assert.equal(result.unrealizedPnl, 1000);
  assert.equal(result.unrealizedPnlPct, 10);
  assert.equal(result.previousClose, 108);
  assert.equal(result.dayPnl, 200);
  assert.equal(result.dayPnlPct, 1.85);
  assert.equal(result.investedValue, 10000);
  assert.equal(result.marketValue, 11000);
  assert.equal(result.downsideToStop, 1200);
  assert.equal(result.distanceToStopPct, 10.91);
  assert.equal(result.riskState, "NORMAL");
  assert.equal(trade.lastPrice, 105);
  assert.deepEqual(calculateAppPositionMtm(trade, { ltp: 110, previousClose: 108, isLive: true }), {
    ...calculatePositionMtm(trade, { ltp: 110, previousClose: 108, isLive: true })
  });
});

test("stop proximity and breach are monitoring states, not sell executions", () => {
  const near = calculatePositionMtm(trade, { ltp: 98.5, isLive: true });
  const breached = calculatePositionMtm(trade, { ltp: 97, isLive: true });

  assert.equal(near.riskState, "NEAR_STOP");
  assert.equal(breached.riskState, "BREACHED");
  assert.equal(breached.status, "OPEN");
  assert.equal(breached.downsideToStop, 0);
});

test("portfolio live summary reports MTM and risk against total capital", () => {
  const positions = [
    calculatePositionMtm(trade, { ltp: 110, previousClose: 108, isLive: true }),
    calculatePositionMtm(
      { ...trade, symbol: "SECOND", yahooSymbol: "SECOND.NS", quantity: 50 },
      { ltp: 97, previousClose: 96, isLive: false }
    )
  ];
  const summary = summarizeLivePositions(positions, 1_000_000);

  assert.equal(summary.unrealizedPnl, 850);
  assert.equal(summary.unrealizedPnlPct, 5.67);
  assert.equal(summary.dayPnl, 250);
  assert.equal(summary.dayPnlPct, 1.6);
  assert.equal(summary.investedValue, 15000);
  assert.equal(summary.marketValue, 15850);
  assert.equal(summary.downsideToStops, 1200);
  assert.equal(summary.stopRiskPct, 0.12);
  assert.equal(summary.breachCount, 1);
  assert.equal(summary.liveCount, 1);
  assert.equal(summary.staleCount, 1);
});
