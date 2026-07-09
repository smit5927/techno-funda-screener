import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateRelativeStrength,
  calculateRsi,
  calculateSupertrend,
  latestValue
} from "../src/indicators.js";
import { aggregateDailyToCompletedWeeks } from "../src/yahoo.js";

test("daily candles aggregate only into completed weeks", () => {
  const candles = [
    candle("2026-06-26", 100, 102, 98, 101, 10),
    candle("2026-06-29", 101, 106, 100, 105, 20),
    candle("2026-07-03", 105, 109, 104, 108, 30),
    candle("2026-07-06", 108, 112, 107, 111, 40)
  ];
  const weekly = aggregateDailyToCompletedWeeks(
    candles,
    new Date("2026-07-07T05:00:00Z")
  );

  assert.equal(weekly.length, 2);
  assert.equal(weekly[1].date, "2026-06-29");
  assert.equal(weekly[1].open, 101);
  assert.equal(weekly[1].high, 109);
  assert.equal(weekly[1].low, 100);
  assert.equal(weekly[1].close, 108);
  assert.equal(weekly[1].volume, 50);
});

test("Friday candle becomes a completed week after market close", () => {
  const candles = [
    candle("2026-07-06", 100, 103, 99, 102, 10),
    candle("2026-07-10", 102, 106, 101, 105, 20)
  ];
  const weekly = aggregateDailyToCompletedWeeks(
    candles,
    new Date("2026-07-10T11:00:00Z")
  );
  assert.equal(weekly.length, 1);
  assert.equal(weekly[0].close, 105);
});

test("RS is zero when stock and benchmark have identical returns", () => {
  const stock = Array.from({ length: 30 }, (_, index) =>
    candle(`2026-01-${String(index + 1).padStart(2, "0")}`, 100 + index, 0, 0, 100 + index, 1)
  );
  const benchmark = stock.map((item) => ({ ...item }));
  const rs = calculateRelativeStrength(stock, benchmark, 21);
  assert.equal(latestValue(rs), 0);
});

test("RSI and Supertrend produce finite values on sufficient history", () => {
  const candles = Array.from({ length: 80 }, (_, index) => {
    const close = 100 + index * 0.5 + Math.sin(index / 3);
    return candle(
      new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
      close - 0.2,
      close + 1,
      close - 1,
      close,
      1000 + index
    );
  });

  assert.ok(Number.isFinite(latestValue(calculateRsi(candles, 14))));
  assert.ok(Number.isFinite(latestValue(calculateSupertrend(candles, 10, 3))));
});

function candle(date, open, high, low, close, volume) {
  return {
    date,
    time: new Date(`${date}T00:00:00Z`).getTime(),
    open,
    high,
    low,
    close,
    volume
  };
}
