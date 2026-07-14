import assert from "node:assert/strict";
import test from "node:test";
import { validateReviews } from "../src/ai-decision-review.js";

test("AI review is bounded and cannot introduce an unscanned symbol", () => {
  const reviews = validateReviews([
    { symbol: "ABC", adjustment: 99, confidence: 4, summary: "confirmed", flags: ["one", "two", "three", "four"] },
    { symbol: "FAKE", adjustment: 2, confidence: 1, summary: "invented" }
  ], new Set(["ABC"]));
  assert.equal(reviews.size, 1);
  assert.equal(reviews.get("ABC").adjustment, 2);
  assert.equal(reviews.get("ABC").confidence, 1);
  assert.equal(reviews.get("ABC").flags.length, 3);
});
