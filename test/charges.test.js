import test from "node:test";
import assert from "node:assert/strict";
import {
  applyTradeChargeAccounting,
  calculateDeliveryCharges
} from "../src/charges.js";

const discountConfig = {
  trade: {
    chargesEnabled: true,
    brokerageMode: "FLAT_PER_ORDER",
    brokerageFlatPerOrder: 20,
    brokeragePercent: 0.1,
    dpChargePerSell: 15.34
  }
};

test("delivery buy calculates brokerage and all statutory charges without DP", () => {
  const charges = calculateDeliveryCharges({ side: "BUY", price: 100, quantity: 1000 }, discountConfig);
  assert.equal(charges.turnover, 100000);
  assert.equal(charges.brokerage, 20);
  assert.equal(charges.stt, 100);
  assert.equal(charges.stampDuty, 15);
  assert.equal(charges.dpCharge, 0);
  assert.ok(charges.total > 140);
});

test("delivery sell adds DP charge and percentage brokerage is turnover based", () => {
  const charges = calculateDeliveryCharges(
    { side: "SELL", price: 110, quantity: 500 },
    { trade: { ...discountConfig.trade, brokerageMode: "PERCENT_TURNOVER", brokeragePercent: 0.25 } }
  );
  assert.equal(charges.brokerage, 137.5);
  assert.equal(charges.stampDuty, 0);
  assert.equal(charges.dpCharge, 15.34);
});

test("charges off returns a zero-cost transaction", () => {
  const charges = calculateDeliveryCharges({ side: "SELL", price: 110, quantity: 500 }, { trade: {} });
  assert.equal(charges.total, 0);
  assert.equal(charges.turnover, 55000);
});

test("trade accounting keeps gross and net P&L separate across partial and full exits", () => {
  const trade = {
    status: "CLOSED",
    entryDate: "2026-07-01",
    entryTime: "09:17 IST",
    entryPrice: 100,
    initialEntryPrice: 100,
    initialQuantity: 100,
    originalQuantity: 100,
    originalInvestedValue: 10000,
    quantity: 50,
    partialExits: [{ date: "2026-07-10", time: "09:17 IST", price: 110, quantity: 50 }],
    addOns: [],
    exitDate: "2026-07-15",
    exitTime: "09:17 IST",
    exitPrice: 120
  };
  applyTradeChargeAccounting(trade, discountConfig);
  assert.equal(trade.chargeSummary.grossRealizedPnl, 1500);
  assert.ok(trade.pnl < 1500);
  assert.equal(trade.pnl, trade.chargeSummary.netRealizedPnl);
  assert.equal(trade.partialExits[0].pnl, trade.partialExits[0].netPnl);
  assert.equal(trade.transactions.length, 3);
});

test("open unrealized P&L includes buy charges and estimated delivery sell charges", () => {
  const trade = {
    status: "OPEN",
    entryDate: "2026-07-01",
    entryPrice: 100,
    initialEntryPrice: 100,
    initialQuantity: 100,
    originalQuantity: 100,
    originalInvestedValue: 10000,
    quantity: 100,
    lastPrice: 105,
    partialExits: [],
    addOns: []
  };
  applyTradeChargeAccounting(trade, discountConfig, 105);
  assert.equal(trade.chargeSummary.grossUnrealizedPnl, 500);
  assert.ok(trade.unrealizedPnl < 500);
  assert.ok(trade.estimatedExitCharges > 0);
  assert.equal(trade.unrealizedPnl, trade.chargeSummary.netUnrealizedPnl);
});
