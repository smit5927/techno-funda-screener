import { appConfig } from "./config.js";
import {
  calculateRelativeStrength,
  calculateRsi,
  calculateSupertrend,
  latestIndex,
  latestValue,
  priceAboveSma
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

    const sorted = results.sort(sortResults);
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
  const signalReason =
    status === "ENTRY"
      ? entryReason
      : status === "EXIT"
        ? exitReason
        : technicalReady
          ? ["No entry: one or more compulsory entry checks are not satisfied."]
          : ["Indicator data incomplete."];

  const fundamental = await fundamentals.get(item.yahooSymbol, dailyCandles);
  const technicalScore = Object.values(entryChecks).filter(Boolean).length;

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
    signalReason,
    priceConfirmation: {
      weekly: weeklyPriceOk,
      dailyLong: dailyLongPriceOk,
      dailyShort: dailyShortPriceOk
    },
    fundamental,
    technicalScore,
    fundamentalScore: fundamental.score,
    score: technicalScore + fundamental.score,
    lastIndicatorIndex: {
      dailyRsi: latestIndex(dailyRsiSeries),
      weeklyRsi: latestIndex(weeklyRsiSeries),
      dailySupertrend: latestIndex(dailySupertrendSeries)
    }
  };
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
