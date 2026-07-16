import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCorporateActionToTrade,
  parseCorporateAction,
  updateOpenPositionCorporateActions
} from "../src/corporate-actions.js";
import { applyTradeChargeAccounting } from "../src/charges.js";

function openTrade(overrides = {}) {
  return {
    id: "ABC-1",
    symbol: "ABC",
    yahooSymbol: "ABC.NS",
    status: "OPEN",
    entryDate: "2026-06-01",
    entryPrice: 100,
    initialEntryPrice: 100,
    initialQuantity: 100,
    originalQuantity: 100,
    originalInvestedValue: 10000,
    investedValue: 10000,
    quantity: 100,
    lastPrice: 105,
    initialStopPrice: 92,
    trailingStopPrice: 98,
    riskPerShare: 8,
    addOns: [],
    partialExits: [],
    ...overrides
  };
}

test("NSE dividend, special dividend, bonus and split purposes are parsed", () => {
  const dividend = parseCorporateAction({
    symbol: "ABC",
    exDate: "03-Jul-2026",
    recDate: "03-Jul-2026",
    subject: "Dividend - Re 1 Per Share/Special Dividend - Rs 2 Per Share"
  });
  const bonus = parseCorporateAction({ symbol: "ABC", exDate: "04-Jul-2026", subject: "Bonus 2:1" });
  const split = parseCorporateAction({
    symbol: "ABC",
    exDate: "05-Jul-2026",
    subject: "Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share"
  });

  assert.equal(dividend.type, "DIVIDEND");
  assert.equal(dividend.dividendPerShare, 3);
  assert.equal(bonus.type, "BONUS");
  assert.equal(bonus.factor, 3);
  assert.equal(split.type, "SPLIT");
  assert.equal(split.factor, 5);
});

test("split adjusts an open position once while preserving cost-basis accounting", () => {
  const trade = openTrade();
  const action = parseCorporateAction({
    symbol: "ABC",
    exDate: "05-Jul-2026",
    subject: "Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share"
  });

  assert.equal(applyCorporateActionToTrade(trade, action).applied, true);
  assert.equal(trade.quantity, 500);
  assert.equal(trade.entryPrice, 20);
  assert.equal(trade.trailingStopPrice, 19.6);
  assert.equal(trade.accountingInitialQuantity, 100);
  assert.equal(applyCorporateActionToTrade(trade, action).applied, false);

  applyTradeChargeAccounting(trade, { trade: { chargesEnabled: false } }, 21);
  assert.equal(trade.quantity, 500);
  assert.equal(trade.investedValue, 10000);
  assert.equal(trade.unrealizedPnl, 500);
  assert.equal(trade.transactions.filter((item) => item.type === "CORPORATE_ADJUSTMENT").length, 1);
});

test("dividend is separate realized income and is not credited twice", () => {
  const trade = openTrade();
  const action = parseCorporateAction({
    symbol: "ABC",
    exDate: "03-Jul-2026",
    subject: "Dividend - Rs 2.50 Per Share"
  });

  applyCorporateActionToTrade(trade, action);
  applyTradeChargeAccounting(trade, { trade: { chargesEnabled: false } }, 105);
  assert.equal(trade.dividendRealizedPnl, 250);
  assert.equal(trade.tradeRealizedPnlToDate, 0);
  assert.equal(trade.realizedPnlToDate, 250);
  assert.equal(trade.chargeSummary.realizedCharges, 0);
  assert.equal(trade.transactions.find((item) => item.type === "DIVIDEND").netPnl, 250);

  applyCorporateActionToTrade(trade, action);
  applyTradeChargeAccounting(trade, { trade: { chargesEnabled: false } }, 105);
  assert.equal(trade.dividendRealizedPnl, 250);
});

test("only eligible open positions are processed and complex actions enter review", async () => {
  const active = openTrade();
  const pendingEntry = openTrade({ id: "ABC-2", status: "PENDING_ENTRY", entryDate: null });
  const closed = openTrade({ id: "ABC-3", status: "CLOSED" });
  const outcome = await updateOpenPositionCorporateActions(
    [active, pendingEntry, closed],
    { scannedAt: "2026-07-16T08:00:00.000Z", marketContext: { asOf: "2026-07-15" } },
    { corporateActions: { enabled: true, lookbackDays: 400 } },
    { actions: [{ symbol: "ABC", exDate: "10-Jul-2026", subject: "Demerger" }] }
  );

  assert.equal(outcome.appliedCount, 1);
  assert.equal(outcome.reviewCount, 1);
  assert.equal(active.corporateActions[0].status, "REVIEW_REQUIRED");
  assert.equal(pendingEntry.corporateActions, undefined);
  assert.equal(closed.corporateActions, undefined);
});

test("entry on the ex-date is not entitled to that corporate action", () => {
  const trade = openTrade({ entryDate: "2026-07-03" });
  const dividend = parseCorporateAction({ symbol: "ABC", exDate: "03-Jul-2026", subject: "Dividend - Rs 5 Per Share" });
  assert.equal(applyCorporateActionToTrade(trade, dividend).applied, false);
});

test("ex-date morning exit preserves dividend entitlement in realized P&L", async () => {
  const trade = openTrade({
    status: "PENDING_EXIT",
    exitSignalDate: "2026-07-15",
    exitReason: ["Full exit confirmed on the prior close."]
  });
  const outcome = await updateOpenPositionCorporateActions(
    [trade],
    {
      scannedAt: "2026-07-16T03:00:00.000Z",
      marketContext: { asOf: "2026-07-15" }
    },
    { corporateActions: { enabled: true, lookbackDays: 400 } },
    { actions: [{ symbol: "ABC", exDate: "16-Jul-2026", subject: "Dividend - Rs 5 Per Share" }] }
  );

  assert.equal(outcome.appliedCount, 1);
  assert.equal(outcome.events[0].type, "DIVIDEND_CREDIT");
  assert.equal(trade.corporateActions[0].exDate, "2026-07-16");
  assert.equal(trade.corporateActions[0].entitledQuantity, 100);
  assert.equal(trade.corporateActions[0].amount, 500);

  trade.status = "CLOSED";
  trade.exitDate = "2026-07-16";
  trade.exitTime = "09:17 IST";
  trade.exitPrice = 98;
  trade.lastPrice = 98;
  applyTradeChargeAccounting(trade, { trade: { chargesEnabled: false } }, 98);

  assert.equal(trade.tradeRealizedPnlToDate, -200);
  assert.equal(trade.dividendRealizedPnl, 500);
  assert.equal(trade.realizedPnlToDate, 300);
  assert.equal(trade.pnl, 300);
});
