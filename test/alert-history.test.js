import assert from "node:assert/strict";
import test from "node:test";
import { alertFromTradeEvent, updateAlertHistory } from "../src/alert-history.js";

test("trade events become reason-first alerts for every required portfolio action", () => {
  const baseTrade = {
    id: "ABC-2026-07-16",
    symbol: "ABC",
    entrySignalDate: "2026-07-15",
    entryReason: ["Weekly and daily leadership confirmed."],
    quantity: 100,
    entryPrice: 100,
    trailingStopPrice: 94
  };
  const cases = [
    ["ENTRY_SIGNAL_PENDING", "ENTRY"],
    ["EXIT_SIGNAL_PENDING", "EXIT"],
    ["PARTIAL_EXIT_PENDING", "PARTIAL_EXIT"],
    ["PYRAMID_ADD_PENDING", "PYRAMID"]
  ];
  for (const [type, category] of cases) {
    const alert = alertFromTradeEvent({ type, trade: baseTrade }, "2026-07-16T03:00:00.000Z");
    assert.equal(alert.category, category);
    assert.equal(alert.symbol, "ABC");
    assert.ok(alert.summary);
  }
});

test("trade action alerts include quantity, value and configured total-fund percentage", () => {
  const pendingEntry = alertFromTradeEvent({
    type: "ENTRY_SIGNAL_PENDING",
    trade: {
      id: "ABC-entry",
      symbol: "ABC",
      plannedQuantity: 100,
      plannedAllocation: 99_500,
      entryReason: ["Leadership confirmed."]
    }
  }, "2026-07-16T03:00:00.000Z", { totalFund: 1_000_000 });
  assert.equal(pendingEntry.details.actionSide, "BUY");
  assert.equal(pendingEntry.details.actionQuantity, 100);
  assert.equal(pendingEntry.details.actionValue, 99_500);
  assert.equal(pendingEntry.details.actionFundPct, 9.95);
  assert.match(pendingEntry.allocationSummary, /APPROX BUY: Qty 100.*Fund Allocation 9\.95% of total fund/);

  const partialExit = alertFromTradeEvent({
    type: "PARTIAL_EXIT_PENDING",
    trade: {
      id: "ABC-partial",
      symbol: "ABC",
      quantity: 101,
      pendingPartialExitPct: 50,
      lastPrice: 120,
      pendingPartialExitReason: ["Confirmed deterioration."]
    }
  }, "2026-07-16T03:00:00.000Z", { totalFund: 1_000_000 });
  assert.equal(partialExit.details.actionSide, "PARTIAL SELL");
  assert.equal(partialExit.details.actionQuantity, 50);
  assert.equal(partialExit.details.actionValue, 6_000);
  assert.equal(partialExit.details.actionFundPct, 0.6);
});

test("dividend alert carries entitlement details while accounting stays in realized P&L", () => {
  const alert = alertFromTradeEvent({
    type: "DIVIDEND_CREDIT",
    trade: { id: "ABC-1", symbol: "ABC" },
    corporateAction: {
      id: "ABC-DIV-1",
      type: "DIVIDEND",
      exDate: "2026-07-16",
      purpose: "Dividend Rs 2 per share",
      entitledQuantity: 100,
      dividendPerShare: 2,
      amount: 200
    }
  }, "2026-07-16T03:00:00.000Z");
  assert.equal(alert.category, "CORPORATE");
  assert.equal(alert.actionDate, "2026-07-16");
  assert.equal(alert.details.exDate, "2026-07-16");
  assert.match(alert.summary, /Dividend ex-date 2026-07-16/);
  assert.equal(alert.details.dividendAmount, 200);
  assert.equal(alert.details.entitledQuantity, 100);
});

test("alert history is actionable-only, duplicate-proof, newest-first and capped", () => {
  const event = {
    type: "ENTRY_SIGNAL_PENDING",
    trade: { id: "ABC-1", symbol: "ABC", entrySignalDate: "2026-07-16", plannedEntryPrice: 100, plannedQuantity: 100 }
  };
  const once = updateAlertHistory([], [event], "2026-07-16T03:47:00.000Z");
  const twice = updateAlertHistory(once, [event], "2026-07-16T03:48:00.000Z");
  assert.equal(twice.length, 1);

  const existing = Array.from({ length: 500 }, (_, index) => ({
    id: `existing-${index}`,
    type: "ENTRY_SIGNAL_PENDING",
    symbol: `S${index}`,
    occurredAt: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString()
  }));
  const capped = updateAlertHistory(existing, [event], "2026-07-16T03:47:00.000Z");
  assert.equal(capped.length, 500);
  assert.equal(capped[0].symbol, "ABC");
});

test("operational noise is not exposed as a user alert", () => {
  for (const type of [
    "ENTRY_SKIPPED",
    "ENTRY_TRADE_OPENED",
    "EXIT_TRADE_CLOSED",
    "EXIT_SIGNAL_CANCELLED",
    "PARTIAL_EXIT_FILLED",
    "PYRAMID_ADD_FILLED",
    "ROTATION_CANCELLED",
    "CORPORATE_ACTION_REVIEW"
  ]) {
    assert.equal(alertFromTradeEvent({ type, trade: { id: "ABC-1", symbol: "ABC" } }), null);
  }
});

test("alerts auto-expire permanently when they complete 30 days", () => {
  const reference = "2026-07-31T03:00:00.000Z";
  const existing = [
    { id: "expired", type: "ENTRY_SIGNAL_PENDING", symbol: "OLD", occurredAt: "2026-07-01T03:00:00.000Z" },
    { id: "fresh", type: "ENTRY_SIGNAL_PENDING", symbol: "FRESH", occurredAt: "2026-07-01T03:00:00.001Z" },
    { id: "invalid-date", type: "ENTRY_SIGNAL_PENDING", symbol: "BAD", occurredAt: "not-a-date" }
  ];

  const history = updateAlertHistory(existing, [], reference);

  assert.deepEqual(history.map((alert) => alert.id), ["fresh"]);
});
