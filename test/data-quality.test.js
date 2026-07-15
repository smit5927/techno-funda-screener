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
