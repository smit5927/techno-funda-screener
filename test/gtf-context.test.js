import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateCompletedCalendarCandles,
  buildGtfContext,
  detectGtfZones
} from "../src/gtf-context.js";
import { candidateRank, structuralStop } from "../src/portfolio-engine.js";
import { sameExecutionSlot } from "../src/trade-journal.js";

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

test("GTF remains additive to rank but cannot replace the video-derived structural stop", () => {
  const candles = demandFixture();
  const close = candles.at(-1).close;
  const gtfContext = buildGtfContext(candles, [], close);
  const baseRow = strongRow();
  const enhanced = { ...baseRow, gtfContext };

  assert.equal(gtfContext.dataAvailable, true);
  assert.ok(gtfContext.score >= 3);
  assert.ok(candidateRank(enhanced) > candidateRank(baseRow));
  assert.equal(structuralStop(enhanced, close, {}), structuralStop(baseRow, close, {}));
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

test("calendar aggregation excludes the still-forming higher-timeframe candle", () => {
  const daily = [
    candle(Date.UTC(2026, 0, 2), 100, 102, 99, 101),
    candle(Date.UTC(2026, 0, 30), 101, 104, 100, 103),
    candle(Date.UTC(2026, 1, 2), 103, 105, 102, 104)
  ];
  const monthly = aggregateCompletedCalendarCandles(daily, "monthly");

  assert.equal(monthly.length, 1);
  assert.equal(monthly[0].date, "2026-01-30");
  assert.equal(monthly[0].open, 100);
  assert.equal(monthly[0].close, 103);
});

test("GTF RHTF is a labelled secondary confirmation and cannot become a primary trigger", () => {
  const daily = htfReactionFixture();
  const weekly = Array.from({ length: 70 }, (_, index) =>
    candle(Date.UTC(2024, 0, 5 + index * 7), 90 + index, 92 + index, 89 + index, 91 + index)
  );
  const context = buildGtfContext(daily, weekly, daily.at(-1).close);

  assert.equal(context.reactingFromHtf.active, true);
  assert.equal(context.reactingFromHtf.role, "SECONDARY_CONFLUENCE_ONLY");
  assert.equal(context.reactingFromHtf.sourceStatus, "PROXY_UNVALIDATED");
  assert.equal(context.reactingFromHtf.managementClass, "HTF_REACTION_2R_FOLLOWUPS");
});

test("quality rotation buy must share the sell execution date and 09:17 slot", () => {
  const sell = { exitDate: "2026-07-13", exitTime: "09:17 IST" };
  assert.equal(sameExecutionSlot(sell, { date: "2026-07-13", timeLabel: "09:17 IST" }), true);
  assert.equal(sameExecutionSlot(sell, { date: "2026-07-14", timeLabel: "09:17 IST" }), false);
  assert.equal(sameExecutionSlot(sell, { date: "2026-07-13", timeLabel: "09:18 IST" }), false);
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

function htfReactionFixture() {
  const rows = [];
  addMonth(rows, 2025, 1, 120, 121, 99, 100);
  addMonth(rows, 2025, 2, 100.5, 103, 100, 101.5);
  addMonth(rows, 2025, 3, 102, 125, 101, 124);
  for (let month = 4; month <= 12; month += 1) {
    const base = 123 + month;
    addMonth(rows, 2025, month, base, base + 3, base - 1, base + 2);
  }
  for (let month = 1; month <= 6; month += 1) {
    const base = 135 + month;
    addMonth(rows, 2026, month, base, base + 3, base - 1, base + 2);
  }
  addMonth(rows, 2026, 7, 145, 150, 100.5, 149);
  return rows.sort((a, b) => a.time - b.time);
}

function addMonth(rows, year, month, open, high, low, close) {
  const days = [2, 5, 8, 11];
  for (let index = 0; index < days.length; index += 1) {
    const progress = index / (days.length - 1);
    const value = open + (close - open) * progress;
    rows.push(candle(
      Date.UTC(year, month - 1, days[index]),
      index === 0 ? open : value,
      index === 1 ? high : Math.max(value, open, close) + 0.2,
      index === 1 ? low : Math.min(value, open, close) - 0.2,
      index === days.length - 1 ? close : value
    ));
  }
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
