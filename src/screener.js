import { appConfig } from "./config.js";
import {
  calculateRelativeStrength,
  calculateRsi,
  calculateSupertrend,
  latestIndex,
  latestValue,
  priceAboveSma,
  simpleMovingAverage
} from "./indicators.js";
import { createFundamentalsService } from "./fundamentals.js";
import { loadWatchlist } from "./watchlist.js";
import { fetchCandles } from "./yahoo.js";
import { readLatestScan, saveLatestScan } from "./storage.js";
import { sendTelegramSummary } from "./telegram.js";
import { updateTradeJournal } from "./trade-journal.js";

export async function runScreener(options = {}) {
  const config = options.config || appConfig;
  const rules = config.rules;
  const fundamentals = createFundamentalsService(config);
  const listFilter = options.listId || "all";
  const lists = config.lists.filter((list) => listFilter === "all" || list.id === listFilter);

  const [benchmarkDaily, benchmarkWeekly] = await Promise.all([
    fetchCandles(config.benchmarkSymbol, "1d", 3),
    fetchCandles(config.benchmarkSymbol, "1wk", 5)
  ]);

  const scannedLists = {};

  for (const list of lists) {
    const watchlist = loadWatchlist(list.path, config.maxSymbols);
    const results = await mapLimit(watchlist, config.scanConcurrency, async (item) => {
      try {
        return await scanSymbol(item, list, benchmarkDaily, benchmarkWeekly, rules, fundamentals);
      } catch (error) {
        return {
          listId: list.id,
          listLabel: list.label,
          symbol: item.symbol,
          yahooSymbol: item.yahooSymbol,
          name: item.name,
          industry: item.industry,
          status: "ERROR",
          error: error.message || String(error),
          signalReason: [`Data error: ${error.message || String(error)}`],
          entryReason: [],
          exitReason: [],
          score: 0,
          fundamentalScore: 0
        };
      }
    });

    const sorted = applySectorStrength(results, rules).sort(sortResults);
    scannedLists[list.id] = {
      id: list.id,
      label: list.label,
      editable: list.editable,
      summary: summarize(sorted),
      results: sorted
    };
  }

  fundamentals.save();

  const previous = listFilter === "all" ? null : readLatestScan();
  const mergedLists = {
    ...(previous?.lists || {}),
    ...scannedLists
  };
  const allResults = Object.values(mergedLists).flatMap((list) => list.results || []);
  const payload = {
    scannedAt: new Date().toISOString(),
    benchmark: config.benchmarkSymbol,
    benchmarkLabel: config.benchmarkLabel || rules.benchmarkLabel || config.benchmarkSymbol,
    lists: mergedLists,
    scannedListIds: lists.map((list) => list.id),
    rules,
    summary: summarize(allResults),
    results: allResults.sort(sortResults)
  };

  saveLatestScan(payload);
  const journal = await updateTradeJournal(payload, config);
  payload.tradeSummary = summarizeTrades(journal.trades);
  payload.tradeEvents = journal.events;
  saveLatestScan(payload);

  let telegram = { sent: false, reason: "disabled" };
  if (options.sendTelegram) {
    telegram = await sendTelegramSummary(payload, config);
  }

  return { ...payload, telegram };
}

function summarizeTrades(trades) {
  const open = trades.filter((trade) => trade.status === "OPEN");
  const closed = trades.filter((trade) => trade.status === "CLOSED");
  return {
    open: open.length,
    closed: closed.length,
    realizedPnl: Number(
      closed.reduce((sum, trade) => sum + (Number(trade.pnl) || 0), 0).toFixed(2)
    )
  };
}

async function scanSymbol(item, list, benchmarkDaily, benchmarkWeekly, rules, fundamentals) {
  const [dailyCandles, weeklyCandles] = await Promise.all([
    fetchCandles(item.yahooSymbol, "1d", 3),
    fetchCandles(item.yahooSymbol, "1wk", 5)
  ]);

  if (dailyCandles.length < 80) throw new Error("not enough daily price history");
  if (weeklyCandles.length < 30) throw new Error("not enough weekly price history");

  const rsiLength = rules.rsi?.length || 14;
  const weeklyRsPeriod = rules.relativeStrength?.weekly?.period || 21;
  const dailyLongPeriod = rules.relativeStrength?.dailyLong?.period || 55;
  const dailyShortPeriod = rules.relativeStrength?.dailyShort?.period || 21;

  const dailyRsiSeries = calculateRsi(dailyCandles, rsiLength);
  const weeklyRsiSeries = calculateRsi(weeklyCandles, rsiLength);
  const weeklyRsSeries = calculateRelativeStrength(
    weeklyCandles,
    benchmarkWeekly,
    weeklyRsPeriod
  );
  const dailyLongRsSeries = calculateRelativeStrength(
    dailyCandles,
    benchmarkDaily,
    dailyLongPeriod
  );
  const dailyShortRsSeries = calculateRelativeStrength(
    dailyCandles,
    benchmarkDaily,
    dailyShortPeriod
  );
  const supertrendLength = rules.supertrend?.daily?.atrLength || 10;
  const supertrendMultiplier = rules.supertrend?.daily?.multiplier || 3;
  const dailySupertrendSeries = calculateSupertrend(
    dailyCandles,
    supertrendLength,
    supertrendMultiplier
  );

  const latestDailyIndex = dailyCandles.length - 1;
  const latestWeeklyIndex = weeklyCandles.length - 1;
  const close = dailyCandles[latestDailyIndex].close;

  const dailyRsi = latestValue(dailyRsiSeries);
  const weeklyRsi = latestValue(weeklyRsiSeries);
  const weeklyRs = latestValue(weeklyRsSeries);
  const dailyLongRs = latestValue(dailyLongRsSeries);
  const dailyShortRs = latestValue(dailyShortRsSeries);
  const dailySupertrend = latestValue(dailySupertrendSeries);
  const setupStrength = buildSetupStrength({
    dailyCandles,
    close,
    dailySupertrend,
    weeklyRsSeries,
    dailyLongRsSeries,
    dailyShortRsSeries,
    rules
  });

  const technicalReady = [
    dailyRsi,
    weeklyRsi,
    weeklyRs,
    dailyLongRs,
    dailyShortRs,
    dailySupertrend
  ].every(Number.isFinite);

  const entryChecks = {
    weeklyRsi: weeklyRsi > (rules.entry?.weeklyRsiAbove ?? 50),
    dailyRsi: dailyRsi > (rules.entry?.dailyRsiAbove ?? 50),
    weeklyRs: weeklyRs > (rules.entry?.weeklyRsAbove ?? 0),
    dailyLongRs: dailyLongRs > (rules.entry?.dailyLongRsAbove ?? 0),
    dailyShortRs: dailyShortRs > (rules.entry?.dailyShortRsAbove ?? 0),
    dailyPriceAboveSupertrend: close > dailySupertrend
  };

  const exitChecks = {
    weeklyRs: weeklyRs < (rules.exit?.weeklyRsBelow ?? 0)
  };

  const entry = technicalReady && Object.values(entryChecks).every(Boolean);
  const exit = technicalReady && Object.values(exitChecks).some(Boolean);
  const status = !technicalReady ? "ERROR" : exit ? "EXIT" : entry ? "ENTRY" : "WATCH";
  const entryReason = buildEntryReasons(entryChecks, {
    weeklyRsi,
    dailyRsi,
    weeklyRs,
    dailyLongRs,
    dailyShortRs,
    close,
    dailySupertrend,
    supertrendLength,
    supertrendMultiplier
  });
  const exitReason = buildExitReasons(exitChecks, { weeklyRs });
  const setupReason = buildSetupStrengthReasons(setupStrength);
  const weaknessReason = buildWeaknessReasons({
    dailyShortRs,
    dailyLongRs,
    close,
    dailySupertrend,
    setupStrength
  });
  const signalReason =
    status === "ENTRY"
      ? [...entryReason, ...setupReason]
      : status === "EXIT"
        ? exitReason
        : technicalReady
          ? ["No entry: one or more compulsory entry checks are not satisfied.", ...weaknessReason]
          : ["Indicator data incomplete."];

  const fundamental = await fundamentals.get(item.yahooSymbol, dailyCandles);
  const technicalScore = Object.values(entryChecks).filter(Boolean).length;
  const setupStrengthScore = setupStrength.score;

  const dailyLongPriceOk = priceAboveSma(
    dailyCandles,
    rules.relativeStrength?.dailyLong?.priceConfirmationPeriod || 50
  );
  const dailyShortPriceOk = priceAboveSma(
    dailyCandles,
    rules.relativeStrength?.dailyShort?.priceConfirmationPeriod || 50
  );
  const weeklyPriceOk = priceAboveSma(
    weeklyCandles,
    rules.relativeStrength?.weekly?.priceConfirmationPeriod || 61
  );

  return {
    listId: list.id,
    listLabel: list.label,
    symbol: item.symbol,
    yahooSymbol: item.yahooSymbol,
    name: item.name,
    industry: item.industry,
    status,
    asOf: dailyCandles[latestDailyIndex].date,
    weeklyAsOf: weeklyCandles[latestWeeklyIndex].date,
    close,
    dailyRsi,
    weeklyRsi,
    weeklyRs,
    dailyLongRs,
    dailyShortRs,
    dailySupertrend,
    dailyPriceAboveSupertrend: close > dailySupertrend,
    entryChecks,
    exitChecks,
    entryReason,
    exitReason,
    setupReason,
    weaknessReason,
    signalReason,
    priceConfirmation: {
      weekly: weeklyPriceOk,
      dailyLong: dailyLongPriceOk,
      dailyShort: dailyShortPriceOk
    },
    setupStrength,
    fundamental,
    technicalScore,
    setupStrengthScore,
    fundamentalScore: fundamental.score,
    sectorStrengthScore: 0,
    score: technicalScore + setupStrengthScore + fundamental.score,
    lastIndicatorIndex: {
      dailyRsi: latestIndex(dailyRsiSeries),
      weeklyRsi: latestIndex(weeklyRsiSeries),
      dailySupertrend: latestIndex(dailySupertrendSeries)
    }
  };
}

function buildSetupStrength({ dailyCandles, close, dailySupertrend, weeklyRsSeries, dailyLongRsSeries, dailyShortRsSeries, rules }) {
  const setupRules = rules.setupStrength || {};
  const latestDailyIndex = dailyCandles.length - 1;
  const previousCandle = dailyCandles[latestDailyIndex - 1] || null;
  const currentCandle = dailyCandles[latestDailyIndex] || null;
  const recentHighPeriod = setupRules.dailyRecentHighPeriod || 55;
  const yearHighPeriod = setupRules.dailyYearHighPeriod || 252;
  const volumeAveragePeriod = setupRules.volumeAveragePeriod || 50;
  const volumeExpansionMultiple = setupRules.volumeExpansionMultiple || 1.5;
  const nearYearHighPct = setupRules.nearYearHighPct || 15;
  const riskToSupertrendMaxPct = setupRules.riskToSupertrendMaxPct || 7;
  const rsTrendLookback = setupRules.rsTrendLookback || 5;
  const smaFastPeriod = setupRules.smaFastPeriod || 50;
  const smaSlowPeriod = setupRules.smaSlowPeriod || 200;

  const priorRecentHigh = highestHigh(dailyCandles, recentHighPeriod, latestDailyIndex - 1);
  const priorYearHigh = highestHigh(dailyCandles, yearHighPeriod, latestDailyIndex - 1);
  const recentHighBreakout = Number.isFinite(priorRecentHigh) && close > priorRecentHigh;
  const yearHighBreakout = Number.isFinite(priorYearHigh) && close > priorYearHigh;
  const nearYearHigh =
    Number.isFinite(priorYearHigh) && close >= priorYearHigh * (1 - nearYearHighPct / 100);

  const volumeAverage = averageVolume(dailyCandles, volumeAveragePeriod, latestDailyIndex - 1);
  const volumeRatio =
    Number.isFinite(currentCandle?.volume) && Number.isFinite(volumeAverage) && volumeAverage > 0
      ? currentCandle.volume / volumeAverage
      : null;
  const volumeExpansion =
    Number.isFinite(volumeRatio) && volumeRatio >= volumeExpansionMultiple;

  const weeklyRsRising = risingOverLookback(weeklyRsSeries, rsTrendLookback);
  const dailyLongRsRising = risingOverLookback(dailyLongRsSeries, rsTrendLookback);
  const dailyShortRsRising = risingOverLookback(dailyShortRsSeries, rsTrendLookback);
  const smaFast = latestValue(simpleMovingAverage(dailyCandles, smaFastPeriod));
  const smaSlow = latestValue(simpleMovingAverage(dailyCandles, smaSlowPeriod));
  const closeAboveSmaFast = Number.isFinite(smaFast) && close > smaFast;
  const closeAboveSmaSlow = Number.isFinite(smaSlow) && close > smaSlow;
  const smaFastAboveSlow = Number.isFinite(smaFast) && Number.isFinite(smaSlow) && smaFast > smaSlow;

  const previousLow = Number.isFinite(previousCandle?.low) ? previousCandle.low : null;
  const twoCandleLow = lowestLow(dailyCandles, 2, latestDailyIndex - 1);
  const fourCandleLow = lowestLow(dailyCandles, 4, latestDailyIndex - 1);
  const riskToSupertrendPct =
    Number.isFinite(close) && Number.isFinite(dailySupertrend) && close > 0
      ? ((close - dailySupertrend) / close) * 100
      : null;
  const riskToPreviousLowPct =
    Number.isFinite(close) && Number.isFinite(previousLow) && close > 0
      ? ((close - previousLow) / close) * 100
      : null;
  const favorableRiskToSupertrend =
    Number.isFinite(riskToSupertrendPct) &&
    riskToSupertrendPct >= 0 &&
    riskToSupertrendPct <= riskToSupertrendMaxPct;

  const checks = {
    recentHighBreakout,
    yearHighBreakout,
    nearYearHigh,
    volumeExpansion,
    weeklyRsRising,
    dailyLongRsRising,
    dailyShortRsRising,
    closeAboveSmaFast,
    closeAboveSmaSlow,
    smaFastAboveSlow,
    favorableRiskToSupertrend
  };

  return {
    score: Object.values(checks).filter(Boolean).length,
    checks,
    values: {
      priorRecentHigh,
      priorYearHigh,
      volumeAverage,
      volumeRatio,
      smaFast,
      smaSlow,
      previousLow,
      twoCandleLow,
      fourCandleLow,
      riskToSupertrendPct,
      riskToPreviousLowPct,
      recentHighPeriod,
      yearHighPeriod,
      nearYearHighPct,
      volumeAveragePeriod,
      volumeExpansionMultiple,
      riskToSupertrendMaxPct,
      smaFastPeriod,
      smaSlowPeriod
    }
  };
}

function applySectorStrength(results, rules) {
  const setupRules = rules.setupStrength || {};
  const minPct = setupRules.sectorBreadthMinPct ?? 50;
  const minStocks = setupRules.sectorBreadthMinStocks ?? 5;
  const groups = new Map();

  for (const row of results) {
    const key = String(row.industry || "").trim() || "Unknown";
    if (!groups.has(key)) groups.set(key, { total: 0, strong: 0, entry: 0 });
    const group = groups.get(key);
    if (row.status === "ERROR") continue;
    group.total += 1;
    if (
      row.dailyRsi > (rules.entry?.dailyRsiAbove ?? 50) &&
      row.dailyLongRs > (rules.entry?.dailyLongRsAbove ?? 0) &&
      row.dailyShortRs > (rules.entry?.dailyShortRsAbove ?? 0) &&
      row.dailyPriceAboveSupertrend
    ) {
      group.strong += 1;
    }
    if (row.status === "ENTRY") group.entry += 1;
  }

  return results.map((row) => {
    const key = String(row.industry || "").trim() || "Unknown";
    const group = groups.get(key) || { total: 0, strong: 0, entry: 0 };
    const breadthPct = group.total > 0 ? (group.strong / group.total) * 100 : null;
    const ok =
      Number.isFinite(breadthPct) &&
      group.total >= minStocks &&
      breadthPct >= minPct;
    const sectorStrength = {
      industry: key,
      total: group.total,
      strong: group.strong,
      entry: group.entry,
      breadthPct,
      ok,
      minPct,
      minStocks
    };
    const sectorStrengthScore = ok ? 1 : 0;
    const sectorReason =
      ok
        ? `Sector breadth strong: ${key} has ${group.strong}/${group.total} stocks (${fmt(breadthPct)}%) passing daily strength.`
        : null;

    return {
      ...row,
      sectorStrength,
      sectorStrengthScore,
      setupStrengthScore: (row.setupStrengthScore || 0) + sectorStrengthScore,
      score: (row.score || 0) + sectorStrengthScore,
      signalReason:
        row.status === "ENTRY" && sectorReason
          ? [...(row.signalReason || []), sectorReason]
          : row.signalReason
    };
  });
}

function buildEntryReasons(checks, values) {
  const reasons = [];
  reasons.push(
    checks.weeklyRsi
      ? `Weekly RSI ${fmt(values.weeklyRsi)} is above 50.`
      : `Weekly RSI ${fmt(values.weeklyRsi)} is not above 50.`
  );
  reasons.push(
    checks.dailyRsi
      ? `Daily RSI ${fmt(values.dailyRsi)} is above 50.`
      : `Daily RSI ${fmt(values.dailyRsi)} is not above 50.`
  );
  reasons.push(
    checks.weeklyRs
      ? `Weekly RS ${fmtPct(values.weeklyRs)} is above 0.`
      : `Weekly RS ${fmtPct(values.weeklyRs)} is not above 0.`
  );
  reasons.push(
    checks.dailyLongRs
      ? `Daily long RS55 ${fmtPct(values.dailyLongRs)} is above 0.`
      : `Daily long RS55 ${fmtPct(values.dailyLongRs)} is not above 0.`
  );
  reasons.push(
    checks.dailyShortRs
      ? `Daily short RS21 ${fmtPct(values.dailyShortRs)} is above 0.`
      : `Daily short RS21 ${fmtPct(values.dailyShortRs)} is not above 0.`
  );
  reasons.push(
    checks.dailyPriceAboveSupertrend
      ? `Daily close ${fmt(values.close)} is above Supertrend(${values.supertrendLength}, ${values.supertrendMultiplier}) ${fmt(values.dailySupertrend)}.`
      : `Daily close ${fmt(values.close)} is not above Supertrend(${values.supertrendLength}, ${values.supertrendMultiplier}) ${fmt(values.dailySupertrend)}.`
  );
  return reasons;
}

function buildExitReasons(checks, values) {
  const reasons = [];
  if (checks.weeklyRs) reasons.push(`Weekly RS ${fmtPct(values.weeklyRs)} is below 0 on closed weekly candle.`);
  if (reasons.length === 0) reasons.push("No exit condition is triggered.");
  return reasons;
}

function buildSetupStrengthReasons(setupStrength) {
  const checks = setupStrength.checks || {};
  const values = setupStrength.values || {};
  const reasons = [];

  if (checks.recentHighBreakout) {
    reasons.push(
      `Price action strength: close crossed ${values.recentHighPeriod}-day high ${fmt(values.priorRecentHigh)}.`
    );
  } else if (checks.nearYearHigh) {
    reasons.push(
      `Price action strength: close is within ${values.nearYearHighPct}% of 52-week high ${fmt(values.priorYearHigh)}.`
    );
  }
  if (checks.yearHighBreakout) {
    reasons.push(`52-week breakout: close crossed prior 52-week high ${fmt(values.priorYearHigh)}.`);
  }
  if (checks.volumeExpansion) {
    reasons.push(
      `Volume shocker: latest volume is ${fmt(values.volumeRatio)}x the ${values.volumeAveragePeriod}-day average.`
    );
  }
  if (checks.weeklyRsRising && checks.dailyLongRsRising) {
    reasons.push("RS trend strength: weekly RS and daily RS55 are rising.");
  } else if (checks.dailyLongRsRising) {
    reasons.push("RS trend strength: daily RS55 is rising.");
  }
  if (checks.closeAboveSmaFast && checks.closeAboveSmaSlow && checks.smaFastAboveSlow) {
    reasons.push(
      `Trend strength: close is above ${values.smaFastPeriod}-DMA and ${values.smaSlowPeriod}-DMA, with fast DMA above slow DMA.`
    );
  }
  if (checks.favorableRiskToSupertrend) {
    reasons.push(
      `Risk reference: close is ${fmt(values.riskToSupertrendPct)}% above daily Supertrend.`
    );
  }

  if (reasons.length === 0) reasons.push("Optional setup strength is neutral.");
  return reasons;
}

function buildWeaknessReasons({ dailyShortRs, dailyLongRs, close, dailySupertrend, setupStrength }) {
  const reasons = [];
  if (Number.isFinite(dailyShortRs) && dailyShortRs < 0) {
    reasons.push(`Early weakness: daily short RS21 ${fmtPct(dailyShortRs)} is below 0.`);
  }
  if (Number.isFinite(dailyLongRs) && dailyLongRs < 0) {
    reasons.push(`Early weakness: daily long RS55 ${fmtPct(dailyLongRs)} is below 0.`);
  }
  if (Number.isFinite(close) && Number.isFinite(dailySupertrend) && close < dailySupertrend) {
    reasons.push(`Early weakness: daily close ${fmt(close)} is below Supertrend ${fmt(dailySupertrend)}.`);
  }
  const previousLow = setupStrength?.values?.previousLow;
  if (Number.isFinite(close) && Number.isFinite(previousLow) && close < previousLow) {
    reasons.push(`Price weakness: close is below previous candle low ${fmt(previousLow)}.`);
  }
  return reasons;
}

function summarize(results) {
  return {
    total: results.length,
    entry: results.filter((row) => row.status === "ENTRY").length,
    exit: results.filter((row) => row.status === "EXIT").length,
    watch: results.filter((row) => row.status === "WATCH").length,
    error: results.filter((row) => row.status === "ERROR").length
  };
}

function sortResults(a, b) {
  const rank = { ENTRY: 0, EXIT: 1, WATCH: 2, ERROR: 3 };
  const rankDiff = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
  if (rankDiff !== 0) return rankDiff;
  return (b.score ?? 0) - (a.score ?? 0);
}

async function mapLimit(items, limit, iterator) {
  const results = Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await iterator(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function fmt(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "NA";
}

function fmtPct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "NA";
}

function highestHigh(candles, period, endIndex) {
  const start = Math.max(0, endIndex - period + 1);
  let highest = null;
  for (let index = start; index <= endIndex; index += 1) {
    const high = candles[index]?.high;
    if (Number.isFinite(high)) highest = highest == null ? high : Math.max(highest, high);
  }
  return highest;
}

function lowestLow(candles, period, endIndex) {
  const start = Math.max(0, endIndex - period + 1);
  let lowest = null;
  for (let index = start; index <= endIndex; index += 1) {
    const low = candles[index]?.low;
    if (Number.isFinite(low)) lowest = lowest == null ? low : Math.min(lowest, low);
  }
  return lowest;
}

function averageVolume(candles, period, endIndex) {
  const start = Math.max(0, endIndex - period + 1);
  let sum = 0;
  let count = 0;
  for (let index = start; index <= endIndex; index += 1) {
    const volume = candles[index]?.volume;
    if (!Number.isFinite(volume)) continue;
    sum += volume;
    count += 1;
  }
  return count > 0 ? sum / count : null;
}

function risingOverLookback(values, lookback) {
  const currentIndex = latestIndex(values);
  if (currentIndex < 0) return false;
  const previousIndex = previousFiniteIndex(values, currentIndex - lookback);
  if (previousIndex < 0) return false;
  return values[currentIndex] > values[previousIndex];
}

function previousFiniteIndex(values, startIndex) {
  for (let index = Math.min(startIndex, values.length - 1); index >= 0; index -= 1) {
    if (Number.isFinite(values[index])) return index;
  }
  return -1;
}
