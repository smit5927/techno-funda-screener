import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLegacyStructuralStopUpgrade,
  cancelInvalidPendingModelExit
} from "../src/trade-journal.js";

test("healthy MAYURUNIQ-like legacy holding migrates off the old daily stop before exit", () => {
  const trade = {
    id: "MAYURUNIQ-test",
    symbol: "MAYURUNIQ",
    status: "PENDING_EXIT",
    exitType: "MODEL_EXIT",
    exitSignalDate: "2026-07-20",
    exitReason: ["Daily close 794.55 breached original structural stop 805.6."],
    entryDate: "2026-07-14",
    entryPrice: 853,
    initialEntryPrice: 853,
    quantity: 68,
    originalQuantity: 68,
    initialStopPrice: 805.6,
    trailingStopPrice: 805.6,
    managementCloseDates: ["2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-20"],
    partialExitTags: []
  };
  const row = {
    asOf: "2026-07-20",
    close: 794.55,
    weeklyClose: 785.25,
    weeklyEma13: 702.02,
    weeklyEma13Source: "low",
    weeklyAtr: 34,
    weeklyPriceAboveEma13: true,
    weeklyRs: 0.48,
    dailyLongRs: 0.47,
    dailyShortRs: 0.04,
    dailyRsi: 61,
    dailySupertrend: 780.78,
    setupStrength: { checks: {}, values: {} }
  };

  const migration = applyLegacyStructuralStopUpgrade(
    trade,
    row,
    { trade: { totalCapital: 1_000_000, riskPerTradePct: 1 } },
    "2026-07-20T16:30:00.000Z"
  );

  assert.equal(migration.upgraded, true);
  assert.equal(trade.initialStopMigration.previousStopPrice, 805.6);
  assert.equal(trade.initialStopSource, "WEEKLY_EMA13_LOW");
  assert.ok(trade.initialStopPrice < row.close);
  assert.ok(migration.currentStopRisk <= migration.maximumStopRisk);
  assert.equal(cancelInvalidPendingModelExit(trade, row, { trade: {} }).cancelled, true);
  assert.equal(trade.status, "OPEN");
});

test("published 09:17 exit is not silently changed by a stop-policy migration", () => {
  const trade = {
    status: "PENDING_EXIT",
    exitOrderState: "CONFIRMED_FOR_0917",
    entryPrice: 100,
    quantity: 100,
    initialStopPrice: 95,
    trailingStopPrice: 95
  };
  const row = {
    close: 94,
    weeklyClose: 94,
    weeklyEma13: 85,
    weeklyEma13Source: "low",
    weeklyAtr: 4,
    weeklyPriceAboveEma13: true,
    weeklyRs: 0.2,
    dailyLongRs: 0.1,
    dailySupertrend: 90,
    setupStrength: { values: {} }
  };

  const migration = applyLegacyStructuralStopUpgrade(trade, row, { trade: {} });

  assert.equal(migration.upgraded, false);
  assert.equal(trade.initialStopPrice, 95);
});

test("a legacy marginal RS55 pending exit is cancelled before 09:17 execution", () => {
  const trade = {
    id: "PRUDENT-test",
    symbol: "PRUDENT",
    status: "PENDING_EXIT",
    exitType: "MODEL_EXIT",
    exitSignalDate: "2026-07-16",
    exitReason: ["Completed-close daily long RS55 is below zero."],
    entryDate: "2026-07-10",
    entryPrice: 2986,
    quantity: 17,
    initialStopPrice: 2750,
    trailingStopPrice: 2750,
    dailyLongRsBelowZeroDates: ["2026-07-16"],
    managementCloseDates: ["2026-07-10", "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16"],
    rotationReview: { qualificationVersion: 3, weakCloseDates: ["2026-07-16"] },
    partialExitTags: []
  };
  const row = {
    asOf: "2026-07-16",
    close: 2863.7,
    weeklyRs: 0.13,
    dailyLongRs: -0.014,
    dailyShortRs: -0.07,
    dailyRsi: 44.22,
    dailySupertrend: 2759.71,
    weeklyPriceAboveEma13: true,
    weeklyClose: 2983.2,
    weeklyEma13: 2827.41,
    setupGrade: "WATCH",
    setupStrength: { checks: {}, values: { smaFast: 2851.27, smaSlow: 2611.03 } }
  };

  const result = cancelInvalidPendingModelExit(trade, row, { trade: {} });

  assert.equal(result.cancelled, true);
  assert.equal(trade.status, "OPEN");
  assert.equal(trade.exitSignalDate, null);
  assert.equal(trade.cancelledExitSignals.length, 1);
  assert.match(trade.riskActionNote, /balanced confirmation policy/i);
});

test("confirmed RS55 without price damage cancels full exit while material damage remains scheduled", () => {
  const base = {
    status: "PENDING_EXIT",
    exitType: "MODEL_EXIT",
    exitSignalDate: "2026-07-16",
    entryDate: "2026-07-10",
    entryPrice: 100,
    quantity: 100,
    initialStopPrice: 90,
    trailingStopPrice: 90,
    managementCloseDates: ["2026-07-16"],
    partialExitTags: []
  };
  const row = {
    asOf: "2026-07-16",
    close: 98,
    weeklyRs: 0.2,
    dailyLongRs: -0.02,
    dailyShortRs: 0.1,
    dailyRsi: 55,
    dailySupertrend: 92,
    weeklyPriceAboveEma13: true,
    setupStrength: { checks: {}, values: {} }
  };
  const confirmed = {
    ...base,
    dailyLongRsBelowZeroDates: ["2026-07-15", "2026-07-16"]
  };
  assert.equal(cancelInvalidPendingModelExit(confirmed, row, { trade: {} }).cancelled, true);
  assert.equal(confirmed.status, "OPEN");

  const material = { ...base, dailyLongRsBelowZeroDates: ["2026-07-16"] };
  assert.equal(
    cancelInvalidPendingModelExit(material, { ...row, dailyLongRs: -0.11 }, { trade: {} }).cancelled,
    false
  );
});
