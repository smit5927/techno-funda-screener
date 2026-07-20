import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateRelativeStrength,
  calculateMacd,
  calculateObv,
  calculateRsi,
  calculateSupertrend,
  latestValue
} from "../src/indicators.js";
import { analyzeDeliveryHistory } from "../src/institutional-context.js";
import { buildWeeklyEmaContext } from "../src/screener.js";
import {
  applyExecutionPriceCorrection,
  rowPassesTradeQuality,
  tradeSettingsSummary
} from "../src/trade-journal.js";
import {
  aggregateDailyToCompletedWeeks,
  backfillNifty500Benchmark,
  fetchNifty500ArchiveCandle,
  parseNifty500ArchiveCandle,
  selectNextTradingSessionExecutionCandle
} from "../src/yahoo.js";

test("official NSE archive fills a missing NIFTY 500 completed close", async () => {
  const yahoo = [candle("2026-07-13", 23300, 23400, 23200, 23347.05, 1)];
  const official = candle("2026-07-14", 23235.25, 23287.45, 23167.85, 23199.45, 1);
  const merged = await backfillNifty500Benchmark(yahoo, {
    now: new Date("2026-07-15T03:00:00Z"),
    archiveLoader: async (date) => date === "2026-07-14" ? official : null
  });

  assert.equal(merged.length, 2);
  assert.equal(merged.at(-1).date, "2026-07-14");
  assert.equal(merged.at(-1).close, 23199.45);
});

test("temporary NSE archive outage does not stop the screener", async () => {
  const yahoo = [candle("2026-07-13", 23300, 23400, 23200, 23347.05, 1)];
  const warnings = [];
  const merged = await backfillNifty500Benchmark(yahoo, {
    now: new Date("2026-07-15T03:00:00Z"),
    archiveLoader: async () => {
      throw new Error("NSE index archive failed 503 Service Unavailable");
    },
    onArchiveError: (warning) => warnings.push(warning)
  });

  assert.deepEqual(merged, yahoo);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /503 Service Unavailable/);
});

test("NSE index archive retries a temporary 503 response", async () => {
  let calls = 0;
  const csv = [
    "Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,Volume",
    "Nifty 500,14-07-2026,23235.25,23287.45,23167.85,23199.45,2142190771"
  ].join("\n");
  const candle = await fetchNifty500ArchiveCandle("2026-07-14", {
    attempts: 2,
    fetcher: async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, status: 503, statusText: "Service Unavailable" }
        : { ok: true, status: 200, statusText: "OK", text: async () => csv };
    }
  });

  assert.equal(calls, 2);
  assert.equal(candle.close, 23199.45);
});

test("NSE index archive parser selects the NIFTY 500 row", () => {
  const csv = [
    "Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,Volume",
    "Nifty 50,14-07-2026,24068,24157.1,24023.7,24052.05,355829008",
    "Nifty 500,14-07-2026,23235.25,23287.45,23167.85,23199.45,2142190771"
  ].join("\n");
  const parsed = parseNifty500ArchiveCandle(csv);

  assert.equal(parsed.date, "2026-07-14");
  assert.equal(parsed.close, 23199.45);
  assert.equal(parsed.source, "NSE index closing archive");
});

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
  const macd = calculateMacd(candles);
  assert.ok(Number.isFinite(latestValue(macd.macd)));
  assert.ok(Number.isFinite(latestValue(macd.signal)));
  assert.ok(latestValue(calculateObv(candles)) > 0);
});

test("official delivery history confirms operator accumulation only with price and participation", () => {
  const history = [
    { date: "2026-07-10", previousClose: 100, close: 104, averagePrice: 102, tradedQuantity: 2000, deliveryQuantity: 1200, deliveryPct: 60 },
    { date: "2026-07-09", tradedQuantity: 1000, deliveryQuantity: 500 },
    { date: "2026-07-08", tradedQuantity: 1000, deliveryQuantity: 500 },
    { date: "2026-07-07", tradedQuantity: 1000, deliveryQuantity: 500 }
  ];
  const result = analyzeDeliveryHistory(history, 1.2);
  assert.equal(result.accumulation, true);
  assert.equal(result.distribution, false);
  assert.equal(result.tradedQuantityRatio, 2);
  assert.equal(result.deliveryQuantityRatio, 2.4);
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

test("a 09:17 market order uses the first actual traded candle in the controlled opening window", () => {
  const candles = [
    openingCandle("2026-07-13", 9, 15, 100),
    openingCandle("2026-07-13", 9, 18, 102)
  ];
  const fill = selectNextTradingSessionExecutionCandle(candles, "2026-07-10");
  assert.equal(fill.minutes, 9 * 60 + 18);
  assert.equal(fill.open, 102);
});

test("weekly EMA13 uses completed weekly lows and identifies a close reclaim", () => {
  const stable = Array.from({ length: 13 }, (_, index) => {
    const date = new Date("2026-01-05T00:00:00Z");
    date.setUTCDate(date.getUTCDate() + index * 7);
    return candle(date.toISOString().slice(0, 10), 100, 101, 99, 100, 10);
  });
  const broken = buildWeeklyEmaContext([
    ...stable,
    candle("2026-04-06", 100, 101, 89, 90, 10)
  ]);
  assert.equal(broken.source, "low");
  assert.ok(Math.abs(broken.ema - 97.57142857142857) < 1e-10);
  assert.equal(broken.above, false);
  assert.equal(broken.consecutiveBelow, 1);
  assert.equal(broken.reclaim, false);

  const reclaimed = buildWeeklyEmaContext([
    ...stable,
    candle("2026-04-06", 100, 101, 89, 90, 10),
    candle("2026-04-13", 91, 106, 90, 105, 10)
  ]);
  assert.equal(reclaimed.above, true);
  assert.equal(reclaimed.reclaim, true);
  assert.equal(reclaimed.consecutiveBelow, 0);
});

test("weekly EMA13 decision differs from a close-source EMA and follows Low input", () => {
  const stable = Array.from({ length: 13 }, (_, index) => {
    const date = new Date("2026-01-05T00:00:00Z");
    date.setUTCDate(date.getUTCDate() + index * 7);
    return candle(date.toISOString().slice(0, 10), 95, 101, 90, 100, 10);
  });
  const context = buildWeeklyEmaContext([
    ...stable,
    candle("2026-04-06", 90, 92, 80, 91, 10)
  ]);

  assert.equal(context.source, "low");
  assert.ok(Math.abs(context.ema - 88.57142857142857) < 1e-10);
  assert.equal(context.close, 91);
  assert.equal(context.above, true);
});

test("weekly low-source EMA13 remains unavailable until 13 completed weeks exist", () => {
  const context = buildWeeklyEmaContext([
    candle("2026-01-05", 95, 101, 90, 100, 10),
    candle("2026-01-12", 96, 102, 91, 101, 10)
  ]);

  assert.equal(context.source, "low");
  assert.equal(context.ema, null);
  assert.equal(context.above, null);
});

test("a missing execution window cannot be replaced with a later session's fictional fill", () => {
  const candles = [
    openingCandle("2026-07-13", 9, 15, 100),
    openingCandle("2026-07-14", 9, 17, 103)
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
