import fs from "node:fs";
import ExcelJS from "exceljs";
import { appConfig } from "./config.js";
import { readTrades, saveTrades } from "./storage.js";
import { fetchOpeningWindowPrice } from "./yahoo.js";
import {
  buildPositionPlan,
  candidateRank,
  nextTrailingStop,
  portfolioConfig,
  portfolioSummary,
  positionExitDecision,
  positionWeakness,
  rotationDecision
} from "./portfolio-engine.js";

const TRADE_SCOPE_LABELS = {
  "all-market": "All NSE Market",
  default: "Nifty 500",
  custom: "My List"
};

const TRADE_QUALITY_LABELS = {
  BEST_ONLY: "Best only (A+/A)",
  STRONG_OR_BETTER: "Strong and best (A+/A/B)",
  ALL_ENTRIES: "All entry signals"
};

export async function updateTradeJournal(scan, config = appConfig) {
  const journal = readTrades();
  const settings = tradeSettingsSummary(config);
  const riskRules = portfolioConfig(config);
  const liveMode = config.trade.onlyNewSignals !== false;
  const portfolioUpgrade = !journal.portfolioEngineStartedAt;
  const firstLiveScan = liveMode && !journal.liveModeStartedAt;
  const trades = firstLiveScan ? [] : Array.isArray(journal.trades) ? journal.trades : [];
  let candidates = firstLiveScan ? [] : Array.isArray(journal.candidates) ? journal.candidates : [];
  const signalState =
    journal.signalState && typeof journal.signalState === "object" ? journal.signalState : {};
  const nextSignalState = { ...signalState };
  const events = [];
  const capitalTransactions = Array.isArray(journal.capitalTransactions)
    ? [...journal.capitalTransactions]
    : [];
  const previousCapital = Number(journal.portfolioRules?.totalCapital);
  if (Number.isFinite(previousCapital) && previousCapital !== riskRules.totalCapital) {
    const difference = riskRules.totalCapital - previousCapital;
    capitalTransactions.push({
      date: scan.scannedAt,
      type: difference > 0 ? "CAPITAL_ADDED" : "CAPITAL_REDUCED",
      amount: round(Math.abs(difference)),
      previousCapital: round(previousCapital),
      newCapital: round(riskRules.totalCapital),
      source: "Saved Trade Settings"
    });
  } else if (!Number.isFinite(previousCapital)) {
    capitalTransactions.push({
      date: scan.scannedAt,
      type: "OPENING_CAPITAL",
      amount: round(riskRules.totalCapital),
      previousCapital: 0,
      newCapital: round(riskRules.totalCapital),
      source: "Portfolio Engine Initialization"
    });
  }
  const rows = uniqueScannedRows(scan, settings.scopeListId);
  const rowBySymbol = new Map(
    allScannedRows(scan).map((row) => [row.yahooSymbol || row.symbol, row])
  );

  migrateTradeMetadata(trades);
  if (portfolioUpgrade) {
    for (const trade of trades.filter((item) => item.status === "PENDING_ENTRY")) {
      trade.status = "SKIPPED_ENTRY";
      trade.skipReason =
        "Legacy pending buy cancelled when the Rs 10 lakh portfolio-risk engine was initialized.";
      trade.executionError = trade.skipReason;
    }
  }
  await migrateLegacyOpeningPrices(trades, config);

  for (const trade of trades) {
    const row = executionRow(
      trade,
      rowBySymbol.get(trade.yahooSymbol || trade.symbol),
      scan.marketContext?.asOf
    );
    if (row && ["OPEN", "PENDING_EXIT", "PENDING_PARTIAL_EXIT"].includes(trade.status)) {
      markToMarket(trade, row);
      trade.currentRank = candidateRank(row);
      trade.currentGrade = row.setupGrade;
      trade.trailingStopPrice = nextTrailingStop(trade, row, config);
      trade.currentWeakness = positionWeakness(row);
    }
    cancelInvalidGtfPartialExit(trade, row);
    if (trade.status === "PENDING_EXIT" && row) {
      const filled = await fillExit(trade, row);
      if (filled) events.push({ type: "EXIT_TRADE_CLOSED", trade });
    }
    if (trade.status === "PENDING_PARTIAL_EXIT" && row) {
      const filled = await fillPartialExit(trade, row);
      if (filled) events.push({ type: "PARTIAL_EXIT_FILLED", trade });
    }
  }

  for (const trade of trades.filter((item) => item.status === "OPEN")) {
    const row = executionRow(
      trade,
      rowBySymbol.get(trade.yahooSymbol || trade.symbol),
      scan.marketContext?.asOf
    );
    if (!row) continue;
    if (inferTradeScope(trade) !== settings.scopeListId) {
      prepareFullExit(
        trade,
        row,
        scan,
        [`Trade universe changed to ${settings.scopeLabel}; this position is outside the active portfolio.`],
        "SCOPE_REBALANCE"
      );
      events.push({ type: "PORTFOLIO_EXIT_PENDING", trade });
      continue;
    }
    const decision = positionExitDecision(trade, row, config);
    trade.trailingStopPrice = decision.trailingStop || trade.trailingStopPrice;
    trade.currentRewardR = decision.rewardR;
    if (decision.action === "FULL_EXIT") {
      prepareFullExit(trade, row, scan, decision.reasons, "MODEL_EXIT");
      events.push({ type: "EXIT_SIGNAL_PENDING", trade });
    } else if (decision.action === "PARTIAL_EXIT") {
      preparePartialExit(trade, row, scan, decision, config);
      events.push({ type: "PARTIAL_EXIT_PENDING", trade });
    }
  }

  enforcePortfolioLimits(trades, rowBySymbol, scan, settings, config, events);

  for (const trade of trades) {
    const row = executionRow(
      trade,
      rowBySymbol.get(trade.yahooSymbol || trade.symbol),
      scan.marketContext?.asOf
    );
    if (trade.status === "PENDING_EXIT" && row) {
      const filled = await fillExit(trade, row);
      if (filled) events.push({ type: "EXIT_TRADE_CLOSED", trade });
    }
    if (trade.status === "PENDING_PARTIAL_EXIT" && row) {
      const filled = await fillPartialExit(trade, row);
      if (filled) events.push({ type: "PARTIAL_EXIT_FILLED", trade });
    }
  }

  for (const row of rows) {
    const key = signalStateKey(settings.scopeListId, row);
    const previousStatus = previousSymbolStatus(signalState, key, row, settings.scopeListId);
    const activeTrade = findAnyActiveTrade(trades, row);
    const existingCandidate = candidates.find((item) => sameInstrument(item, row));
    const newEligibleSignal =
      !firstLiveScan &&
      previousStatus != null &&
      previousStatus !== "ENTRY" &&
      row.status === "ENTRY" &&
      !activeTrade &&
      rowPassesTradeQuality(row, settings);
    if (newEligibleSignal || (existingCandidate && row.status === "ENTRY" && !activeTrade)) {
      upsertCandidate(candidates, row, scan, settings, existingCandidate);
    }
    nextSignalState[key] = {
      status: row.status,
      asOf: row.asOf,
      scannedAt: scan.scannedAt,
      scopeListId: settings.scopeListId
    };
  }

  candidates = candidates.filter((candidate) => {
    const row = rowBySymbol.get(candidate.yahooSymbol || candidate.symbol);
    return row?.status === "ENTRY" &&
      rowPassesTradeQuality(row, settings) &&
      !findAnyActiveTrade(trades, row);
  });

  let rotationScheduled = false;
  for (const candidate of [...candidates].sort((a, b) => b.rank - a.rank)) {
    const row = rowBySymbol.get(candidate.yahooSymbol || candidate.symbol);
    if (!row) continue;
    const portfolio = portfolioSummary(trades, candidates, config);
    const plan = buildPositionPlan(row, row.close, portfolio, config);
    candidate.rank = plan.rank;
    candidate.grade = row.setupGrade;
    candidate.plannedStopPrice = plan.stopPrice;
    candidate.plannedRisk = plan.plannedRisk;
    candidate.plannedAllocation = plan.allocation;
    candidate.lastEvaluatedAt = scan.scannedAt;
    if (plan.eligible) {
      const trade = createPendingEntry(row, scan, config, settings, plan);
      trades.push(trade);
      candidates = candidates.filter((item) => item !== candidate);
      events.push({ type: "ENTRY_SIGNAL_PENDING", trade });
      continue;
    }

    candidate.status = "WAITING_CAPITAL";
    candidate.skipReason = plan.reason;
    if (!candidate.skipAlertedAt) {
      candidate.skipAlertedAt = scan.scannedAt;
      events.push({ type: "ENTRY_SKIPPED", candidate });
    }
    if (
      !rotationScheduled &&
      !String(plan.reason).startsWith("Sector exposure")
    ) {
      const rotation = rotationDecision(row, trades, rowBySymbol, config);
      if (rotation.rotate) {
        const weakRow = rowBySymbol.get(rotation.trade.yahooSymbol || rotation.trade.symbol);
        prepareFullExit(
          rotation.trade,
          weakRow,
          scan,
          [rotation.reason, `Weakness: ${rotation.weakness.reasons.join("; ")}.`],
          "QUALITY_ROTATION"
        );
        rotation.trade.replacementCandidateSymbol = row.symbol;
        candidate.status = "WAITING_ROTATION";
        candidate.skipReason = `Waiting for ${rotation.trade.symbol} rotation exit. ${rotation.reason}`;
        rotationScheduled = true;
        events.push({ type: "ROTATION_EXIT_PENDING", trade: rotation.trade, candidate });
      }
    }
  }

  for (const trade of trades.filter((item) => item.status === "PENDING_ENTRY")) {
    const row = rowBySymbol.get(trade.yahooSymbol || trade.symbol);
    if (!row) continue;
    const outcome = await fillEntry(trade, row, config, trades, candidates);
    if (outcome === "FILLED") events.push({ type: "ENTRY_TRADE_OPENED", trade });
    if (outcome === "SKIPPED") {
      const candidate = upsertCandidate(candidates, row, scan, settings, null);
      candidate.status = "WAITING_CAPITAL";
      candidate.skipReason = trade.skipReason;
      candidate.skipAlertedAt = scan.scannedAt;
      events.push({ type: "ENTRY_SKIPPED", trade, candidate });
    }
  }

  const finalPortfolio = portfolioSummary(trades, candidates, config);

  const nextJournal = {
    updatedAt: new Date().toISOString(),
    portfolioEngineStartedAt: journal.portfolioEngineStartedAt || scan.scannedAt,
    liveModeStartedAt: journal.liveModeStartedAt || (liveMode ? new Date().toISOString() : null),
    baselineInitialized: true,
    baselineScanAt: journal.baselineScanAt || (firstLiveScan ? scan.scannedAt : null),
    executionRule: {
      signalBasis: "completed daily/weekly closing candle",
      sessionRule: "first actual exchange session after the signal date; weekends and market holidays are skipped",
      window: `${config.trade.executionWindowStart}-${config.trade.executionWindowEnd} IST`,
      priceSource: config.trade.executionPriceSource
    },
    signalState: nextSignalState,
    tradeCapitalPerStock: riskRules.totalCapital * riskRules.maxPositionPct / 100,
    portfolioRules: riskRules,
    portfolioSummary: finalPortfolio,
    capitalTransactions,
    candidates: candidates.sort((a, b) => b.rank - a.rank),
    tradeSettings: settings,
    trades: trades.sort(sortTrades)
  };
  saveTrades(nextJournal);
  const visibleTrades = visibleTradesForSettings(nextJournal.trades, settings);
  await writeTradeSheets({ ...nextJournal, trades: visibleTrades }, config);
  return { ...nextJournal, visibleTrades, events, visibleCandidates: nextJournal.candidates };
}

function cancelInvalidGtfPartialExit(trade, row) {
  if (trade.status !== "PENDING_PARTIAL_EXIT" || !row) return;
  const reasons = Array.isArray(trade.pendingPartialExitReason)
    ? trade.pendingPartialExitReason
    : [];
  const gtfOnly =
    trade.pendingPartialExitTag === "EARLY_WEAKNESS" &&
    reasons.some((reason) => String(reason).includes("GTF opposing supply")) &&
    reasons.every((reason) =>
      String(reason).includes("GTF opposing supply") || String(reason).startsWith("Sell ")
    );
  const stillBlocked =
    row.gtfContext?.supplyBlocked === true ||
    row.gtfContext?.checks?.roomForTwoR === false;
  if (!gtfOnly || stillBlocked) return;
  trade.status = "OPEN";
  trade.pendingPartialExitPct = null;
  trade.pendingPartialExitTag = null;
  trade.pendingPartialExitReason = [];
  trade.partialExitSignalDate = null;
  trade.partialExitSignalScanAt = null;
  trade.executionError = null;
  trade.riskActionNote =
    "Cancelled automatically: the GTF supply level no longer passes the fresh score-7 blocker gate.";
}

export async function writeTradeSheets(journal, config = appConfig) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const settings = journal.tradeSettings || tradeSettingsSummary(config);
  const sheetJournal = {
    ...journal,
    tradeSettings: settings,
    trades: visibleTradesForSettings(journal.trades || [], settings)
  };
  await writeXlsx(sheetJournal, config.tradeSheetPath);
  writeCsv(sheetJournal, config.tradeCsvPath);
}

export function tradeSettingsSummary(config = appConfig) {
  const scopeListId = normalizeTradeScope(config.trade?.scopeListId);
  const qualityMode = normalizeTradeQuality(config.trade?.qualityMode);
  return {
    scopeListId,
    scopeLabel: TRADE_SCOPE_LABELS[scopeListId],
    qualityMode,
    qualityLabel: TRADE_QUALITY_LABELS[qualityMode],
    totalCapital: config.trade?.totalCapital ?? 1000000,
    capitalPerStock: config.trade?.capitalPerStock ?? 100000,
    executionWindow: `${config.trade?.executionWindowStart || "09:15"}-${config.trade?.executionWindowEnd || "09:20"} IST`
  };
}

export function rowPassesTradeQuality(row, settingsOrConfig = appConfig) {
  const settings = settingsOrConfig.trade ? tradeSettingsSummary(settingsOrConfig) : settingsOrConfig;
  const mode = normalizeTradeQuality(settings.qualityMode);
  if (mode === "ALL_ENTRIES") return true;
  const grade = String(row.setupGrade || "").toUpperCase();
  if (mode === "STRONG_OR_BETTER") return ["A+", "A", "B"].includes(grade);
  return ["A+", "A"].includes(grade);
}

function createPendingEntry(row, scan, config, settings, plan) {
  const sourceLists = row.sourceLists || [row.listLabel].filter(Boolean);
  return {
    id: `${row.symbol}-${row.asOf}-${Date.now()}`,
    listId: row.listId,
    listLabel: sourceLists.join(", "),
    sourceLists,
    tradeScope: settings.scopeListId,
    tradeScopeLabel: settings.scopeLabel,
    tradeQualityMode: settings.qualityMode,
    tradeQualityLabel: settings.qualityLabel,
    symbol: row.symbol,
    yahooSymbol: row.yahooSymbol,
    name: row.name,
    industry: row.industry || "Unknown",
    status: "PENDING_ENTRY",
    entrySignalDate: row.asOf,
    entrySignalScanAt: scan.scannedAt,
    entryDate: null,
    entryTime: null,
    entryPrice: null,
    executionWindow: `${config.trade.executionWindowStart}-${config.trade.executionWindowEnd} IST`,
    executionMethod: config.trade.executionPriceSource,
    quantity: null,
    investedValue: null,
    plannedQuantity: plan.quantity,
    plannedAllocation: plan.allocation,
    plannedRisk: plan.plannedRisk,
    initialStopPrice: plan.stopPrice,
    trailingStopPrice: plan.stopPrice,
    riskPerShare: plan.riskPerShare,
    riskBudget: plan.riskBudget,
    positionRank: plan.rank,
    currentRank: plan.rank,
    allocationMethod: "min(capital cap, 1% risk budget, cash, sector cap)",
    partialExits: [],
    partialExitTags: [],
    realizedPnlToDate: 0,
    entryReason: [
      ...(row.signalReason || row.entryReason || []),
      `Trade sheet filter: ${settings.scopeLabel}, ${settings.qualityLabel}.`,
      `Portfolio rank ${plan.rank}; planned allocation Rs ${plan.allocation}, quantity ${plan.quantity}, initial stop ${plan.stopPrice}, planned risk Rs ${plan.plannedRisk}.`,
      `Closing signal dated ${row.asOf}; buy fill must come from the next actual market session 09:15-09:20 IST window, after skipping weekends and exchange holidays.`
    ],
    entrySnapshot: snapshot(row),
    exitSignalDate: null,
    exitSignalScanAt: null,
    exitDate: null,
    exitTime: null,
    exitPrice: null,
    exitReason: [],
    lastPrice: row.close,
    lastPriceDate: row.asOf,
    unrealizedPnl: null,
    unrealizedPnlPct: null,
    pnl: null,
    pnlPct: null,
    holdingDays: null
  };
}

function prepareFullExit(trade, row, scan, reasons, exitType = "MODEL_EXIT") {
  trade.status = "PENDING_EXIT";
  trade.exitType = exitType;
  const portfolioDriven = ["SCOPE_REBALANCE", "CAPITAL_REBALANCE", "QUALITY_ROTATION"].includes(exitType);
  trade.exitSignalDate = portfolioDriven
    ? scan.marketContext?.asOf || row.asOf
    : row.asOf;
  trade.exitSignalScanAt = scan.scannedAt;
  trade.exitReason = [
    ...(reasons || row.signalReason || row.exitReason || []),
    `Closing exit signal dated ${trade.exitSignalDate}; sell fill must come from the next actual market session 09:15-09:20 IST window, after skipping weekends and exchange holidays.`
  ];
  trade.exitSnapshot = snapshot(row);
  markToMarket(trade, row);
}

function preparePartialExit(trade, row, scan, decision, config) {
  const rules = portfolioConfig(config);
  trade.status = "PENDING_PARTIAL_EXIT";
  trade.partialExitSignalDate = row.asOf;
  trade.partialExitSignalScanAt = scan.scannedAt;
  trade.pendingPartialExitPct = decision.partialPct || rules.partialExitPct;
  trade.pendingPartialExitTag = decision.tag || "RISK_REDUCTION";
  trade.pendingPartialExitReason = [
    ...(decision.reasons || []),
    `Sell ${trade.pendingPartialExitPct}% on the next actual market session at 09:15 and trail the balance.`
  ];
  trade.exitSnapshot = snapshot(row);
  markToMarket(trade, row);
}

async function fillEntry(trade, row, config, trades, candidates) {
  try {
    const fill = await fetchOpeningWindowPrice(
      trade.yahooSymbol || row.yahooSymbol,
      trade.entrySignalDate
    );
    if (!fill) {
      trade.executionError =
        "Next market-session 09:15 candle is not available yet; pending through weekends and NSE holidays.";
      return "WAITING";
    }
    const summary = portfolioSummary(trades, candidates, config);
    const sector = String(trade.industry || row.industry || "Unknown");
    const adjustedSectorExposure = { ...summary.sectorExposure };
    adjustedSectorExposure[sector] = Math.max(
      0,
      (adjustedSectorExposure[sector] || 0) - (Number(trade.plannedAllocation) || 0)
    );
    const plan = buildPositionPlan(
      row,
      fill.price,
      {
        ...summary,
        availableCash: summary.availableCash + (Number(trade.plannedAllocation) || 0),
        availableRisk: summary.availableRisk + (Number(trade.plannedRisk) || 0),
        openSlots: summary.openSlots + 1,
        sectorExposure: adjustedSectorExposure
      },
      config
    );
    if (!plan.eligible) {
      trade.executionError = `Entry skipped at actual fill: ${plan.reason}`;
      trade.status = "SKIPPED_ENTRY";
      trade.skipReason = trade.executionError;
      return "SKIPPED";
    }
    const quantity = plan.quantity;
    trade.status = "OPEN";
    trade.entryDate = fill.date;
    trade.entryTime = "09:15 IST";
    trade.entryPrice = round(fill.price);
    trade.quantity = quantity;
    trade.originalQuantity = quantity;
    trade.investedValue = round(quantity * fill.price);
    trade.originalInvestedValue = trade.investedValue;
    trade.initialStopPrice = plan.stopPrice;
    trade.trailingStopPrice = plan.stopPrice;
    trade.riskPerShare = plan.riskPerShare;
    trade.initialRiskAmount = plan.plannedRisk;
    trade.positionRank = plan.rank;
    trade.currentRank = plan.rank;
    trade.plannedQuantity = null;
    trade.plannedAllocation = null;
    trade.plannedRisk = null;
    trade.executionMethod = fill.source;
    trade.executionWindow = fill.window;
    trade.executionError = null;
    markToMarket(trade, row);
    return "FILLED";
  } catch (error) {
    trade.executionError = error.message || String(error);
    return "WAITING";
  }
}

async function fillExit(trade, row) {
  try {
    const fill = await fetchOpeningWindowPrice(
      trade.yahooSymbol || row.yahooSymbol,
      trade.exitSignalDate
    );
    if (!fill) {
      trade.executionError =
        "Next market-session 09:15 candle is not available yet; pending through weekends and NSE holidays.";
      return false;
    }
    trade.status = "CLOSED";
    trade.exitDate = fill.date;
    trade.exitTime = "09:15 IST";
    trade.exitPrice = round(fill.price);
    trade.executionError = null;
    const finalLegPnl = (fill.price - trade.entryPrice) * trade.quantity;
    trade.pnl = round((Number(trade.realizedPnlToDate) || 0) + finalLegPnl);
    trade.pnlPct = Number(trade.originalInvestedValue) > 0
      ? round(trade.pnl / trade.originalInvestedValue * 100)
      : round(((fill.price / trade.entryPrice) - 1) * 100);
    trade.holdingDays = holdingDays(trade.entryDate, fill.date);
    trade.lastPrice = round(fill.price);
    trade.lastPriceDate = fill.date;
    trade.unrealizedPnl = null;
    trade.unrealizedPnlPct = null;
    return true;
  } catch (error) {
    trade.executionError = error.message || String(error);
    return false;
  }
}

function markToMarket(trade, row) {
  if (!Number.isFinite(row.close)) return;
  trade.lastPrice = round(row.close);
  trade.lastPriceDate = row.asOf;
  if (!Number.isFinite(trade.entryPrice) || !Number.isFinite(trade.quantity)) return;
  trade.unrealizedPnl = round((row.close - trade.entryPrice) * trade.quantity);
  trade.unrealizedPnlPct = round(((row.close / trade.entryPrice) - 1) * 100);
}

async function migrateLegacyOpeningPrices(trades, config) {
  for (const trade of trades) {
    if (trade.entrySignalDate || !trade.entryDate || !Number.isFinite(trade.entryPrice)) continue;
    const oldSignalDate = trade.entryDate;
    trade.entrySignalDate = oldSignalDate;
    trade.entrySignalScanAt = trade.entryScanAt || null;
    trade.yahooSymbol = trade.yahooSymbol || `${trade.symbol}.NS`;
    try {
      const fill = await fetchOpeningWindowPrice(trade.yahooSymbol, oldSignalDate);
      if (!fill) {
        trade.executionMethod = "legacy_closing_price";
        continue;
      }
      trade.entryDate = fill.date;
      trade.entryTime = "09:15 IST";
      trade.entryPrice = round(fill.price);
      trade.quantity = calculateQuantity(fill.price, config);
      trade.investedValue = round(trade.quantity * fill.price);
      trade.executionMethod = fill.source;
      trade.executionWindow = fill.window;
      trade.migratedToOpeningWindow = true;
    } catch {
      trade.executionMethod = "legacy_closing_price";
    }
  }
}

async function fillPartialExit(trade, row) {
  try {
    const fill = await fetchOpeningWindowPrice(
      trade.yahooSymbol || row.yahooSymbol,
      trade.partialExitSignalDate
    );
    if (!fill) {
      trade.executionError =
        "Partial exit is pending until the next actual market-session 09:15 candle.";
      return false;
    }
    const percentage = Number(trade.pendingPartialExitPct) || 50;
    const sellQuantity = Math.max(1, Math.min(
      trade.quantity - 1,
      Math.floor(trade.quantity * percentage / 100)
    ));
    if (sellQuantity < 1 || trade.quantity < 2) {
      trade.status = "OPEN";
      trade.executionError = "Partial exit skipped because remaining quantity is too small.";
      return false;
    }
    const pnl = (fill.price - trade.entryPrice) * sellQuantity;
    trade.partialExits = Array.isArray(trade.partialExits) ? trade.partialExits : [];
    trade.partialExits.push({
      date: fill.date,
      time: "09:15 IST",
      price: round(fill.price),
      quantity: sellQuantity,
      pnl: round(pnl),
      tag: trade.pendingPartialExitTag,
      reason: trade.pendingPartialExitReason || []
    });
    trade.partialExitTags = Array.isArray(trade.partialExitTags) ? trade.partialExitTags : [];
    if (trade.pendingPartialExitTag && !trade.partialExitTags.includes(trade.pendingPartialExitTag)) {
      trade.partialExitTags.push(trade.pendingPartialExitTag);
    }
    trade.realizedPnlToDate = round((Number(trade.realizedPnlToDate) || 0) + pnl);
    trade.quantity -= sellQuantity;
    trade.investedValue = round(trade.quantity * trade.entryPrice);
    trade.status = "OPEN";
    trade.lastPartialExitDate = fill.date;
    trade.lastRiskActionSignalDate = row.asOf;
    trade.lastPartialExitPrice = round(fill.price);
    trade.executionError = null;
    trade.pendingPartialExitPct = null;
    trade.pendingPartialExitTag = null;
    trade.pendingPartialExitReason = [];
    markToMarket(trade, row);
    return true;
  } catch (error) {
    trade.executionError = error.message || String(error);
    return false;
  }
}

function migrateTradeMetadata(trades) {
  for (const trade of trades) {
    trade.tradeScope = inferTradeScope(trade);
    trade.tradeScopeLabel = TRADE_SCOPE_LABELS[trade.tradeScope];
    trade.tradeQualityMode = trade.tradeQualityMode || "LEGACY";
    trade.tradeQualityLabel = trade.tradeQualityLabel || "Legacy trade";
    trade.industry = trade.industry || trade.entrySnapshot?.industry || "Unknown";
    trade.originalQuantity = trade.originalQuantity || trade.quantity || null;
    trade.originalInvestedValue = trade.originalInvestedValue || trade.investedValue || null;
    trade.partialExits = Array.isArray(trade.partialExits) ? trade.partialExits : [];
    trade.partialExitTags = Array.isArray(trade.partialExitTags) ? trade.partialExitTags : [];
    trade.realizedPnlToDate = Number(trade.realizedPnlToDate) || 0;
    if (Number.isFinite(trade.entryPrice) && !Number.isFinite(trade.initialStopPrice)) {
      trade.initialStopPrice = round(trade.entryPrice * 0.92);
    }
    trade.trailingStopPrice = trade.trailingStopPrice || trade.initialStopPrice || null;
  }
}

function allScannedRows(scan) {
  const grouped = new Map();
  for (const list of Object.values(scan.lists || {})) {
    for (const row of list.results || []) {
      const key = row.yahooSymbol || row.symbol;
      if (!key || grouped.has(key)) continue;
      grouped.set(key, row);
    }
  }
  return [...grouped.values()];
}

function uniqueScannedRows(scan, scopeListId) {
  const scannedIds = new Set(scan.scannedListIds || Object.keys(scan.lists || {}));
  const primary = scan.lists?.[scopeListId];
  if (!primary || !scannedIds.has(scopeListId)) return [];

  const sourceListsByKey = new Map();
  const industryByKey = new Map();
  for (const list of Object.values(scan.lists || {})) {
    if (!scannedIds.has(list.id)) continue;
    for (const row of list.results || []) {
      const key = row.yahooSymbol || row.symbol;
      if (!key) continue;
      const labels = sourceListsByKey.get(key) || [];
      if (row.listLabel && !labels.includes(row.listLabel)) labels.push(row.listLabel);
      sourceListsByKey.set(key, labels);
      if (isSpecificIndustry(row.industry) && !industryByKey.has(key)) {
        industryByKey.set(key, row.industry);
      }
    }
  }

  const grouped = new Map();
  for (const row of primary.results || []) {
    const key = row.yahooSymbol || row.symbol;
    if (!key || grouped.has(key)) continue;
    grouped.set(key, {
      ...row,
      industry: industryByKey.get(key) || row.industry || "Unclassified",
      sourceLists: sourceListsByKey.get(key) || [row.listLabel].filter(Boolean)
    });
  }
  return [...grouped.values()];
}

function isSpecificIndustry(industry) {
  const value = String(industry || "").trim().toLowerCase();
  return Boolean(value) && !["unknown", "unclassified", "nse equity", "my list"].includes(value);
}

function signalStateKey(scopeListId, row) {
  return `${scopeListId}:${row.yahooSymbol || row.symbol}`;
}

function previousSymbolStatus(signalState, scopedKey, row, scopeListId) {
  if (signalState[scopedKey]?.status) return signalState[scopedKey].status;
  const yahooSymbol = row.yahooSymbol || row.symbol;
  const displaySymbol = row.symbol;
  const exactKeys = [`${scopeListId}:${displaySymbol}`, `${scopeListId}:${yahooSymbol}`];
  if (scopeListId === "all-market") exactKeys.push(yahooSymbol, displaySymbol);
  for (const key of exactKeys) {
    if (signalState[key]?.status) return signalState[key].status;
  }

  const suffixes = [`:${displaySymbol}`, `:${yahooSymbol}`];
  for (const [key, value] of Object.entries(signalState)) {
    if (
      key.startsWith(`${scopeListId}:`) &&
      suffixes.some((suffix) => key.endsWith(suffix)) &&
      value?.status
    ) {
      return value.status;
    }
  }
  return null;
}

function findAnyActiveTrade(trades, row) {
  return trades.find(
    (trade) =>
      ["PENDING_ENTRY", "OPEN", "PENDING_EXIT", "PENDING_PARTIAL_EXIT"].includes(trade.status) &&
      sameInstrument(trade, row)
  );
}

function upsertCandidate(candidates, row, scan, settings, existing) {
  const target = existing || {
    id: `${row.symbol}-${row.asOf}-candidate`,
    symbol: row.symbol,
    yahooSymbol: row.yahooSymbol,
    name: row.name,
    industry: row.industry || "Unknown",
    sourceLists: row.sourceLists || [row.listLabel].filter(Boolean),
    tradeScope: settings.scopeListId,
    tradeScopeLabel: settings.scopeLabel,
    firstSignalDate: row.asOf,
    firstSeenAt: scan.scannedAt
  };
  target.lastSignalDate = row.asOf;
  target.lastSeenAt = scan.scannedAt;
  target.rank = candidateRank(row);
  target.grade = row.setupGrade;
  target.score = row.score;
  target.entryStyle = row.entryStyle?.label || "";
  target.status = target.status || "WAITING_ALLOCATION";
  target.skipReason = target.skipReason || "Waiting for portfolio allocation.";
  if (!existing) candidates.push(target);
  return target;
}

function enforcePortfolioLimits(trades, rowBySymbol, scan, settings, config, events) {
  const rules = portfolioConfig(config);
  const open = trades
    .filter((trade) => ["OPEN", "PENDING_PARTIAL_EXIT"].includes(trade.status))
    .map((trade) => ({
      trade,
      row: executionRow(
        trade,
        rowBySymbol.get(trade.yahooSymbol || trade.symbol),
        scan.marketContext?.asOf
      ),
      rank: Number(trade.currentRank) || Number(trade.positionRank) || 0
    }))
    .filter((item) => item.row)
    .sort((a, b) => b.rank - a.rank);
  let keptCount = 0;
  let keptCapital = 0;
  for (const item of open) {
    if (inferTradeScope(item.trade) !== settings.scopeListId) continue;
    const capital = Number(item.trade.investedValue) || 0;
    const keep =
      keptCount < rules.maxOpenPositions &&
      keptCapital + capital <= rules.totalCapital;
    if (keep) {
      keptCount += 1;
      keptCapital += capital;
      continue;
    }
    prepareFullExit(
      item.trade,
      item.row,
      scan,
      [
        `Portfolio rebalance: only the best ${rules.maxOpenPositions} positions can use total capital Rs ${rules.totalCapital}.`,
        `Current portfolio rank ${item.rank}; stronger positions receive capital priority.`
      ],
      "CAPITAL_REBALANCE"
    );
    events.push({ type: "PORTFOLIO_EXIT_PENDING", trade: item.trade });
  }
}

function executionRow(trade, row, latestMarketClose) {
  const asOf =
    row?.asOf ||
    trade.exitSignalDate ||
    trade.partialExitSignalDate ||
    latestMarketClose ||
    trade.lastPriceDate ||
    trade.entrySignalDate;
  if (!asOf) return null;
  if (row?.asOf) return row;
  return {
    ...(row || {}),
    symbol: trade.symbol,
    yahooSymbol: trade.yahooSymbol,
    asOf,
    close: Number(trade.lastPrice) || Number(trade.entryPrice) || null,
    dailySupertrend: trade.trailingStopPrice || trade.initialStopPrice || null,
    weeklyRs: trade.currentWeeklyRs ?? trade.entrySnapshot?.weeklyRs ?? null,
    dailyLongRs: trade.entrySnapshot?.dailyLongRs ?? null,
    dailyShortRs: trade.entrySnapshot?.dailyShortRs ?? null,
    dailyRsi: trade.entrySnapshot?.dailyRsi ?? null,
    setupGrade: trade.currentGrade || trade.entrySnapshot?.setupGrade || "WATCH",
    setupStrength: trade.entrySnapshot?.setupStrength || {},
    fundamentalScore: trade.entrySnapshot?.fundamentalScore ?? null
  };
}

function visibleTradesForSettings(trades, settings) {
  return trades.filter(
    (trade) =>
      ["PENDING_ENTRY", "OPEN", "PENDING_EXIT", "PENDING_PARTIAL_EXIT"].includes(trade.status) ||
      tradeMatchesSettings(trade, settings)
  );
}

function tradeMatchesSettings(trade, settings) {
  return (
    inferTradeScope(trade) === settings.scopeListId &&
    tradePassesQuality(trade, settings.qualityMode)
  );
}

function tradePassesQuality(trade, qualityMode) {
  const mode = normalizeTradeQuality(qualityMode);
  if (mode === "ALL_ENTRIES") return true;
  const grade = String(trade.entrySnapshot?.setupGrade || "").toUpperCase();
  if (mode === "STRONG_OR_BETTER") return ["A+", "A", "B"].includes(grade);
  return ["A+", "A"].includes(grade);
}

function inferTradeScope(trade) {
  if (TRADE_SCOPE_LABELS[trade.tradeScope]) return trade.tradeScope;
  if (TRADE_SCOPE_LABELS[trade.listId]) return trade.listId;
  const source = [trade.listLabel, ...(trade.sourceLists || [])].join(" ").toLowerCase();
  if (source.includes("my custom") || source.includes("my list")) return "custom";
  if (source.includes("nifty")) return "default";
  if (source.includes("all nse")) return "all-market";
  return "default";
}

function sameInstrument(trade, row) {
  if (trade.yahooSymbol && row.yahooSymbol) return trade.yahooSymbol === row.yahooSymbol;
  return trade.symbol === row.symbol;
}

function calculateQuantity(price, config) {
  if (Number.isFinite(config.trade.capitalPerStock) && config.trade.capitalPerStock > 0) {
    return Math.max(1, Math.floor(config.trade.capitalPerStock / price));
  }
  return config.trade.defaultQty;
}

async function writeXlsx(journal, filePath) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Techno Funda Screener";
  workbook.created = new Date();

  const pending = journal.trades.filter((trade) => trade.status.startsWith("PENDING_"));
  const open = journal.trades.filter((trade) => trade.status === "OPEN");
  const closed = journal.trades.filter((trade) => trade.status === "CLOSED");
  const realizedPnl = closed.reduce((sum, trade) => sum + (trade.pnl || 0), 0);
  const unrealizedPnl = open.reduce((sum, trade) => sum + (trade.unrealizedPnl || 0), 0);
  const portfolio = journal.portfolioSummary || portfolioSummary(journal.trades, journal.candidates, config);

  const summary = workbook.addWorksheet("Summary");
  summary.columns = [
    { header: "Metric", key: "metric", width: 34 },
    { header: "Value", key: "value", width: 32 }
  ];
  summary.addRows([
    { metric: "Updated At", value: journal.updatedAt },
    { metric: "Total Capital", value: portfolio.totalCapital },
    { metric: "Total Equity", value: portfolio.totalEquity },
    { metric: "Invested Capital", value: portfolio.investedCapital },
    { metric: "Reserved Capital", value: portfolio.reservedCapital },
    { metric: "Available Cash", value: portfolio.availableCash },
    { metric: "Capital Utilization %", value: portfolio.capitalUtilizationPct },
    { metric: "Portfolio Risk", value: portfolio.portfolioRisk },
    { metric: "Portfolio Risk %", value: portfolio.portfolioRiskPct },
    { metric: "Portfolio Risk Limit", value: portfolio.riskLimit },
    { metric: "Waiting Candidates", value: portfolio.waitingCandidates },
    { metric: "Pending Orders", value: pending.length },
    { metric: "Open Positions", value: open.length },
    { metric: "Closed Trades", value: closed.length },
    { metric: "Realized P&L", value: round(realizedPnl) },
    { metric: "Unrealized P&L", value: round(unrealizedPnl) },
    { metric: "Capital Per Stock", value: journal.tradeCapitalPerStock },
    { metric: "Trade Scope", value: journal.tradeSettings?.scopeLabel || "" },
    { metric: "Trade Quality", value: journal.tradeSettings?.qualityLabel || "" },
    { metric: "Signal Basis", value: journal.executionRule?.signalBasis || "" },
    { metric: "Session Rule", value: journal.executionRule?.sessionRule || "Skip weekends and market holidays" },
    { metric: "Execution Window", value: journal.executionRule?.window || "09:15-09:20 IST" },
    { metric: "Execution Price", value: "First 5-minute candle open (09:15)" }
  ]);

  addTradeWorksheet(workbook, "Open Positions", open);
  addTradeWorksheet(workbook, "Pending Orders", pending);
  addTradeWorksheet(workbook, "Closed Trades", closed);
  addTradeWorksheet(workbook, "All Trades", journal.trades);
  addCandidateWorksheet(workbook, journal.candidates || []);
  addCapitalLedgerWorksheet(workbook, journal.capitalTransactions || []);

  await workbook.xlsx.writeFile(filePath);
}

function addTradeWorksheet(workbook, name, trades) {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = tradeColumns();
  sheet.addRows(trades.map(tradeToRow));
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  formatSheet(sheet);
}

function writeCsv(journal, filePath) {
  const headers = tradeColumns().map((column) => column.header);
  const lines = [headers.join(",")];
  for (const trade of journal.trades) {
    const row = tradeToRow(trade);
    lines.push(headers.map((header) => csvValue(row[header])).join(","));
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function tradeColumns() {
  return [
    { header: "Trade Scope", key: "Trade Scope", width: 18 },
    { header: "Trade Quality", key: "Trade Quality", width: 22 },
    { header: "Source Lists", key: "Source Lists", width: 28 },
    { header: "Symbol", key: "Symbol", width: 14 },
    { header: "Name", key: "Name", width: 28 },
    { header: "Status", key: "Status", width: 16 },
    { header: "Entry Signal Date", key: "Entry Signal Date", width: 18 },
    { header: "Entry Date", key: "Entry Date", width: 14 },
    { header: "Entry Time", key: "Entry Time", width: 13 },
    { header: "Entry Price", key: "Entry Price", width: 14 },
    { header: "Quantity", key: "Quantity", width: 10 },
    { header: "Original Quantity", key: "Original Quantity", width: 16 },
    { header: "Invested Value", key: "Invested Value", width: 16 },
    { header: "Last Close", key: "Last Close", width: 14 },
    { header: "Unrealized P&L", key: "Unrealized P&L", width: 16 },
    { header: "Unrealized P&L %", key: "Unrealized P&L %", width: 18 },
    { header: "Exit Signal Date", key: "Exit Signal Date", width: 18 },
    { header: "Exit Date", key: "Exit Date", width: 14 },
    { header: "Exit Time", key: "Exit Time", width: 13 },
    { header: "Exit Price", key: "Exit Price", width: 14 },
    { header: "Realized P&L", key: "Realized P&L", width: 16 },
    { header: "Realized P&L %", key: "Realized P&L %", width: 18 },
    { header: "Holding Days", key: "Holding Days", width: 14 },
    { header: "Execution Window", key: "Execution Window", width: 20 },
    { header: "Position Rank", key: "Position Rank", width: 14 },
    { header: "Current Rank", key: "Current Rank", width: 14 },
    { header: "Initial Stop", key: "Initial Stop", width: 14 },
    { header: "Trailing Stop", key: "Trailing Stop", width: 14 },
    { header: "Initial Risk", key: "Initial Risk", width: 14 },
    { header: "Current R", key: "Current R", width: 12 },
    { header: "Partial Exit Count", key: "Partial Exit Count", width: 18 },
    { header: "Partial Realized P&L", key: "Partial Realized P&L", width: 20 },
    { header: "Exit Type", key: "Exit Type", width: 22 },
    { header: "Replacement Candidate", key: "Replacement Candidate", width: 24 },
    { header: "Entry Style", key: "Entry Style", width: 26 },
    { header: "Setup Grade", key: "Setup Grade", width: 13 },
    { header: "Setup Score", key: "Setup Score", width: 14 },
    { header: "Fundamental Score", key: "Fundamental Score", width: 18 },
    { header: "Institutional Score", key: "Institutional Score", width: 18 },
    { header: "GTF Score", key: "GTF Score", width: 14 },
    { header: "GTF Daily Demand", key: "GTF Daily Demand", width: 28 },
    { header: "GTF Weekly Demand", key: "GTF Weekly Demand", width: 28 },
    { header: "GTF Opposing Supply", key: "GTF Opposing Supply", width: 30 },
    { header: "GTF 2R Room", key: "GTF 2R Room", width: 14 },
    { header: "Index Context", key: "Index Context", width: 34 },
    { header: "Derivatives Context", key: "Derivatives Context", width: 34 },
    { header: "Options Context", key: "Options Context", width: 34 },
    { header: "Commodity Context", key: "Commodity Context", width: 34 },
    { header: "Concept Score", key: "Concept Score", width: 16 },
    { header: "Strong Concepts", key: "Strong Concepts", width: 42 },
    { header: "Weak Concepts", key: "Weak Concepts", width: 42 },
    { header: "Data Gaps", key: "Data Gaps", width: 30 },
    { header: "Excluded Playbooks", key: "Excluded Playbooks", width: 36 },
    { header: "Sector Breadth", key: "Sector Breadth", width: 18 },
    { header: "Near 52W High", key: "Near 52W High", width: 14 },
    { header: "55D Breakout", key: "55D Breakout", width: 14 },
    { header: "Volume Ratio", key: "Volume Ratio", width: 14 },
    { header: "ATR %", key: "ATR %", width: 12 },
    { header: "Risk To ST %", key: "Risk To ST %", width: 14 },
    { header: "Retracement Buy", key: "Retracement Buy", width: 18 },
    { header: "Pullback Depth %", key: "Pullback Depth %", width: 18 },
    { header: "Pullback Support", key: "Pullback Support", width: 20 },
    { header: "Pullback Risk %", key: "Pullback Risk %", width: 18 },
    { header: "Pullback Volume Ratio", key: "Pullback Volume Ratio", width: 22 },
    { header: "Reclaim Volume Ratio", key: "Reclaim Volume Ratio", width: 22 },
    { header: "Candle Pattern", key: "Candle Pattern", width: 24 },
    { header: "Previous Low", key: "Previous Low", width: 14 },
    { header: "2 Candle Low", key: "2 Candle Low", width: 14 },
    { header: "4 Candle Low", key: "4 Candle Low", width: 14 },
    { header: "Entry Reason", key: "Entry Reason", width: 60 },
    { header: "Exit Reason", key: "Exit Reason", width: 60 }
  ];
}

function tradeToRow(trade) {
  const setup = trade.entrySnapshot?.setupStrength || {};
  const values = setup.values || {};
  const checks = setup.checks || {};
  const sector = trade.entrySnapshot?.sectorStrength || {};
  const coverage = trade.entrySnapshot?.conceptCoverage || {};
  const institutional = trade.entrySnapshot?.institutionalContext || {};
  const gtf = trade.entrySnapshot?.gtfContext || {};
  return {
    "Trade Scope": trade.tradeScopeLabel || TRADE_SCOPE_LABELS[inferTradeScope(trade)] || "",
    "Trade Quality": trade.tradeQualityLabel || "",
    "Source Lists": (trade.sourceLists || [trade.listLabel]).filter(Boolean).join(", "),
    Symbol: trade.symbol,
    Name: trade.name,
    Status: trade.status,
    "Entry Signal Date": trade.entrySignalDate || "",
    "Entry Date": trade.entryDate || "",
    "Entry Time": trade.entryTime || "",
    "Entry Price": trade.entryPrice ?? "",
    Quantity: trade.quantity ?? "",
    "Original Quantity": trade.originalQuantity ?? "",
    "Invested Value": trade.investedValue ?? "",
    "Last Close": trade.lastPrice ?? "",
    "Unrealized P&L": trade.unrealizedPnl ?? "",
    "Unrealized P&L %": trade.unrealizedPnlPct ?? "",
    "Exit Signal Date": trade.exitSignalDate || "",
    "Exit Date": trade.exitDate || "",
    "Exit Time": trade.exitTime || "",
    "Exit Price": trade.exitPrice ?? "",
    "Realized P&L": trade.pnl ?? "",
    "Realized P&L %": trade.pnlPct ?? "",
    "Holding Days": trade.holdingDays ?? "",
    "Execution Window": trade.executionWindow || "",
    "Position Rank": trade.positionRank ?? "",
    "Current Rank": trade.currentRank ?? "",
    "Initial Stop": trade.initialStopPrice ?? "",
    "Trailing Stop": trade.trailingStopPrice ?? "",
    "Initial Risk": trade.initialRiskAmount ?? trade.plannedRisk ?? "",
    "Current R": trade.currentRewardR ?? "",
    "Partial Exit Count": trade.partialExits?.length || 0,
    "Partial Realized P&L": trade.realizedPnlToDate ?? 0,
    "Exit Type": trade.exitType || "",
    "Replacement Candidate": trade.replacementCandidateSymbol || "",
    "Entry Style": trade.entrySnapshot?.entryStyle?.label || "",
    "Setup Grade": trade.entrySnapshot?.setupGrade || "",
    "Setup Score": trade.entrySnapshot?.setupStrengthScore ?? "",
    "Fundamental Score": trade.entrySnapshot?.fundamentalScore ?? "",
    "Institutional Score": institutional.maxScore ? `${institutional.score}/${institutional.maxScore}` : "",
    "GTF Score": gtf.maxScore ? `${gtf.score}/${gtf.maxScore} (${gtf.grade || ""})` : "",
    "GTF Daily Demand": formatGtfZone(gtf.dailyDemand),
    "GTF Weekly Demand": formatGtfZone(gtf.weeklyDemand),
    "GTF Opposing Supply": formatGtfZone(gtf.opposingSupply),
    "GTF 2R Room": gtf.unlimitedRewardRoom ? "Clear" : Number.isFinite(gtf.rewardRisk) ? `${round(gtf.rewardRisk)}R` : "",
    "Index Context": institutional.index?.reason || "",
    "Derivatives Context": institutional.derivatives?.reason || "",
    "Options Context": institutional.options?.reason || "",
    "Commodity Context": institutional.commodity?.reason || "",
    "Concept Score": coverage.applicable ? `${coverage.passed}/${coverage.applicable}` : "",
    "Strong Concepts": (coverage.passLabels || []).join("; "),
    "Weak Concepts": (coverage.weakLabels || []).join("; "),
    "Data Gaps": (coverage.dataGapLabels || []).join("; "),
    "Excluded Playbooks": (coverage.excludedLabels || []).join("; "),
    "Sector Breadth": Number.isFinite(sector.breadthPct)
      ? `${round(sector.breadthPct)}% (${sector.strong}/${sector.total})`
      : "",
    "Near 52W High": checks.nearYearHigh ? "Yes" : "No",
    "55D Breakout": checks.recentHighBreakout ? "Yes" : "No",
    "Volume Ratio": Number.isFinite(values.volumeRatio) ? round(values.volumeRatio) : "",
    "ATR %": Number.isFinite(values.atrPct) ? round(values.atrPct) : "",
    "Risk To ST %": Number.isFinite(values.riskToSupertrendPct)
      ? round(values.riskToSupertrendPct)
      : "",
    "Retracement Buy": checks.retracementBuyZone ? "Yes" : "No",
    "Pullback Depth %": Number.isFinite(values.retracementPullbackDepthPct)
      ? round(values.retracementPullbackDepthPct)
      : "",
    "Pullback Support": values.retracementSupportSource || "",
    "Pullback Risk %": Number.isFinite(values.retracementSupportDistancePct)
      ? round(values.retracementSupportDistancePct)
      : "",
    "Pullback Volume Ratio": Number.isFinite(values.retracementPullbackVolumeRatio)
      ? round(values.retracementPullbackVolumeRatio)
      : "",
    "Reclaim Volume Ratio": Number.isFinite(values.retracementCurrentVolumeRatio)
      ? round(values.retracementCurrentVolumeRatio)
      : "",
    "Candle Pattern": values.candlePattern || "",
    "Previous Low": Number.isFinite(values.previousLow) ? round(values.previousLow) : "",
    "2 Candle Low": Number.isFinite(values.twoCandleLow) ? round(values.twoCandleLow) : "",
    "4 Candle Low": Number.isFinite(values.fourCandleLow) ? round(values.fourCandleLow) : "",
    "Entry Reason": (trade.entryReason || []).join(" "),
    "Exit Reason": (trade.exitReason || []).join(" ")
  };
}

function formatSheet(sheet) {
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF182026" }
  };
  sheet.autoFilter = {
    from: "A1",
    to: `${sheet.getColumn(sheet.columns.length).letter}1`
  };
  const availableKeys = new Set(sheet.columns.map((column) => column.key));
  for (const row of sheet.getRows(2, Math.max(0, sheet.rowCount - 1)) || []) {
    for (const key of ["Unrealized P&L", "Realized P&L"]) {
      if (!availableKeys.has(key)) continue;
      const cell = row.getCell(key);
      if (Number(cell.value) > 0) cell.font = { color: { argb: "FF147A52" } };
      if (Number(cell.value) < 0) cell.font = { color: { argb: "FFB4232A" } };
    }
  }
}

function snapshot(row) {
  return {
    industry: row.industry || "Unknown",
    close: row.close,
    asOf: row.asOf,
    dailyRsi: row.dailyRsi,
    weeklyRsi: row.weeklyRsi,
    weeklyRs: row.weeklyRs,
    dailyLongRs: row.dailyLongRs,
    dailyShortRs: row.dailyShortRs,
    dailySupertrend: row.dailySupertrend,
    dailyPriceAboveSupertrend: row.dailyPriceAboveSupertrend,
    entryStyle: row.entryStyle,
    setupStrength: row.setupStrength,
    setupStrengthScore: row.setupStrengthScore,
    setupGrade: row.setupGrade,
    sectorStrength: row.sectorStrength,
    sectorStrengthScore: row.sectorStrengthScore,
    institutionalContext: row.institutionalContext,
    institutionalScore: row.institutionalScore,
    gtfContext: row.gtfContext,
    gtfScore: row.gtfScore,
    conceptCoverage: row.conceptCoverage,
    fundamentalScore: row.fundamentalScore,
    fundamental: row.fundamental,
    score: row.score
  };
}

function sortTrades(a, b) {
  const rank = { PENDING_EXIT: 0, PENDING_ENTRY: 1, OPEN: 2, CLOSED: 3 };
  const rankDifference = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
  if (rankDifference !== 0) return rankDifference;
  return String(b.entrySignalDate || b.entryDate || "").localeCompare(
    String(a.entrySignalDate || a.entryDate || "")
  );
}

function holdingDays(entryDate, exitDate) {
  const entry = new Date(entryDate).getTime();
  const exit = new Date(exitDate).getTime();
  if (!Number.isFinite(entry) || !Number.isFinite(exit)) return null;
  return Math.max(0, Math.round((exit - entry) / (24 * 60 * 60 * 1000)));
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function csvValue(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatGtfZone(zone) {
  if (!zone) return "";
  const freshness = zone.freshnessTests === 0 ? "fresh" : `tests ${zone.freshnessTests}`;
  return `${zone.timeframe || ""} ${zone.pattern || ""} ${zone.distal}-${zone.proximal}; ${freshness}; ${zone.score}/7`;
}

function addCapitalLedgerWorksheet(workbook, transactions) {
  const sheet = workbook.addWorksheet("Capital Ledger");
  sheet.columns = [
    { header: "Date", key: "date", width: 24 },
    { header: "Type", key: "type", width: 20 },
    { header: "Amount", key: "amount", width: 16 },
    { header: "Previous Capital", key: "previousCapital", width: 20 },
    { header: "New Capital", key: "newCapital", width: 20 },
    { header: "Source", key: "source", width: 34 }
  ];
  sheet.addRows(transactions);
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  formatSheet(sheet);
}

function addCandidateWorksheet(workbook, candidates) {
  const sheet = workbook.addWorksheet("Waiting Candidates");
  sheet.columns = [
    { header: "Status", key: "status", width: 20 },
    { header: "Symbol", key: "symbol", width: 16 },
    { header: "Industry", key: "industry", width: 24 },
    { header: "Signal Date", key: "signalDate", width: 16 },
    { header: "Grade", key: "grade", width: 12 },
    { header: "Rank", key: "rank", width: 12 },
    { header: "Entry Style", key: "entryStyle", width: 28 },
    { header: "Planned Allocation", key: "allocation", width: 20 },
    { header: "Planned Risk", key: "risk", width: 16 },
    { header: "Planned Stop", key: "stop", width: 16 },
    { header: "Decision Reason", key: "reason", width: 70 }
  ];
  sheet.addRows(candidates.map((candidate) => ({
    status: candidate.status,
    symbol: candidate.symbol,
    industry: candidate.industry,
    signalDate: candidate.firstSignalDate,
    grade: candidate.grade,
    rank: candidate.rank,
    entryStyle: candidate.entryStyle,
    allocation: candidate.plannedAllocation,
    risk: candidate.plannedRisk,
    stop: candidate.plannedStopPrice,
    reason: candidate.skipReason
  })));
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  formatSheet(sheet);
}

function normalizeTradeScope(scopeListId) {
  return TRADE_SCOPE_LABELS[scopeListId] ? scopeListId : "all-market";
}

function normalizeTradeQuality(qualityMode) {
  return TRADE_QUALITY_LABELS[qualityMode] ? qualityMode : "BEST_ONLY";
}
