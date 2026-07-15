import { appConfig } from "./config.js";
import { readTrades } from "./storage.js";
import { sendTelegramSummary } from "./telegram.js";
import { updateTradeJournal } from "./trade-journal.js";
import { portfolioSummary, totalRealizedPnl } from "./portfolio-engine.js";

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
  if (!options.executionOnly) {
    await postApp({
      action: "ingest-market-state",
      internalKey: APP_INTERNAL_KEY,
      strategyVersion,
      state: marketOnlyState(scan)
    });
  }

  const runtime = await postApp({
    action: "get-runtime-users",
    internalKey: APP_INTERNAL_KEY
  });
  const users = Array.isArray(runtime.users) ? runtime.users : [];
  const outcomes = [];
  const legacyOwnerJournal = readTrades();

  for (const user of users) {
    try {
      const userScan = scanForUser(scan, user.symbols || []);
      const config = configForUser(user.settings || {}, user.telegram || {});
      const journal = await updateTradeJournal(userScan, config, {
        journal: journalForUser(user, legacyOwnerJournal, scan.scannedAt),
        persist: false,
        writeSheets: false
      });
      const state = portfolioState(userScan, journal, user.settings || {}, config);
      let telegram = { sent: false, reason: "not configured" };
      if (config.telegram.botToken && config.telegram.chatId) {
        try {
          telegram = await sendTelegramSummary(state, config);
        } catch (error) {
          telegram = { sent: false, reason: error.message || String(error) };
        }
      }
      state.telegram = telegram;
      await postApp({
        action: "save-user-state",
        internalKey: APP_INTERNAL_KEY,
        strategyVersion,
        userId: user.userId,
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
    telegram,
    ...market
  } = scan;
  return {
    ...market,
    lists: compactMarketLists(scan.lists || {})
  };
}

function compactMarketLists(lists) {
  const allMarket = lists["all-market"] || { id: "all-market", label: "All NSE Market", results: [] };
  const nifty500 = lists.default || { id: "default", label: "Nifty 500", results: [] };
  return {
    "all-market": {
      id: allMarket.id || "all-market",
      label: allMarket.label || "All NSE Market",
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
    "symbol", "yahooSymbol", "name", "industry", "asOf", "status", "close",
    "dailySupertrend", "dailyPriceAboveSupertrend", "weeklyRsi", "weeklyRs",
    "dailyLongRs", "dailyShortRs", "dailyRsi", "fundamentalScore", "score",
    "setupGrade", "entryStyle", "aiReview", "aiScore"
  ]);
  output.signalReason = compactReasons(row.signalReason);

  if (row.status === "ENTRY") {
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
        "riskToSupertrendPct", "atrPct", "averageTurnover", "previousLow"
      ])
    };
    output.sectorStrength = row.sectorStrength;
    output.conceptCoverage = compactCoverage(row.conceptCoverage);
    output.gtfContext = compactGtf(row.gtfContext);
    output.institutionalContext = compactInstitutional(row.institutionalContext);
  } else if (row.status === "EXIT") {
    output.fundamental = row.fundamental;
    output.gtfContext = pick(row.gtfContext || {}, [
      "dataAvailable", "score", "maxScore", "supplyBlocked"
    ]);
  }
  return output;
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
  const customResults = (Array.isArray(allMarket.results) ? allMarket.results : [])
    .filter((row) => wanted.has(normalizeSymbol(row.symbol || row.yahooSymbol)));
  return {
    ...scan,
    lists: {
      ...(scan.lists || {}),
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
      scopeListId: settings.scopeListId || appConfig.trade.scopeListId,
      qualityMode: settings.qualityMode || appConfig.trade.qualityMode,
      maxOpenPositions: finite(settings.maxOpenPositions, appConfig.trade.maxOpenPositions),
      riskPerTradePct: finite(settings.riskPerTradePct, appConfig.trade.riskPerTradePct),
      maxPortfolioRiskPct: finite(settings.maxPortfolioRiskPct, appConfig.trade.maxPortfolioRiskPct),
      maxPositionPct: finite(settings.maxPositionPct, appConfig.trade.maxPositionPct),
      maxSectorExposurePct: finite(settings.maxSectorExposurePct, appConfig.trade.maxSectorExposurePct),
      pyramidingEnabled: settings.pyramidingEnabled !== false
    },
    telegram: {
      ...appConfig.telegram,
      botToken: String(telegram.bot_token || telegram.botToken || ""),
      chatId: String(telegram.chat_id || telegram.chatId || ""),
      sendEmpty: false
    }
  };
}

export function portfolioState(scan, journal, settings, config = appConfig) {
  const visibleTrades = journal.visibleTrades || journal.trades || [];
  const visibleCandidates = journal.visibleCandidates || journal.candidates || [];
  return {
    scannedAt: scan.scannedAt,
    fullScanAt: scan.fullScanAt,
    executionPassAt: scan.executionPassAt,
    scanMode: scan.scanMode,
    executionPass: scan.executionPass,
    benchmark: scan.benchmark,
    benchmarkLabel: scan.benchmarkLabel,
    marketContext: scan.marketContext,
    institutionalContext: scan.institutionalContext,
    tradeSettings: settings,
    tradeSummary: summarizeTrades(visibleTrades),
    portfolioSummary: portfolioSummary(visibleTrades, visibleCandidates, config),
    portfolioRules: journal.portfolioRules,
    trades: visibleTrades,
    waitingCandidates: visibleCandidates,
    candidateDecisionLog: journal.visibleCandidateDecisions || [],
    tradeEvents: journal.events || []
  };
}

function serializableJournal(journal) {
  const {
    visibleTrades,
    visibleCandidates,
    visibleCandidateDecisions,
    events,
    ...stored
  } = journal;
  return stored;
}

function summarizeTrades(trades = []) {
  const byStatus = (status) => trades.filter((trade) => trade.status === status);
  const open = byStatus("OPEN");
  const closed = byStatus("CLOSED");
  return {
    open: open.length,
    closed: closed.length,
    pendingEntry: byStatus("PENDING_ENTRY").length,
    pendingExit: byStatus("PENDING_EXIT").length,
    pendingPartialExit: byStatus("PENDING_PARTIAL_EXIT").length,
    realizedPnl: totalRealizedPnl(trades),
    unrealizedPnl: round(open.reduce((sum, trade) => sum + (Number(trade.unrealizedPnl) || 0), 0))
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

async function postApp(body) {
  const response = await fetch(APP_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new Error(payload.error || `App API failed with ${response.status}`);
  }
  return payload;
}
