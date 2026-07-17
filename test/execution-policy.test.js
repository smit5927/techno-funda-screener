import test from "node:test";
import assert from "node:assert/strict";
import { executionAfterDate, isRetroactiveExecution } from "../src/execution-policy.js";

test("08:30 IST decision can use the same session 09:17 execution", () => {
  assert.equal(
    executionAfterDate("2026-07-15", "2026-07-16T03:00:00.000Z"),
    "2026-07-15"
  );
});

test("a post-09:17 order can never back-fill the elapsed execution candle", () => {
  assert.equal(
    executionAfterDate("2026-07-15", "2026-07-16T10:04:39.799Z"),
    "2026-07-16"
  );
});

test("weekend order uses the weekend date as the lower execution bound", () => {
  assert.equal(
    executionAfterDate("2026-07-17", "2026-07-18T10:00:00.000Z"),
    "2026-07-18"
  );
});

test("post-close order cannot claim an earlier 09:17 fill from that day", () => {
  assert.equal(
    isRetroactiveExecution("2026-07-16T10:04:39.799Z", "2026-07-16", "09:17 IST"),
    true
  );
  assert.equal(
    isRetroactiveExecution("2026-07-16T03:00:00.000Z", "2026-07-16", "09:17 IST"),
    false
  );
});
