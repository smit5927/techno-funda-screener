import { appConfig } from "./config.js";
import { sendTelegramSummary } from "./telegram.js";
import { updateTradeJournal } from "./trade-journal.js";

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

  for (const user of users) {
    try {
      const userScan = scanForUser(scan, user.symbols || []);
      const config = configForUser(user.settings || {}, user.telegram || {});
      const journal = await updateTradeJournal(userScan, config, {
        journal: user.journal || {},
        persist: false,
        writeSheets: false
      });
      const state = portfolioState(userScan, journal, user.settings || {});
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
  return market;
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

function portfolioState(scan, journal, settings) {
  const visibleTrades = journal.visibleTrades || journal.trades || [];
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
    portfolioSummary: journal.portfolioSummary,
    portfolioRules: journal.portfolioRules,
    trades: visibleTrades,
    waitingCandidates: journal.visibleCandidates || journal.candidates || [],
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
    realizedPnl: round(closed.reduce((sum, trade) => sum + (Number(trade.pnl) || 0), 0)),
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
