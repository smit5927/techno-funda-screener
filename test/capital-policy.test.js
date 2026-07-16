import assert from "node:assert/strict";
import test from "node:test";
import { flowAdjustedReturn, resolveCapitalChange } from "../supabase/functions/techno-funda-app-api/capital-policy.js";

const summary = {
  totalCapital: 1_000_000,
  availableCash: 160_000,
  totalEquity: 1_025_000,
  realizedPnl: 10_000,
  unrealizedPnl: 15_000
};

test("capital can be removed only from available free cash", () => {
  const change = resolveCapitalChange({
    previousCapital: 1_000_000,
    removeCapital: 150_000,
    portfolioSummary: summary
  });
  assert.equal(change.type, "CAPITAL_REMOVED");
  assert.equal(change.totalCapital, 850_000);
  assert.equal(change.withdrawalLimit, 160_000);
  assert.equal(change.event.type, "CAPITAL_REMOVED");
  assert.ok(change.event.unitsAfterFlow < change.event.unitsBeforeFlow);
});

test("capital withdrawal above available cash gives the exact reason", () => {
  assert.throws(
    () => resolveCapitalChange({
      previousCapital: 1_000_000,
      removeCapital: 200_000,
      portfolioSummary: summary
    }),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /exceeds available free cash Rs 1,60,000/);
      assert.match(error.message, /deployed, reserved, or unavailable/);
      return true;
    }
  );
});

test("lowering total capital manually cannot bypass withdrawal validation", () => {
  assert.throws(
    () => resolveCapitalChange({
      previousCapital: 1_000_000,
      requestedCapital: 700_000,
      portfolioSummary: summary
    }),
    /Requested withdrawal Rs 3,00,000 exceeds available free cash/
  );
});

test("stale portfolio summary is adjusted after capital was added", () => {
  const change = resolveCapitalChange({
    previousCapital: 1_100_000,
    removeCapital: 250_000,
    portfolioSummary: summary
  });
  assert.equal(change.availableCash, 260_000);
  assert.equal(change.totalCapital, 850_000);
});

test("add and remove cannot be submitted together", () => {
  assert.throws(
    () => resolveCapitalChange({ previousCapital: 1_000_000, addCapital: 10_000, removeCapital: 10_000 }),
    /cannot be used together/
  );
});

test("minimum capital remains protected", () => {
  assert.throws(
    () => resolveCapitalChange({ previousCapital: 20_000, removeCapital: 15_000, portfolioSummary: { totalCapital: 20_000, availableCash: 20_000 } }),
    /At least Rs 10,000 total capital must remain/
  );
});

test("flow-adjusted NAV return is unchanged immediately after deposit", () => {
  const change = resolveCapitalChange({
    previousCapital: 1_000_000,
    addCapital: 200_000,
    portfolioSummary: summary
  });
  const before = 25_000 / 1_000_000 * 100;
  const after = flowAdjustedReturn({ totalCapital: 1_200_000, netPnl: 25_000, capitalHistory: [change.event] });
  assert.ok(Math.abs(after - before) < 0.000001);
});
