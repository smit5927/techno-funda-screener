import fs from "node:fs";
import ExcelJS from "exceljs";
import { appConfig } from "./config.js";
import { readTrades, saveTrades } from "./storage.js";
import { fetchExecutionPrice } from "./yahoo.js";
import {
  buildPositionPlan,
  buildPyramidAddPlan,
  candidateEntryDecision,
  candidateRank,
  nextTrailingStop,
  portfolioConfig,
  portfolioSummary,
  positionExitDecision,
  positionWeakness,
  postEntryPyramidState,
  pyramidAddDecision,
  rotationDecision,
  totalRealizedPnl
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

const EXECUTION_TIME = "09:17 IST";
const LEGACY_EXECUTION_METHODS = new Set([
  "09:15 five-minute candle open",
  "first_5m_candle_open"
]);

export async function updateTradeJournal(scan, config = appConfig, options = {}) {
  const journal = options.journal && typeof options.journal === "object"
    ? structuredClone(options.journal)
    : readTrades();
  const settings = tradeSettingsSummary(config);
  const riskRules = portfolioConfig(config);
  const liveMode = config.trade.onlyNewSignals !== false;
  const portfolioUpgrade = !journal.portfolioEngineStartedAt;
  const pyramidingUpgrade = !journal.pyramidingStartedAt;
  const swingPyramidingUpgrade = !journal.pyramidSwingEngineStartedAt;
  const firstLiveScan = liveMode && !journal.liveModeStartedAt;
  const trades = firstLiveScan ? [] : Array.isArray(journal.trades) ? journal.trades : [];
  let candidates = firstLiveScan ? [] : Array.isArray(journal.candidates) ? journal.candidates : [];
  let candidateDecisionLog = firstLiveScan
    ? []
    : Array.isArray(journal.candidateDecisionLog) ? journal.candidateDecisionLog : [];
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
  const scopeRowBySymbol = new Map(
    rows.map((row) => [row.yahooSymbol || row.symbol, row])
  );
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
  await correctActiveExecutionPrices(trades);

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
      recordRotationObservation(trade, row, trade.currentWeakness);
    }
    if (trade.status === "OPEN" && trade.pendingAdd && row) {
      const outcome = await fillPyramidAdd(trade, row, config, trades, candidates);
      if (outcome === "FILLED") events.push({ type: "PYRAMID_ADD_FILLED", trade });
      if (outcome === "SKIPPED") events.push({ type: "PYRAMID_ADD_SKIPPED", trade });
    }
    cancelInvalidPendingPartialExit(trade, row, config);
    if (trade.status === "PENDING_EXIT" && row) {
      await attemptPendingExit(
        trade,
        row,
        candidates,
        rowBySymbol,
        scan,
        settings,
        config,
        events
      );
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
    trade.latestManagementDecision = {
      asOf: row.asOf,
      action: decision.action,
      reasons: decision.reasons || [],
      hierarchy: "FULL_EXIT > PARTIAL_EXIT > QUALITY_ROTATION > HOLD"
    };
    if (decision.action === "FULL_EXIT") {
      prepareFullExit(trade, row, scan, decision.reasons, "MODEL_EXIT");
      events.push({ type: "EXIT_SIGNAL_PENDING", trade });
    } else if (decision.action === "PARTIAL_EXIT") {
      preparePartialExit(trade, row, scan, decision, config);
      events.push({ type: "PARTIAL_EXIT_PENDING", trade });
    }
  }

  enforcePortfolioLimits(trades, rowBySymbol, scan, settings, config, events);

  for (const trade of trades.filter((item) => item.status === "OPEN")) {
    const row = executionRow(
      trade,
      rowBySymbol.get(trade.yahooSymbol || trade.symbol),
      scan.marketContext?.asOf
    );
    if (!row?.asOf || trade.pyramidState?.asOf === row.asOf) continue;
    const currentState = { ...postEntryPyramidState(trade, row, config), asOf: row.asOf };
    const previousState = trade.pyramidState;
    const freshBreakout =
      !pyramidingUpgrade &&
      !swingPyramidingUpgrade &&
      previousState?.breakout === false &&
      currentState.breakout === true;
    if (freshBreakout && !trade.pendingAdd) {
      const portfolio = portfolioSummary(trades, candidates, config);
      const decision = pyramidAddDecision(trade, row, portfolio, config);
      trade.lastPyramidDecision = {
        asOf: row.asOf,
        eligible: decision.eligible,
        reasons: decision.reasons,
        breakout: decision.breakout,
        rewardR: decision.rewardR
      };
      if (decision.eligible) {
        preparePyramidAdd(trade, row, scan, decision);
        events.push({ type: "PYRAMID_ADD_PENDING", trade });
      }
    }
    trade.pyramidState = currentState;
  }

  for (const trade of trades) {
    const row = executionRow(
      trade,
      rowBySymbol.get(trade.yahooSymbol || trade.symbol),
      scan.marketContext?.asOf
    );
    if (trade.status === "PENDING_EXIT" && row) {
      await attemptPendingExit(
        trade,
        row,
        candidates,
        rowBySymbol,
        scan,
        settings,
        config,
        events
      );
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

  const retainedCandidates = [];
  for (const candidate of candidates) {
    const row = scopeRowBySymbol.get(candidate.yahooSymbol || candidate.symbol);
    const qualityPass = Boolean(row && rowPassesTradeQuality(row, settings));
    const decision = candidateEntryDecision(candidate, row || {}, config, { qualityPass });
    applyCandidateDecision(candidate, decision, scan);
    if (row && !findAnyActiveTrade(trades, row) && decision.disposition !== "EXPIRED") {
      retainedCandidates.push(candidate);
    } else {
      candidateDecisionLog = recordCandidateDecision(candidateDecisionLog, candidate, decision, scan, "REMOVED");
    }
  }
  candidates = retainedCandidates;

  let rotationScheduled = false;
  for (const candidate of [...candidates].sort((a, b) => b.rank - a.rank)) {
    const row = scopeRowBySymbol.get(candidate.yahooSymbol || candidate.symbol);
    if (!row) continue;
    const linkedRotation = rotationExecutionForCandidate(candidate, trades);
    if (candidate.rotation?.sourceTradeId && !linkedRotation) {
      const source = trades.find((trade) => trade.id === candidate.rotation.sourceTradeId);
      candidate.status = "WAITING_ROTATION";
      candidate.skipReason = `Waiting for ${source?.symbol || candidate.rotation.sourceSymbol} exact 09:17 rotation sell to release cash.`;
      candidate.lastEvaluatedAt = scan.scannedAt;
      continue;
    }
    const candidateCheck = candidateEntryDecision(candidate, row, config, {
      qualityPass: rowPassesTradeQuality(row, settings),
      forRotation: false
    });
    applyCandidateDecision(candidate, candidateCheck, scan);
    if (!candidateCheck.actionable) {
      candidateDecisionLog = recordCandidateDecision(
        candidateDecisionLog,
        candidate,
        candidateCheck,
        scan,
        "DEFERRED"
      );
      continue;
    }
    const portfolio = portfolioSummary(trades, candidates, config);
    const plan = buildPositionPlan(row, row.close, portfolio, config);
    candidate.rank = plan.rank;
    candidate.grade = row.setupGrade;
    candidate.plannedStopPrice = plan.stopPrice;
    candidate.plannedRisk = plan.plannedRisk;
    candidate.plannedAllocation = plan.allocation;
    candidate.lastEvaluatedAt = scan.scannedAt;
    if (plan.eligible) {
      const trade = createPendingEntry(
        row,
        scan,
        config,
        settings,
        plan,
        linkedRotation,
        candidate
      );
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
      const rotationCheck = candidateEntryDecision(candidate, row, config, {
        qualityPass: rowPassesTradeQuality(row, settings),
        forRotation: true
      });
      if (!rotationCheck.actionable) {
        candidate.status = rotationCheck.disposition;
        candidate.skipReason = rotationCheck.reasons.join(" ");
        candidate.lastDecision = rotationCheck;
        candidateDecisionLog = recordCandidateDecision(
          candidateDecisionLog,
          candidate,
          rotationCheck,
          scan,
          "ROTATION_DEFERRED"
        );
        continue;
      }
      const rotation = rotationDecision(row, trades, rowBySymbol, config, candidate);
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
        candidate.rotation = {
          sourceTradeId: rotation.trade.id,
          sourceSymbol: rotation.trade.symbol,
          requestedAt: scan.scannedAt,
          rankAdvantage: round(rotation.advantage)
        };
        candidate.status = "WAITING_ROTATION";
        candidate.skipReason = `Waiting for ${rotation.trade.symbol} rotation exit. ${rotation.reason}`;
        rotationScheduled = true;
        events.push({ type: "ROTATION_EXIT_PENDING", trade: rotation.trade, candidate });
        const filled = await attemptPendingExit(
          rotation.trade,
          weakRow,
          candidates,
          rowBySymbol,
          scan,
          settings,
          config,
          events
        );
        if (filled) {
          const fundedPlan = buildPositionPlan(
            row,
            row.close,
            portfolioSummary(trades, candidates, config),
            config
          );
          if (fundedPlan.eligible) {
            const rotationExecution = rotationExecutionForCandidate(candidate, trades);
            const replacement = createPendingEntry(
              row,
              scan,
              config,
              settings,
              fundedPlan,
              rotationExecution,
              candidate
            );
            trades.push(replacement);
            candidates = candidates.filter((item) => item !== candidate);
            events.push({ type: "ENTRY_SIGNAL_PENDING", trade: replacement });
          } else {
            candidate.status = "ROTATION_CASH_READY";
            candidate.skipReason =
              `${rotation.trade.symbol} sold at 09:17, but replacement risk recheck did not pass: ${fundedPlan.reason}`;
          }
        }
      }
    }
  }

  for (const trade of trades.filter((item) => item.status === "PENDING_ENTRY")) {
    const row = rowBySymbol.get(trade.yahooSymbol || trade.symbol);
    if (!row) continue;
    const outcome = await fillEntry(trade, row, config, trades, candidates);
    if (outcome === "FILLED") events.push({ type: "ENTRY_TRADE_OPENED", trade });
    if (outcome === "SKIPPED") {
      const candidate = upsertCandidate(
        candidates,
        row,
        scan,
        settings,
        null,
        trade.candidateContext
      );
      candidate.status = "WAITING_CAPITAL";
      candidate.skipReason = trade.skipReason;
      candidate.skipAlertedAt = scan.scannedAt;
      events.push({ type: "ENTRY_SKIPPED", trade, candidate });
    }
  }

  const finalPortfolio = portfolioSummary(trades, candidates, config);

  const nextJournal = {
    updatedAt: new Date().toISOString(),
    legacyOwnerJournalMigratedAt: journal.legacyOwnerJournalMigratedAt || null,
    portfolioEngineStartedAt: journal.portfolioEngineStartedAt || scan.scannedAt,
    pyramidingStartedAt: journal.pyramidingStartedAt || scan.scannedAt,
    pyramidSwingEngineStartedAt: journal.pyramidSwingEngineStartedAt || scan.scannedAt,
    liveModeStartedAt: journal.liveModeStartedAt || (liveMode ? new Date().toISOString() : null),
    baselineInitialized: true,
    baselineScanAt: journal.baselineScanAt || (firstLiveScan ? scan.scannedAt : null),
    executionRule: {
      signalBasis: "completed daily/weekly closing candle",
      sessionRule: "first actual exchange session after the signal date; weekends and market holidays are skipped",
      window: EXECUTION_TIME,
      priceSource: config.trade.executionPriceSource
    },
    signalState: nextSignalState,
    tradeCapitalPerStock: riskRules.totalCapital * riskRules.maxPositionPct / 100,
    portfolioRules: riskRules,
    portfolioSummary: finalPortfolio,
    capitalTransactions,
    candidates: candidates.sort((a, b) => b.rank - a.rank),
    candidateDecisionLog: candidateDecisionLog.slice(-250),
    tradeSettings: settings,
    trades: trades.sort(sortTrades)
  };
  if (options.persist !== false) saveTrades(nextJournal);
  const visibleTrades = visibleTradesForSettings(nextJournal.trades, settings);
  if (options.writeSheets !== false) {
    await writeTradeSheets({ ...nextJournal, trades: visibleTrades }, config);
  }
  return {
    ...nextJournal,
    visibleTrades,
    events,
    visibleCandidates: nextJournal.candidates,
    visibleCandidateDecisions: nextJournal.candidateDecisionLog.slice(-50).reverse()
  };
}

function cancelInvalidPendingPartialExit(trade, row, config) {
  if (trade.status !== "PENDING_PARTIAL_EXIT" || !row) return;
  const decision = positionExitDecision({ ...trade, status: "OPEN" }, row, config);
  const stillValid = decision.action === "PARTIAL_EXIT" && decision.tag === trade.pendingPartialExitTag;
  if (stillValid) return;
  trade.status = "OPEN";
  trade.pendingPartialExitPct = null;
  trade.pendingPartialExitTag = null;
  trade.pendingPartialExitReason = [];
  trade.partialExitSignalDate = null;
  trade.partialExitSignalScanAt = null;
  trade.executionError = null;
  trade.riskActionNote =
    "Cancelled automatically: the pending partial exit no longer passes the confirmed trend-deterioration policy.";
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
    executionWindow: EXECUTION_TIME
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

function createPendingEntry(
  row,
  scan,
  config,
  settings,
  plan,
  rotationExecution = null,
  candidate = null
) {
  const sourceLists = row.sourceLists || [row.listLabel].filter(Boolean);
  return {
    id: `${row.symbol}-${row.asOf}-${Date.now()}`,
    listId: settings.scopeListId,
    listLabel: settings.scopeLabel,
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
    executionWindow: EXECUTION_TIME,
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
    rotationExecution,
    rotationSourceTradeId: rotationExecution?.sourceTradeId || null,
    rotationSourceSymbol: rotationExecution?.sourceSymbol || null,
    candidateContext: candidate ? candidateContext(candidate, row) : {
      firstSignalDate: row.asOf,
      firstSignalClose: row.close,
      peakRank: plan.rank,
      entryCloseDates: [row.asOf]
    },
    addOns: [],
    addOnSkips: [],
    pendingAdd: null,
    partialExits: [],
    partialExitTags: [],
    realizedPnlToDate: 0,
    entryReason: [
      ...(row.signalReason || row.entryReason || []),
      `Trade sheet filter: ${settings.scopeLabel}, ${settings.qualityLabel}.`,
      `Portfolio rank ${plan.rank}; planned allocation Rs ${plan.allocation}, quantity ${plan.quantity}, initial stop ${plan.stopPrice}, planned risk Rs ${plan.plannedRisk}.`,
      ...(rotationExecution ? [
        `Immediate quality rotation: ${rotationExecution.sourceSymbol} sold ${rotationExecution.exitDate} ${rotationExecution.exitTime}; released cash is reusable immediately and this replacement must fill in the same execution slot.`
      ] : []),
      `Closing signal dated ${row.asOf}; buy fill must come from the next actual market session at exactly 09:17 IST, after skipping weekends and exchange holidays.`
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
  cancelPendingAdd(trade, `Cancelled because ${exitType} sell takes priority.`);
  trade.status = "PENDING_EXIT";
  trade.exitType = exitType;
  const portfolioDriven = ["SCOPE_REBALANCE", "CAPITAL_REBALANCE", "QUALITY_ROTATION"].includes(exitType);
  trade.exitSignalDate = portfolioDriven
    ? scan.marketContext?.asOf || row.asOf
    : row.asOf;
  trade.exitSignalScanAt = scan.scannedAt;
  trade.exitReason = [
    ...(reasons || row.signalReason || row.exitReason || []),
    `Closing exit signal dated ${trade.exitSignalDate}; sell fill must come from the next actual market session at exactly 09:17 IST, after skipping weekends and exchange holidays.`
  ];
  trade.exitSnapshot = snapshot(row);
  markToMarket(trade, row);
}

function preparePartialExit(trade, row, scan, decision, config) {
  const rules = portfolioConfig(config);
  cancelPendingAdd(trade, "Cancelled because risk reduction takes priority.");
  trade.status = "PENDING_PARTIAL_EXIT";
  trade.partialExitSignalDate = row.asOf;
  trade.partialExitSignalScanAt = scan.scannedAt;
  trade.pendingPartialExitPct = decision.partialPct || rules.partialExitPct;
  trade.pendingPartialExitTag = decision.tag || "RISK_REDUCTION";
  trade.pendingPartialExitReason = [
    ...(decision.reasons || []),
    `Sell ${trade.pendingPartialExitPct}% on the next actual market session at 09:17 IST and trail the balance.`
  ];
  trade.exitSnapshot = snapshot(row);
  markToMarket(trade, row);
}

function preparePyramidAdd(trade, row, scan, decision) {
  trade.pendingAdd = {
    signalDate: row.asOf,
    signalScanAt: scan.scannedAt,
    plannedQuantity: decision.quantity,
    plannedAllocation: decision.allocation,
    plannedRisk: decision.plannedRisk,
    plannedStop: decision.trailingStop,
    breakoutType: decision.breakout?.type,
    breakoutLevel: decision.breakout?.level,
    swingHighDate: decision.breakout?.swingHighDate,
    pullbackLowDate: decision.breakout?.pullbackLowDate,
    pullbackLow: decision.breakout?.pullbackLow,
    pullbackDepthPct: decision.breakout?.pullbackDepthPct,
    advancePct: decision.breakout?.advancePct,
    structureAnchorDate: decision.breakout?.anchorDate,
    rewardR: decision.rewardR,
    rank: decision.rank,
    reason: [
      ...(decision.reasons || []),
      `Add only on the next actual market session at exactly 09:17 IST; weekends and exchange holidays are skipped. Maximum total stock allocation remains 15% of portfolio capital.`
    ],
    snapshot: snapshot(row)
  };
  trade.executionError = null;
}

function cancelPendingAdd(trade, reason) {
  if (!trade.pendingAdd) return;
  trade.addOnSkips = Array.isArray(trade.addOnSkips) ? trade.addOnSkips : [];
  trade.addOnSkips.push({
    signalDate: trade.pendingAdd.signalDate,
    cancelledAt: new Date().toISOString(),
    reason
  });
  trade.pendingAdd = null;
}

async function attemptPendingExit(
  trade,
  row,
  candidates,
  rowBySymbol,
  scan,
  settings,
  config,
  events
) {
  if (trade.exitType === "QUALITY_ROTATION") {
    const preflight = await preflightRotationReplacement(
      trade,
      candidates,
      rowBySymbol,
      scan,
      settings,
      config
    );
    if (!preflight.ready) {
      if (preflight.cancelled) {
        events.push({
          type: "ROTATION_CANCELLED",
          trade,
          candidate: preflight.candidate,
          reason: preflight.reason
        });
      }
      return false;
    }
  }
  const filled = await fillExit(trade, row, config);
  if (!filled) return false;
  markRotationExitReady(candidates, trade);
  events.push({ type: "EXIT_TRADE_CLOSED", trade });
  return true;
}

async function preflightRotationReplacement(
  sourceTrade,
  candidates,
  rowBySymbol,
  scan,
  settings,
  config
) {
  const candidate = candidates.find((item) =>
    item.rotation?.sourceTradeId === sourceTrade.id ||
    item.symbol === sourceTrade.replacementCandidateSymbol
  );
  const row = candidate
    ? rowBySymbol.get(candidate.yahooSymbol || candidate.symbol)
    : null;
  if (!candidate || !row) {
    const reason = "Optional rotation cancelled because the linked replacement is no longer in the live candidate universe.";
    cancelQualityRotation(sourceTrade, candidate, reason, scan);
    return { ready: false, cancelled: true, candidate, reason };
  }

  const closeDecision = candidateEntryDecision(candidate, row, config, {
    forRotation: true,
    qualityPass: rowPassesTradeQuality(row, settings)
  });
  applyCandidateDecision(candidate, closeDecision, scan);
  if (!closeDecision.actionable) {
    const reason = `Optional rotation cancelled before selling ${sourceTrade.symbol}: ${closeDecision.reasons.join(" ")}`;
    cancelQualityRotation(sourceTrade, candidate, reason, scan, closeDecision);
    return { ready: false, cancelled: true, candidate, reason };
  }

  const fill = await executionPriceFetcher(config)(
    candidate.yahooSymbol || row.yahooSymbol,
    sourceTrade.exitSignalDate
  );
  if (!fill) {
    sourceTrade.executionError =
      "Rotation sell is waiting because the replacement's exact next-session 09:17 price is not available for preflight.";
    candidate.status = "WAITING_EXECUTION_PREFLIGHT";
    candidate.skipReason = sourceTrade.executionError;
    return { ready: false, waiting: true, candidate, reason: sourceTrade.executionError };
  }

  const executionDecision = candidateEntryDecision(candidate, row, config, {
    executionPrice: fill.price,
    forRotation: true,
    qualityPass: rowPassesTradeQuality(row, settings)
  });
  applyCandidateDecision(candidate, executionDecision, scan);
  if (!executionDecision.actionable) {
    const reason = `Optional rotation cancelled before selling ${sourceTrade.symbol}: ${executionDecision.reasons.join(" ")}`;
    cancelQualityRotation(sourceTrade, candidate, reason, scan, executionDecision);
    return { ready: false, cancelled: true, candidate, reason };
  }

  candidate.rotation = {
    ...(candidate.rotation || {}),
    preflight: {
      evaluatedAt: scan.scannedAt,
      date: fill.date,
      time: fill.timeLabel || EXECUTION_TIME,
      actualFillTime: fill.actualTimeLabel || fill.timeLabel || EXECUTION_TIME,
      price: round(fill.price),
      decision: executionDecision
    }
  };
  sourceTrade.executionError = null;
  return { ready: true, candidate, fill, decision: executionDecision };
}

function cancelQualityRotation(sourceTrade, candidate, reason, scan, decision = null) {
  sourceTrade.rotationCancellations = Array.isArray(sourceTrade.rotationCancellations)
    ? sourceTrade.rotationCancellations
    : [];
  sourceTrade.rotationCancellations.push({
    cancelledAt: scan.scannedAt,
    asOf: scan.marketContext?.asOf,
    replacement: candidate?.symbol || sourceTrade.replacementCandidateSymbol,
    reason
  });
  sourceTrade.status = "OPEN";
  sourceTrade.exitType = null;
  sourceTrade.exitSignalDate = null;
  sourceTrade.exitSignalScanAt = null;
  sourceTrade.exitReason = [];
  sourceTrade.exitSnapshot = null;
  sourceTrade.replacementCandidateSymbol = null;
  sourceTrade.executionError = null;
  if (candidate) {
    candidate.rotation = null;
    candidate.status = decision?.disposition || "WAITING_RECONFIRMATION";
    candidate.skipReason = reason;
    candidate.lastDecision = decision || candidate.lastDecision;
  }
}

function markRotationExitReady(candidates, sourceTrade) {
  if (
    sourceTrade.exitType !== "QUALITY_ROTATION" ||
    sourceTrade.status !== "CLOSED" ||
    !sourceTrade.exitDate
  ) return;
  const candidate = candidates.find((item) =>
    item.rotation?.sourceTradeId === sourceTrade.id ||
    item.symbol === sourceTrade.replacementCandidateSymbol
  );
  if (!candidate) return;
  candidate.rotation = {
    ...(candidate.rotation || {}),
    sourceTradeId: sourceTrade.id,
    sourceSymbol: sourceTrade.symbol,
    exitDate: sourceTrade.exitDate,
    exitTime: sourceTrade.exitTime || EXECUTION_TIME,
    exitPrice: sourceTrade.exitPrice,
    releasedCash: round(Number(sourceTrade.exitPrice) * Number(sourceTrade.quantity)),
    readyAt: new Date().toISOString()
  };
  candidate.status = "ROTATION_CASH_READY";
  candidate.skipReason =
    `${sourceTrade.symbol} sold ${sourceTrade.exitDate} ${sourceTrade.exitTime || EXECUTION_TIME}; replacement must buy in that same execution slot.`;
}

function rotationExecutionForCandidate(candidate, trades) {
  const link = candidate.rotation;
  if (!link?.sourceTradeId) return null;
  const source = trades.find((trade) => trade.id === link.sourceTradeId);
  if (source?.status !== "CLOSED" || !source.exitDate) return null;
  return {
    sourceTradeId: source.id,
    sourceSymbol: source.symbol,
    exitDate: source.exitDate,
    exitTime: source.exitTime || EXECUTION_TIME,
    exitPrice: source.exitPrice,
    releasedCash: round(Number(source.exitPrice) * Number(source.quantity)),
    rankAdvantage: link.rankAdvantage ?? null,
    rule: "SELL_THEN_BUY_SAME_0917_SLOT"
  };
}

function executionPriceFetcher(config) {
  const injected = config?.trade?.executionPriceFetcher || config?.executionPriceFetcher;
  return typeof injected === "function" ? injected : fetchExecutionPrice;
}

export function sameExecutionSlot(rotationExecution, fill) {
  if (!rotationExecution?.exitDate || !fill?.date) return false;
  const sellTime = String(rotationExecution.exitTime || EXECUTION_TIME).replace(/\s+/g, " ").trim();
  const buyTime = String(fill.timeLabel || fill.window || EXECUTION_TIME).replace(/\s+/g, " ").trim();
  return rotationExecution.exitDate === fill.date && sellTime === buyTime;
}

async function fillPyramidAdd(trade, row, config, trades, candidates) {
  const pending = trade.pendingAdd;
  if (!pending) return "WAITING";
  try {
    const fill = await fetchExecutionPrice(
      trade.yahooSymbol || row.yahooSymbol,
      pending.signalDate
    );
    if (!fill) {
      trade.executionError =
        "Winner add-on is pending until the next actual market-session exact 09:17 candle.";
      return "WAITING";
    }
    const summary = portfolioSummary(trades, candidates, config);
    const sector = String(trade.industry || row.industry || "Unknown");
    const adjustedSectorExposure = { ...summary.sectorExposure };
    adjustedSectorExposure[sector] = Math.max(
      0,
      (adjustedSectorExposure[sector] || 0) - (Number(pending.plannedAllocation) || 0)
    );
    const plan = buildPyramidAddPlan(
      trade,
      row,
      fill.price,
      {
        ...summary,
        availableCash: summary.availableCash + (Number(pending.plannedAllocation) || 0),
        availableRisk: summary.availableRisk + (Number(pending.plannedRisk) || 0),
        sectorExposure: adjustedSectorExposure
      },
      config
    );
    if (!plan.eligible) {
      const reason = `Winner add-on skipped at actual 09:17 fill: ${plan.reason}`;
      trade.addOnSkips = Array.isArray(trade.addOnSkips) ? trade.addOnSkips : [];
      trade.addOnSkips.push({
        signalDate: pending.signalDate,
        evaluatedDate: fill.date,
        evaluatedPrice: round(fill.price),
        reason
      });
      trade.lastPyramidDecision = {
        ...trade.lastPyramidDecision,
        eligible: false,
        fillDate: fill.date,
        fillPrice: round(fill.price),
        reasons: [reason]
      };
      trade.pendingAdd = null;
      trade.executionError = reason;
      return "SKIPPED";
    }

    const previousQuantity = Number(trade.quantity) || 0;
    const previousAverage = Number(trade.entryPrice) || 0;
    const addQuantity = plan.quantity;
    const nextQuantity = previousQuantity + addQuantity;
    const nextAverage = (
      previousAverage * previousQuantity + fill.price * addQuantity
    ) / nextQuantity;
    trade.initialEntryPrice = trade.initialEntryPrice || previousAverage;
    trade.initialQuantity = trade.initialQuantity || trade.originalQuantity || previousQuantity;
    trade.addOns = Array.isArray(trade.addOns) ? trade.addOns : [];
    const addOn = {
      number: trade.addOns.length + 1,
      signalDate: pending.signalDate,
      date: fill.date,
      time: fill.timeLabel || EXECUTION_TIME,
      actualFillTime: fill.actualTimeLabel || fill.timeLabel || EXECUTION_TIME,
      price: round(fill.price),
      quantity: addQuantity,
      allocation: round(addQuantity * fill.price),
      plannedRisk: plan.plannedRisk,
      trailingStop: plan.trailingStop,
      breakoutType: pending.breakoutType,
      breakoutLevel: pending.breakoutLevel,
      swingHighDate: pending.swingHighDate,
      pullbackLowDate: pending.pullbackLowDate,
      pullbackLow: pending.pullbackLow,
      pullbackDepthPct: pending.pullbackDepthPct,
      advancePct: pending.advancePct,
      structureAnchorDate: pending.structureAnchorDate,
      rewardRAtSignal: pending.rewardR,
      rankAtSignal: pending.rank,
      executionMethod: fill.source,
      executionWindow: fill.window,
      reason: pending.reason,
      snapshot: pending.snapshot
    };
    trade.addOns.push(addOn);
    trade.entryPrice = round(nextAverage);
    trade.quantity = nextQuantity;
    trade.originalQuantity = (Number(trade.originalQuantity) || previousQuantity) + addQuantity;
    trade.investedValue = round(nextQuantity * nextAverage);
    trade.originalInvestedValue = round(
      (Number(trade.originalInvestedValue) || previousAverage * previousQuantity) +
      addQuantity * fill.price
    );
    trade.trailingStopPrice = Math.max(
      Number(trade.trailingStopPrice) || 0,
      Number(plan.trailingStop) || 0
    );
    trade.riskPerShare = round(Math.max(0, nextAverage - trade.trailingStopPrice));
    trade.lastAddDate = fill.date;
    trade.lastAddTime = addOn.time;
    trade.lastAddPrice = addOn.price;
    trade.lastPyramidDecision = {
      ...trade.lastPyramidDecision,
      eligible: true,
      filled: true,
      fillDate: fill.date,
      fillPrice: addOn.price,
      quantity: addQuantity
    };
    trade.entryReason = [
      ...(trade.entryReason || []),
      `Winner add-on ${addOn.number} filled ${fill.date} ${addOn.time} at Rs ${addOn.price}, quantity ${addQuantity}; blended average Rs ${trade.entryPrice}. Trailing stop remains ratcheted at Rs ${trade.trailingStopPrice}.`
    ];
    trade.pendingAdd = null;
    trade.executionError = null;
    markToMarket(trade, row);
    return "FILLED";
  } catch (error) {
    trade.executionError = error.message || String(error);
    return "WAITING";
  }
}

async function fillEntry(trade, row, config, trades, candidates) {
  try {
    const fill = await executionPriceFetcher(config)(
      trade.yahooSymbol || row.yahooSymbol,
      trade.entrySignalDate
    );
    if (!fill) {
      trade.executionError =
        "Next market-session exact 09:17 one-minute candle is not available yet; pending through weekends and NSE holidays.";
      return "WAITING";
    }
    if (
      trade.rotationExecution?.exitDate &&
      !sameExecutionSlot(trade.rotationExecution, fill)
    ) {
      trade.executionError =
        `Rotation replacement requires ${trade.rotationExecution.exitDate} ${trade.rotationExecution.exitTime}; no fictional later-session switch is allowed.`;
      return "WAITING";
    }
    const executionDecision = candidateEntryDecision(
      trade.candidateContext || {
        firstSignalDate: trade.entrySignalDate,
        firstSignalClose: trade.entrySnapshot?.close,
        peakRank: trade.positionRank,
        entryCloseDates: [trade.entrySignalDate]
      },
      row,
      config,
      {
        executionPrice: fill.price,
        forRotation: Boolean(trade.rotationExecution),
        qualityPass: rowPassesTradeQuality(row, { qualityMode: trade.tradeQualityMode })
      }
    );
    trade.entryExecutionDecision = {
      ...executionDecision,
      evaluatedDate: fill.date,
      evaluatedTime: fill.timeLabel || EXECUTION_TIME
    };
    if (!executionDecision.actionable) {
      trade.executionError = `Entry skipped at actual 09:17 recheck: ${executionDecision.reasons.join(" ")}`;
      trade.status = "SKIPPED_ENTRY";
      trade.skipReason = trade.executionError;
      return "SKIPPED";
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
    trade.entryTime = fill.timeLabel || EXECUTION_TIME;
    trade.entryActualFillTime = fill.actualTimeLabel || trade.entryTime;
    trade.entryPrice = round(fill.price);
    trade.initialEntryPrice = trade.entryPrice;
    trade.quantity = quantity;
    trade.originalQuantity = quantity;
    trade.initialQuantity = quantity;
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

async function fillExit(trade, row, config = appConfig) {
  try {
    const fill = await executionPriceFetcher(config)(
      trade.yahooSymbol || row.yahooSymbol,
      trade.exitSignalDate
    );
    if (!fill) {
      trade.executionError =
        "Next market-session exact 09:17 one-minute candle is not available yet; pending through weekends and NSE holidays.";
      return false;
    }
    trade.status = "CLOSED";
    trade.exitDate = fill.date;
    trade.exitTime = fill.timeLabel || EXECUTION_TIME;
    trade.exitActualFillTime = fill.actualTimeLabel || trade.exitTime;
    trade.exitPrice = round(fill.price);
    trade.exitExecutionMethod = fill.source;
    trade.exitExecutionWindow = fill.window;
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
  trade.currentValue = round(row.close * trade.quantity);
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
      const fill = await fetchExecutionPrice(trade.yahooSymbol, oldSignalDate);
      if (!fill) {
        trade.executionMethod = "legacy_closing_price";
        continue;
      }
      trade.entryDate = fill.date;
      trade.entryTime = fill.timeLabel || EXECUTION_TIME;
      trade.entryPrice = round(fill.price);
      trade.quantity = calculateQuantity(fill.price, config);
      trade.investedValue = round(trade.quantity * fill.price);
      trade.executionMethod = fill.source;
      trade.executionWindow = fill.window;
      trade.migratedToExecutionTime = true;
    } catch {
      trade.executionMethod = "legacy_closing_price";
    }
  }
}

async function correctActiveExecutionPrices(trades) {
  const activeStatuses = new Set(["OPEN", "PENDING_EXIT", "PENDING_PARTIAL_EXIT"]);
  for (const trade of trades) {
    if (!activeStatuses.has(trade.status)) continue;
    if (!LEGACY_EXECUTION_METHODS.has(String(trade.executionMethod || ""))) continue;
    if (!trade.entrySignalDate || !trade.entryDate || !trade.yahooSymbol) continue;

    try {
      const fill = await fetchExecutionPrice(trade.yahooSymbol, trade.entrySignalDate);
      if (!fill || fill.date !== trade.entryDate) continue;
      applyExecutionPriceCorrection(trade, fill);
    } catch (error) {
      trade.executionCorrectionError = error?.message || String(error);
    }
  }
}

export function applyExecutionPriceCorrection(trade, fill, correctedAt = new Date()) {
  const previousPrice = trade.entryPrice;
  const previousTime = trade.entryTime;
  const previousMethod = trade.executionMethod;
  trade.entryExecutionCorrection = {
    correctedAt: correctedAt.toISOString(),
    previousPrice,
    previousTime,
    previousMethod,
    reason: "Execution rule changed from the 09:15 market open to the exact 09:17 one-minute candle open."
  };
  trade.entryTime = fill.timeLabel || EXECUTION_TIME;
  trade.entryPrice = round(fill.price);
  trade.executionMethod = fill.source;
  trade.executionWindow = fill.window;
  trade.migratedToExecutionTime = true;

  const currentQuantity = Number(trade.quantity) || 0;
  const originalQuantity = Number(trade.originalQuantity) || currentQuantity;
  trade.investedValue = round(currentQuantity * fill.price);
  trade.originalInvestedValue = round(originalQuantity * fill.price);
  if (Number.isFinite(trade.initialStopPrice)) {
    trade.riskPerShare = round(Math.max(0, fill.price - trade.initialStopPrice));
    trade.initialRiskAmount = round(trade.riskPerShare * originalQuantity);
  }
  if (Array.isArray(trade.partialExits)) {
    for (const leg of trade.partialExits) {
      if (Number.isFinite(leg.price) && Number.isFinite(leg.quantity)) {
        leg.pnl = round((leg.price - fill.price) * leg.quantity);
      }
    }
    trade.realizedPnlToDate = round(
      trade.partialExits.reduce((sum, leg) => sum + (Number(leg.pnl) || 0), 0)
    );
  }
  trade.entryReason = rewriteExecutionReasons(trade.entryReason);
  if (trade.entrySnapshot) {
    trade.entrySnapshot.signalReason = rewriteExecutionReasons(trade.entrySnapshot.signalReason);
    const coverage = trade.entrySnapshot.conceptCoverage;
    if (coverage) {
      coverage.passLabels = rewriteExecutionReasons(coverage.passLabels);
      coverage.weakLabels = rewriteExecutionReasons(coverage.weakLabels);
      coverage.dataGapLabels = rewriteExecutionReasons(coverage.dataGapLabels);
      coverage.excludedLabels = rewriteExecutionReasons(coverage.excludedLabels);
    }
  }
  return trade;
}

function rewriteExecutionReasons(reasons) {
  if (!Array.isArray(reasons)) return reasons;
  return reasons.map((reason) => String(reason)
    .replaceAll("09:15 five-minute candle open", "09:17 one-minute candle open")
    .replaceAll("09:15 execution discipline", "09:17 execution discipline")
    .replaceAll("next actual market session 09:15-09:20 IST window", "next actual market session at exactly 09:17 IST")
    .replaceAll("next session 09:15-09:20 IST window", "next session at exactly 09:17 IST")
    .replaceAll("09:15-09:20 IST window", "exact 09:17 IST execution time"));
}

async function fillPartialExit(trade, row) {
  try {
    const fill = await fetchExecutionPrice(
      trade.yahooSymbol || row.yahooSymbol,
      trade.partialExitSignalDate
    );
    if (!fill) {
      trade.executionError =
        "Partial exit is pending until the next actual market-session exact 09:17 candle.";
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
      time: fill.timeLabel || EXECUTION_TIME,
      actualFillTime: fill.actualTimeLabel || fill.timeLabel || EXECUTION_TIME,
      price: round(fill.price),
      executionMethod: fill.source,
      executionWindow: fill.window,
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
    trade.listId = trade.tradeScope;
    trade.listLabel = trade.tradeScopeLabel;
    trade.tradeQualityMode = trade.tradeQualityMode || "LEGACY";
    trade.tradeQualityLabel = trade.tradeQualityLabel || "Legacy trade";
    trade.industry = trade.industry || trade.entrySnapshot?.industry || "Unknown";
    trade.originalQuantity = trade.originalQuantity || trade.quantity || null;
    trade.originalInvestedValue = trade.originalInvestedValue || trade.investedValue || null;
    trade.partialExits = Array.isArray(trade.partialExits) ? trade.partialExits : [];
    trade.partialExitTags = Array.isArray(trade.partialExitTags) ? trade.partialExitTags : [];
    trade.addOns = Array.isArray(trade.addOns) ? trade.addOns : [];
    trade.addOnSkips = Array.isArray(trade.addOnSkips) ? trade.addOnSkips : [];
    trade.initialEntryPrice = trade.initialEntryPrice || trade.entryPrice || null;
    trade.initialQuantity = trade.initialQuantity || trade.originalQuantity || trade.quantity || null;
    trade.realizedPnlToDate = Number(trade.realizedPnlToDate) || 0;
    trade.entryReason = rewriteExecutionReasons(trade.entryReason);
    trade.exitReason = rewriteExecutionReasons(trade.exitReason);
    if (trade.entrySnapshot) {
      trade.entrySnapshot.signalReason = rewriteExecutionReasons(trade.entrySnapshot.signalReason);
      const coverage = trade.entrySnapshot.conceptCoverage;
      if (coverage) {
        coverage.passLabels = rewriteExecutionReasons(coverage.passLabels);
        coverage.weakLabels = rewriteExecutionReasons(coverage.weakLabels);
        coverage.dataGapLabels = rewriteExecutionReasons(coverage.dataGapLabels);
        coverage.excludedLabels = rewriteExecutionReasons(coverage.excludedLabels);
      }
    }
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

function recordRotationObservation(trade, row, weakness) {
  const qualificationVersion = 2;
  const currentVersion = Number(trade.rotationReview?.qualificationVersion) || 0;
  if (
    !row?.asOf ||
    (currentVersion === qualificationVersion && trade.rotationReview?.lastObservedAsOf === row.asOf)
  ) return;
  const qualifies = weakness?.primaryScore >= 2;
  const priorDates = currentVersion === qualificationVersion && Array.isArray(trade.rotationReview?.weakCloseDates)
    ? trade.rotationReview.weakCloseDates
    : [];
  const weakCloseDates = qualifies
    ? Array.from(new Set([...priorDates, row.asOf])).slice(-10)
    : [];
  trade.rotationReview = {
    lastObservedAsOf: row.asOf,
    weakCloseDates,
    confirmedWeakCloses: weakCloseDates.length,
    currentQualifies: qualifies,
    currentPrimaryScore: weakness?.primaryScore || 0,
    currentScore: weakness?.score || 0,
    currentReasons: weakness?.reasons || [],
    qualificationVersion
  };
}

function candidateContext(candidate, row) {
  return {
    firstSignalDate: candidate.firstSignalDate || row.asOf,
    firstSignalClose: candidate.firstSignalClose ?? row.close,
    firstSignalRank: candidate.firstSignalRank ?? candidate.rank ?? candidateRank(row),
    firstFundamentalScore: candidate.firstFundamentalScore ?? row.fundamentalScore,
    firstSeenAt: candidate.firstSeenAt,
    peakRank: candidate.peakRank ?? candidate.rank ?? candidateRank(row),
    entryCloseDates: [...(candidate.entryCloseDates || [row.asOf])]
  };
}

function applyCandidateDecision(candidate, decision, scan) {
  candidate.lastDecision = decision;
  candidate.lastEvaluatedAt = scan.scannedAt;
  candidate.status = decision.actionable ? "ACTIONABLE" : decision.disposition;
  candidate.skipReason = decision.actionable
    ? [
        "Latest completed close remains entry-ready; waiting for cash, risk and execution checks.",
        ...(decision.warnings || [])
      ].join(" ")
    : decision.reasons.join(" ");
}

function recordCandidateDecision(log, candidate, decision, scan, outcome) {
  const reason = decision.reasons.join(" ") || candidate.skipReason || "Candidate remains actionable.";
  const item = {
    id: `${candidate.symbol}-${candidate.latestAsOf || candidate.lastSignalDate || "NA"}-${outcome}-${decision.disposition}`,
    evaluatedAt: scan.scannedAt,
    asOf: candidate.latestAsOf || candidate.lastSignalDate || null,
    symbol: candidate.symbol,
    industry: candidate.industry,
    firstSignalDate: candidate.firstSignalDate,
    firstSignalClose: candidate.firstSignalClose,
    outcome,
    disposition: decision.disposition,
    grade: candidate.grade,
    rank: candidate.rank,
    metrics: decision.metrics,
    reason
  };
  const withoutDuplicate = log.filter((entry) => entry.id !== item.id);
  return [...withoutDuplicate, item].slice(-250);
}

function upsertCandidate(candidates, row, scan, settings, existing, seed = null) {
  const target = existing || {
    ...(seed || {}),
    id: `${row.symbol}-${row.asOf}-candidate`,
    symbol: row.symbol,
    yahooSymbol: row.yahooSymbol,
    name: row.name,
    industry: row.industry || "Unknown",
    sourceLists: row.sourceLists || [row.listLabel].filter(Boolean),
    listId: settings.scopeListId,
    listLabel: settings.scopeLabel,
    tradeScope: settings.scopeListId,
    tradeScopeLabel: settings.scopeLabel,
    firstSignalDate: seed?.firstSignalDate || row.asOf,
    firstSignalClose: seed?.firstSignalClose ?? row.close,
    firstSignalRank: seed?.firstSignalRank ?? candidateRank(row),
    firstFundamentalScore: seed?.firstFundamentalScore ?? row.fundamentalScore,
    firstSeenAt: seed?.firstSeenAt || scan.scannedAt
  };
  target.firstSignalDate = target.firstSignalDate || seed?.firstSignalDate || row.asOf;
  target.listId = settings.scopeListId;
  target.listLabel = settings.scopeLabel;
  target.tradeScope = settings.scopeListId;
  target.tradeScopeLabel = settings.scopeLabel;
  target.firstSignalClose = target.firstSignalClose ?? seed?.firstSignalClose ?? row.close;
  target.firstSignalRank = target.firstSignalRank ?? seed?.firstSignalRank ?? candidateRank(row);
  target.firstFundamentalScore =
    target.firstFundamentalScore ?? seed?.firstFundamentalScore ?? row.fundamentalScore;
  target.firstSeenAt = target.firstSeenAt || seed?.firstSeenAt || scan.scannedAt;
  target.lastSignalDate = row.asOf;
  target.lastSeenAt = scan.scannedAt;
  target.rank = candidateRank(row);
  target.peakRank = Math.max(Number(target.peakRank) || target.rank, target.rank);
  target.grade = row.setupGrade;
  target.score = row.score;
  target.entryStyle = row.entryStyle?.label || "";
  target.latestClose = row.close;
  target.latestAsOf = row.asOf;
  target.entryCloseDates = Array.from(new Set([...(target.entryCloseDates || []), row.asOf])).slice(-10);
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
  return trades.filter((trade) => tradeMatchesSettings(trade, settings));
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

  const pending = journal.trades.filter(
    (trade) => trade.status.startsWith("PENDING_") || Boolean(trade.pendingAdd)
  );
  const open = journal.trades.filter((trade) => trade.status === "OPEN");
  const closed = journal.trades.filter((trade) => trade.status === "CLOSED");
  const realizedPnl = totalRealizedPnl(journal.trades);
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
    { metric: "Actual Cash", value: portfolio.actualCash },
    { metric: "Market Risk Mode", value: portfolio.marketRiskMode },
    { metric: "Effective Exposure Cap %", value: portfolio.effectiveExposureCapPct },
    { metric: "Exposure Limit", value: portfolio.exposureLimit },
    { metric: "Portfolio Drawdown %", value: portfolio.drawdownPct },
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
    { metric: "Unrealized P&L %", value: portfolio.unrealizedPnlPct },
    { metric: "Capital Per Stock", value: journal.tradeCapitalPerStock },
    { metric: "Trade Scope", value: journal.tradeSettings?.scopeLabel || "" },
    { metric: "Trade Quality", value: journal.tradeSettings?.qualityLabel || "" },
    { metric: "Signal Basis", value: journal.executionRule?.signalBasis || "" },
    { metric: "Session Rule", value: journal.executionRule?.sessionRule || "Skip weekends and market holidays" },
    { metric: "Execution Time", value: journal.executionRule?.window || EXECUTION_TIME },
    { metric: "Execution Price", value: "Exact 09:17 one-minute candle open" }
  ]);

  addTradeWorksheet(workbook, "Open Positions", open);
  addTradeWorksheet(workbook, "Pending Orders", pending);
  addTradeWorksheet(workbook, "Closed Trades", closed);
  addTradeWorksheet(workbook, "All Trades", journal.trades);
  addCandidateWorksheet(workbook, journal.candidates || []);
  addCandidateDecisionWorksheet(workbook, journal.candidateDecisionLog || []);
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
    { header: "Entry Actual Fill Time", key: "Entry Actual Fill Time", width: 22 },
    { header: "Entry Price", key: "Entry Price", width: 14 },
    { header: "Initial Entry Price", key: "Initial Entry Price", width: 18 },
    { header: "Entry Execution Method", key: "Entry Execution Method", width: 30 },
    { header: "Quantity", key: "Quantity", width: 10 },
    { header: "Original Quantity", key: "Original Quantity", width: 16 },
    { header: "Initial Quantity", key: "Initial Quantity", width: 15 },
    { header: "Invested Value", key: "Invested Value", width: 16 },
    { header: "Current Value", key: "Current Value", width: 16 },
    { header: "Last Close", key: "Last Close", width: 14 },
    { header: "Unrealized P&L", key: "Unrealized P&L", width: 16 },
    { header: "Unrealized P&L %", key: "Unrealized P&L %", width: 18 },
    { header: "Exit Signal Date", key: "Exit Signal Date", width: 18 },
    { header: "Exit Date", key: "Exit Date", width: 14 },
    { header: "Exit Time", key: "Exit Time", width: 13 },
    { header: "Exit Actual Fill Time", key: "Exit Actual Fill Time", width: 22 },
    { header: "Exit Price", key: "Exit Price", width: 14 },
    { header: "Exit Execution Method", key: "Exit Execution Method", width: 30 },
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
    { header: "Add-On Count", key: "Add-On Count", width: 14 },
    { header: "Pending Add", key: "Pending Add", width: 14 },
    { header: "Last Add Date", key: "Last Add Date", width: 14 },
    { header: "Last Add Time", key: "Last Add Time", width: 14 },
    { header: "Last Add Price", key: "Last Add Price", width: 14 },
    { header: "Last Add Quantity", key: "Last Add Quantity", width: 18 },
    { header: "Add-On History", key: "Add-On History", width: 60 },
    { header: "Add-On Decision", key: "Add-On Decision", width: 60 },
    { header: "Partial Exit Count", key: "Partial Exit Count", width: 18 },
    { header: "Partial Realized P&L", key: "Partial Realized P&L", width: 20 },
    { header: "Exit Type", key: "Exit Type", width: 22 },
    { header: "Replacement Candidate", key: "Replacement Candidate", width: 24 },
    { header: "Rotation Source", key: "Rotation Source", width: 20 },
    { header: "Rotation Rule", key: "Rotation Rule", width: 32 },
    { header: "Rotation Same Slot", key: "Rotation Same Slot", width: 20 },
    { header: "Management Decision", key: "Management Decision", width: 26 },
    { header: "Management Reasons", key: "Management Reasons", width: 70 },
    { header: "Confirmed Weak Closes", key: "Confirmed Weak Closes", width: 22 },
    { header: "Rotation Cancellations", key: "Rotation Cancellations", width: 70 },
    { header: "Entry Execution Recheck", key: "Entry Execution Recheck", width: 70 },
    { header: "Entry Style", key: "Entry Style", width: 26 },
    { header: "Setup Grade", key: "Setup Grade", width: 13 },
    { header: "Setup Score", key: "Setup Score", width: 14 },
    { header: "Fundamental Score", key: "Fundamental Score", width: 18 },
    { header: "Institutional Score", key: "Institutional Score", width: 18 },
    { header: "GTF Score", key: "GTF Score", width: 14 },
    { header: "GTF Daily Demand", key: "GTF Daily Demand", width: 28 },
    { header: "GTF Weekly Demand", key: "GTF Weekly Demand", width: 28 },
    { header: "GTF Reacting From HTF", key: "GTF Reacting From HTF", width: 36 },
    { header: "GTF RHTF Source Status", key: "GTF RHTF Source Status", width: 24 },
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
    "Entry Actual Fill Time": trade.entryActualFillTime || trade.entryTime || "",
    "Entry Price": trade.entryPrice ?? "",
    "Initial Entry Price": trade.initialEntryPrice ?? trade.entryPrice ?? "",
    "Entry Execution Method": trade.executionMethod || "",
    Quantity: trade.quantity ?? "",
    "Original Quantity": trade.originalQuantity ?? "",
    "Initial Quantity": trade.initialQuantity ?? "",
    "Invested Value": trade.investedValue ?? "",
    "Current Value": trade.currentValue ?? (
      Number.isFinite(trade.lastPrice) && Number.isFinite(trade.quantity)
        ? round(trade.lastPrice * trade.quantity)
        : ""
    ),
    "Last Close": trade.lastPrice ?? "",
    "Unrealized P&L": trade.unrealizedPnl ?? "",
    "Unrealized P&L %": trade.unrealizedPnlPct ?? "",
    "Exit Signal Date": trade.exitSignalDate || "",
    "Exit Date": trade.exitDate || "",
    "Exit Time": trade.exitTime || "",
    "Exit Actual Fill Time": trade.exitActualFillTime || trade.exitTime || "",
    "Exit Price": trade.exitPrice ?? "",
    "Exit Execution Method": trade.exitExecutionMethod || "",
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
    "Add-On Count": trade.addOns?.length || 0,
    "Pending Add": trade.pendingAdd ? "Yes" : "No",
    "Last Add Date": trade.lastAddDate || "",
    "Last Add Time": trade.lastAddTime || "",
    "Last Add Price": trade.lastAddPrice ?? "",
    "Last Add Quantity": trade.addOns?.at(-1)?.quantity ?? "",
    "Add-On History": (trade.addOns || []).map((add) =>
      `#${add.number} signal ${add.signalDate}; fill ${add.date} ${add.time} @ ${add.price}; qty ${add.quantity}; stop ${add.trailingStop}; swing high ${add.swingHighDate || "NA"} @ ${add.breakoutLevel ?? "NA"}; pullback low ${add.pullbackLowDate || "NA"} @ ${add.pullbackLow ?? "NA"} (${add.pullbackDepthPct ?? "NA"}%); ${add.breakoutType || "breakout"}`
    ).join(" | "),
    "Add-On Decision": trade.pendingAdd
      ? (trade.pendingAdd.reason || []).join(" ")
      : (trade.lastPyramidDecision?.reasons || []).join(" "),
    "Partial Exit Count": trade.partialExits?.length || 0,
    "Partial Realized P&L": trade.realizedPnlToDate ?? 0,
    "Exit Type": trade.exitType || "",
    "Replacement Candidate": trade.replacementCandidateSymbol || "",
    "Rotation Source": trade.rotationSourceSymbol || "",
    "Rotation Rule": trade.rotationExecution?.rule || "",
    "Rotation Same Slot": trade.rotationExecution
      ? (trade.entryDate === trade.rotationExecution.exitDate && trade.entryTime === trade.rotationExecution.exitTime ? "Yes" : "Pending")
      : "",
    "Management Decision": trade.latestManagementDecision?.action || "",
    "Management Reasons": (trade.latestManagementDecision?.reasons || []).join(" "),
    "Confirmed Weak Closes": trade.rotationReview?.confirmedWeakCloses ?? 0,
    "Rotation Cancellations": (trade.rotationCancellations || []).map((item) =>
      `${item.cancelledAt}: ${item.replacement || "NA"}; ${item.reason}`
    ).join(" | "),
    "Entry Execution Recheck": trade.entryExecutionDecision
      ? `${trade.entryExecutionDecision.actionable ? "PASS" : "SKIP"}; ${(trade.entryExecutionDecision.reasons || []).join(" ")}`
      : "",
    "Entry Style": trade.entrySnapshot?.entryStyle?.label || "",
    "Setup Grade": trade.entrySnapshot?.setupGrade || "",
    "Setup Score": trade.entrySnapshot?.setupStrengthScore ?? "",
    "Fundamental Score": trade.entrySnapshot?.fundamentalScore ?? "",
    "Institutional Score": institutional.maxScore ? `${institutional.score}/${institutional.maxScore}` : "",
    "GTF Score": gtf.maxScore ? `${gtf.score}/${gtf.maxScore} (${gtf.grade || ""})` : "",
    "GTF Daily Demand": formatGtfZone(gtf.dailyDemand),
    "GTF Weekly Demand": formatGtfZone(gtf.weeklyDemand),
    "GTF Reacting From HTF": gtf.reactingFromHtf?.active
      ? `${formatGtfZone(gtf.reactingFromHtf.zone)}; ${gtf.reactingFromHtf.managementClass}`
      : "No",
    "GTF RHTF Source Status": gtf.reactingFromHtf?.sourceStatus || "",
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
    { header: "Valid Entry Closes", key: "confirmedCloses", width: 20 },
    { header: "Run-up %", key: "runupPct", width: 14 },
    { header: "09:17 Gap %", key: "executionGapPct", width: 14 },
    { header: "ST Distance %", key: "supertrendDistancePct", width: 16 },
    { header: "ATR Extension", key: "atrExtension", width: 16 },
    { header: "Rank Decay", key: "rankDecay", width: 14 },
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
    confirmedCloses: candidate.lastDecision?.metrics?.confirmedEntryCloses ?? 0,
    runupPct: candidate.lastDecision?.metrics?.runupPct ?? "",
    executionGapPct: candidate.lastDecision?.metrics?.executionGapPct ?? "",
    supertrendDistancePct: candidate.lastDecision?.metrics?.supertrendDistancePct ?? "",
    atrExtension: candidate.lastDecision?.metrics?.atrExtension ?? "",
    rankDecay: candidate.lastDecision?.metrics?.rankDecay ?? "",
    entryStyle: candidate.entryStyle,
    allocation: candidate.plannedAllocation,
    risk: candidate.plannedRisk,
    stop: candidate.plannedStopPrice,
    reason: candidate.skipReason
  })));
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  formatSheet(sheet);
}

function addCandidateDecisionWorksheet(workbook, decisions) {
  const sheet = workbook.addWorksheet("Candidate Decision Log");
  sheet.columns = [
    { header: "Evaluated At", key: "evaluatedAt", width: 24 },
    { header: "Closing Date", key: "asOf", width: 16 },
    { header: "Symbol", key: "symbol", width: 16 },
    { header: "Industry", key: "industry", width: 24 },
    { header: "First Signal", key: "firstSignalDate", width: 16 },
    { header: "First Signal Close", key: "firstSignalClose", width: 18 },
    { header: "Outcome", key: "outcome", width: 16 },
    { header: "Disposition", key: "disposition", width: 24 },
    { header: "Grade", key: "grade", width: 12 },
    { header: "Rank", key: "rank", width: 12 },
    { header: "Run-up %", key: "runupPct", width: 14 },
    { header: "09:17 Gap %", key: "executionGapPct", width: 14 },
    { header: "ST Distance %", key: "supertrendDistancePct", width: 16 },
    { header: "ATR Extension", key: "atrExtension", width: 16 },
    { header: "Rank Decay", key: "rankDecay", width: 14 },
    { header: "Valid Entry Closes", key: "confirmedCloses", width: 20 },
    { header: "Reason", key: "reason", width: 90 }
  ];
  sheet.addRows(decisions.map((decision) => ({
    ...decision,
    runupPct: decision.metrics?.runupPct ?? "",
    executionGapPct: decision.metrics?.executionGapPct ?? "",
    supertrendDistancePct: decision.metrics?.supertrendDistancePct ?? "",
    atrExtension: decision.metrics?.atrExtension ?? "",
    rankDecay: decision.metrics?.rankDecay ?? "",
    confirmedCloses: decision.metrics?.confirmedEntryCloses ?? 0
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
