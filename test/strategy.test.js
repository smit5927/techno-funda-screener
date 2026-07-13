import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateRelativeStrength,
  calculateRsi,
  calculateSupertrend,
  latestValue
} from "../src/indicators.js";
import {
  applyExecutionPriceCorrection,
  rowPassesTradeQuality,
  tradeSettingsSummary
} from "../src/trade-journal.js";
import {
  aggregateDailyToCompletedWeeks,
  selectNextTradingSessionExecutionCandle
} from "../src/yahoo.js";

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

test("trade settings default to all-market best-only mode", () => {
  const settings = tradeSettingsSummary({ trade: {} });
  assert.equal(settings.scopeListId, "all-market");
  assert.equal(settings.qualityMode, "BEST_ONLY");
});

test("best-only trade quality accepts only A+ and A entries", () => {
  const settings = { qualityMode: "BEST_ONLY" };
  assert.equal(rowPassesTradeQuality({ setupGrade: "A+" }, settings), true);
  assert.equal(rowPassesTradeQuality({ setupGrade: "A" }, settings), true);
  assert.equal(rowPassesTradeQuality({ setupGrade: "B" }, settings), false);
  assert.equal(rowPassesTradeQuality({ setupGrade: "C" }, settings), false);
});

test("trade quality modes can loosen to strong or all entries", () => {
  assert.equal(rowPassesTradeQuality({ setupGrade: "B" }, { qualityMode: "STRONG_OR_BETTER" }), true);
  assert.equal(rowPassesTradeQuality({ setupGrade: "C" }, { qualityMode: "STRONG_OR_BETTER" }), false);
  assert.equal(rowPassesTradeQuality({ setupGrade: "C" }, { qualityMode: "ALL_ENTRIES" }), true);
});

test("Friday closing signal fills at Monday 09:17 instead of the market open", () => {
  const candles = [
    openingCandle("2026-07-10", 9, 15, 100),
    openingCandle("2026-07-13", 9, 15, 104),
    openingCandle("2026-07-13", 9, 17, 104.75),
    openingCandle("2026-07-13", 9, 18, 105)
  ];

  const fill = selectNextTradingSessionExecutionCandle(candles, "2026-07-10");
  assert.equal(fill.date, "2026-07-13");
  assert.equal(fill.minutes, 9 * 60 + 17);
  assert.equal(fill.open, 104.75);
});

test("market holiday is skipped until the next actual 09:17 session candle", () => {
  const candles = [
    openingCandle("2026-08-14", 9, 17, 250),
    // 17 August is intentionally absent to model an exchange holiday.
    openingCandle("2026-08-18", 9, 17, 257)
  ];

  const fill = selectNextTradingSessionExecutionCandle(candles, "2026-08-14");
  assert.equal(fill.date, "2026-08-18");
  assert.equal(fill.open, 257);
});

test("pending order remains unfilled when no later market session candle exists", () => {
  const candles = [openingCandle("2026-07-10", 9, 17, 100)];
  assert.equal(selectNextTradingSessionExecutionCandle(candles, "2026-07-10"), null);
});

test("09:15 and 09:18 prices cannot substitute for a missing exact 09:17 fill", () => {
  const candles = [
    openingCandle("2026-07-13", 9, 15, 100),
    openingCandle("2026-07-13", 9, 18, 102)
  ];
  assert.equal(selectNextTradingSessionExecutionCandle(candles, "2026-07-10"), null);
});

test("active legacy trade correction preserves an audit trail and recalculates capital risk", () => {
  const trade = {
    entryTime: "09:15 IST",
    entryPrice: 100,
    executionMethod: "09:15 five-minute candle open",
    quantity: 50,
    originalQuantity: 50,
    initialStopPrice: 95,
    entryReason: ["Execution plan uses the 09:15 five-minute candle open."],
    entrySnapshot: {
      signalReason: ["Fill in the 09:15-09:20 IST window."],
      conceptCoverage: { passLabels: ["09:15 execution discipline"] }
    },
    partialExits: []
  };
  applyExecutionPriceCorrection(
    trade,
    {
      price: 102.25,
      timeLabel: "09:17 IST",
      source: "09:17 one-minute candle open",
      window: "09:17 IST"
    },
    new Date("2026-07-13T04:00:00.000Z")
  );

  assert.equal(trade.entryPrice, 102.25);
  assert.equal(trade.entryTime, "09:17 IST");
  assert.equal(trade.investedValue, 5112.5);
  assert.equal(trade.initialRiskAmount, 362.5);
  assert.equal(trade.entryExecutionCorrection.previousPrice, 100);
  assert.match(trade.entryReason[0], /09:17 one-minute/);
  assert.equal(trade.entrySnapshot.signalReason[0], "Fill in the exact 09:17 IST execution time.");
  assert.equal(trade.entrySnapshot.conceptCoverage.passLabels[0], "09:17 execution discipline");
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

function openingCandle(date, hour, minute, open) {
  const time = new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+05:30`).getTime();
  return {
    date,
    time,
    minutes: hour * 60 + minute,
    open
  };
}
