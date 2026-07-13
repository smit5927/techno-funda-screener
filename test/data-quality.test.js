import assert from "node:assert/strict";
import test from "node:test";
import { classifyScanFailure, resolvePriceHistory } from "../src/screener.js";

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
