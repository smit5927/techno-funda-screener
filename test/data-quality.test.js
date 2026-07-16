import assert from "node:assert/strict";
import test from "node:test";
import { classifyScanFailure, reconcileResultFreshness, resolvePriceHistory } from "../src/screener.js";

test("custom symbol falls back from unavailable NSE history to BSE", async () => {
  const calls = [];
  const result = await resolvePriceHistory("BRPL.NS", {
    allowBseFallback: true,
    fetcher: async (symbol) => {
      calls.push(symbol);
      if (symbol.endsWith(".NS")) throw new Error("Yahoo request failed 404 Not Found");
      return candles(220);
    }
  });

  assert.equal(result.yahooSymbol, "BRPL.BO");
  assert.deepEqual(calls, ["BRPL.NS", "BRPL.BO"]);
});

test("custom symbol prefers BSE when NSE listing history is too short", async () => {
  const result = await resolvePriceHistory("BIMETAL.NS", {
    allowBseFallback: true,
    fetcher: async (symbol) => symbol.endsWith(".NS") ? candles(40) : candles(220)
  });

  assert.equal(result.yahooSymbol, "BIMETAL.BO");
  assert.equal(result.candles.length, 220);
});

test("ready NSE history does not make an unnecessary BSE request", async () => {
  const calls = [];
  const result = await resolvePriceHistory("RELIANCE.NS", {
    allowBseFallback: true,
    fetcher: async (symbol) => {
      calls.push(symbol);
      return candles(220);
    }
  });

  assert.equal(result.yahooSymbol, "RELIANCE.NS");
  assert.deepEqual(calls, ["RELIANCE.NS"]);
});

test("unavailable exchange data is a data gap while transient failures remain errors", async () => {
  let unavailable;
  try {
    await resolvePriceHistory("MISSING.NS", {
      allowBseFallback: true,
      fetcher: async () => { throw new Error("Yahoo request failed 404 Not Found"); }
    });
  } catch (error) {
    unavailable = classifyScanFailure(error);
  }

  assert.equal(unavailable.status, "DATA_GAP");
  assert.equal(unavailable.code, "SYMBOL_UNAVAILABLE");
  assert.equal(classifyScanFailure(new Error("request timed out")).status, "ERROR");
});

test("an older provider candle cannot overwrite a newer completed close", () => {
  const previous = [{ symbol: "RAIN", asOf: "2026-07-14", status: "WATCH", dailyShortRs: -0.024 }];
  const current = [{ symbol: "RAIN", asOf: "2026-07-13", status: "ENTRY", dailyShortRs: 0.038, listId: "custom", listLabel: "My List" }];
  const [row] = reconcileResultFreshness(current, previous);
  assert.equal(row.asOf, "2026-07-14");
  assert.equal(row.status, "WATCH");
  assert.equal(row.dailyShortRs, -0.024);
  assert.deepEqual(row.dataFreshness, {
    status: "PRESERVED_NEWER_CLOSE",
    preservedAsOf: "2026-07-14",
    fetchedAsOf: "2026-07-13"
  });
});

test("an older provider row still enriches the preserved close with completed weekly EMA13 evidence", () => {
  const previous = [{
    symbol: "INGERRAND",
    asOf: "2026-07-15",
    status: "WATCH",
    dailyShortRs: -0.01,
    signalReason: ["Daily pullback watch."],
    setupStrength: { checks: {}, values: { previousLow: 4300 } }
  }];
  const current = [{
    symbol: "INGERRAND",
    asOf: "2026-07-14",
    weeklyAsOf: "2026-07-06",
    status: "EXIT",
    dailyShortRs: 0.02,
    weeklyClose: 4100,
    weeklyEma13: 4200,
    weeklyPriceAboveEma13: false,
    weeklyEma13Rising: true,
    weeklyEma13Reclaim: false,
    weeklyEma13BelowCloses: 1,
    exitChecks: { weeklyRs: false, weeklyEma13: true },
    signalReason: ["Completed weekly candle closed below EMA13; weekly momentum structure is broken."],
    setupStrength: {
      checks: { weeklyCloseAboveEma13: false, weeklyEma13Rising: true, weeklyEma13Reclaim: false },
      values: { weeklyClose: 4100, weeklyEma13: 4200, weeklyEma13Period: 13 }
    },
    listId: "custom",
    listLabel: "My List"
  }];

  const [row] = reconcileResultFreshness(current, previous);
  assert.equal(row.asOf, "2026-07-15");
  assert.equal(row.dailyShortRs, -0.01);
  assert.equal(row.weeklyEma13, 4200);
  assert.equal(row.setupStrength.values.previousLow, 4300);
  assert.equal(row.setupStrength.values.weeklyEma13, 4200);
  assert.equal(row.status, "EXIT");
  assert.match(row.signalReason.join(" "), /weekly.*EMA13/i);
});

test("a same-day or newer provider candle replaces the previous row", () => {
  const previous = [{ symbol: "RAIN", asOf: "2026-07-14", status: "WATCH" }];
  const current = [{ symbol: "RAIN", asOf: "2026-07-15", status: "ENTRY" }];
  assert.equal(reconcileResultFreshness(current, previous)[0], current[0]);
});

function candles(count) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(2024, 0, index + 1));
    return {
      date: date.toISOString().slice(0, 10),
      time: date.getTime(),
      open: 100 + index,
      high: 102 + index,
      low: 99 + index,
      close: 101 + index,
      volume: 1000 + index
    };
  });
}
