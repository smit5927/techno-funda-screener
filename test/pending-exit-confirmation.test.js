import assert from "node:assert/strict";
import test from "node:test";
import { cancelInvalidPendingModelExit } from "../src/trade-journal.js";

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

test("confirmed or material RS55 pending exit remains scheduled", () => {
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
  assert.equal(cancelInvalidPendingModelExit(confirmed, row, { trade: {} }).cancelled, false);
  assert.equal(confirmed.status, "PENDING_EXIT");

  const material = { ...base, dailyLongRsBelowZeroDates: ["2026-07-16"] };
  assert.equal(
    cancelInvalidPendingModelExit(material, { ...row, dailyLongRs: -0.11 }, { trade: {} }).cancelled,
    false
  );
});
