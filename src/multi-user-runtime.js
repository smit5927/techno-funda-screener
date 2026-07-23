import { appConfig } from "./config.js";
import { readTrades } from "./storage.js";
import { sendTelegramSummary } from "./telegram.js";
import { updateTradeJournal, visibleWaitingPipeline } from "./trade-journal.js";
import { portfolioSummary, totalRealizedPnl } from "./portfolio-engine.js";
import { gunzipSync, gzipSync } from "node:zlib";

const APP_API_URL = process.env.TECHNO_FUNDA_APP_API_URL || "";
const APP_INTERNAL_KEY = process.env.TECHNO_FUNDA_APP_INTERNAL_KEY || "";

export function multiUserRuntimeEnabled() {
  return Boolean(APP_API_URL && APP_INTERNAL_KEY);
}

export async function syncMultiUserRuntime(scan, options = {}) {
  if (!multiUserRuntimeEnabled()) {
    return { ok: false, reason: "multi-user app sync is not configured", processed: 0 };
  }

  const strategyVersion = process.env.GITHUB_SHA || process.env.npm_package_version || "local";
  if (!options.executionOnly && !options.approvalOnly) {
    if (!scan?.lists) throw new Error("A completed market scan is required for market-state ingestion.");
    const marketState = marketOnlyState(scan);
    await postApp({
      action: "ingest-market-state",
      internalKey: APP_INTERNAL_KEY,
      strategyVersion,
      scanAt: marketState.scannedAt,
      encodedState: encodeMarketState(marketState)
    });
  }

  const runtime = await postApp({
    action: "get-runtime-users",
    internalKey: APP_INTERNAL_KEY
  });
  const users = Array.isArray(runtime.users) ? runtime.users : [];
  const runtimeMarket = runtime.encodedMarketState
    ? decodeMarketState(runtime.encodedMarketState)
    : null;
  const effectiveMarket = selectFreshMarketState(scan, runtimeMarket, {
    preferRuntime: options.executionOnly === true || options.approvalOnly === true
  });
  if (!effectiveMarket?.lists) {
    throw new Error("Multi-user cycle requires the latest completed cloud market scan.");
  }
  const outcomes = [];
  const legacyOwnerJournal = readTrades();

  for (const user of users) {
    try {
      const userScan = scanForUser(effectiveMarket, user.symbols || []);
      if (options.executionOnly === true || options.approvalOnly === true) {
        const cycleAt = options.cycleAt || new Date().toISOString();
        userScan.fullScanAt = effectiveMarket.fullScanAt || effectiveMarket.scannedAt;
        userScan.scannedAt = cycleAt;
        userScan.executionPassAt = options.executionOnly === true ? cycleAt : userScan.executionPassAt;
        userScan.scanMode = options.executionOnly === true ? "EXECUTION_PASS" : "MORNING_APPROVAL";
      }
      const config = configForUser(user.settings || {}, user.telegram || {});
      const journal = await updateTradeJournal(userScan, config, {
        journal: journalForUser(user, legacyOwnerJournal, userScan.scannedAt),
        persist: false,
        writeSheets: false,
        publishActionAlerts: options.publishActionAlerts === true
      });
      const processStatus = processStatusForCycle(
        user.processStatus || user.journal?.processStatus,
        userScan,
        journal,
        options
      );
      journal.processStatus = processStatus;
      const state = portfolioState(userScan, journal, user.settings || {}, config, processStatus);
      let telegram = { sent: false, reason: "not configured" };
      if (options.sendTelegram === true && config.telegram.botToken && config.telegram.chatId) {
        try {
          telegram = await sendTelegramSummary(state, config);
        } catch (error) {
          telegram = { sent: false, reason: error.message || String(error) };
        }
      }
      state.telegram = telegram;
      if (options.approvalOnly === true && state.processStatus?.morningApproval) {
        state.processStatus.morningApproval.telegram = telegram.sent
          ? "SENT"
          : state.processStatus.morningApproval.approvedOrders > 0
            ? `FAILED: ${telegram.reason || "delivery unavailable"}`
            : "NO_ACTION";
        journal.processStatus = state.processStatus;
      }
      await postApp({
        action: "save-user-state",
        internalKey: APP_INTERNAL_KEY,
        strategyVersion,
        userId: user.userId,
        resetGeneration: user.resetGeneration,
        state: { ...state, journal: serializableJournal(journal) }
      });
      outcomes.push({ userId: user.userId, username: user.username, ok: true });
    } catch (error) {
      console.error(`Multi-user portfolio failed for ${user.username || user.userId}:`, error);
      outcomes.push({
        userId: user.userId,
        username: user.username,
        ok: false,
        reason: error.message || String(error)
      });
    }
  }

  return {
    ok: outcomes.every((item) => item.ok),
    processed: outcomes.length,
    failed: outcomes.filter((item) => !item.ok).length,
    outcomes
  };
}

export function selectFreshMarketState(scan, runtimeMarket, { preferRuntime = false } = {}) {
  if (!runtimeMarket?.lists) return scan;
  if (!scan?.lists || preferRuntime) return runtimeMarket;
  const inputTime = completedScanTime(scan);
  const runtimeTime = completedScanTime(runtimeMarket);
  return runtimeTime > inputTime ? runtimeMarket : scan;
}

function completedScanTime(scan = {}) {
  const value = Date.parse(String(scan.fullScanAt || scan.scannedAt || ""));
  return Number.isFinite(value) ? value : 0;
}

export function journalForUser(user = {}, legacyJournal = {}, migratedAt = new Date().toISOString()) {
  const current = user.journal && typeof user.journal === "object" ? user.journal : {};
  if (user.role !== "admin" || current.legacyOwnerJournalMigratedAt) return current;
  if (Array.isArray(current.trades) && current.trades.length > 0) {
    return { ...current, legacyOwnerJournalMigratedAt: current.updatedAt || migratedAt };
  }
  if (!Array.isArray(legacyJournal?.trades) || legacyJournal.trades.length === 0) return current;
  return {
    ...structuredClone(legacyJournal),
    legacyOwnerJournalMigratedAt: migratedAt
  };
}

export function marketOnlyState(scan = {}) {
  const {
    tradeSettings,
    tradeSummary,
    portfolioSummary,
    portfolioRules,
    trades,
    waitingCandidates,
    candidateDecisionLog,
    tradeEvents,
    alertHistory,
    telegram,
    ...market
  } = scan;
  return {
    ...market,
    lists: compactMarketLists(scan.lists || {})
  };
}

function compactMarketLists(lists) {
  const allMarket = lists["all-market"] || { id: "all-market", label: "All Indian Market", results: [] };
  const nifty500 = lists.default || { id: "default", label: "Nifty 500", results: [] };
  return {
    "all-market": {
      id: allMarket.id || "all-market",
      label: allMarket.label || "All Indian Market",
      editable: false,
      summary: allMarket.summary || summarizeRows(allMarket.results || []),
      results: (allMarket.results || []).map(compactMobileRow)
    },
    default: {
      id: nifty500.id || "default",
      label: nifty500.label || "Nifty 500",
      editable: false,
      summary: nifty500.summary || summarizeRows(nifty500.results || []),
      symbols: (nifty500.results || []).map((row) => normalizeSymbol(row.symbol || row.yahooSymbol)).filter(Boolean)
    }
  };
}

function compactMobileRow(row = {}) {
  const output = pick(row, [
    "symbol", "requestedYahooSymbol", "yahooSymbol", "exchangeFallback", "name", "industry", "searchAliases", "asOf", "weeklyAsOf", "status", "close",
    "dailySupertrend", "dailyPriceAboveSupertrend", "weeklyRsi", "weeklyRs", "weeklyAtr",
    "dailyLongRs", "dailyShortRs", "dailyRsi", "fundamentalScore", "score",
    "weeklyClose", "weeklyEma13", "weeklyEma13Source", "weeklyPriceAboveEma13", "weeklyEma13Rising",
    "weeklyEma13Reclaim", "weeklyEma13BelowCloses", "setupGrade", "entryStyle",
    "aiReview", "aiScore"
  ]);
  output.signalReason = compactReasons(row.signalReason);

  // Every screener row can be opened in the detail drawer. Keep the compact
  // evidence for every status so WATCH/EXIT/DATA_GAP rows do not render as NA.
  output.fundamental = row.fundamental;
  output.setupStrength = {
    score: row.setupStrength?.score,
    checks: row.setupStrength?.checks,
    values: pick(row.setupStrength?.values || {}, [
      "priorBaseHigh", "recentBaseLow", "priorRecentHigh", "priorYearHigh",
      "volumeRatio", "macd", "retracementPullbackDepthPct",
      "retracementSupportProximityOk", "retracementSupportDistancePct",
      "retracementVolumePatternOk", "retracementPullbackVolumeRatio",
      "retracementReclaimCandleOk", "retracementCloseLocationPct",
      "riskToSupertrendPct", "atrPct", "averageTurnover", "previousLow",
      "weeklyClose", "weeklyEma13", "weeklyEma13Source", "weeklyEma13Previous",
      "weeklyAtr", "weeklyEma13DistancePct", "weeklyEma13BelowCloses", "weeklyEma13Period"
    ])
  };
  output.sectorStrength = row.sectorStrength;
  output.conceptCoverage = compactCoverage(row.conceptCoverage);
  output.gtfContext = compactGtf(row.gtfContext);
  output.institutionalContext = compactInstitutional(row.institutionalContext);
  return output;
}

export function encodeMarketState(state = {}) {
  const raw = Buffer.from(JSON.stringify(state));
  const compressed = gzipSync(raw, { level: 9 });
  return {
    formatVersion: 1,
    encoding: "gzip-base64",
    rawBytes: raw.length,
    compressedBytes: compressed.length,
    data: compressed.toString("base64")
  };
}

export function decodeMarketState(payload = {}) {
  if (payload?.encoding !== "gzip-base64") return payload;
  if (typeof payload.data !== "string" || !payload.data) {
    throw new Error("Compressed market state is missing data");
  }
  return JSON.parse(gunzipSync(Buffer.from(payload.data, "base64")).toString("utf8"));
}

function compactReasons(input) {
  const reasons = (Array.isArray(input) ? input : [input]).map((value) => String(value || "").trim()).filter(Boolean);
  const selected = reasons.slice(0, 14);
  for (const reason of reasons) {
    if (selected.length >= 20) break;
    if (/AI |fundamental|exit|risk|GTF|data gap|block|rotation/i.test(reason) && !selected.includes(reason)) {
      selected.push(reason);
    }
  }
  return selected;
}

function compactCoverage(coverage = {}) {
  return {
    summary: coverage.summary,
    passLabels: (coverage.passLabels || []).slice(0, 12),
    weakLabels: (coverage.weakLabels || []).slice(0, 8),
    dataGapLabels: (coverage.dataGapLabels || []).slice(0, 8),
    excludedLabels: (coverage.excludedLabels || []).slice(0, 8)
  };
}

function compactGtf(gtf = {}) {
  return {
    ...pick(gtf, [
      "dataAvailable", "score", "maxScore", "grade", "rankAdjustment",
      "preferredEntryStyle", "structuralStop", "dailyTrend", "weeklyTrend",
      "rewardRisk", "unlimitedRewardRoom", "supplyDistancePct", "supplyBlocked",
      "demandRetest", "checks"
    ]),
    dailyDemand: compactZone(gtf.dailyDemand),
    weeklyDemand: compactZone(gtf.weeklyDemand),
    opposingSupply: compactZone(gtf.opposingSupply),
    reactingFromHtf: gtf.reactingFromHtf ? {
      ...pick(gtf.reactingFromHtf, ["active", "managementClass", "reason"]),
      zone: compactZone(gtf.reactingFromHtf.zone)
    } : null,
    reasons: (gtf.reasons || []).slice(0, 8)
  };
}

function compactZone(zone) {
  return zone ? pick(zone, [
    "timeframe", "pattern", "distal", "proximal", "freshnessTests", "score", "achievementR"
  ]) : null;
}

function compactInstitutional(context = {}) {
  return {
    score: context.score,
    maxScore: context.maxScore,
    grade: context.grade,
    index: pick(context.index || {}, ["supportsLongs", "reason"]),
    derivatives: pick(context.derivatives || {}, ["fnoEligible", "reason"]),
    options: pick(context.options || {}, ["supportsLongs", "reason"]),
    commodity: pick(context.commodity || {}, ["supportsSector", "reason"]),
    operator: pick(context.operator || {}, ["accumulation", "reason"])
  };
}

function pick(object, keys) {
  return Object.fromEntries(keys.filter((key) => object?.[key] !== undefined).map((key) => [key, object[key]]));
}

export function scanForUser(scan = {}, symbols = []) {
  const wanted = new Set(symbols.map(normalizeSymbol).filter(Boolean));
  const allMarket = scan.lists?.["all-market"] || { results: [] };
  const allMarketResults = Array.isArray(allMarket.results) ? allMarket.results : [];
  const customResults = allMarketResults
    .filter((row) => wanted.has(normalizeSymbol(row.symbol || row.yahooSymbol)));
  const defaultList = scan.lists?.default || { id: "default", label: "Nifty 500" };
  const defaultSymbols = new Set([
    ...(Array.isArray(defaultList.symbols) ? defaultList.symbols : []),
    ...(Array.isArray(defaultList.results)
      ? defaultList.results.map((row) => row.symbol || row.yahooSymbol)
      : [])
  ].map(normalizeSymbol).filter(Boolean));
  const defaultResults = allMarketResults.filter((row) =>
    defaultSymbols.has(normalizeSymbol(row.symbol || row.yahooSymbol))
  );
  return {
    ...scan,
    lists: {
      ...(scan.lists || {}),
      default: {
        ...defaultList,
        id: defaultList.id || "default",
        label: defaultList.label || "Nifty 500",
        editable: false,
        summary: summarizeRows(defaultResults),
        results: defaultResults,
        symbols: [...defaultSymbols]
      },
      custom: {
        id: "custom",
        label: "My Custom List",
        editable: true,
        summary: summarizeRows(customResults),
        results: customResults
      }
    }
  };
}

export function configForUser(settings = {}, telegram = {}) {
  return {
    ...appConfig,
    trade: {
      ...appConfig.trade,
      totalCapital: finite(settings.totalCapital, appConfig.trade.totalCapital),
      minimumInitialAllocation: finite(
        settings.minimumInitialAllocation,
        appConfig.trade.minimumInitialAllocation
      ),
      scopeListId: settings.scopeListId || appConfig.trade.scopeListId,
      qualityMode: settings.qualityMode || appConfig.trade.qualityMode,
      maxOpenPositions: finite(settings.maxOpenPositions, appConfig.trade.maxOpenPositions),
      riskPerTradePct: finite(settings.riskPerTradePct, appConfig.trade.riskPerTradePct),
      maxPortfolioRiskPct: finite(settings.maxPortfolioRiskPct, appConfig.trade.maxPortfolioRiskPct),
      maxPositionPct: finite(settings.maxPositionPct, appConfig.trade.maxPositionPct),
      maxSectorExposurePct: finite(settings.maxSectorExposurePct, appConfig.trade.maxSectorExposurePct),
      pyramidingEnabled: settings.pyramidingEnabled !== false,
      chargesEnabled: settings.chargesEnabled === true,
      brokerageMode: settings.brokerageMode || appConfig.trade.brokerageMode,
      brokerageFlatPerOrder: finite(settings.brokerageFlatPerOrder, appConfig.trade.brokerageFlatPerOrder),
      brokeragePercent: finite(settings.brokeragePercent, appConfig.trade.brokeragePercent),
      dpChargePerSell: finite(settings.dpChargePerSell, appConfig.trade.dpChargePerSell)
    },
    telegram: {
      ...appConfig.telegram,
      botToken: String(telegram.bot_token || telegram.botToken || ""),
      chatId: String(telegram.chat_id || telegram.chatId || ""),
      sendEmpty: false
    }
  };
}

export function portfolioState(scan, journal, settings, config = appConfig, processStatus = {}) {
  const visibleTrades = journal.visibleTrades || journal.trades || [];
  const visibleCandidates = journal.visibleCandidates || journal.candidates || [];
  return {
    scannedAt: scan.scannedAt,
    fullScanAt: scan.fullScanAt,
    marketScanAt: scan.fullScanAt || scan.scannedAt,
    executionPassAt: scan.executionPassAt,
    scanMode: scan.scanMode,
    executionPass: scan.executionPass,
    processStatus,
    benchmark: scan.benchmark,
    benchmarkLabel: scan.benchmarkLabel,
    marketContext: scan.marketContext,
    institutionalContext: scan.institutionalContext,
    tradeSettings: settings,
    tradeSummary: summarizeTrades(visibleTrades),
    portfolioSummary: portfolioSummary(visibleTrades, visibleCandidates, config),
    portfolioRules: journal.portfolioRules,
    corporateActionStatus: journal.corporateActionStatus,
    trades: visibleTrades.map(compactStoredTrade),
    waitingCandidates: visibleWaitingPipeline(visibleTrades, visibleCandidates).map(compactStoredCandidate),
    candidateDecisionLog: journal.visibleCandidateDecisions || [],
    alertHistory: journal.alertHistory || [],
    tradeEvents: journal.events || []
  };
}

export function processStatusForCycle(previous = {}, scan = {}, journal = {}, options = {}) {
  const next = structuredClone(previous && typeof previous === "object" ? previous : {});
  const trades = journal.visibleTrades || journal.trades || [];
  const events = Array.isArray(journal.events) ? journal.events : [];

  if (!options.approvalOnly && !options.executionOnly) {
    const completedAt = scan.fullScanAt || scan.scannedAt;
    next.fullScan = {
      status: "COMPLETED",
      completedAt,
      marketAsOf: scan.marketContext?.asOf || null,
      rows: Number(scan.lists?.["all-market"]?.summary?.total) ||
        Number(scan.lists?.["all-market"]?.results?.length) || 0
    };
  }

  if (options.approvalOnly === true) {
    const summary = summarizeTrades(trades);
    next.morningApproval = {
      status: "COMPLETED",
      completedAt: scan.scannedAt,
      approvedOrders: summary.pendingEntry + summary.pendingExit + summary.pendingPartialExit,
      pendingEntry: summary.pendingEntry,
      pendingExit: summary.pendingExit,
      pendingPartialExit: summary.pendingPartialExit
    };
  }

  if (options.executionOnly === true) {
    const summary = summarizeTrades(trades);
    next.execution = {
      status: "COMPLETED",
      completedAt: scan.executionPassAt || scan.scannedAt,
      filledActions: events.filter((event) =>
        /FILLED|OPENED|CLOSED|PARTIAL_EXIT|PYRAMID|AVERAG/i.test(String(event?.type || ""))
      ).length,
      remainingOrders: summary.pendingEntry + summary.pendingExit + summary.pendingPartialExit
    };
  }

  return next;
}

function serializableJournal(journal) {
  const {
    visibleTrades,
    visibleCandidates,
    visibleCandidateDecisions,
    events,
    ...stored
  } = journal;
  return {
    ...stored,
    trades: (stored.trades || []).map(compactStoredTrade),
    candidates: (stored.candidates || []).map(compactStoredCandidate),
    candidateDecisionLog: (stored.candidateDecisionLog || []).slice(0, 100)
  };
}

function compactStoredTrade(trade = {}) {
  return {
    ...trade,
    entrySnapshot: trade.entrySnapshot ? compactMobileRow(trade.entrySnapshot) : trade.entrySnapshot,
    currentSnapshot: trade.currentSnapshot ? compactMobileRow(trade.currentSnapshot) : trade.currentSnapshot,
    entryReason: compactReasons(trade.entryReason),
    exitReason: compactReasons(trade.exitReason),
    partialExitReason: compactReasons(trade.partialExitReason),
    pendingReason: compactReasons(trade.pendingReason),
    candidateContext: trade.candidateContext ? pick(trade.candidateContext, [
      "grade", "rank", "entryStyle", "firstSignalDate", "firstSignalClose",
      "confirmedCloses", "runupPct", "executionGapPct", "supertrendDistancePct",
      "atrExtension", "rankDecay", "reason"
    ]) : trade.candidateContext
  };
}

function compactStoredCandidate(candidate = {}) {
  return {
    ...candidate,
    latestSnapshot: candidate.latestSnapshot ? compactMobileRow(candidate.latestSnapshot) : candidate.latestSnapshot,
    lastDecision: candidate.lastDecision ? {
      ...pick(candidate.lastDecision, ["disposition", "outcome", "reason", "asOf", "evaluatedAt"]),
      metrics: pick(candidate.lastDecision.metrics || {}, [
        "confirmedEntryCloses", "runupPct", "executionGapPct",
        "supertrendDistancePct", "atrExtension", "rankDecay"
      ])
    } : candidate.lastDecision
  };
}

function summarizeTrades(trades = []) {
  const byStatus = (status) => trades.filter((trade) => trade.status === status);
  const active = trades.filter((trade) => ["OPEN", "PENDING_EXIT", "PENDING_PARTIAL_EXIT"].includes(trade.status));
  const closed = byStatus("CLOSED");
  return {
    open: active.length,
    closed: closed.length,
    pendingEntry: byStatus("PENDING_ENTRY").filter((trade) => trade.orderState === "CONFIRMED_FOR_0917").length,
    pendingExit: byStatus("PENDING_EXIT").filter((trade) => trade.exitOrderState === "CONFIRMED_FOR_0917").length,
    pendingPartialExit: byStatus("PENDING_PARTIAL_EXIT").filter((trade) => trade.partialExitOrderState === "CONFIRMED_FOR_0917").length,
    realizedPnl: totalRealizedPnl(trades),
    tradeRealizedPnl: round(trades.reduce((sum, trade) => {
      if (trade.status === "CLOSED") return sum + (Number(trade.pnl) || 0) - (Number(trade.dividendRealizedPnl) || 0);
      return sum + (Number(trade.tradeRealizedPnlToDate) || 0);
    }, 0)),
    dividendRealizedPnl: round(trades.reduce((sum, trade) => sum + (Number(trade.dividendRealizedPnl) || 0), 0)),
    unrealizedPnl: round(active.reduce((sum, trade) => sum + (Number(trade.unrealizedPnl) || 0), 0))
  };
}

function summarizeRows(rows = []) {
  return rows.reduce((summary, row) => {
    summary.total += 1;
    const key = String(row.status || "").toLowerCase();
    if (key === "data_gap") summary.dataGap += 1;
    else if (Object.hasOwn(summary, key)) summary[key] += 1;
    return summary;
  }, { total: 0, entry: 0, exit: 0, watch: 0, dataGap: 0, error: 0 });
}

function normalizeSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^NSE:/, "")
    .replace(/\.(NS|BO)$/i, "")
    .replace(/[^A-Z0-9&_-]/g, "");
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value) {
  return Number((Number(value) || 0).toFixed(2));
}

async function postApp(body, attempt = 0) {
  const response = await fetch(APP_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const message = payload.error || `App API failed with ${response.status}`;
    const retryable = response.status >= 500 || /timeout|temporar|unavailable|connection/i.test(message);
    if (retryable && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1500));
      return postApp(body, attempt + 1);
    }
    throw new Error(message);
  }
  return payload;
}
