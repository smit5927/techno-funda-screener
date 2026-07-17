import assert from "node:assert/strict";
import test from "node:test";
import { projectedSellFunding, publishPortfolioActionEvents } from "../src/trade-journal.js";

function pendingTrade() {
  return {
    id: "BHEL-2026-07-16",
    symbol: "BHEL",
    status: "PENDING_ENTRY",
    entrySignalDate: "2026-07-16",
    plannedQuantity: 229,
    plannedAllocation: 99_706.6,
    plannedRisk: 7_877.6
  };
}

test("deployment or manual scan keeps an approved order private until the morning alert cycle", () => {
  const trade = pendingTrade();
  const events = [{ type: "ENTRY_SIGNAL_PENDING", trade }];
  const hidden = publishPortfolioActionEvents(events, [trade], "2026-07-17T03:55:00.000Z", {
    enabled: false
  });
  assert.deepEqual(hidden, []);
  assert.equal(trade.actionAlertPublications, undefined);

  const morning = publishPortfolioActionEvents([], [trade], "2026-07-20T03:00:00.000Z", {
    enabled: true
  });
  assert.equal(morning.length, 1);
  assert.equal(morning[0].type, "ENTRY_SIGNAL_PENDING");
  assert.equal(trade.orderState, "CONFIRMED_FOR_0917");
  assert.equal(trade.capitalReservedAt, "2026-07-20T03:00:00.000Z");
});

test("one reserved order publishes only once even across repeated 08:30 scans", () => {
  const trade = pendingTrade();
  const first = publishPortfolioActionEvents([], [trade], "2026-07-20T03:00:00.000Z", { enabled: true });
  const retry = publishPortfolioActionEvents([], [trade], "2026-07-21T03:00:00.000Z", { enabled: true });
  assert.equal(first.length, 1);
  assert.equal(retry.length, 0);
});

test("a dividend discovered outside 08:30 is deferred without replaying old corporate history", () => {
  const currentDividend = { id: "DIV-2026", type: "DIVIDEND", exDate: "2026-07-17" };
  const oldDividend = { id: "DIV-2025", type: "DIVIDEND", exDate: "2025-07-17" };
  const trade = {
    id: "ABC-open",
    symbol: "ABC",
    status: "OPEN",
    corporateActions: [oldDividend, currentDividend]
  };
  publishPortfolioActionEvents(
    [{ type: "DIVIDEND_CREDIT", trade, corporateAction: currentDividend }],
    [trade],
    "2026-07-17T10:00:00.000Z",
    { enabled: false }
  );
  assert.equal(currentDividend.notificationPending, true);
  assert.equal(oldDividend.notificationPending, undefined);

  const morning = publishPortfolioActionEvents([], [trade], "2026-07-20T03:00:00.000Z", { enabled: true });
  assert.deepEqual(morning.map((event) => event.corporateAction.id), ["DIV-2026"]);
  assert.equal(currentDividend.notificationPending, false);
});

test("same-batch funding counts confirmed full and partial sell proceeds before approving buys", () => {
  const funding = projectedSellFunding([
    {
      id: "FULL",
      symbol: "WEAK",
      status: "PENDING_EXIT",
      quantity: 100,
      lastPrice: 200,
      investedValue: 18_000,
      industry: "Industrials"
    },
    {
      id: "PARTIAL",
      symbol: "TRIM",
      status: "PENDING_PARTIAL_EXIT",
      quantity: 80,
      pendingPartialExitPct: 25,
      lastPrice: 500,
      investedValue: 32_000,
      industry: "Finance"
    }
  ]);
  assert.equal(funding.expectedProceeds, 30_000);
  assert.equal(funding.fullExitCount, 1);
  assert.deepEqual(funding.sources.map((source) => [source.kind, source.expectedQuantity]), [
    ["FULL_EXIT", 100],
    ["PARTIAL_EXIT", 20]
  ]);
});
