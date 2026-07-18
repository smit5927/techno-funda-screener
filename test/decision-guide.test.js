import assert from "node:assert/strict";
import test from "node:test";
import { buildDecisionGuide } from "../public/decision-guide.js";

function strongRow(overrides = {}) {
  return {
    status: "ENTRY",
    close: 120,
    weeklyRs: 0.3,
    dailyLongRs: 0.2,
    dailyShortRs: 0.1,
    dailyRsi: 62,
    dailySupertrend: 108,
    signalReason: ["Weekly and daily leadership are positive."],
    entryStyle: { type: "BREAKOUT_BUY" },
    setupStrength: {
      values: {
        priorRecentHigh: 118,
        smaFast: 112,
        smaSlow: 100,
        fourCandleLow: 109,
        atr: 5
      }
    },
    ...overrides
  };
}

test("healthy open winner has no fixed profit target and rides the trend", () => {
  const guide = buildDecisionGuide(strongRow(), {
    status: "OPEN",
    entryPrice: 100,
    initialStopPrice: 94,
    trailingStopPrice: 108,
    addOns: []
  });
  assert.equal(guide.label, "RIDE TREND");
  assert.match(guide.levels[1].note, /No fixed profit target/i);
  assert.equal(guide.levels[2].value, "Rs 108.00");
  assert.equal(guide.levels[3].value, "Rs 108.00 - Rs 113.00");
  assert.equal(guide.levels[0].note, "Actual average/base fill price.");
});

test("pending partial exit explains the reduction without presenting a full exit", () => {
  const guide = buildDecisionGuide(strongRow(), {
    status: "PENDING_PARTIAL_EXIT",
    entryPrice: 100,
    trailingStopPrice: 108,
    pendingPartialExitPct: 50,
    pendingPartialExitReason: ["Two-close deterioration is confirmed."]
  });
  assert.equal(guide.label, "PARTIAL EXIT");
  assert.match(guide.summary, /Two-close deterioration/);
  assert.match(guide.levels[1].value, /50%/);
});

test("cash constrained candidate shows waiting reason and reference entry band", () => {
  const guide = buildDecisionGuide(strongRow(), null, {
    status: "WAITING_CAPITAL",
    latestClose: 120,
    plannedStopPrice: 108,
    skipReason: "Available portfolio cash is insufficient for a new position."
  });
  assert.equal(guide.label, "WAIT FOR FUNDS");
  assert.match(guide.summary, /cash is insufficient/i);
  assert.match(guide.levels[0].value, /Rs 118.00/);
});

test("pending pyramid add is shown as an add-winner decision", () => {
  const guide = buildDecisionGuide(strongRow(), {
    status: "OPEN",
    entryPrice: 100,
    trailingStopPrice: 108,
    pendingAdd: { reason: ["Fresh close above the post-entry pullback swing high."] }
  });
  assert.equal(guide.label, "ADD WINNER");
  assert.match(guide.summary, /swing high/i);
});

test("pending controlled retest is clearly separated from winner pyramiding", () => {
  const guide = buildDecisionGuide(strongRow({ close: 97 }), {
    status: "OPEN",
    entryPrice: 98,
    initialEntryPrice: 100,
    trailingStopPrice: 94,
    pendingAdd: {
      kind: "CONTROLLED_RETEST",
      reason: ["Support and reclaim confirmation completed inside the 0.25R to 0.75R band."]
    }
  });
  assert.equal(guide.label, "ADD RETEST");
  assert.match(guide.summary, /Support and reclaim/i);
});
