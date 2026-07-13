import { simpleMovingAverage } from "./indicators.js";

const DEFAULTS = {
  baseBodyLimit: 0.495,
  significantGapPct: 1,
  maxBaseCandles: 3,
  entryBufferPct: 0.1,
  stopBufferPct: 0.4,
  maxSupportDistancePct: 8,
  supplyBlockDistancePct: 3,
  dirtyBaseWickRatio: 1.2,
  htfReactionLookbackDays: 5
};

export function buildGtfContext(dailyCandles = [], weeklyCandles = [], close, config = {}) {
  const rules = { ...DEFAULTS, ...(config || {}) };
  if (!Number.isFinite(close) || dailyCandles.length < 20) return emptyContext();

  const dailyZones = detectGtfZones(dailyCandles, { ...rules, timeframe: "daily" });
  const weeklyZones = detectGtfZones(weeklyCandles, { ...rules, timeframe: "weekly" });
  const htfFrames = Object.fromEntries(
    ["monthly", "quarterly", "half_yearly", "yearly"].map((timeframe) => [
      timeframe,
      aggregateCompletedCalendarCandles(dailyCandles, timeframe)
    ])
  );
  const htfZones = Object.fromEntries(
    Object.entries(htfFrames).map(([timeframe, candles]) => [
      timeframe,
      detectGtfZones(candles, { ...rules, timeframe })
    ])
  );
  const dailyTrend = smaTrend(dailyCandles);
  const weeklyTrend = smaTrend(weeklyCandles);
  const dailyDemand = selectDemand(dailyZones, close, rules.maxSupportDistancePct);
  const weeklyDemand = selectDemand(weeklyZones, close, rules.maxSupportDistancePct * 1.5);
  const dailySupply = selectSupply(dailyZones, close);
  const weeklySupply = selectSupply(weeklyZones, close);
  const htfSupply = Object.values(htfZones)
    .map((zones) => selectSupply(zones, close));
  const opposingSupply = nearestSupply([dailySupply, weeklySupply, ...htfSupply], close);
  const demandReference = bestDemand([dailyDemand, weeklyDemand], close);
  const reactingFromHtf = detectHtfDemandReaction({
    dailyCandles,
    dailyDemand,
    weeklyDemand,
    htfZones,
    close,
    dailyTrend,
    weeklyTrend,
    lookbackDays: rules.htfReactionLookbackDays
  });
  const demandRisk = demandReference ? close - demandReference.stopLoss : null;
  const rewardRoom = opposingSupply ? opposingSupply.proximal - close : null;
  const rewardRisk = Number.isFinite(demandRisk) && demandRisk > 0 && Number.isFinite(rewardRoom)
    ? rewardRoom / demandRisk
    : opposingSupply ? null : Infinity;
  const supplyDistancePct = opposingSupply && close > 0
    ? Math.max(0, (opposingSupply.distal - close) / close * 100)
    : null;
  const supplyBlocked = Boolean(
    opposingSupply &&
    (zoneContains(opposingSupply, close) || supplyDistancePct <= rules.supplyBlockDistancePct)
  );
  const dailyDemandQualified = zoneUsable(dailyDemand);
  const weeklyDemandQualified = zoneUsable(weeklyDemand);
  const dailyDemandFresh = zoneBest(dailyDemand);
  const weeklyDemandFresh = zoneBest(weeklyDemand);
  const demandRetest = Boolean(
    dailyDemandQualified && close >= dailyDemand.distal && close <= dailyDemand.proximal * 1.03
  );
  const roomForTwoR = rewardRisk === Infinity || (Number.isFinite(rewardRisk) && rewardRisk >= 2);
  const checks = {
    dailyDemandQualified,
    weeklyDemandQualified,
    dailyDemandFresh,
    weeklyDemandFresh,
    demandRetest,
    reactingFromHtf: reactingFromHtf.active,
    dailyTrendUp: dailyTrend === "up",
    weeklyTrendNotDown: !["down", "unknown"].includes(weeklyTrend),
    roomForTwoR,
    supplyBlocked
  };

  let score = 0;
  if (dailyDemandQualified) score += dailyDemandFresh ? 2 : 1;
  if (weeklyDemandQualified) score += weeklyDemandFresh ? 2 : 1;
  if (demandRetest) score += 2;
  if (reactingFromHtf.active) score += 1;
  if (checks.dailyTrendUp) score += 1;
  if (checks.weeklyTrendNotDown) score += 1;
  if (roomForTwoR) score += 1;
  if (supplyBlocked) score -= 3;
  if (dailyTrend === "down") score -= 1;
  score = clamp(score, 0, 10);

  const rankAdjustment = clamp(
    score * 1.5 +
      (dailyDemandFresh ? 2 : 0) +
      (weeklyDemandFresh ? 2 : 0) -
      (supplyBlocked ? 8 : 0) -
      (!roomForTwoR ? 4 : 0) +
      (reactingFromHtf.active ? 3 : 0),
    -12,
    19
  );
  const preferredEntryStyle = demandRetest
    ? "GTF_DEMAND_RETEST"
    : roomForTwoR && !supplyBlocked
      ? "GTF_CLEAR_RUNWAY"
      : "GTF_NEUTRAL";
  const structuralStop = demandReference && demandReference.stopLoss < close
    ? demandReference.stopLoss
    : null;
  const reasons = buildReasons({
    dailyDemand,
    weeklyDemand,
    opposingSupply,
    dailyTrend,
    weeklyTrend,
    rewardRisk,
    supplyBlocked,
    demandRetest,
    reactingFromHtf
  });

  return {
    dataAvailable: true,
    score,
    maxScore: 10,
    grade: score >= 7 ? "GTF A" : score >= 5 ? "GTF B" : score >= 3 ? "GTF C" : "GTF neutral",
    rankAdjustment: round(rankAdjustment),
    preferredEntryStyle,
    structuralStop: roundOrNull(structuralStop),
    dailyTrend,
    weeklyTrend,
    dailyDemand: zonePayload(dailyDemand),
    weeklyDemand: zonePayload(weeklyDemand),
    higherTimeframeDemand: reactingFromHtf.zone,
    reactingFromHtf,
    opposingSupply: zonePayload(opposingSupply),
    rewardRisk: rewardRisk === Infinity ? null : roundOrNull(rewardRisk),
    unlimitedRewardRoom: rewardRisk === Infinity,
    supplyDistancePct: roundOrNull(supplyDistancePct),
    supplyBlocked,
    demandRetest,
    checks,
    reasons
  };
}

export function aggregateCompletedCalendarCandles(candles = [], timeframe = "monthly") {
  const groups = new Map();
  for (const candle of candles || []) {
    if (!candle?.date || !Number.isFinite(Number(candle.close))) continue;
    const key = calendarPeriodKey(candle.date, timeframe);
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        date: candle.date,
        time: candle.time || new Date(`${candle.date}T00:00:00Z`).getTime(),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: Number(candle.volume) || 0
      });
      continue;
    }
    const row = groups.get(key);
    row.date = candle.date;
    row.time = candle.time || new Date(`${candle.date}T00:00:00Z`).getTime();
    if (Number.isFinite(candle.high)) row.high = Math.max(Number(row.high), Number(candle.high));
    if (Number.isFinite(candle.low)) row.low = Math.min(Number(row.low), Number(candle.low));
    if (Number.isFinite(candle.close)) row.close = Number(candle.close);
    if (Number.isFinite(candle.volume)) row.volume += Number(candle.volume);
  }
  const completed = [...groups.values()].sort((a, b) => a.time - b.time);
  completed.pop();
  return completed;
}

function calendarPeriodKey(date, timeframe) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (timeframe === "monthly") return `${year}-M${month}`;
  if (timeframe === "quarterly") return `${year}-Q${Math.ceil(month / 3)}`;
  if (timeframe === "half_yearly") return `${year}-H${month <= 6 ? 1 : 2}`;
  if (timeframe === "yearly") return `${year}`;
  return null;
}

function detectHtfDemandReaction({
  dailyCandles,
  dailyDemand,
  weeklyDemand,
  htfZones,
  close,
  dailyTrend,
  weeklyTrend,
  lookbackDays
}) {
  const sourceStatus = "PROXY_UNVALIDATED";
  const alignment = dailyTrend === "up" && !["down", "unknown"].includes(weeklyTrend);
  const executionZones = [dailyDemand, weeklyDemand].filter(zoneUsable);
  const recent = dailyCandles.slice(-Math.max(1, Number(lookbackDays) || 5));
  const timeframePriority = { yearly: 4, half_yearly: 3, quarterly: 2, monthly: 1 };
  const candidates = Object.values(htfZones)
    .flat()
    .filter((zone) => zone.side === "demand" && zoneBest(zone))
    .map((zone) => {
      const overlap = executionZones.some((executionZone) => zonesOverlap(executionZone, zone));
      const recentTouch = recent.some((candle) =>
        Number(candle.low) <= Math.max(zone.proximal, zone.distal) &&
        Number(candle.high) >= Math.min(zone.proximal, zone.distal)
      );
      const reclaimed = Number(close) >= Number(zone.proximal);
      return {
        zone,
        overlap,
        recentTouch,
        reclaimed,
        active: alignment && (overlap || (recentTouch && reclaimed))
      };
    })
    .filter((item) => item.active)
    .sort((a, b) =>
      (timeframePriority[b.zone.timeframe] || 0) - (timeframePriority[a.zone.timeframe] || 0) ||
      Math.abs(a.zone.proximal - close) - Math.abs(b.zone.proximal - close)
    );
  const selected = candidates[0];
  if (!selected) {
    return {
      active: false,
      sourceStatus,
      role: "SECONDARY_CONFLUENCE_ONLY",
      managementClass: null,
      managementPlan: null,
      zone: null,
      overlapWithExecutionDemand: false,
      recentTouchAndReclaim: false,
      reason: alignment
        ? "No fresh score-7 M/Q/HY/Y demand overlap or recent reclaim was detected."
        : "Higher-timeframe demand reaction is not confirmed because daily/weekly trend alignment is absent."
    };
  }
  return {
    active: true,
    sourceStatus,
    role: "SECONDARY_CONFLUENCE_ONLY",
    managementClass: "HTF_REACTION_2R_FOLLOWUPS",
    managementPlan: "Primary video setup may be managed toward 2R; each later fresh follow-up zone requires a separate primary entry signal.",
    zone: zonePayload(selected.zone),
    overlapWithExecutionDemand: selected.overlap,
    recentTouchAndReclaim: selected.recentTouch && selected.reclaimed,
    reason: `GTF secondary proxy: price is reacting from fresh ${selected.zone.timeframe} demand ${selected.zone.distal}-${selected.zone.proximal} with aligned daily/weekly trend.`
  };
}

function zonesOverlap(a, b) {
  if (!a || !b) return false;
  return Math.max(Math.min(a.proximal, a.distal), Math.min(b.proximal, b.distal)) <=
    Math.min(Math.max(a.proximal, a.distal), Math.max(b.proximal, b.distal));
}

export function detectGtfZones(candles = [], config = {}) {
  const rules = { ...DEFAULTS, ...(config || {}) };
  const rows = candles.map((candle, index) => candleFeature(candle, candles[index - 1], rules));
  const zones = [];
  const seen = new Set();
  for (let baseStart = 1; baseStart < rows.length - 1; baseStart += 1) {
    if (!rows[baseStart].isBase || !rows[baseStart - 1].isExciting) continue;
    let maxEnd = baseStart;
    while (
      maxEnd + 1 < rows.length - 1 &&
      canExtendBase(rows[maxEnd + 1]) &&
      maxEnd - baseStart + 1 < rules.maxBaseCandles
    ) {
      maxEnd += 1;
    }
    for (let baseEnd = baseStart; baseEnd <= maxEnd; baseEnd += 1) {
      const legoutIndex = baseEnd + 1;
      for (const side of ["demand", "supply"]) {
        const departure = side === "demand" ? rows[legoutIndex].bullishExciting : rows[legoutIndex].bearishExciting;
        if (!departure) continue;
        const key = `${side}|${baseStart}|${baseEnd}|${legoutIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const zone = buildZone(rows, side, baseStart, baseEnd, legoutIndex, rules);
        if (zone) zones.push(zone);
      }
    }
  }
  return zones;
}

function buildZone(rows, side, baseStart, baseEnd, legoutIndex, rules) {
  const leginIndex = baseStart - 1;
  const base = rows.slice(baseStart, baseEnd + 1);
  const legin = rows[leginIndex];
  const legout = rows[legoutIndex];
  if (side === "demand" && legin.gapDownExciting) return null;
  if (side === "supply" && legin.gapUpExciting) return null;

  const bodyHighs = base.map((row) => Math.max(row.open, row.close));
  const bodyLows = base.map((row) => Math.min(row.open, row.close));
  let proximal;
  let distal;
  let adverseWick;
  if (side === "demand") {
    proximal = Math.max(...bodyHighs);
    distal = Math.min(...base.map((row) => row.low));
    adverseWick = Math.max(...base.map((row) => row.high)) - proximal;
    if (distal <= legout.open && legout.open <= proximal && legout.low < distal) distal = legout.low;
  } else {
    proximal = Math.min(...bodyLows);
    distal = Math.max(...base.map((row) => row.high));
    adverseWick = proximal - Math.min(...base.map((row) => row.low));
    if (proximal <= legout.open && legout.open <= distal && legout.high > distal) distal = legout.high;
  }
  const width = Math.abs(proximal - distal);
  if (!(width > 0)) return null;
  const baseWickRatio = Math.max(0, adverseWick) / width;
  if (baseWickRatio > rules.dirtyBaseWickRatio) return null;

  const second = rows[legoutIndex + 1];
  const secondExciting = Boolean(
    second && (side === "demand" ? second.bullishExciting : second.bearishExciting)
  );
  const firstCloseValid = side === "demand" ? legout.close > legin.high : legout.close < legin.low;
  const secondCloseValid = Boolean(
    secondExciting && (side === "demand" ? second.close > legin.high : second.close < legin.low)
  );
  const continuationValid = continuationCloseValid(rows, side, proximal, distal, leginIndex, legoutIndex);
  if (!firstCloseValid && !secondCloseValid && !continuationValid) return null;

  const directionalGap = side === "demand" ? legout.directionalGapUp : legout.directionalGapDown;
  const departureQuality = directionalGap
    ? "significant_gap"
    : secondExciting
      ? "two_exciting_candles"
      : continuationValid
        ? "achievement_close"
        : "single_exciting_candle";
  const freshnessTests = countTests(rows, side, proximal, distal, legoutIndex + 1);
  const achievementR = achievementMultiple(rows, side, proximal, distal, legoutIndex);
  const freshnessPoints = freshnessTests === 0 ? 3 : freshnessTests === 1 ? 1.5 : 0;
  const strengthPoints = directionalGap || secondExciting || continuationValid ? 2 : 1;
  const baseCount = baseEnd - baseStart + 1;
  const basePoints = baseCount <= 3 ? 2 : baseCount <= 5 ? 1 : 0;
  const entry = side === "demand"
    ? proximal * (1 + rules.entryBufferPct / 100)
    : proximal * (1 - rules.entryBufferPct / 100);
  const stopLoss = side === "demand"
    ? distal * (1 - rules.stopBufferPct / 100)
    : distal * (1 + rules.stopBufferPct / 100);
  const active = side === "demand"
    ? rows.slice(legoutIndex + 1).every((row) => row.low >= distal)
    : rows.slice(legoutIndex + 1).every((row) => row.high <= distal);

  return {
    side,
    timeframe: rules.timeframe || "daily",
    pattern: side === "demand" ? (legin.close > legin.open ? "RBR" : "DBR") : (legin.close < legin.open ? "DBD" : "RBD"),
    baseStart: rows[baseStart].date,
    baseEnd: rows[baseEnd].date,
    legoutDate: legout.date,
    baseCount,
    proximal: round(proximal),
    distal: round(distal),
    entry: round(entry),
    stopLoss: round(stopLoss),
    freshnessTests,
    score: round(freshnessPoints + strengthPoints + basePoints),
    achievementR: round(achievementR),
    baseWickRatio: round(baseWickRatio),
    departureQuality,
    active
  };
}

function candleFeature(candle, previous, rules) {
  const range = Number(candle.high) - Number(candle.low);
  const body = Math.abs(Number(candle.close) - Number(candle.open));
  const bodyPct = range > 0 ? body / range : 0;
  const previousClose = Number(previous?.close);
  const openingGapPct = Number.isFinite(previousClose) && previousClose > 0
    ? Math.abs(Number(candle.open) - previousClose) / previousClose * 100
    : 0;
  const directionalGapUp = Number.isFinite(previousClose) && candle.open > previousClose && openingGapPct >= rules.significantGapPct;
  const directionalGapDown = Number.isFinite(previousClose) && candle.open < previousClose && openingGapPct >= rules.significantGapPct;
  const baseBody = bodyPct <= rules.baseBodyLimit;
  const gapUpExciting = baseBody && directionalGapUp;
  const gapDownExciting = baseBody && directionalGapDown;
  const isBase = baseBody && !gapUpExciting && !gapDownExciting;
  return {
    ...candle,
    bodyPct,
    directionalGapUp,
    directionalGapDown,
    gapUpExciting,
    gapDownExciting,
    isBase,
    isExciting: !isBase,
    bullishExciting: (bodyPct > rules.baseBodyLimit && candle.close > candle.open) || gapUpExciting,
    bearishExciting: (bodyPct > rules.baseBodyLimit && candle.close < candle.open) || gapDownExciting
  };
}

function continuationCloseValid(rows, side, proximal, distal, leginIndex, legoutIndex) {
  const width = Math.max(Math.abs(proximal - distal), 1e-9);
  const stop = Math.min(rows.length, legoutIndex + 4);
  for (let index = legoutIndex + 1; index < stop; index += 1) {
    const section = rows.slice(legoutIndex, index + 1);
    const closePassed = side === "demand"
      ? rows[index].close > rows[leginIndex].high
      : rows[index].close < rows[leginIndex].low;
    const achieved = side === "demand"
      ? (Math.max(...section.map((row) => row.high)) - proximal) / width
      : (proximal - Math.min(...section.map((row) => row.low))) / width;
    if (closePassed && achieved >= 1) return true;
  }
  return false;
}

function achievementMultiple(rows, side, proximal, distal, legoutIndex) {
  const width = Math.max(Math.abs(proximal - distal), 1e-9);
  let end = rows.length;
  for (let index = legoutIndex + 1; index < rows.length; index += 1) {
    if (rows[index].low <= Math.max(proximal, distal) && rows[index].high >= Math.min(proximal, distal)) {
      end = index;
      break;
    }
  }
  const move = rows.slice(legoutIndex, Math.max(legoutIndex + 1, end));
  return side === "demand"
    ? Math.max(0, (Math.max(...move.map((row) => row.high)) - proximal) / width)
    : Math.max(0, (proximal - Math.min(...move.map((row) => row.low))) / width);
}

function countTests(rows, side, proximal, distal, startIndex) {
  let tests = 0;
  let touching = false;
  for (const row of rows.slice(startIndex)) {
    const touched = row.low <= Math.max(proximal, distal) && row.high >= Math.min(proximal, distal);
    const left = side === "demand" ? row.close > proximal : row.close < proximal;
    if (touched && !touching) {
      tests += 1;
      touching = true;
    }
    if (touching && left) touching = false;
  }
  return tests;
}

function selectDemand(zones, close, maxDistancePct) {
  return zones
    .filter((zone) => zone.side === "demand" && zone.active && close >= zone.distal)
    .map((zone) => ({ ...zone, distancePct: close > 0 ? Math.max(0, (close - zone.proximal) / close * 100) : null }))
    .filter((zone) => zoneContains(zone, close) || zone.distancePct <= maxDistancePct)
    .sort(zoneSort)[0] || null;
}

function selectSupply(zones, close) {
  return zones
    .filter((zone) => zone.side === "supply" && zoneBest(zone) && close <= zone.distal)
    .map((zone) => ({ ...zone, distancePct: close > 0 ? Math.max(0, (zone.distal - close) / close * 100) : null }))
    .sort(zoneSort)[0] || null;
}

function zoneSort(a, b) {
  return (a.distancePct ?? Infinity) - (b.distancePct ?? Infinity) || b.score - a.score || b.achievementR - a.achievementR;
}

function nearestSupply(zones, close) {
  return zones.filter(Boolean).sort((a, b) => Math.abs(a.distal - close) - Math.abs(b.distal - close))[0] || null;
}

function bestDemand(zones, close) {
  return zones.filter(zoneUsable).sort((a, b) => Math.abs(a.proximal - close) - Math.abs(b.proximal - close))[0] || null;
}

function zoneUsable(zone) {
  return Boolean(zone && zone.active && zone.freshnessTests <= 1 && zone.score >= 5.5 && zone.achievementR >= 1 && zone.baseWickRatio <= 1.2);
}

function zoneBest(zone) {
  return Boolean(zoneUsable(zone) && zone.freshnessTests === 0 && zone.score >= 7);
}

function zoneContains(zone, price) {
  return Boolean(zone && price >= Math.min(zone.proximal, zone.distal) && price <= Math.max(zone.proximal, zone.distal));
}

function smaTrend(candles) {
  if (candles.length < 57) return "unknown";
  const values = simpleMovingAverage(candles, 50);
  const current = values[values.length - 1];
  const previous = values[values.length - 8];
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return "unknown";
  const slope = (current - previous) / previous;
  return slope > 0.0015 ? "up" : slope < -0.0015 ? "down" : "sideways";
}

function buildReasons(context) {
  const reasons = [];
  if (zoneUsable(context.dailyDemand)) reasons.push(zoneReason("Daily demand", context.dailyDemand));
  if (zoneUsable(context.weeklyDemand)) reasons.push(zoneReason("Weekly demand", context.weeklyDemand));
  if (context.demandRetest) reasons.push("GTF retracement confirmation: close is retesting a usable daily demand zone.");
  if (context.reactingFromHtf.active) reasons.push(context.reactingFromHtf.reason);
  reasons.push(`GTF 50-SMA slope: daily ${context.dailyTrend}, weekly ${context.weeklyTrend}.`);
  if (context.opposingSupply) {
    const rr = Number.isFinite(context.rewardRisk) ? `; estimated room ${round(context.rewardRisk)}R` : "";
    reasons.push(`Opposing ${context.opposingSupply.timeframe} supply ${context.opposingSupply.proximal}-${context.opposingSupply.distal}${rr}${context.supplyBlocked ? "; blocker/early-risk flag" : ""}.`);
  } else {
    reasons.push("No active daily/weekly/higher-timeframe GTF supply blocker was detected above price.");
  }
  return reasons;
}

function zoneReason(label, zone) {
  const freshness = zone.freshnessTests === 0 ? "fresh" : "tested once";
  return `${label} ${zone.pattern} ${zone.distal}-${zone.proximal}: ${freshness}, score ${zone.score}/7, achievement ${zone.achievementR}R, ${zone.departureQuality}.`;
}

function zonePayload(zone) {
  if (!zone) return null;
  return {
    timeframe: zone.timeframe,
    side: zone.side,
    pattern: zone.pattern,
    proximal: zone.proximal,
    distal: zone.distal,
    entry: zone.entry,
    stopLoss: zone.stopLoss,
    score: zone.score,
    freshnessTests: zone.freshnessTests,
    achievementR: zone.achievementR,
    baseWickRatio: zone.baseWickRatio,
    departureQuality: zone.departureQuality,
    legoutDate: zone.legoutDate,
    active: zone.active,
    distancePct: roundOrNull(zone.distancePct)
  };
}

function canExtendBase(row) {
  return row.isBase || row.gapUpExciting || row.gapDownExciting;
}

function emptyContext() {
  return {
    dataAvailable: false,
    score: 0,
    maxScore: 10,
    grade: "GTF unavailable",
    rankAdjustment: 0,
    preferredEntryStyle: "GTF_NEUTRAL",
    structuralStop: null,
    supplyBlocked: false,
    demandRetest: false,
    higherTimeframeDemand: null,
    reactingFromHtf: {
      active: false,
      sourceStatus: "PROXY_UNVALIDATED",
      role: "SECONDARY_CONFLUENCE_ONLY",
      managementClass: null,
      managementPlan: null,
      zone: null,
      reason: "GTF higher-timeframe reaction is unavailable because price history is insufficient."
    },
    checks: {},
    reasons: ["GTF confluence unavailable because price history is insufficient."]
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function roundOrNull(value) {
  return Number.isFinite(value) ? round(value) : null;
}
