import test from "node:test";
import assert from "node:assert/strict";

import { buildGtfContext, detectGtfZones } from "../src/gtf-context.js";
import { candidateRank, structuralStop } from "../src/portfolio-engine.js";

test("detects a fresh score-7 GTF demand zone with achievement", () => {
  const candles = demandFixture();
  const demand = detectGtfZones(candles, { timeframe: "daily" })
    .find((zone) => zone.side === "demand" && zone.legoutDate === "2026-03-01");

  assert.ok(demand);
  assert.equal(demand.pattern, "DBR");
  assert.equal(demand.freshnessTests, 0);
  assert.equal(demand.score, 7);
  assert.ok(demand.achievementR >= 1);
  assert.equal(demand.active, true);
});

test("GTF remains additive while improving rank and structural stop", () => {
  const candles = demandFixture();
  const close = candles.at(-1).close;
  const gtfContext = buildGtfContext(candles, [], close);
  const baseRow = strongRow();
  const enhanced = { ...baseRow, gtfContext };

  assert.equal(gtfContext.dataAvailable, true);
  assert.ok(gtfContext.score >= 3);
  assert.ok(candidateRank(enhanced) > candidateRank(baseRow));
  assert.ok(structuralStop(enhanced, close, {}) >= structuralStop(baseRow, close, {}));
});

test("nearby active GTF supply creates a blocker and rank penalty", () => {
  const neutral = strongRow();
  const blocked = {
    ...neutral,
    gtfContext: {
      dataAvailable: true,
      score: 2,
      rankAdjustment: -10,
      supplyBlocked: true,
      checks: { roomForTwoR: false }
    }
  };

  assert.ok(candidateRank(blocked) < candidateRank(neutral));
});

function demandFixture() {
  const candles = [];
  const start = Date.UTC(2026, 0, 1);
  for (let index = 0; index < 57; index += 1) {
    const close = 90 + index * 0.35;
    candles.push(candle(start + index * 86_400_000, close - 0.4, close + 0.8, close - 0.8, close));
  }
  candles.push(candle(Date.UTC(2026, 1, 27), 111, 112, 103, 104));
  candles.push(candle(Date.UTC(2026, 1, 28), 104, 105, 103.5, 104.5));
  candles.push(candle(Date.UTC(2026, 2, 1), 104.5, 113, 104, 112));
  candles.push(candle(Date.UTC(2026, 2, 2), 112, 116, 111, 115));
  candles.push(candle(Date.UTC(2026, 2, 3), 115, 117, 113, 116));
  candles.push(candle(Date.UTC(2026, 2, 4), 116, 117, 109, 110));
  return candles;
}

function candle(time, open, high, low, close) {
  const date = new Date(time).toISOString().slice(0, 10);
  return { time, date, open, high, low, close, volume: 1_000_000 };
}

function strongRow() {
  return {
    setupGrade: "A",
    weeklyRs: 0.12,
    dailyLongRs: 0.08,
    dailyShortRs: 0.04,
    setupStrengthScore: 12,
    fundamentalScore: 4,
    entryStyle: { type: "BREAKOUT_BUY" },
    institutionalContext: { score: 3 },
    conceptCoverage: { applicable: 20, passed: 15, dataGaps: 0 },
    setupStrength: {
      checks: {
        weeklyRsRising: true,
        dailyLongRsRising: true,
        closeAboveSmaFast: true,
        closeAboveSmaSlow: true,
        smaFastAboveSlow: true,
        volumeExpansion: true,
        bullishCandleConfirmation: true,
        marketRegimeStrong: true
      },
      values: {
        fourCandleLow: 104,
        twoCandleLow: 106,
        atrPct: 3,
        riskToSupertrendPct: 4
      }
    }
  };
}
