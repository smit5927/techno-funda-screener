import assert from "node:assert/strict";
import test from "node:test";
import {
  remainingOpenLotPerformance,
  tradeSheetPositionPnl
} from "../public/pnl-accounting.js";

test("GRINDWELL remaining seven shares show their open profit without booked partial losses", () => {
  const entryPrice = 2048.2;
  const quantity = 7;
  const livePrice = 2135;
  const unrealizedPnl = (livePrice - entryPrice) * quantity;
  const result = remainingOpenLotPerformance(unrealizedPnl, entryPrice * quantity);

  assert.ok(Math.abs(result.pnl - 607.6) < 0.0001);
  assert.ok(result.pnlPct > 4.2);
  const tradeSheetPnl = tradeSheetPositionPnl({
    closed: false,
    finalRealizedPnl: -1561.2,
    unrealizedPnl
  });
  assert.ok(Math.abs(tradeSheetPnl - 607.6) < 0.0001);
});

test("closed trade sheet rows use final realized P&L", () => {
  assert.equal(tradeSheetPositionPnl({
    closed: true,
    finalRealizedPnl: -1561.2,
    unrealizedPnl: 607.6
  }), -1561.2);
});
