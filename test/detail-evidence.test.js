import test from "node:test";
import assert from "node:assert/strict";
import { buildDetailEvidenceRow } from "../public/detail-evidence.js";

test("detail evidence uses current scalars and fills compact-row gaps from current snapshot", () => {
  const row = {
    symbol: "PRUDENT",
    status: "WATCH",
    close: 2981.7,
    dailyShortRs: -0.02
  };
  const trade = {
    entrySnapshot: {
      close: 2986,
      fundamental: { checks: { netIncomeYoYUp: true } },
      setupStrength: { checks: { baseBreakout: true }, values: { priorBaseHigh: 2900 } }
    },
    currentSnapshot: {
      asOf: "2026-07-14",
      close: 2981.7,
      fundamental: { checks: { netIncomeYoYUp: false, peRising: true } },
      gtfContext: { dataAvailable: true, score: 5, checks: { roomForTwoR: false } },
      institutionalContext: { score: 3, maxScore: 5 }
    }
  };

  const result = buildDetailEvidenceRow(row, trade);

  assert.equal(result.close, 2981.7);
  assert.equal(result.status, "WATCH");
  assert.equal(result.fundamental.checks.netIncomeYoYUp, false);
  assert.equal(result.fundamental.checks.peRising, true);
  assert.equal(result.setupStrength.checks.baseBreakout, true);
  assert.equal(result.gtfContext.checks.roomForTwoR, false);
  assert.equal(result.institutionalContext.score, 3);
});

test("detail evidence supports legacy trades with entry snapshot only", () => {
  const result = buildDetailEvidenceRow(
    { symbol: "RAIN", close: 208.95, weeklyRs: 0.44 },
    {
      entrySnapshot: {
        fundamental: { checks: { operatingIncomeYoYUp: true } },
        conceptCoverage: { passLabels: ["Weekly RS leadership"] }
      }
    }
  );

  assert.equal(result.symbol, "RAIN");
  assert.equal(result.close, 208.95);
  assert.equal(result.fundamental.checks.operatingIncomeYoYUp, true);
  assert.deepEqual(result.conceptCoverage.passLabels, ["Weekly RS leadership"]);
});

test("latest candidate snapshot fills non-actionable compact rows", () => {
  const result = buildDetailEvidenceRow(
    { symbol: "ABC", status: "WATCH", score: 8 },
    null,
    {
      latestSnapshot: {
        setupStrength: { checks: { volumeExpansion: true } },
        gtfContext: { dataAvailable: true, supplyBlocked: false }
      }
    }
  );

  assert.equal(result.score, 8);
  assert.equal(result.setupStrength.checks.volumeExpansion, true);
  assert.equal(result.gtfContext.supplyBlocked, false);
});
