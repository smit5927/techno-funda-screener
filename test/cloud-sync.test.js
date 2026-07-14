import assert from "node:assert/strict";
import test from "node:test";
import { compactCloudState } from "../src/cloud-sync.js";

test("cloud state keeps portfolio data but removes thousands of detailed scan rows", () => {
  const state = {
    scannedAt: "2026-07-11T00:00:00.000Z",
    fullScanAt: "2026-07-11T00:00:00.000Z",
    executionPassAt: "2026-07-11T04:00:00.000Z",
    scanMode: "EXECUTION_PASS",
    summary: { total: 2384 },
    lists: {
      "all-market": {
        id: "all-market",
        label: "All NSE Market",
        summary: { total: 2384, entry: 500 },
        results: Array.from({ length: 2384 }, (_, index) => ({ symbol: `S${index}` }))
      }
    },
    portfolioSummary: { totalCapital: 1_000_000 },
    trades: [{ symbol: "ABC", status: "OPEN" }],
    waitingCandidates: [{ symbol: "XYZ" }],
    candidateDecisionLog: [{ symbol: "OLD", disposition: "EXPIRED" }]
  };
  const compact = compactCloudState(state);
  assert.equal(compact.lists["all-market"].summary.total, 2384);
  assert.equal(Object.hasOwn(compact.lists["all-market"], "results"), false);
  assert.equal(compact.portfolioSummary.totalCapital, 1_000_000);
  assert.equal(compact.trades.length, 1);
  assert.equal(compact.waitingCandidates.length, 1);
  assert.equal(compact.candidateDecisionLog.length, 1);
  assert.equal(compact.executionPassAt, state.executionPassAt);
  assert.equal(compact.scanMode, "EXECUTION_PASS");
  assert.ok(JSON.stringify(compact).length < 10_000);
});
