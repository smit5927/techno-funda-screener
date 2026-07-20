import { appConfig } from "./config.js";
import {
  calculateAtr,
  calculateMacd,
  calculateObv,
  calculateRelativeStrength,
  calculateRsi,
  calculateSupertrend,
  exponentialMovingAverage,
  latestIndex,
  latestValue,
  priceAboveSma,
  simpleMovingAverage
} from "./indicators.js";
import { createFundamentalsService, emptyFundamentals } from "./fundamentals.js";
import { loadWatchlist } from "./watchlist.js";
import { aggregateDailyToCompletedWeeks, fetchBenchmarkCandles, fetchCandles } from "./yahoo.js";
import {
  buildInstitutionalContext,
  buildInstitutionalReasons,
  buildSymbolInstitutionalContext,
  institutionalContextForPayload
} from "./institutional-context.js";
import { readLatestScan, saveLatestScan } from "./storage.js";
import { sendTelegramSummary } from "./telegram.js";
import { tradeSettingsSummary, updateTradeJournal } from "./trade-journal.js";
import { buildGtfContext } from "./gtf-context.js";
import { applyAiDecisionReview } from "./ai-decision-review.js";
import { portfolioSummary, totalRealizedPnl } from "./portfolio-engine.js";

export async function runScreener(options = {}) {
  const config = options.config || appConfig;
  const previousScan = readLatestScan();
  const rules = config.rules;
  const fundamentals = createFundamentalsService(config);
  const listFilter = options.listId || "all";
  const lists = config.lists.filter((list) => listFilter === "all" || list.id === listFilter);

  const benchmarkDaily = await fetchBenchmarkCandles(
    config.benchmarkSymbol,
    "1d",
    config.priceHistoryYears || 5
  );
  const benchmarkWeekly = aggregateDailyToCompletedWeeks(benchmarkDaily);
  const marketContext = buildMarketContext(benchmarkDaily, rules);
  const institutionalContext = await buildInstitutionalContext(config, benchmarkDaily, marketContext);

  const scannedLists = {};
  const scanCache = new Map();

  for (const list of lists) {
    const watchlist = loadWatchlist(list.path, config.maxSymbols);
    const results = await mapLimit(watchlist, config.scanConcurrency, async (item) => {
      try {
        const allowBseFallback = list.id === "custom" && item.yahooSymbol.endsWith(".NS");
        const cacheKey = `${item.yahooSymbol}|${allowBseFallback ? "cross-exchange" : "primary"}`;
        if (!scanCache.has(cacheKey)) {
          scanCache.set(
            cacheKey,
            scanSymbol(
              item,
              benchmarkDaily,
              benchmarkWeekly,
              rules,
              fundamentals,
              marketContext,
              institutionalContext,
              { allowBseFallback, historyYears: config.priceHistoryYears || 5 }
            )
          );
        }
        const core = await scanCache.get(cacheKey);
        return {
          ...core,
          listId: list.id,
          listLabel: list.label,
          symbol: item.symbol,
          requestedYahooSymbol: item.yahooSymbol,
          yahooSymbol: core.resolvedYahooSymbol || item.yahooSymbol,
          exchangeFallback:
            String(core.resolvedYahooSymbol || item.yahooSymbol).toUpperCase() !==
            String(item.yahooSymbol).toUpperCase(),
          name: item.name,
          industry: item.industry,
          searchAliases: item.searchAliases
        };
      } catch (error) {
        const failure = classifyScanFailure(error);
        return {
          listId: list.id,
          listLabel: list.label,
          symbol: item.symbol,
          requestedYahooSymbol: item.yahooSymbol,
          yahooSymbol: item.yahooSymbol,
          exchangeFallback: false,
          name: item.name,
          industry: item.industry,
          searchAliases: item.searchAliases,
          status: failure.status,
          error: failure.status === "ERROR" ? failure.message : undefined,
          dataGapCode: failure.code,
          signalReason: [failure.reason],
          score: 0,
          fundamentalScore: 0
        };
      }
    });

    const freshnessSafeResults = reconcileResultFreshness(
      results,
      previousScan?.lists?.[list.id]?.results || []
    );
    const sorted = applySectorStrength(freshnessSafeResults, rules).sort(sortResults);
    scannedLists[list.id] = {
      id: list.id,
      label: list.label,
      editable: list.editable,
      summary: summarize(sorted),
      results: sorted
    };
  }

  const aiReview = await applyAiDecisionReview(scannedLists);

  fundamentals.save();

  const previous = listFilter === "all" ? null : previousScan;
  const mergedLists = {
    ...(previous?.lists || {}),
    ...scannedLists
  };
  const allResults = uniqueResults(mergedLists);
  const scannedAt = new Date().toISOString();
  const payload = {
    scannedAt,
    fullScanAt: scannedAt,
    executionPassAt: previousScan?.executionPassAt || null,
    scanMode: "FULL_SCAN",
    benchmark: config.benchmarkSymbol,
    benchmarkLabel: config.benchmarkLabel || rules.benchmarkLabel || config.benchmarkSymbol,
    lists: mergedLists,
    scannedListIds: lists.map((list) => list.id),
    marketContext,
    institutionalContext: institutionalContextForPayload(institutionalContext),
    aiReview,
    tradeSettings: tradeSettingsSummary(config),
    rules,
    summary: summarize(allResults)
  };

  saveLatestScan(payload);
  const journal = await updateTradeJournal(payload, { ...config, marketContext }, {
    publishActionAlerts: options.publishActionAlerts === true
  });
  const visibleTrades = journal.visibleTrades || journal.trades;
  payload.tradeSummary = summarizeTrades(visibleTrades);
  payload.portfolioSummary = visiblePortfolioSummary(journal, config);
  payload.portfolioRules = journal.portfolioRules;
  payload.corporateActionStatus = journal.corporateActionStatus;
  payload.waitingCandidates = journal.visibleCandidates || journal.candidates || [];
  payload.candidateDecisionLog = journal.visibleCandidateDecisions || [];
  payload.alertHistory = journal.alertHistory || [];
  payload.trades = visibleTrades;
  payload.tradeEvents = mergeTradeEvents(
    shouldRetryTradeEvents(previousScan, options, config, payload.scannedAt)
      ? previousScan.tradeEvents
      : [],
    journal.events
  );
  saveLatestScan(payload);

  let telegram = { sent: false, reason: "disabled" };
  if (options.sendTelegram) {
    try {
      telegram = await sendTelegramSummary(payload, config);
    } catch (error) {
      telegram = {
        sent: false,
        reason: error.message || String(error)
      };
      console.error(`Telegram alert failed: ${telegram.reason}`);
    }
  }

  const finalPayload = { ...payload, telegram };
  saveLatestScan(finalPayload);
  return finalPayload;
}

export function reconcileResultFreshness(currentRows = [], previousRows = []) {
  const previousBySymbol = new Map(
    previousRows.filter((row) => row?.symbol).map((row) => [row.symbol, row])
  );
  return currentRows.map((current) => {
    const previous = previousBySymbol.get(current?.symbol);
    if (!previous?.asOf || !current?.asOf || current.asOf >= previous.asOf) return current;
    const hasWeeklyEmaEvidence = Number.isFinite(Number(current.weeklyEma13));
    const weeklyFields = hasWeeklyEmaEvidence
      ? {
          weeklyAsOf: current.weeklyAsOf || previous.weeklyAsOf,
          weeklyClose: current.weeklyClose,
          weeklyEma13: current.weeklyEma13,
          weeklyEma13Source: current.weeklyEma13Source || "low",
          weeklyPriceAboveEma13: current.weeklyPriceAboveEma13,
          weeklyEma13Rising: current.weeklyEma13Rising,
          weeklyEma13Reclaim: current.weeklyEma13Reclaim,
          weeklyEma13BelowCloses: current.weeklyEma13BelowCloses,
          setupStrength: mergeWeeklyEmaSetup(previous.setupStrength, current.setupStrength),
          exitChecks: {
            ...(previous.exitChecks || {}),
            weeklyEma13: current.exitChecks?.weeklyEma13 === true
          }
        }
      : {};
    const weeklyMomentumExit = hasWeeklyEmaEvidence && current.exitChecks?.weeklyEma13 === true;
    const weeklyExitReasons = weeklyMomentumExit
      ? (current.signalReason || []).filter((reason) => /weekly.*EMA13|weekly momentum/i.test(reason))
      : [];
    return {
      ...previous,
      ...weeklyFields,
      status: weeklyMomentumExit ? "EXIT" : previous.status,
      signalReason: weeklyMomentumExit
        ? [...weeklyExitReasons, ...(previous.signalReason || []).filter((reason) => !/execution plan/i.test(reason))]
        : previous.signalReason,
      executionPlan: weeklyMomentumExit ? "SELL_NEXT_SESSION_0915_IF_OPEN" : previous.executionPlan,
      entryStyle: current.weeklyEma13Reclaim ? current.entryStyle : previous.entryStyle,
      listId: current.listId,
      listLabel: current.listLabel,
      symbol: current.symbol,
      requestedYahooSymbol: current.requestedYahooSymbol || previous.requestedYahooSymbol,
      yahooSymbol: current.yahooSymbol || previous.yahooSymbol,
      resolvedYahooSymbol: current.resolvedYahooSymbol || previous.resolvedYahooSymbol,
      exchangeFallback: current.exchangeFallback === true,
      name: current.name || previous.name,
      industry: current.industry || previous.industry,
      dataFreshness: {
        status: "PRESERVED_NEWER_CLOSE",
        preservedAsOf: previous.asOf,
        fetchedAsOf: current.asOf
      }
    };
  });
}

function mergeWeeklyEmaSetup(previousSetup = {}, currentSetup = {}) {
  const currentChecks = currentSetup?.checks || {};
  const currentValues = currentSetup?.values || {};
  return {
    ...previousSetup,
    checks: {
      ...(previousSetup?.checks || {}),
      weeklyCloseAboveEma13: currentChecks.weeklyCloseAboveEma13,
      weeklyEma13Rising: currentChecks.weeklyEma13Rising,
      weeklyEma13Reclaim: currentChecks.weeklyEma13Reclaim
    },
    values: {
      ...(previousSetup?.values || {}),
      weeklyClose: currentValues.weeklyClose,
      weeklyEma13: currentValues.weeklyEma13,
      weeklyEma13Source: currentValues.weeklyEma13Source || "low",
      weeklyEma13Previous: currentValues.weeklyEma13Previous,
      weeklyEma13DistancePct: currentValues.weeklyEma13DistancePct,
      weeklyEma13BelowCloses: currentValues.weeklyEma13BelowCloses,
      weeklyEma13Period: currentValues.weeklyEma13Period
    }
  };
}

export async function runExecutionPass(options = {}) {
  const config = options.config || appConfig;
  const previousScan = readLatestScan();
  if (!previousScan?.lists || !Array.isArray(previousScan.trades)) {
    throw new Error("Execution pass requires an existing completed market scan.");
  }

  const checkedAt = new Date().toISOString();
  if (!hasPendingExecutionWork(previousScan.trades)) {
    return {
      ...previousScan,
      executionPass: {
        status: "NO_PENDING_ORDERS",
        checkedAt
      }
    };
  }

  const payload = {
    ...previousScan,
    scannedAt: checkedAt,
    fullScanAt: previousScan.fullScanAt || previousScan.scannedAt,
    executionPassAt: checkedAt,
    scanMode: "EXECUTION_PASS",
    tradeSettings: tradeSettingsSummary(config),
    executionPass: {
      status: "PROCESSED",
      checkedAt,
      priceRule: "Exact 09:17 one-minute candle open"
    }
  };

  const journal = await updateTradeJournal(payload, {
    ...config,
    marketContext: payload.marketContext
  }, {
    publishActionAlerts: false
  });
  const visibleTrades = journal.visibleTrades || journal.trades;
  payload.tradeSummary = summarizeTrades(visibleTrades);
  payload.portfolioSummary = visiblePortfolioSummary(journal, config);
  payload.portfolioRules = journal.portfolioRules;
  payload.corporateActionStatus = journal.corporateActionStatus;
  payload.waitingCandidates = journal.visibleCandidates || journal.candidates || [];
  payload.candidateDecisionLog = journal.visibleCandidateDecisions || [];
  payload.alertHistory = journal.alertHistory || [];
  payload.trades = visibleTrades;
  payload.tradeEvents = mergeTradeEvents(
    shouldRetryTradeEvents(previousScan, options, config, checkedAt)
      ? previousScan.tradeEvents
      : [],
    journal.events
  );
  saveLatestScan(payload);

  let telegram = { sent: false, reason: "disabled" };
  if (options.sendTelegram) {
    try {
      telegram = await sendTelegramSummary(payload, config);
    } catch (error) {
      telegram = { sent: false, reason: error.message || String(error) };
      console.error(`Telegram alert failed: ${telegram.reason}`);
    }
  }

  const finalPayload = { ...payload, telegram };
  saveLatestScan(finalPayload);
  return finalPayload;
}

export function hasPendingExecutionWork(trades = []) {
  return trades.some((trade) =>
    (trade.status === "PENDING_ENTRY" && trade.orderState === "CONFIRMED_FOR_0917") ||
    (trade.status === "PENDING_EXIT" && trade.exitOrderState === "CONFIRMED_FOR_0917") ||
    (trade.status === "PENDING_PARTIAL_EXIT" && trade.partialExitOrderState === "CONFIRMED_FOR_0917") ||
    (trade.status === "OPEN" && trade.pendingAdd?.orderState === "CONFIRMED_FOR_0917")
  );
}

function shouldRetryTradeEvents(previousScan, options, config, currentScanAt) {
  const previousTime = new Date(previousScan?.scannedAt || 0).getTime();
  const currentTime = new Date(currentScanAt || Date.now()).getTime();
  const ageHours = (currentTime - previousTime) / (60 * 60 * 1000);
  const retryHours = config.telegram?.retryFailedEventsMaxHours ?? 12;
  return (
    options.sendTelegram === true &&
    Array.isArray(previousScan?.tradeEvents) &&
    previousScan.tradeEvents.length > 0 &&
    previousScan.telegram?.sent !== true &&
    Number.isFinite(ageHours) &&
    ageHours >= 0 &&
    ageHours <= retryHours
  );
}

function mergeTradeEvents(previousEvents, currentEvents) {
  const output = [];
  const seen = new Set();
  for (const event of [...(previousEvents || []), ...(currentEvents || [])]) {
    const key = [
      event?.type || "",
      event?.trade?.id || "",
      event?.trade?.symbol || "",
      event?.trade?.entrySignalDate || "",
      event?.trade?.exitSignalDate || ""
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(event);
  }
  return output;
}

export function visiblePortfolioSummary(journal = {}, config = appConfig) {
  const visibleTrades = journal.visibleTrades || journal.trades || [];
  const visibleCandidates = journal.visibleCandidates || journal.candidates || [];
  return portfolioSummary(visibleTrades, visibleCandidates, config);
}

export function summarizeTrades(trades) {
  const active = trades.filter((trade) => ["OPEN", "PENDING_EXIT", "PENDING_PARTIAL_EXIT"].includes(trade.status));
  const closed = trades.filter((trade) => trade.status === "CLOSED");
  const pendingEntry = trades.filter((trade) => trade.status === "PENDING_ENTRY" && trade.orderState === "CONFIRMED_FOR_0917");
  const pendingExit = trades.filter((trade) => trade.status === "PENDING_EXIT" && trade.exitOrderState === "CONFIRMED_FOR_0917");
  const pendingPartialExit = trades.filter((trade) => trade.status === "PENDING_PARTIAL_EXIT" && trade.partialExitOrderState === "CONFIRMED_FOR_0917");
  return {
    open: active.length,
    closed: closed.length,
    pendingEntry: pendingEntry.length,
    pendingExit: pendingExit.length,
    pendingPartialExit: pendingPartialExit.length,
    realizedPnl: totalRealizedPnl(trades),
    tradeRealizedPnl: Number(trades.reduce((sum, trade) => {
      if (trade.status === "CLOSED") return sum + (Number(trade.pnl) || 0) - (Number(trade.dividendRealizedPnl) || 0);
      return sum + (Number(trade.tradeRealizedPnlToDate) || 0);
    }, 0).toFixed(2)),
    dividendRealizedPnl: Number(trades.reduce((sum, trade) => sum + (Number(trade.dividendRealizedPnl) || 0), 0).toFixed(2)),
    unrealizedPnl: Number(
      active.reduce((sum, trade) => sum + (Number(trade.unrealizedPnl) || 0), 0).toFixed(2)
    )
  };
}

class DataGapError extends Error {
  constructor(message, code = "DATA_UNAVAILABLE") {
    super(message);
    this.name = "DataGapError";
    this.code = code;
  }
}

export async function resolvePriceHistory(
  yahooSymbol,
  { allowBseFallback = false, fetcher = fetchCandles, historyYears = 5 } = {}
) {
  let primary = null;
  let primaryError = null;
  try {
    primary = {
      yahooSymbol,
      candles: await fetcher(yahooSymbol, "1d", historyYears)
    };
  } catch (error) {
    primaryError = error;
  }

  const canTryBse = allowBseFallback && String(yahooSymbol).endsWith(".NS");
  if (!canTryBse || historyReady(primary?.candles)) {
    if (primary) return primary;
    throw primaryError;
  }

  const bseSymbol = String(yahooSymbol).replace(/\.NS$/i, ".BO");
  let fallback = null;
  let fallbackError = null;
  try {
    fallback = {
      yahooSymbol: bseSymbol,
      candles: await fetcher(bseSymbol, "1d", historyYears)
    };
  } catch (error) {
    fallbackError = error;
  }

  if (historyReady(fallback?.candles)) return fallback;
  if (primary && fallback) return historyQuality(fallback.candles) > historyQuality(primary.candles) ? fallback : primary;
  if (primary) return primary;
  if (fallback) return fallback;

  if (isUnavailablePriceError(primaryError) && isUnavailablePriceError(fallbackError)) {
    throw new DataGapError(
      "Price history unavailable on both NSE and BSE. Verify the TradingView exchange prefix.",
      "SYMBOL_UNAVAILABLE"
    );
  }
  throw primaryError || fallbackError || new Error("Price history request failed");
}

export function classifyScanFailure(error) {
  const message = String(error?.message || error || "Unknown scan failure");
  if (error instanceof DataGapError) {
    return {
      status: "DATA_GAP",
      code: error.code,
      message,
      reason: message
    };
  }
  if (/not enough (daily|completed weekly) price history/i.test(message)) {
    return {
      status: "DATA_GAP",
      code: "INSUFFICIENT_HISTORY",
      message,
      reason: `History building: ${message.replace(/^not enough\s*/i, "")}.`
    };
  }
  if (isUnavailablePriceError(error)) {
    return {
      status: "DATA_GAP",
      code: "SYMBOL_UNAVAILABLE",
      message,
      reason: "Price history unavailable. Verify the TradingView exchange prefix or listing status."
    };
  }
  return {
    status: "ERROR",
    code: "SYSTEM_ERROR",
    message,
    reason: `System error after automatic retries: ${message}`
  };
}

function historyReady(candles = []) {
  return candles.length >= 65 && aggregateDailyToCompletedWeeks(candles).length >= 25;
}

function historyQuality(candles = []) {
  return candles.length + aggregateDailyToCompletedWeeks(candles).length * 3;
}

function isUnavailablePriceError(error) {
  return /404|not found|no data|delisted|invalid symbol/i.test(String(error?.message || error || ""));
}

async function scanSymbol(
  item,
  benchmarkDaily,
  benchmarkWeekly,
  rules,
  fundamentals,
  marketContext,
  institutionalMarketContext,
  options = {}
) {
  const priceHistory = await resolvePriceHistory(item.yahooSymbol, {
    allowBseFallback: options.allowBseFallback,
    historyYears: options.historyYears || 5
  });
  const dailyCandles = priceHistory.candles;
  const weeklyCandles = aggregateDailyToCompletedWeeks(dailyCandles);

  if (dailyCandles.length < 65) {
    throw new DataGapError(
      `History building: ${dailyCandles.length}/65 completed daily candles available.`,
      "INSUFFICIENT_DAILY_HISTORY"
    );
  }
  if (weeklyCandles.length < 25) {
    throw new DataGapError(
      `History building: ${weeklyCandles.length}/25 completed weekly candles available.`,
      "INSUFFICIENT_WEEKLY_HISTORY"
    );
  }

  const resolvedItem = { ...item, yahooSymbol: priceHistory.yahooSymbol };

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
  const weeklyEmaContext = buildWeeklyEmaContext(
    weeklyCandles,
    rules.exit?.weeklyEmaPeriod || rules.setupStrength?.weeklyEmaPeriod || 13,
    rules.exit?.weeklyEmaSource || rules.setupStrength?.weeklyEmaSource || "low"
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
    weeklyEmaContext,
    marketContext,
    rules
  });
  const gtfContext = buildGtfContext(
    dailyCandles,
    weeklyCandles,
    close,
    rules.gtfConfluence
  );

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
    weeklyRs: weeklyRs < (rules.exit?.weeklyRsBelow ?? 0),
    weeklyEma13: weeklyEmaContext.above === false
  };

  const entry = technicalReady && Object.values(entryChecks).every(Boolean);
  const exit = technicalReady && Object.values(exitChecks).some(Boolean);
  const status = !technicalReady ? "DATA_GAP" : exit ? "EXIT" : entry ? "ENTRY" : "WATCH";
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
  const exitReason = buildExitReasons(exitChecks, {
    weeklyRs,
    weeklyAsOf: weeklyEmaContext.asOf,
    weeklyClose: weeklyEmaContext.close,
    weeklyEma13: weeklyEmaContext.ema
  });
  const setupReason = buildSetupStrengthReasons(setupStrength);
  const institutionalContext = buildSymbolInstitutionalContext(resolvedItem, institutionalMarketContext);
  const institutionalReason = buildInstitutionalReasons(institutionalContext);
  const entryStyle = buildEntryStyle(setupStrength);
  const weaknessReason = buildWeaknessReasons({
    dailyShortRs,
    dailyLongRs,
    close,
    dailySupertrend,
    weeklyEmaContext,
    setupStrength
  });
  const signalReason =
    status === "ENTRY"
      ? [
          ...entryReason,
          `Entry style: ${entryStyle.label}.`,
          ...setupReason,
          ...gtfContext.reasons,
          ...institutionalReason,
          `Execution plan: buy on the next actual market session using the exact 09:17 one-minute candle open; weekends and exchange holidays are skipped.`
        ]
      : status === "EXIT"
        ? [
            ...exitReason,
            `Execution plan for an open position: sell on the next actual market session using the exact 09:17 one-minute candle open; weekends and exchange holidays are skipped.`
          ]
        : technicalReady
          ? ["No entry: one or more compulsory entry checks are not satisfied.", ...weaknessReason]
          : ["Indicator data gap: one or more required calculations are not yet finite."];

  const technicalScore = Object.values(entryChecks).filter(Boolean).length;
  const fundamental =
    technicalScore >= 4
      ? await fundamentals.get(priceHistory.yahooSymbol, dailyCandles)
      : emptyFundamentals("Skipped until at least 4/6 compulsory technical checks pass.");
  const institutionalScore = institutionalContext.score || 0;
  const gtfScore = gtfScoreContribution(gtfContext);
  const setupStrengthScore = setupStrength.score + institutionalScore + gtfScore;

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
    status,
    asOf: dailyCandles[latestDailyIndex].date,
    requestedYahooSymbol: item.yahooSymbol,
    resolvedYahooSymbol: priceHistory.yahooSymbol,
    exchangeFallback:
      String(priceHistory.yahooSymbol).toUpperCase() !== String(item.yahooSymbol).toUpperCase(),
    weeklyAsOf: weeklyCandles[latestWeeklyIndex].date,
    close,
    dailyRsi,
    weeklyRsi,
    weeklyRs,
    dailyLongRs,
    dailyShortRs,
    dailySupertrend,
    weeklyClose: weeklyEmaContext.close,
    weeklyEma13: weeklyEmaContext.ema,
    weeklyEma13Source: weeklyEmaContext.source,
    weeklyPriceAboveEma13: weeklyEmaContext.above,
    weeklyEma13Rising: weeklyEmaContext.rising,
    weeklyEma13Reclaim: weeklyEmaContext.reclaim,
    weeklyEma13BelowCloses: weeklyEmaContext.consecutiveBelow,
    dailyPriceAboveSupertrend: close > dailySupertrend,
    entryChecks,
    exitChecks,
    signalReason,
    executionPlan:
      status === "ENTRY"
        ? "BUY_NEXT_SESSION_0915"
        : status === "EXIT"
          ? "SELL_NEXT_SESSION_0915_IF_OPEN"
          : "NONE",
    priceConfirmationScore: [weeklyPriceOk, dailyLongPriceOk, dailyShortPriceOk].filter(Boolean).length,
    entryStyle,
    setupStrength,
    gtfContext,
    gtfScore,
    institutionalContext,
    institutionalScore,
    fundamental,
    technicalScore,
    setupStrengthScore,
    fundamentalScore: fundamental.score,
    setupGrade: setupGrade(technicalScore, setupStrengthScore, fundamental.score),
    sectorStrengthScore: 0,
    score: technicalScore + setupStrengthScore + fundamental.score
  };
}

export function buildWeeklyEmaContext(weeklyCandles = [], period = 13, source = "low") {
  const normalizedPeriod = Math.max(2, Math.floor(Number(period) || 13));
  const normalizedSource = String(source || "low").trim().toLowerCase();
  if (normalizedSource !== "low") throw new Error("Weekly EMA13 source must be low");
  const series = exponentialMovingAverage(weeklyCandles, normalizedPeriod, normalizedSource);
  const latestIndex = weeklyCandles.length - 1;
  const previousIndex = latestIndex - 1;
  const close = Number(weeklyCandles[latestIndex]?.close);
  const ema = Number.isFinite(series[latestIndex]) ? Number(series[latestIndex]) : Number.NaN;
  const previousClose = Number(weeklyCandles[previousIndex]?.close);
  const previousEma = Number.isFinite(series[previousIndex]) ? Number(series[previousIndex]) : Number.NaN;
  const available = Number.isFinite(close) && Number.isFinite(ema);
  const previousAvailable = Number.isFinite(previousClose) && Number.isFinite(previousEma);
  let consecutiveBelow = 0;

  for (let index = latestIndex; index >= 0; index -= 1) {
    const candleClose = Number(weeklyCandles[index]?.close);
    const candleEma = Number(series[index]);
    if (!Number.isFinite(candleClose) || !Number.isFinite(candleEma) || candleClose >= candleEma) break;
    consecutiveBelow += 1;
  }

  return {
    period: normalizedPeriod,
    source: normalizedSource,
    asOf: weeklyCandles[latestIndex]?.date || null,
    close: available ? close : null,
    ema: available ? ema : null,
    previousClose: previousAvailable ? previousClose : null,
    previousEma: previousAvailable ? previousEma : null,
    above: available ? close >= ema : null,
    rising: available && previousAvailable ? ema > previousEma : null,
    reclaim: available && previousAvailable ? close >= ema && previousClose < previousEma : false,
    consecutiveBelow,
    distancePct: available && ema > 0 ? ((close - ema) / ema) * 100 : null
  };
}

function buildSetupStrength({
  dailyCandles,
  close,
  dailySupertrend,
  weeklyRsSeries,
  dailyLongRsSeries,
  dailyShortRsSeries,
  weeklyEmaContext,
  marketContext,
  rules
}) {
  const setupRules = rules.setupStrength || {};
  const latestDailyIndex = dailyCandles.length - 1;
  const previousCandle = dailyCandles[latestDailyIndex - 1] || null;
  const currentCandle = dailyCandles[latestDailyIndex] || null;
  const recentHighPeriod = setupRules.dailyRecentHighPeriod || 55;
  const baseBreakoutPeriod = setupRules.baseBreakoutPeriod || 20;
  const yearHighPeriod = setupRules.dailyYearHighPeriod || 252;
  const volumeAveragePeriod = setupRules.volumeAveragePeriod || 50;
  const volumeExpansionMultiple = setupRules.volumeExpansionMultiple || 1.5;
  const nearYearHighPct = setupRules.nearYearHighPct || 15;
  const riskToSupertrendMaxPct = setupRules.riskToSupertrendMaxPct || 7;
  const rsTrendLookback = setupRules.rsTrendLookback || 5;
  const smaFastPeriod = setupRules.smaFastPeriod || 50;
  const smaSlowPeriod = setupRules.smaSlowPeriod || 200;
  const atrPeriod = setupRules.atrPeriod || 14;
  const maxAtrPct = setupRules.maxAtrPct || 8;
  const minimumAverageTurnover = setupRules.minimumAverageTurnover || 10_000_000;

  const priorRecentHigh = highestHigh(dailyCandles, recentHighPeriod, latestDailyIndex - 1);
  const priorBaseHigh = highestHigh(dailyCandles, baseBreakoutPeriod, latestDailyIndex - 1);
  const recentBaseLow = lowestLow(dailyCandles, Math.floor(baseBreakoutPeriod / 2), latestDailyIndex - 1);
  const previousBaseLow = lowestLow(
    dailyCandles,
    Math.floor(baseBreakoutPeriod / 2),
    latestDailyIndex - 1 - Math.floor(baseBreakoutPeriod / 2)
  );
  const priorYearHigh = highestHigh(dailyCandles, yearHighPeriod, latestDailyIndex - 1);
  const recentHighBreakout = Number.isFinite(priorRecentHigh) && close > priorRecentHigh;
  const baseBreakout = Number.isFinite(priorBaseHigh) && close > priorBaseHigh;
  const higherLowStructure =
    Number.isFinite(recentBaseLow) && Number.isFinite(previousBaseLow) && recentBaseLow > previousBaseLow;
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
  const atr = latestValue(calculateAtr(dailyCandles, atrPeriod));
  const atrPct = Number.isFinite(atr) && close > 0 ? (atr / close) * 100 : null;
  const controlledVolatility = Number.isFinite(atrPct) && atrPct <= maxAtrPct;
  const averageTurnover = averageTradedValue(dailyCandles, 20, latestDailyIndex);
  const liquidEnough =
    Number.isFinite(averageTurnover) && averageTurnover >= minimumAverageTurnover;
  const candle = candleSignals(previousCandle, currentCandle);
  const macd = calculateMacd(dailyCandles);
  const macdValue = latestValue(macd.macd);
  const macdSignal = latestValue(macd.signal);
  const macdHistogram = latestValue(macd.histogram);
  const macdBullish =
    Number.isFinite(macdValue) && Number.isFinite(macdSignal) && macdValue > 0 && macdValue > macdSignal;
  const obvSeries = calculateObv(dailyCandles);
  const obvRising = risingOverLookback(obvSeries, 10);
  const marketRegimeStrong = marketContext?.strong === true;

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
  const fibonacci = buildFibonacciContext(dailyCandles, latestDailyIndex, close, setupRules);
  const bollinger = buildBollingerContext(dailyCandles, latestDailyIndex, close, setupRules);
  const retracement = buildRetracementContext({
    dailyCandles,
    latestDailyIndex,
    close,
    dailySupertrend,
    priorRecentHigh,
    smaFast,
    smaSlow,
    volumeAverage,
    volumeRatio,
    candle,
    fibonacci,
    setupRules
  });
  const pyramidStructure = buildPyramidStructure(dailyCandles, setupRules);

  const checks = {
    recentHighBreakout,
    baseBreakout,
    higherLowStructure,
    yearHighBreakout,
    nearYearHigh,
    volumeExpansion,
    weeklyRsRising,
    dailyLongRsRising,
    dailyShortRsRising,
    weeklyCloseAboveEma13: weeklyEmaContext?.above === true,
    weeklyEma13Rising: weeklyEmaContext?.rising === true,
    weeklyEma13Reclaim: weeklyEmaContext?.reclaim === true,
    closeAboveSmaFast,
    closeAboveSmaSlow,
    smaFastAboveSlow,
    favorableRiskToSupertrend,
    controlledVolatility,
    liquidEnough,
    bullishCandleConfirmation: candle.bullishConfirmation,
    bullishEngulfing: candle.bullishEngulfing,
    hammer: candle.hammer,
    macdBullish,
    obvRising,
    retracementBuyZone: retracement.retracementBuyZone,
    fibonacciSupportNearby: fibonacci.supportNearby,
    bollingerTrendSupport: bollinger.trendSupport,
    bollingerRangeBound: bollinger.rangeBound,
    marketRegimeStrong
  };

  return {
    score: Object.entries(checks)
      .filter(([key, value]) =>
        value && ![
          "fibonacciSupportNearby",
          "bollingerTrendSupport",
          "bollingerRangeBound",
          "weeklyEma13Reclaim"
        ].includes(key)
      ).length,
    checks,
    pyramidStructure,
    values: {
      priorRecentHigh,
      priorBaseHigh,
      recentBaseLow,
      previousBaseLow,
      macd: macdValue,
      macdSignal,
      macdHistogram,
      priorYearHigh,
      volumeAverage,
      volumeRatio,
      smaFast,
      smaSlow,
      atr,
      atrPct,
      averageTurnover,
      previousLow,
      twoCandleLow,
      fourCandleLow,
      riskToSupertrendPct,
      riskToPreviousLowPct,
      weeklyClose: weeklyEmaContext?.close ?? null,
      weeklyEma13: weeklyEmaContext?.ema ?? null,
      weeklyEma13Source: weeklyEmaContext?.source || "low",
      weeklyEma13Previous: weeklyEmaContext?.previousEma ?? null,
      weeklyEma13DistancePct: weeklyEmaContext?.distancePct ?? null,
      weeklyEma13BelowCloses: weeklyEmaContext?.consecutiveBelow ?? 0,
      weeklyEma13Period: weeklyEmaContext?.period || 13,
      retracementPullbackDepthPct: retracement.pullbackDepthPct,
      retracementSupportSource: retracement.supportSource,
      retracementSupportReference: retracement.supportReference,
      retracementSupportDistancePct: retracement.supportDistancePct,
      retracementPullbackVolumeRatio: retracement.pullbackVolumeRatio,
      retracementCurrentVolumeRatio: retracement.currentVolumeRatio,
      retracementCloseLocationPct: retracement.closeLocationPct,
      retracementPullbackDepthOk: retracement.pullbackDepthOk,
      retracementSupportProximityOk: retracement.supportProximityOk,
      retracementVolumePatternOk: retracement.volumePatternOk,
      retracementReclaimCandleOk: retracement.reclaimCandleOk,
      retracementRiskOk: retracement.riskOk,
      retracementTrendHoldOk: retracement.trendHoldOk,
      retracementPatternLabel: retracement.patternLabel,
      retracementLookback: retracement.lookback,
      retracementMinPullbackPct: retracement.minPullbackPct,
      retracementMaxPullbackPct: retracement.maxPullbackPct,
      retracementSupportProximityPct: retracement.supportProximityPct,
      retracementBreakoutRetestPct: retracement.breakoutRetestPct,
      retracementDryVolumeMaxRatio: retracement.dryVolumeMaxRatio,
      retracementReclaimVolumeMinRatio: retracement.reclaimVolumeMinRatio,
      retracementMaxRiskPct: retracement.maxRiskPct,
      fibonacciSwingHigh: fibonacci.swingHigh,
      fibonacciSwingLow: fibonacci.swingLow,
      fibonacciNearestLevel: fibonacci.nearestLevel,
      fibonacciNearestPrice: fibonacci.nearestPrice,
      fibonacciDistancePct: fibonacci.distancePct,
      fibonacciSupportNearby: fibonacci.supportNearby,
      bollingerMiddle: bollinger.middle,
      bollingerUpper: bollinger.upper,
      bollingerLower: bollinger.lower,
      bollingerPercentB: bollinger.percentB,
      bollingerBandwidthPct: bollinger.bandwidthPct,
      bollingerRangeBound: bollinger.rangeBound,
      recentHighPeriod,
      baseBreakoutPeriod,
      yearHighPeriod,
      nearYearHighPct,
      volumeAveragePeriod,
      volumeExpansionMultiple,
      riskToSupertrendMaxPct,
      smaFastPeriod,
      smaSlowPeriod,
      atrPeriod,
      maxAtrPct,
      minimumAverageTurnover,
      candlePattern: candle.label,
      marketRegimeLabel: marketContext?.label || "Unknown"
    }
  };
}

export function buildPyramidStructure(dailyCandles = [], setupRules = {}) {
  const pivotBars = Math.max(1, Math.floor(Number(setupRules.pyramidPivotBars) || 2));
  const lookback = Math.max(
    pivotBars * 2 + 1,
    Math.floor(Number(setupRules.pyramidSwingLookback) || 160)
  );
  const maximumPoints = Math.max(
    6,
    Math.floor(Number(setupRules.pyramidMaximumPoints) || 24)
  );
  const latestIndex = dailyCandles.length - 1;
  const startIndex = Math.max(pivotBars, latestIndex - lookback + 1);
  const lastConfirmedIndex = latestIndex - pivotBars;
  const points = [];

  for (let index = startIndex; index <= lastConfirmedIndex; index += 1) {
    const candle = dailyCandles[index];
    if (!candle?.date || !Number.isFinite(candle.high) || !Number.isFinite(candle.low)) continue;
    const left = dailyCandles.slice(index - pivotBars, index);
    const right = dailyCandles.slice(index + 1, index + pivotBars + 1);
    const pivotHigh =
      left.every((item) => Number.isFinite(item?.high) && candle.high > item.high) &&
      right.every((item) => Number.isFinite(item?.high) && candle.high >= item.high);
    const pivotLow =
      left.every((item) => Number.isFinite(item?.low) && candle.low < item.low) &&
      right.every((item) => Number.isFinite(item?.low) && candle.low <= item.low);
    if (pivotHigh) points.push({ date: candle.date, type: "HIGH", price: candle.high });
    if (pivotLow) points.push({ date: candle.date, type: "LOW", price: candle.low });
  }

  return {
    pivotBars,
    lookback,
    latestDate: dailyCandles[latestIndex]?.date || null,
    latestClose: dailyCandles[latestIndex]?.close ?? null,
    previousDate: dailyCandles[latestIndex - 1]?.date || null,
    previousClose: dailyCandles[latestIndex - 1]?.close ?? null,
    points: points.slice(-maximumPoints)
  };
}

function buildRetracementContext({
  dailyCandles,
  latestDailyIndex,
  close,
  dailySupertrend,
  priorRecentHigh,
  smaFast,
  smaSlow,
  volumeAverage,
  volumeRatio,
  candle,
  fibonacci,
  setupRules
}) {
  const currentCandle = dailyCandles[latestDailyIndex] || null;
  const previousCandle = dailyCandles[latestDailyIndex - 1] || null;
  const lookback = setupRules.retracementLookback || 5;
  const minPullbackPct = setupRules.retracementMinPullbackPct ?? 2;
  const maxPullbackPct = setupRules.retracementMaxPullbackPct ?? 15;
  const supportProximityPct = setupRules.retracementSupportProximityPct ?? 5;
  const breakoutRetestPct = setupRules.retracementBreakoutRetestPct ?? 3;
  const dryVolumeMaxRatio = setupRules.retracementDryVolumeMaxRatio ?? 0.9;
  const reclaimVolumeMinRatio = setupRules.retracementReclaimVolumeMinRatio ?? 1.1;
  const maxRiskPct = setupRules.retracementMaxRiskPct ?? 8;

  const pullbackDepthPct =
    Number.isFinite(priorRecentHigh) && priorRecentHigh > 0 && close < priorRecentHigh
      ? ((priorRecentHigh - close) / priorRecentHigh) * 100
      : 0;
  const pullbackDepthOk =
    Number.isFinite(pullbackDepthPct) &&
    pullbackDepthPct >= minPullbackPct &&
    pullbackDepthPct <= maxPullbackPct;
  const supportCandidates = [
    supportCandidate("Supertrend", dailySupertrend, close),
    supportCandidate(`${setupRules.smaFastPeriod || 50}-DMA`, smaFast, close),
    supportCandidate(`${setupRules.smaSlowPeriod || 200}-DMA`, smaSlow, close),
    supportCandidate(
      `Fibonacci ${fibonacci?.nearestLevel || "retracement"}`,
      fibonacci?.supportNearby ? fibonacci.nearestPrice : null,
      close
    )
  ].filter(Boolean);
  const nearestSupport = supportCandidates.sort((a, b) => a.distancePct - b.distancePct)[0] || null;
  const breakoutRetestDistancePct =
    Number.isFinite(priorRecentHigh) && priorRecentHigh > 0 && close > 0
      ? Math.abs((close - priorRecentHigh) / close) * 100
      : null;
  const breakoutRetest =
    Number.isFinite(breakoutRetestDistancePct) && breakoutRetestDistancePct <= breakoutRetestPct;
  const supportSource = breakoutRetest
    ? `${setupRules.dailyRecentHighPeriod || 55}D high retest`
    : nearestSupport?.source || "";
  const supportReference = breakoutRetest ? priorRecentHigh : nearestSupport?.value ?? null;
  const supportDistancePct = breakoutRetest
    ? breakoutRetestDistancePct
    : nearestSupport?.distancePct ?? null;
  const supportProximityOk =
    Number.isFinite(supportDistancePct) && supportDistancePct <= supportProximityPct;
  const pullbackVolumeAverage = averageVolume(dailyCandles, lookback, latestDailyIndex - 1);
  const pullbackVolumeRatio =
    Number.isFinite(pullbackVolumeAverage) && Number.isFinite(volumeAverage) && volumeAverage > 0
      ? pullbackVolumeAverage / volumeAverage
      : null;
  const dryPullbackVolume =
    Number.isFinite(pullbackVolumeRatio) && pullbackVolumeRatio <= dryVolumeMaxRatio;
  const reclaimVolume =
    Number.isFinite(volumeRatio) && volumeRatio >= reclaimVolumeMinRatio;
  const volumePatternOk = dryPullbackVolume || reclaimVolume;
  const closeLocationPct =
    Number.isFinite(currentCandle?.high) &&
    Number.isFinite(currentCandle?.low) &&
    currentCandle.high > currentCandle.low
      ? ((close - currentCandle.low) / (currentCandle.high - currentCandle.low)) * 100
      : null;
  const reclaimCandleOk =
    candle.bullishConfirmation ||
    candle.bullishEngulfing ||
    candle.hammer ||
    (
      Number.isFinite(currentCandle?.open) &&
      Number.isFinite(previousCandle?.close) &&
      currentCandle.close > currentCandle.open &&
      currentCandle.close > previousCandle.close &&
      Number.isFinite(closeLocationPct) &&
      closeLocationPct >= 55
    );
  const riskOk =
    Number.isFinite(supportDistancePct) &&
    supportDistancePct >= 0 &&
    supportDistancePct <= maxRiskPct;
  const trendHoldOk =
    Number.isFinite(dailySupertrend) &&
    close > dailySupertrend &&
    (Number.isFinite(smaFast) ? close >= smaFast * 0.98 : true);
  const retracementBuyZone =
    pullbackDepthOk &&
    supportProximityOk &&
    volumePatternOk &&
    reclaimCandleOk &&
    riskOk &&
    trendHoldOk;
  const patternLabel = retracementBuyZone
    ? `Pullback ${fmt(pullbackDepthPct)}% to ${supportSource}`
    : pullbackDepthOk
      ? `Pullback present, waiting for support/reclaim confirmation`
      : "No institutional retracement setup";

  return {
    retracementBuyZone,
    pullbackDepthPct,
    supportSource,
    supportReference,
    supportDistancePct,
    pullbackVolumeRatio,
    currentVolumeRatio: volumeRatio,
    closeLocationPct,
    pullbackDepthOk,
    supportProximityOk,
    dryPullbackVolume,
    reclaimVolume,
    volumePatternOk,
    reclaimCandleOk,
    riskOk,
    trendHoldOk,
    breakoutRetest,
    patternLabel,
    lookback,
    minPullbackPct,
    maxPullbackPct,
    supportProximityPct,
    breakoutRetestPct,
    dryVolumeMaxRatio,
    reclaimVolumeMinRatio,
    maxRiskPct
  };
}

function buildFibonacciContext(dailyCandles, latestDailyIndex, close, setupRules) {
  const lookback = setupRules.fibonacciLookback || 55;
  const proximityPct = setupRules.fibonacciProximityPct ?? 2;
  const swingHigh = highestHigh(dailyCandles, lookback, latestDailyIndex - 1);
  const swingLow = lowestLow(dailyCandles, lookback, latestDailyIndex - 1);
  if (!Number.isFinite(swingHigh) || !Number.isFinite(swingLow) || swingHigh <= swingLow) {
    return { swingHigh, swingLow, nearestLevel: null, nearestPrice: null, distancePct: null, supportNearby: false };
  }

  const range = swingHigh - swingLow;
  const levels = [
    { label: "38.2%", price: swingHigh - range * 0.382 },
    { label: "50.0%", price: swingHigh - range * 0.5 },
    { label: "61.8%", price: swingHigh - range * 0.618 }
  ];
  const nearest = levels
    .map((level) => ({
      ...level,
      distancePct: Number.isFinite(close) && close > 0 ? Math.abs(close - level.price) / close * 100 : null
    }))
    .sort((a, b) => (a.distancePct ?? Infinity) - (b.distancePct ?? Infinity))[0];
  const supportNearby =
    Number.isFinite(nearest?.distancePct) &&
    nearest.distancePct <= proximityPct &&
    close >= nearest.price;
  return {
    swingHigh,
    swingLow,
    nearestLevel: nearest?.label || null,
    nearestPrice: nearest?.price ?? null,
    distancePct: nearest?.distancePct ?? null,
    supportNearby
  };
}

function buildBollingerContext(dailyCandles, latestDailyIndex, close, setupRules) {
  const period = setupRules.bollingerPeriod || 20;
  const multiplier = setupRules.bollingerStdDev ?? 2;
  const rangeBoundMaxBandwidthPct = setupRules.rangeBoundMaxBandwidthPct ?? 10;
  const closes = dailyCandles
    .slice(Math.max(0, latestDailyIndex - period + 1), latestDailyIndex + 1)
    .map((candle) => candle.close)
    .filter(Number.isFinite);
  if (closes.length < period) {
    return { middle: null, upper: null, lower: null, percentB: null, bandwidthPct: null, trendSupport: false, rangeBound: false };
  }
  const middle = closes.reduce((sum, value) => sum + value, 0) / closes.length;
  const variance = closes.reduce((sum, value) => sum + (value - middle) ** 2, 0) / closes.length;
  const deviation = Math.sqrt(variance);
  const upper = middle + multiplier * deviation;
  const lower = middle - multiplier * deviation;
  const width = upper - lower;
  const percentB = width > 0 ? (close - lower) / width : null;
  const bandwidthPct = middle > 0 ? width / middle * 100 : null;
  return {
    middle,
    upper,
    lower,
    percentB,
    bandwidthPct,
    trendSupport: Number.isFinite(close) && close >= middle,
    rangeBound: Number.isFinite(bandwidthPct) && bandwidthPct <= rangeBoundMaxBandwidthPct
  };
}

function supportCandidate(source, value, close) {
  if (!Number.isFinite(value) || !Number.isFinite(close) || close <= 0 || value <= 0) return null;
  if (value > close) return null;
  return {
    source,
    value,
    distancePct: ((close - value) / close) * 100
  };
}

function buildEntryStyle(setupStrength) {
  const checks = setupStrength?.checks || {};
  const values = setupStrength?.values || {};
  const breakout = checks.yearHighBreakout || checks.recentHighBreakout || checks.baseBreakout;
  if (checks.weeklyEma13Reclaim && breakout) {
    return { type: "BREAKOUT_RECLAIM_BUY", label: "Breakout after weekly EMA13 (Low) reclaim" };
  }
  if (checks.weeklyEma13Reclaim) {
    return { type: "WEEKLY_TREND_RECLAIM", label: "Weekly EMA13 (Low) reclaim buy" };
  }
  if (checks.retracementBuyZone) {
    return {
      type: "RETRACEMENT_BUY",
      label: `Retracement buy near ${values.retracementSupportSource || "support"}`
    };
  }
  if (breakout) {
    return { type: "BREAKOUT_BUY", label: "Breakout buy" };
  }
  if (checks.nearYearHigh && checks.volumeExpansion) {
    return { type: "MOMENTUM_CONTINUATION", label: "Momentum continuation buy" };
  }
  return { type: "TREND_CONTINUATION", label: "Trend continuation buy" };
}

function gtfScoreContribution(context = {}) {
  let score = context.score >= 7 ? 3 : context.score >= 5 ? 2 : context.score >= 3 ? 1 : 0;
  if (context.supplyBlocked) score -= 2;
  if (context.checks?.roomForTwoR === false) score -= 1;
  return Math.max(-3, Math.min(3, score));
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
    if (["DATA_GAP", "ERROR"].includes(row.status)) continue;
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
      key !== "NSE Equity" &&
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
    const setupStrengthScore = (row.setupStrengthScore || 0) + sectorStrengthScore;
    const sectorReason =
      ok
        ? `Sector breadth strong: ${key} has ${group.strong}/${group.total} stocks (${fmt(breadthPct)}%) passing daily strength.`
        : null;

    const enriched = {
      ...row,
      sectorStrength,
      sectorStrengthScore,
      setupStrengthScore,
      setupGrade: setupGrade(row.technicalScore || 0, setupStrengthScore, row.fundamentalScore || 0),
      score: (row.score || 0) + sectorStrengthScore,
      signalReason:
        row.status === "ENTRY" && sectorReason
          ? [...(row.signalReason || []), sectorReason]
          : row.signalReason
    };
    const conceptCoverage = buildConceptCoverage(enriched);
    return {
      ...enriched,
      conceptCoverage,
      signalReason:
        enriched.status === "ENTRY"
          ? [
              ...(enriched.signalReason || []),
              `Institutional concept coverage: ${conceptCoverage.passed}/${conceptCoverage.applicable} applicable video-derived buckets are strong.`
            ]
          : enriched.signalReason
    };
  });
}

function buildConceptCoverage(row) {
  const passLabels = [];
  const weakLabels = [];
  const dataGapLabels = [];
  const excludedLabels = [
    "Intraday tick scalping",
    "Broker-only live Greeks/order-book depth",
    "Pair-trading spread execution",
    "Short-selling execution",
    "Options premium/straddle/strangle execution",
    "Manual charting/terminal workflow"
  ];
  const setup = row.setupStrength || {};
  const checks = setup.checks || {};
  const values = setup.values || {};
  const entry = row.entryChecks || {};
  const sector = row.sectorStrength || {};
  const fundamentalChecks = row.fundamental?.checks || {};
  const institutional = row.institutionalContext || {};

  addConcept(
    "Compulsory multi-timeframe engine",
    Object.values(entry).every(Boolean),
    [row.weeklyRsi, row.dailyRsi, row.weeklyRs, row.dailyLongRs, row.dailyShortRs, row.dailySupertrend]
      .every(Number.isFinite)
  );
  addConcept(
    "Relative strength leadership",
    entry.weeklyRs && entry.dailyLongRs && entry.dailyShortRs,
    [row.weeklyRs, row.dailyLongRs, row.dailyShortRs].every(Number.isFinite)
  );
  addConcept(
    "RS trend follow-through",
    checks.weeklyRsRising && checks.dailyLongRsRising,
    true
  );
  addConcept(
    "RSI momentum",
    entry.weeklyRsi && entry.dailyRsi,
    [row.weeklyRsi, row.dailyRsi].every(Number.isFinite)
  );
  addConcept(
    "Supertrend trend filter",
    entry.dailyPriceAboveSupertrend,
    Number.isFinite(row.dailySupertrend)
  );
  addConcept(
    "Weekly EMA13 (Low source) trend health/reclaim",
    checks.weeklyCloseAboveEma13 || checks.weeklyEma13Reclaim,
    Number.isFinite(values.weeklyClose) && Number.isFinite(values.weeklyEma13)
  );
  addConcept(
    "Breakout or 52-week high zone",
    checks.baseBreakout || checks.recentHighBreakout || checks.yearHighBreakout || checks.nearYearHigh,
    Number.isFinite(values.priorBaseHigh) || Number.isFinite(values.priorRecentHigh) || Number.isFinite(values.priorYearHigh)
  );
  addConcept(
    "Price-action base and higher-low structure",
    checks.baseBreakout && checks.higherLowStructure,
    Number.isFinite(values.priorBaseHigh) && Number.isFinite(values.recentBaseLow)
  );
  addConcept(
    "Retracement/pullback buy setup",
    checks.retracementBuyZone,
    Number.isFinite(values.retracementPullbackDepthPct) &&
      (Number.isFinite(values.retracementSupportReference) || values.retracementSupportSource)
  );
  addConcept(
    "GTF demand/supply confluence",
    row.gtfContext?.score >= 5 && !row.gtfContext?.supplyBlocked,
    row.gtfContext?.dataAvailable
  );
  addConcept(
    "GTF reacting from higher timeframe (secondary proxy)",
    row.gtfContext?.reactingFromHtf?.active === true,
    row.gtfContext?.dataAvailable
  );
  addConcept(
    "Fibonacci retracement support",
    checks.fibonacciSupportNearby,
    Number.isFinite(values.fibonacciNearestPrice)
  );
  addConcept(
    "Bollinger trend/range context",
    checks.bollingerTrendSupport && !checks.bollingerRangeBound,
    Number.isFinite(values.bollingerBandwidthPct)
  );
  addConcept(
    "Volume participation",
    checks.volumeExpansion,
    Number.isFinite(values.volumeRatio)
  );
  addConcept(
    "MACD and OBV confirmation",
    checks.macdBullish && checks.obvRising,
    Number.isFinite(values.macd) && Number.isFinite(values.macdSignal)
  );
  addConcept(
    "Operator delivery confirmation",
    institutional.operator?.accumulation,
    institutional.operator?.dataAvailable
  );
  addConcept(
    "Sector breadth",
    sector.ok,
    String(sector.industry || "") !== "NSE Equity" && Number.isFinite(sector.breadthPct)
  );
  addConcept(
    "50/200 DMA trend structure",
    checks.closeAboveSmaFast && checks.closeAboveSmaSlow && checks.smaFastAboveSlow,
    Number.isFinite(values.smaFast) && Number.isFinite(values.smaSlow)
  );
  addConcept(
    "Candle IPC confirmation",
    checks.bullishCandleConfirmation || checks.bullishEngulfing || checks.hammer,
    true
  );
  addConcept(
    "Volatility and liquidity control",
    checks.controlledVolatility && checks.liquidEnough,
    Number.isFinite(values.atrPct) || Number.isFinite(values.averageTurnover)
  );
  addConcept(
    "Risk reference discipline",
    checks.favorableRiskToSupertrend && Number.isFinite(values.previousLow),
    Number.isFinite(values.riskToSupertrendPct) || Number.isFinite(values.previousLow)
  );
  addConcept("Market regime", checks.marketRegimeStrong, true);
  addConcept(
    "Index regime confirmation",
    institutional.index?.supportsLongs,
    institutional.index?.dataAvailable
  );
  addConcept(
    "Derivative/F&O eligibility",
    institutional.derivatives?.fnoEligible,
    institutional.derivatives?.dataAvailable
  );
  addConcept(
    "Derivative OI participation",
    institutional.derivatives?.participation,
    institutional.derivatives?.oiAvailable || institutional.derivatives?.dataAvailable
  );
  addConcept(
    "Index option-chain positioning",
    institutional.options?.supportsLongs,
    institutional.options?.dataAvailable
  );
  addConcept(
    "Commodity/currency macro context",
    institutional.commodity?.supportsSector,
    institutional.commodity?.dataAvailable
  );
  addConcept("News/event context", false, false);

  const fundamentalValues = Object.values(fundamentalChecks);
  const fundamentalKnown = fundamentalValues.some((item) => item?.ok === true || item?.ok === false);
  addConcept(
    "Fundamental improvement",
    (row.fundamentalScore || 0) >= 3,
    fundamentalKnown
  );
  addConcept(
    "Exit rule discipline",
    row.exitChecks && Object.hasOwn(row.exitChecks, "weeklyRs"),
    Number.isFinite(row.weeklyRs)
  );
  addConcept("09:17 execution discipline", Boolean(row.executionPlan), true);

  const applicable = passLabels.length + weakLabels.length + dataGapLabels.length;
  return {
    passed: passLabels.length,
    applicable,
    weak: weakLabels.length,
    dataGaps: dataGapLabels.length,
    excluded: excludedLabels.length,
    passLabels,
    weakLabels,
    dataGapLabels,
    excludedLabels,
    summary: `${passLabels.length}/${applicable} applicable video-derived buckets strong; ${dataGapLabels.length} data gaps; ${excludedLabels.length} non-EOD playbooks excluded.`
  };

  function addConcept(label, passed, hasData) {
    if (!hasData) {
      dataGapLabels.push(label);
    } else if (passed) {
      passLabels.push(label);
    } else {
      weakLabels.push(label);
    }
  }
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
      ? `Weekly RS ${fmtRs(values.weeklyRs)} is above 0.`
      : `Weekly RS ${fmtRs(values.weeklyRs)} is not above 0.`
  );
  reasons.push(
    checks.dailyLongRs
      ? `Daily long RS55 ${fmtRs(values.dailyLongRs)} is above 0.`
      : `Daily long RS55 ${fmtRs(values.dailyLongRs)} is not above 0.`
  );
  reasons.push(
    checks.dailyShortRs
      ? `Daily short RS21 ${fmtRs(values.dailyShortRs)} is above 0.`
      : `Daily short RS21 ${fmtRs(values.dailyShortRs)} is not above 0.`
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
  if (checks.weeklyRs) reasons.push(`Weekly RS ${fmtRs(values.weeklyRs)} is below 0 on closed weekly candle.`);
  if (checks.weeklyEma13) {
    reasons.push(
      `Completed weekly candle ${values.weeklyAsOf || ""} closed ${fmt(values.weeklyClose)} below low-source EMA13 ${fmt(values.weeklyEma13)}; weekly momentum structure is broken.`
    );
  }
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
  if (checks.baseBreakout) {
    reasons.push(
      `${values.baseBreakoutPeriod}-day base breakout above ${fmt(values.priorBaseHigh)}${checks.higherLowStructure ? " with a higher-low structure" : ""}.`
    );
  }
  if (checks.volumeExpansion) {
    reasons.push(
      `Volume shocker: latest volume is ${fmt(values.volumeRatio)}x the ${values.volumeAveragePeriod}-day average.`
    );
  }
  if (checks.macdBullish || checks.obvRising) {
    reasons.push(
      `Momentum confirmation: MACD is ${checks.macdBullish ? "above signal and zero" : "not fully confirmed"}; OBV is ${checks.obvRising ? "rising" : "not rising"}.`
    );
  }
  if (checks.retracementBuyZone) {
    reasons.push(
      `Retracement buy: price pulled back ${fmt(values.retracementPullbackDepthPct)}% from the ${values.recentHighPeriod}-day high and reclaimed near ${values.retracementSupportSource || "support"} ${fmt(values.retracementSupportReference)}; support distance is ${fmt(values.retracementSupportDistancePct)}%.`
    );
    reasons.push(
      `Retracement confirmation: pullback volume ratio ${fmt(values.retracementPullbackVolumeRatio)} and reclaim volume ratio ${fmt(values.retracementCurrentVolumeRatio)} with candle close location ${fmt(values.retracementCloseLocationPct)}%.`
    );
  } else if (values.retracementPullbackDepthOk) {
    reasons.push(
      `Retracement watch: pullback depth ${fmt(values.retracementPullbackDepthPct)}% is valid, but support/reclaim/volume/risk confirmation is incomplete.`
    );
  }
  if (checks.fibonacciSupportNearby) {
    reasons.push(
      `Fibonacci confluence: close is ${fmt(values.fibonacciDistancePct)}% from ${values.fibonacciNearestLevel} retracement support ${fmt(values.fibonacciNearestPrice)}.`
    );
  }
  if (Number.isFinite(values.bollingerBandwidthPct)) {
    reasons.push(
      checks.bollingerRangeBound
        ? `Bollinger context: bandwidth ${fmt(values.bollingerBandwidthPct)}% indicates a range-bound/compressed phase.`
        : `Bollinger context: close is ${checks.bollingerTrendSupport ? "above" : "below"} the middle band ${fmt(values.bollingerMiddle)} with bandwidth ${fmt(values.bollingerBandwidthPct)}%.`
    );
  }
  if (checks.weeklyRsRising && checks.dailyLongRsRising) {
    reasons.push("RS trend strength: weekly RS and daily RS55 are rising.");
  } else if (checks.dailyLongRsRising) {
    reasons.push("RS trend strength: daily RS55 is rising.");
  }
  if (checks.weeklyCloseAboveEma13) {
    reasons.push(
      `Weekly trend health: completed weekly close ${fmt(values.weeklyClose)} is above weekly EMA13 (Low source) ${fmt(values.weeklyEma13)}${checks.weeklyEma13Rising ? " and the EMA is rising" : ""}.`
    );
  } else if (Number.isFinite(values.weeklyClose) && Number.isFinite(values.weeklyEma13)) {
    reasons.push(
      `Weekly momentum break: completed weekly close ${fmt(values.weeklyClose)} is below weekly EMA13 (Low source) ${fmt(values.weeklyEma13)}; intraweek dips are ignored, but this completed-week close is an exit condition.`
    );
  }
  if (checks.weeklyEma13Reclaim) {
    reasons.push("Weekly EMA13 (Low source) reclaim: the completed week closed back above the low-source trend average after the prior week was below it.");
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
  if (checks.bullishCandleConfirmation || checks.bullishEngulfing || checks.hammer) {
    reasons.push(`Price confirmation: ${values.candlePattern || "bullish daily candle"} is present.`);
  }
  if (checks.controlledVolatility) {
    reasons.push(`Volatility is controlled: ATR(${values.atrPeriod}) is ${fmt(values.atrPct)}% of price.`);
  }
  if (checks.liquidEnough) {
    reasons.push(`Liquidity strength: 20-day average turnover is Rs ${fmt(values.averageTurnover)}.`);
  }
  if (checks.marketRegimeStrong) {
    reasons.push(`Market regime supports longs: ${values.marketRegimeLabel}.`);
  }

  if (reasons.length === 0) reasons.push("Optional setup strength is neutral.");
  return reasons;
}

function buildWeaknessReasons({
  dailyShortRs,
  dailyLongRs,
  close,
  dailySupertrend,
  weeklyEmaContext,
  setupStrength
}) {
  const reasons = [];
  if (Number.isFinite(dailyShortRs) && dailyShortRs < 0) {
    reasons.push(`Early weakness: daily short RS21 ${fmtRs(dailyShortRs)} is below 0.`);
  }
  if (Number.isFinite(dailyLongRs) && dailyLongRs < 0) {
    reasons.push(`Early weakness: daily long RS55 ${fmtRs(dailyLongRs)} is below 0.`);
  }
  if (Number.isFinite(close) && Number.isFinite(dailySupertrend) && close < dailySupertrend) {
    reasons.push(`Early weakness: daily close ${fmt(close)} is below Supertrend ${fmt(dailySupertrend)}.`);
  }
  if (weeklyEmaContext?.above === false) {
    reasons.push(
      `Weekly trend warning: completed weekly close ${fmt(weeklyEmaContext.close)} is below low-source EMA13 ${fmt(weeklyEmaContext.ema)} for ${weeklyEmaContext.consecutiveBelow || 1} week(s).`
    );
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
    dataGap: results.filter((row) => row.status === "DATA_GAP").length,
    error: results.filter((row) => row.status === "ERROR").length
  };
}

function sortResults(a, b) {
  const rank = { ENTRY: 0, EXIT: 1, WATCH: 2, DATA_GAP: 3, ERROR: 4 };
  const rankDiff = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
  if (rankDiff !== 0) return rankDiff;
  return (b.score ?? 0) - (a.score ?? 0);
}

function uniqueResults(lists) {
  const preferred = ["custom", "default", "all-market"];
  const orderedIds = [
    ...preferred.filter((id) => lists[id]),
    ...Object.keys(lists).filter((id) => !preferred.includes(id))
  ];
  const seen = new Set();
  const output = [];
  for (const id of orderedIds) {
    for (const row of lists[id]?.results || []) {
      const key = row.yahooSymbol || row.symbol;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      output.push(row);
    }
  }
  return output;
}

function buildMarketContext(benchmarkDaily, rules) {
  const latest = benchmarkDaily[benchmarkDaily.length - 1];
  const rsi = latestValue(calculateRsi(benchmarkDaily, rules.rsi?.length || 14));
  const sma50 = latestValue(simpleMovingAverage(benchmarkDaily, 50));
  const sma200 = latestValue(simpleMovingAverage(benchmarkDaily, 200));
  const close = latest?.close;
  const bollinger = buildBollingerContext(
    benchmarkDaily,
    benchmarkDaily.length - 1,
    close,
    rules.setupStrength || {}
  );
  const previous21 = benchmarkDaily[benchmarkDaily.length - 22]?.close;
  const return21Pct =
    Number.isFinite(close) && Number.isFinite(previous21) && previous21 > 0
      ? ((close / previous21) - 1) * 100
      : null;
  const checks = {
    rsiAbove50: Number.isFinite(rsi) && rsi > 50,
    closeAbove50Dma: Number.isFinite(close) && Number.isFinite(sma50) && close > sma50,
    closeAbove200Dma: Number.isFinite(close) && Number.isFinite(sma200) && close > sma200,
    fastAboveSlow: Number.isFinite(sma50) && Number.isFinite(sma200) && sma50 > sma200
  };
  const score = Object.values(checks).filter(Boolean).length;
  const rangeBound =
    bollinger.rangeBound === true && Number.isFinite(return21Pct) && Math.abs(return21Pct) <= 5;
  const riskMode = score >= 3 ? "BULL" : rangeBound ? "RANGE" : score === 2 ? "MIXED" : "WEAK";
  const exposureCapPct = riskMode === "BULL" ? 100 : riskMode === "MIXED" ? 50 : 25;
  return {
    asOf: latest?.date || null,
    close,
    rsi,
    sma50,
    sma200,
    checks,
    score,
    riskMode,
    exposureCapPct,
    return21Pct,
    bollingerBandwidthPct: bollinger.bandwidthPct,
    rangeBound,
    strong: score >= 3,
    label: score >= 3
      ? "NIFTY 500 bullish/healthy"
      : rangeBound
        ? "NIFTY 500 range-bound; new capital capped at 25%"
        : score === 2
          ? "NIFTY 500 mixed; new capital capped at 50%"
          : "NIFTY 500 weak; new capital capped at 25%"
  };
}

function setupGrade(technicalScore, setupStrengthScore, fundamentalScore) {
  if (technicalScore < 6) return "WATCH";
  const optional = (setupStrengthScore || 0) + (fundamentalScore || 0);
  if (optional >= 15) return "A+";
  if (optional >= 11) return "A";
  if (optional >= 7) return "B";
  return "C";
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

function fmtRs(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "NA";
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

function averageTradedValue(candles, period, endIndex) {
  const start = Math.max(0, endIndex - period + 1);
  let sum = 0;
  let count = 0;
  for (let index = start; index <= endIndex; index += 1) {
    const candle = candles[index];
    if (!Number.isFinite(candle?.close) || !Number.isFinite(candle?.volume)) continue;
    sum += candle.close * candle.volume;
    count += 1;
  }
  return count > 0 ? sum / count : null;
}

function candleSignals(previous, current) {
  if (!previous || !current) {
    return { bullishConfirmation: false, bullishEngulfing: false, hammer: false, label: "None" };
  }
  const previousRed = previous.close < previous.open;
  const currentGreen = current.close > current.open;
  const bullishEngulfing =
    previousRed &&
    currentGreen &&
    current.open <= previous.close &&
    current.close >= previous.open;
  const bullishConfirmation =
    currentGreen &&
    Number.isFinite(previous.high) &&
    current.close > previous.high;
  const body = Math.abs(current.close - current.open);
  const lowerWick = Math.min(current.open, current.close) - current.low;
  const upperWick = current.high - Math.max(current.open, current.close);
  const hammer =
    body > 0 &&
    lowerWick >= body * 2 &&
    upperWick <= body * 1.25;
  const labels = [];
  if (bullishConfirmation) labels.push("previous-high confirmation");
  if (bullishEngulfing) labels.push("bullish engulfing");
  if (hammer) labels.push("hammer");
  return {
    bullishConfirmation,
    bullishEngulfing,
    hammer,
    label: labels.join(" + ") || "No bullish confirmation pattern"
  };
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
