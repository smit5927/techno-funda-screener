import fs from "node:fs";
import ExcelJS from "exceljs";
import { appConfig } from "./config.js";
import { readTrades, saveTrades } from "./storage.js";
import { fetchExecutionPrice } from "./yahoo.js";
import { applyTradeChargeAccounting, chargeSettings } from "./charges.js";
import { updateOpenPositionCorporateActions } from "./corporate-actions.js";
import { updateAlertHistory } from "./alert-history.js";
import { executionAfterDate, isRetroactiveExecution } from "./execution-policy.js";
import {
  buildControlledRetestAddPlan,
  buildPositionPlan,
  buildPyramidAddPlan,
  candidateEntryDecision,
  candidateRank,
  controlledRetestAddDecision,
  nextTrailingStop,
  portfolioConfig,
  portfolioSummary,
  positionExitDecision,
  positionWeakness,
  postEntryPyramidState,
  pyramidAddDecision,
  rotationSourceDecision,
  rotationDecision,
  totalRealizedPnl
} from "./portfolio-engine.js";

const TRADE_SCOPE_LABELS = {
  "all-market": "All Indian Market",
  default: "Nifty 500",
  custom: "My List"
};

const TRADE_QUALITY_LABELS = {
  BEST_ONLY: "Best only (A+/A)",
  STRONG_OR_BETTER: "Strong and best (A+/A/B)",
  ALL_ENTRIES: "All entry signals"
};

const EXECUTION_TIME = "09:17 IST";
const PUBLISHABLE_ACTION_TYPES = new Set([
  "ENTRY_SIGNAL_PENDING",
  "EXIT_SIGNAL_PENDING",
  "PORTFOLIO_EXIT_PENDING",
  "ROTATION_EXIT_PENDING",
  "PARTIAL_EXIT_PENDING",
  "PYRAMID_ADD_PENDING",
  "CONTROLLED_RETEST_ADD_PENDING",
  "DIVIDEND_CREDIT"
]);
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
  const controlledRetestUpgrade = !journal.controlledRetestEngineStartedAt;
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
  const scopeRowBySymbol = indexRowsByInstrument(rows);
  const rowBySymbol = indexRowsByInstrument(allScannedRows(scan));

  migrateTradeMetadata(trades);
  repairRetroactiveEntryFills(trades, scan.scannedAt);
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
  const corporateActionStatus = await updateOpenPositionCorporateActions(
    trades,
    scan,
    config,
    options.corporateActions || {}
  );
  events.push(...(corporateActionStatus.events || []));
  for (const trade of trades) applyTradeChargeAccounting(trade, config, trade.lastPrice);

  for (const trade of trades) {
    const row = executionRow(
      trade,
      rowBySymbol.get(trade.yahooSymbol || trade.symbol),
      scan.marketContext?.asOf
    );
    if (row && ["OPEN", "PENDING_EXIT", "PENDING_PARTIAL_EXIT"].includes(trade.status)) {
      trade.currentSnapshot = snapshot(row);
      markToMarket(trade, row, config);
      trade.currentRank = candidateRank(row);
      trade.currentGrade = row.setupGrade;
      trade.trailingStopPrice = nextTrailingStop(trade, row, config);
      trade.currentWeakness = positionWeakness(row);
      recordRotationObservation(trade, row, trade.currentWeakness);
    }
    if (trade.status === "OPEN" && trade.pendingAdd && row) {
      const pendingKind = trade.pendingAdd.kind;
      const outcome = await fillPyramidAdd(trade, row, config, trades, candidates);
      const prefix = pendingKind === "CONTROLLED_RETEST" ? "CONTROLLED_RETEST_ADD" : "PYRAMID_ADD";
      if (outcome === "FILLED") events.push({ type: `${prefix}_FILLED`, trade });
      if (outcome === "SKIPPED") events.push({ type: `${prefix}_SKIPPED`, trade });
    }
    const exitCancellation = cancelInvalidPendingModelExit(trade, row, config);
    if (exitCancellation.cancelled) {
      events.push({
        type: "EXIT_SIGNAL_CANCELLED",
        trade,
        reason: exitCancellation.reason
      });
    }
    cancelInvalidPendingPartialExit(trade, row, config);
    cancelInvalidPendingQualityRotation(trade, row, candidates, config);
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
      const filled = await fillPartialExit(trade, row, config);
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
        "SCOPE_REBALANCE",
        config
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
      prepareFullExit(trade, row, scan, decision.reasons, "MODEL_EXIT", config);
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
    if (!row?.asOf) continue;
    if (trade.controlledRetestState?.asOf !== row.asOf) {
      const retestDecision = controlledRetestAddDecision(
        trade,
        row,
        portfolioSummary(trades, candidates, config),
        config
      );
      trade.lastControlledRetestDecision = {
        asOf: row.asOf,
        eligible: retestDecision.eligible,
        reasons: retestDecision.reasons,
        state: retestDecision.state
      };
      if (!controlledRetestUpgrade && retestDecision.eligible && !trade.pendingAdd) {
        prepareControlledRetestAdd(trade, row, scan, retestDecision);
        events.push({ type: "CONTROLLED_RETEST_ADD_PENDING", trade });
      }
      trade.controlledRetestState = { ...(retestDecision.state || {}), asOf: row.asOf };
    }
    if (trade.pyramidState?.asOf === row.asOf) continue;
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
      const filled = await fillPartialExit(trade, row, config);
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
          "QUALITY_ROTATION",
          config
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

  candidates = releaseUnfundedCommittedEntries({
    candidates,
    trades,
    scopeRowBySymbol,
    scan,
    settings,
    events
  });

  ({ candidates, candidateDecisionLog } = commitSellFundedEntries({
    candidates,
    candidateDecisionLog,
    events,
    trades,
    scopeRowBySymbol,
    scan,
    settings,
    config
  }));

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

  for (const trade of trades) applyTradeChargeAccounting(trade, config, trade.lastPrice);
  const finalPortfolio = portfolioSummary(trades, candidates, config);
  const publishedEvents = publishPortfolioActionEvents(events, trades, scan.scannedAt, {
    enabled: options.publishActionAlerts === true
  });
  const alertHistory = updateAlertHistory(journal.alertHistory, publishedEvents, scan.scannedAt, {
    totalFund: finalPortfolio.totalCapital || riskRules.totalCapital,
    trades
  });

  const nextJournal = {
    updatedAt: new Date().toISOString(),
    legacyOwnerJournalMigratedAt: journal.legacyOwnerJournalMigratedAt || null,
    portfolioEngineStartedAt: journal.portfolioEngineStartedAt || scan.scannedAt,
    pyramidingStartedAt: journal.pyramidingStartedAt || scan.scannedAt,
    pyramidSwingEngineStartedAt: journal.pyramidSwingEngineStartedAt || scan.scannedAt,
    controlledRetestEngineStartedAt: journal.controlledRetestEngineStartedAt || scan.scannedAt,
    liveModeStartedAt: journal.liveModeStartedAt || (liveMode ? new Date().toISOString() : null),
    baselineInitialized: true,
    baselineScanAt: journal.baselineScanAt || (firstLiveScan ? scan.scannedAt : null),
    executionRule: {
      signalBasis: "completed daily/weekly closing candle",
      sessionRule: "first actual exchange session after the signal date; weekends and market holidays are skipped",
      window: EXECUTION_TIME,
      priceSource: config.trade.executionPriceSource
    },
    chargeRules: chargeSettings(config),
    corporateActionStatus: {
      ...corporateActionStatus,
      events: undefined
    },
    signalState: nextSignalState,
    tradeCapitalPerStock: riskRules.totalCapital * riskRules.initialMaxPositionPct / 100,
    portfolioRules: riskRules,
    portfolioSummary: finalPortfolio,
    capitalTransactions,
    candidates: candidates.sort((a, b) => b.rank - a.rank),
    candidateDecisionLog: candidateDecisionLog.slice(-250),
    alertHistory,
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
    events: publishedEvents,
    visibleCandidates: nextJournal.candidates,
    visibleCandidateDecisions: nextJournal.candidateDecisionLog.slice(-50).reverse()
  };
}

function cancelInvalidPendingPartialExit(trade, row, config) {
  if (trade.status !== "PENDING_PARTIAL_EXIT" || !row) return;
  if (trade.partialExitOrderState === "CONFIRMED_FOR_0917") return;
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

export function cancelInvalidPendingModelExit(trade, row, config) {
  if (trade.status !== "PENDING_EXIT" || trade.exitType !== "MODEL_EXIT" || !row) {
    return { cancelled: false };
  }
  if (trade.exitOrderState === "CONFIRMED_FOR_0917") return { cancelled: false };
  const decision = positionExitDecision({ ...trade, status: "OPEN" }, row, config);
  if (decision.action === "FULL_EXIT") return { cancelled: false };
  const reason = [
    "Pending model exit cancelled before execution because the latest balanced confirmation policy no longer confirms a full exit.",
    ...(decision.reasons || [])
  ].join(" ");
  trade.cancelledExitSignals = Array.isArray(trade.cancelledExitSignals)
    ? trade.cancelledExitSignals
    : [];
  trade.cancelledExitSignals.push({
    cancelledAsOf: row.asOf,
    exitType: trade.exitType,
    exitSignalDate: trade.exitSignalDate,
    originalReasons: trade.exitReason || [],
    cancellationReasons: decision.reasons || []
  });
  trade.status = "OPEN";
  trade.exitType = null;
  trade.exitSignalDate = null;
  trade.exitSignalScanAt = null;
  trade.exitReason = [];
  trade.exitSnapshot = null;
  trade.executionError = null;
  trade.riskActionNote = reason;
  trade.lastExitCancellationDate = row.asOf;
  return { cancelled: true, reason };
}

function cancelInvalidPendingQualityRotation(trade, row, candidates, config) {
  if (trade.status !== "PENDING_EXIT" || trade.exitType !== "QUALITY_ROTATION" || !row) return;
  if (trade.exitOrderState === "CONFIRMED_FOR_0917") return;
  const decision = rotationSourceDecision(trade, row, config);
  if (decision.eligible) return;
  trade.cancelledExitSignals = Array.isArray(trade.cancelledExitSignals)
    ? trade.cancelledExitSignals
    : [];
  trade.cancelledExitSignals.push({
    cancelledAsOf: row.asOf,
    exitType: trade.exitType,
    exitSignalDate: trade.exitSignalDate,
    replacementCandidateSymbol: trade.replacementCandidateSymbol,
    originalReasons: trade.exitReason || [],
    cancellationReasons: decision.reasons
  });
  const linkedCandidate = candidates.find((candidate) =>
    candidate.rotation?.sourceTradeId === trade.id ||
    candidate.symbol === trade.replacementCandidateSymbol
  );
  if (linkedCandidate) {
    linkedCandidate.rotation = null;
    linkedCandidate.status = "WAITING_RECONFIRMATION";
    linkedCandidate.skipReason =
      `Rotation cancelled before execution: ${decision.reasons.join(" ")}`;
  }
  trade.status = "OPEN";
  trade.exitType = null;
  trade.exitSignalDate = null;
  trade.exitSignalScanAt = null;
  trade.exitReason = [];
  trade.exitSnapshot = null;
  trade.replacementCandidateSymbol = null;
  trade.executionError = null;
  trade.riskActionNote =
    `Optional rotation cancelled before execution: ${decision.reasons.join(" ")}`;
}

export async function writeTradeSheets(journal, config = appConfig) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const settings = journal.tradeSettings || tradeSettingsSummary(config);
  const visibleTrades = visibleTradesForSettings(journal.trades || [], settings);
  const sheetJournal = {
    ...journal,
    tradeSettings: settings,
    trades: visibleTrades,
    portfolioSummary: portfolioSummary(visibleTrades, journal.candidates || [], config)
  };
  await writeXlsx(sheetJournal, config.tradeSheetPath);
  writeCsv(sheetJournal, config.tradeCsvPath);
}

export function tradeSettingsSummary(config = appConfig) {
  const scopeListId = normalizeTradeScope(config.trade?.scopeListId);
  const qualityMode = normalizeTradeQuality(config.trade?.qualityMode);
  const rules = portfolioConfig(config);
  return {
    scopeListId,
    scopeLabel: TRADE_SCOPE_LABELS[scopeListId],
    qualityMode,
    qualityLabel: TRADE_QUALITY_LABELS[qualityMode],
    totalCapital: config.trade?.totalCapital ?? 1000000,
    minimumInitialAllocation: config.trade?.minimumInitialAllocation ?? 10000,
    capitalPerStock: config.trade?.capitalPerStock ?? 100000,
    initialMaxPositionPct: rules.initialMaxPositionPct,
    initialRiskPct: rules.initialRiskPct,
    controlledRetestEnabled: rules.controlledRetestEnabled,
    controlledRetestAddMaxPct: rules.controlledRetestAddMaxPct,
    controlledRetestAddRiskPct: rules.controlledRetestAddRiskPct,
    controlledRetestMaxPositionPct: rules.controlledRetestMaxPositionPct,
    controlledRetestMinDrawdownR: rules.controlledRetestMinDrawdownR,
    controlledRetestMaxDrawdownR: rules.controlledRetestMaxDrawdownR,
    pyramidMaxAddOns: rules.pyramidMaxAddOns,
    pyramidAddMaxPct: rules.pyramidAddMaxPct,
    pyramidMaxPositionPct: rules.pyramidMaxPositionPct,
    chargesEnabled: config.trade?.chargesEnabled === true,
    brokerageMode: config.trade?.brokerageMode || "FLAT_PER_ORDER",
    brokerageFlatPerOrder: config.trade?.brokerageFlatPerOrder ?? 20,
    brokeragePercent: config.trade?.brokeragePercent ?? 0.1,
    dpChargePerSell: config.trade?.dpChargePerSell ?? 15.34,
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
  const entryExecutionAfterDate = rotationExecution
    ? row.asOf
    : executionAfterDate(row.asOf, scan.scannedAt);
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
    entryExecutionAfterDate,
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
    managementCloseDates: [],
    trailingStopBreachDates: [],
    cancelledExitSignals: [],
    realizedPnlToDate: 0,
    entryReason: [
      ...(row.signalReason || row.entryReason || []),
      `Trade sheet filter: ${settings.scopeLabel}, ${settings.qualityLabel}.`,
      `Portfolio rank ${plan.rank}; planned allocation Rs ${plan.allocation}, quantity ${plan.quantity}, initial stop ${plan.stopPrice}, planned risk Rs ${plan.plannedRisk}.`,
      ...(rotationExecution ? [
        `Immediate quality rotation: ${rotationExecution.sourceSymbol} sold ${rotationExecution.exitDate} ${rotationExecution.exitTime}; released cash is reusable immediately and this replacement must fill in the same execution slot.`
      ] : []),
      `Closing signal dated ${row.asOf}; execution eligibility starts after ${entryExecutionAfterDate}. Buy fill must come from the next actual market session at exactly 09:17 IST, after skipping weekends and exchange holidays.`
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

function prepareFullExit(trade, row, scan, reasons, exitType = "MODEL_EXIT", config = appConfig) {
  cancelPendingAdd(trade, `Cancelled because ${exitType} sell takes priority.`);
  trade.status = "PENDING_EXIT";
  trade.exitType = exitType;
  const portfolioDriven = ["SCOPE_REBALANCE", "CAPITAL_REBALANCE", "QUALITY_ROTATION"].includes(exitType);
  trade.exitSignalDate = portfolioDriven
    ? scan.marketContext?.asOf || row.asOf
    : row.asOf;
  trade.exitSignalScanAt = scan.scannedAt;
  trade.exitExecutionAfterDate = executionAfterDate(trade.exitSignalDate, scan.scannedAt);
  trade.exitReason = [
    ...(reasons || row.signalReason || row.exitReason || []),
    `Closing exit signal dated ${trade.exitSignalDate}; execution eligibility starts after ${trade.exitExecutionAfterDate}. Sell fill must come from the next actual market session at exactly 09:17 IST, after skipping weekends and exchange holidays.`
  ];
  trade.exitSnapshot = snapshot(row);
  markToMarket(trade, row, config);
}

function preparePartialExit(trade, row, scan, decision, config) {
  const rules = portfolioConfig(config);
  cancelPendingAdd(trade, "Cancelled because risk reduction takes priority.");
  trade.status = "PENDING_PARTIAL_EXIT";
  trade.partialExitSignalDate = row.asOf;
  trade.partialExitSignalScanAt = scan.scannedAt;
  trade.partialExitExecutionAfterDate = executionAfterDate(row.asOf, scan.scannedAt);
  trade.pendingPartialExitPct = decision.partialPct || rules.partialExitPct;
  trade.pendingPartialExitTag = decision.tag || "RISK_REDUCTION";
  trade.pendingPartialExitReason = [
    ...(decision.reasons || []),
    `Sell ${trade.pendingPartialExitPct}% on the next actual market session at 09:17 IST and trail the balance.`
  ];
  trade.exitSnapshot = snapshot(row);
  markToMarket(trade, row, config);
}

function preparePyramidAdd(trade, row, scan, decision) {
  trade.pendingAdd = {
    kind: "PYRAMID",
    signalDate: row.asOf,
    signalScanAt: scan.scannedAt,
    executionAfterDate: executionAfterDate(row.asOf, scan.scannedAt),
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

function prepareControlledRetestAdd(trade, row, scan, decision) {
  trade.pendingAdd = {
    kind: "CONTROLLED_RETEST",
    signalDate: row.asOf,
    signalScanAt: scan.scannedAt,
    executionAfterDate: executionAfterDate(row.asOf, scan.scannedAt),
    plannedQuantity: decision.quantity,
    plannedAllocation: decision.allocation,
    plannedRisk: decision.plannedRisk,
    plannedStop: decision.trailingStop,
    drawdownR: decision.state?.drawdownR,
    supportSource: decision.state?.supportSource,
    supportReference: decision.state?.supportReference,
    pullbackDepthPct: decision.state?.pullbackDepthPct,
    pullbackVolumeRatio: decision.state?.pullbackVolumeRatio,
    reclaimCloseLocationPct: decision.state?.reclaimCloseLocationPct,
    rank: decision.rank,
    reason: [
      ...(decision.reasons || []),
      "Buy the single controlled retest tranche only on the next actual market session at exactly 09:17 IST. Initial plus retest allocation remains capped at 10%, total stock risk at 1%, and the structural stop is never widened."
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
  if (trade.exitOrderState !== "CONFIRMED_FOR_0917") {
    trade.executionError = "Waiting for the 08:30 portfolio approval; an unannounced sell cannot execute at 09:17.";
    return false;
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
  const controlledRetest = pending.kind === "CONTROLLED_RETEST";
  const actionLabel = controlledRetest ? "Controlled retest add" : "Winner add";
  if (pending.orderState !== "CONFIRMED_FOR_0917") {
    trade.executionError = `${actionLabel} is waiting for the 08:30 portfolio approval; an unannounced add cannot execute.`;
    return "WAITING";
  }
  try {
    const fill = await fetchExecutionPrice(
      trade.yahooSymbol || row.yahooSymbol,
      pending.executionAfterDate || executionAfterDate(pending.signalDate, pending.signalScanAt)
    );
    if (!fill) {
      trade.executionError =
        `${actionLabel} is pending until the next actual market-session exact 09:17 candle.`;
      return "WAITING";
    }
    const summary = portfolioSummary(trades, candidates, config);
    const sector = String(trade.industry || row.industry || "Unknown");
    const adjustedSectorExposure = { ...summary.sectorExposure };
    adjustedSectorExposure[sector] = Math.max(
      0,
      (adjustedSectorExposure[sector] || 0) - (Number(pending.plannedAllocation) || 0)
    );
    let plan = (controlledRetest ? buildControlledRetestAddPlan : buildPyramidAddPlan)(
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
    const retestExecutionStillValid = !controlledRetest || (
      Number(fill.price) < Number(trade.initialEntryPrice || trade.entryPrice) &&
      Number(fill.price) > Number(pending.plannedStop || trade.trailingStopPrice || trade.initialStopPrice)
    );
    if (!plan.eligible && pending.orderState === "CONFIRMED_FOR_0917" && retestExecutionStillValid) {
      const reservedQuantity = Number(pending.plannedQuantity) || 0;
      const reservedAllocation = Number(pending.plannedAllocation) || 0;
      const reservedRisk = Number(pending.plannedRisk) || 0;
      const riskPerShare = reservedQuantity > 0 ? Math.max(0.01, reservedRisk / reservedQuantity) : 0.01;
      const quantity = Math.min(
        reservedQuantity,
        Math.floor(Math.min(reservedAllocation, summary.availableCash + reservedAllocation) / fill.price),
        Math.floor((summary.availableRisk + reservedRisk) / riskPerShare)
      );
      if (quantity > 0) {
        plan = {
          ...plan,
          eligible: true,
          quantity,
          allocation: round(quantity * fill.price),
          plannedRisk: round(quantity * riskPerShare),
          trailingStop: Number(plan.trailingStop) || Number(pending.plannedStop) || Number(trade.trailingStopPrice)
        };
      } else {
        trade.executionError = `Confirmed ${actionLabel.toLowerCase()} is still waiting because its reserved cash/risk cannot fit one share at the exact 09:17 price.`;
        return "WAITING";
      }
    }
    if (!plan.eligible) {
      const reason = `${actionLabel} skipped at actual 09:17 fill: ${plan.reason}`;
      trade.addOnSkips = Array.isArray(trade.addOnSkips) ? trade.addOnSkips : [];
      trade.addOnSkips.push({
        signalDate: pending.signalDate,
        evaluatedDate: fill.date,
        evaluatedPrice: round(fill.price),
        reason
      });
      const decisionKey = controlledRetest ? "lastControlledRetestDecision" : "lastPyramidDecision";
      trade[decisionKey] = {
        ...trade[decisionKey],
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
    for (const add of trade.addOns) add.kind = add.kind || "PYRAMID";
    if (trade.pendingAdd) trade.pendingAdd.kind = trade.pendingAdd.kind || "PYRAMID";
    const winnerAddCount = trade.addOns.filter((item) => item.kind !== "CONTROLLED_RETEST").length;
    const addOn = {
      kind: controlledRetest ? "CONTROLLED_RETEST" : "PYRAMID",
      number: controlledRetest ? 1 : winnerAddCount + 1,
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
      drawdownRAtSignal: pending.drawdownR,
      supportSource: pending.supportSource,
      supportReference: pending.supportReference,
      pullbackVolumeRatio: pending.pullbackVolumeRatio,
      reclaimCloseLocationPct: pending.reclaimCloseLocationPct,
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
    const decisionKey = controlledRetest ? "lastControlledRetestDecision" : "lastPyramidDecision";
    trade[decisionKey] = {
      ...trade[decisionKey],
      eligible: true,
      filled: true,
      fillDate: fill.date,
      fillPrice: addOn.price,
      quantity: addQuantity
    };
    trade.entryReason = [
      ...(trade.entryReason || []),
      controlledRetest
        ? `Controlled retest add filled ${fill.date} ${addOn.time} at Rs ${addOn.price}, quantity ${addQuantity}; blended average Rs ${trade.entryPrice}. Combined stock risk stayed within 1% and the structural stop remained Rs ${trade.trailingStopPrice}.`
        : `Winner add-on ${addOn.number} filled ${fill.date} ${addOn.time} at Rs ${addOn.price}, quantity ${addQuantity}; blended average Rs ${trade.entryPrice}. Trailing stop remains ratcheted at Rs ${trade.trailingStopPrice}.`
    ];
    trade.pendingAdd = null;
    trade.executionError = null;
    markToMarket(trade, row, config);
    return "FILLED";
  } catch (error) {
    trade.executionError = error.message || String(error);
    return "WAITING";
  }
}

async function fillEntry(trade, row, config, trades, candidates) {
  try {
    if (trade.orderState !== "CONFIRMED_FOR_0917") {
      trade.executionError = "Waiting for the next 08:30 portfolio approval cycle; unannounced candidates cannot execute.";
      return "WAITING";
    }
    if (trade.rotationFundingCommitment && !trade.rotationExecution) {
      const source = trades.find((item) => item.id === trade.rotationFundingCommitment.sourceTradeId);
      if (source?.status !== "CLOSED" || !source.exitDate) {
        trade.executionError = `Confirmed rotation buy is waiting for ${trade.rotationFundingCommitment.sourceSymbol || "source"} to sell in the same 09:17 batch.`;
        return "WAITING";
      }
      trade.rotationExecution = {
        sourceTradeId: source.id,
        sourceSymbol: source.symbol,
        exitDate: source.exitDate,
        exitTime: source.exitTime || EXECUTION_TIME,
        exitPrice: source.exitPrice,
        releasedCash: round(Number(source.exitPrice) * Number(source.quantity)),
        rule: "SELL_THEN_BUY_SAME_0917_SLOT"
      };
    }
    const afterDate = trade.rotationExecution
      ? trade.entrySignalDate
      : trade.entryExecutionAfterDate || executionAfterDate(trade.entrySignalDate, trade.entrySignalScanAt);
    const fill = await executionPriceFetcher(config)(
      trade.yahooSymbol || row.yahooSymbol,
      afterDate
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
      committedOrderOverride: !executionDecision.actionable,
      evaluatedDate: fill.date,
      evaluatedTime: fill.timeLabel || EXECUTION_TIME
    };
    const summary = portfolioSummary(trades, candidates, config);
    const sector = String(trade.industry || row.industry || "Unknown");
    const adjustedSectorExposure = { ...summary.sectorExposure };
    adjustedSectorExposure[sector] = Math.max(
      0,
      (adjustedSectorExposure[sector] || 0) - (Number(trade.plannedAllocation) || 0)
    );
    const dynamicPlan = buildPositionPlan(
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
    const reservedAllocation = Number(trade.plannedAllocation) || 0;
    const reservedRisk = Number(trade.plannedRisk) || 0;
    const reservedQuantity = Number(trade.plannedQuantity) || 0;
    const cashCapacity = Math.max(0, summary.availableCash + reservedAllocation);
    const riskCapacity = Math.max(0, summary.availableRisk + reservedRisk);
    const stopPrice = Number.isFinite(dynamicPlan.stopPrice)
      ? dynamicPlan.stopPrice
      : Math.min(Number(trade.initialStopPrice) || fill.price * 0.92, fill.price * 0.985);
    const riskPerShare = Math.max(0.01, fill.price - stopPrice);
    const committedQuantity = Math.min(
      reservedQuantity,
      Math.floor(Math.min(reservedAllocation, cashCapacity) / fill.price),
      Math.floor(riskCapacity / riskPerShare)
    );
    if (committedQuantity < 1) {
      trade.executionError = "Confirmed order is still waiting: exact 09:17 price cannot fit even one share inside its reserved cash and risk. No different stock will be substituted.";
      return "WAITING";
    }
    const plan = {
      ...dynamicPlan,
      quantity: committedQuantity,
      allocation: round(committedQuantity * fill.price),
      stopPrice,
      riskPerShare: round(riskPerShare),
      plannedRisk: round(committedQuantity * riskPerShare)
    };
    const quantity = committedQuantity;
    trade.status = "OPEN";
    trade.orderState = "EXECUTED";
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
    markToMarket(trade, row, config);
    return "FILLED";
  } catch (error) {
    trade.executionError = error.message || String(error);
    return "WAITING";
  }
}

async function fillExit(trade, row, config = appConfig) {
  try {
    const afterDate = trade.exitExecutionAfterDate || executionAfterDate(
      trade.exitSignalDate,
      trade.exitSignalScanAt
    );
    const fill = await executionPriceFetcher(config)(
      trade.yahooSymbol || row.yahooSymbol,
      afterDate
    );
    if (!fill) {
      trade.executionError =
        "Next market-session exact 09:17 one-minute candle is not available yet; pending through weekends and NSE holidays.";
      return false;
    }
    trade.status = "CLOSED";
    trade.exitOrderState = "EXECUTED";
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
    applyTradeChargeAccounting(trade, config, fill.price);
    return true;
  } catch (error) {
    trade.executionError = error.message || String(error);
    return false;
  }
}

function markToMarket(trade, row, config = appConfig) {
  if (!Number.isFinite(row.close)) return;
  trade.lastPrice = round(row.close);
  trade.lastPriceDate = row.asOf;
  if (!Number.isFinite(trade.entryPrice) || !Number.isFinite(trade.quantity)) return;
  trade.currentValue = round(row.close * trade.quantity);
  trade.unrealizedPnl = round((row.close - trade.entryPrice) * trade.quantity);
  trade.unrealizedPnlPct = round(((row.close / trade.entryPrice) - 1) * 100);
  applyTradeChargeAccounting(trade, config, row.close);
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

async function fillPartialExit(trade, row, config = appConfig) {
  try {
    if (trade.partialExitOrderState !== "CONFIRMED_FOR_0917") {
      trade.executionError = "Partial sell is waiting for the 08:30 portfolio approval; an unannounced sell cannot execute.";
      return false;
    }
    const afterDate = trade.partialExitExecutionAfterDate || executionAfterDate(
      trade.partialExitSignalDate,
      trade.partialExitSignalScanAt
    );
    const fill = await fetchExecutionPrice(
      trade.yahooSymbol || row.yahooSymbol,
      afterDate
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
    trade.partialExitOrderState = "EXECUTED";
    trade.lastPartialExitDate = fill.date;
    trade.lastRiskActionSignalDate = row.asOf;
    trade.lastPartialExitPrice = round(fill.price);
    trade.executionError = null;
    trade.pendingPartialExitPct = null;
    trade.pendingPartialExitTag = null;
    trade.pendingPartialExitReason = [];
    markToMarket(trade, row, config);
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
    trade.corporateActions = Array.isArray(trade.corporateActions) ? trade.corporateActions : [];
    trade.partialExitTags = Array.isArray(trade.partialExitTags) ? trade.partialExitTags : [];
    trade.managementCloseDates = Array.isArray(trade.managementCloseDates) ? trade.managementCloseDates : [];
    trade.trailingStopBreachDates = Array.isArray(trade.trailingStopBreachDates) ? trade.trailingStopBreachDates : [];
    trade.cancelledExitSignals = Array.isArray(trade.cancelledExitSignals) ? trade.cancelledExitSignals : [];
    trade.addOns = Array.isArray(trade.addOns) ? trade.addOns : [];
    trade.addOnSkips = Array.isArray(trade.addOnSkips) ? trade.addOnSkips : [];
    trade.initialEntryPrice = trade.initialEntryPrice || trade.entryPrice || null;
    trade.initialQuantity = trade.initialQuantity || trade.originalQuantity || trade.quantity || null;
    trade.realizedPnlToDate = Number(trade.realizedPnlToDate) || 0;
    trade.tradeRealizedPnlToDate = Number.isFinite(Number(trade.tradeRealizedPnlToDate))
      ? Number(trade.tradeRealizedPnlToDate)
      : trade.realizedPnlToDate - (Number(trade.dividendRealizedPnl) || 0);
    trade.dividendRealizedPnl = Number(trade.dividendRealizedPnl) || 0;
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

function releaseUnfundedCommittedEntries({
  candidates,
  trades,
  scopeRowBySymbol,
  scan,
  settings,
  events
}) {
  for (const trade of trades.filter((item) =>
    item.status === "PENDING_ENTRY" && item.fundingMode === "CONFIRMED_SELL_PROCEEDS"
  )) {
    const sources = trade.fundingSources || [];
    const valid = sources.length > 0 && sources.every((source) => {
      const fundingTrade = trades.find((item) => item.id === source.tradeId);
      if (!fundingTrade) return false;
      if (source.kind === "FULL_EXIT") {
        return fundingTrade.status === "PENDING_EXIT" ||
          (fundingTrade.status === "CLOSED" && fundingTrade.exitOrderState === "EXECUTED");
      }
      return fundingTrade.status === "PENDING_PARTIAL_EXIT" ||
        fundingTrade.partialExitOrderState === "EXECUTED";
    });
    if (valid) continue;
    trade.status = "SKIPPED_ENTRY";
    trade.orderState = "CANCELLED_BEFORE_ALERT";
    trade.skipReason = "Linked full/partial sell was cancelled before 08:30 approval, so its projected cash cannot fund this buy.";
    trade.executionError = trade.skipReason;
    const row = scopeRowBySymbol.get(trade.yahooSymbol || trade.symbol);
    if (row) {
      const candidate = upsertCandidate(candidates, row, scan, settings, null, trade.candidateContext);
      candidate.status = "WAITING_CAPITAL";
      candidate.skipReason = trade.skipReason;
      events.push({ type: "ENTRY_SKIPPED", trade, candidate });
    }
  }
  return candidates;
}

function commitSellFundedEntries({
  candidates,
  candidateDecisionLog,
  events,
  trades,
  scopeRowBySymbol,
  scan,
  settings,
  config
}) {
  const funding = projectedSellFunding(trades);
  if (funding.expectedProceeds <= 0) return { candidates, candidateDecisionLog };

  const alreadyCommitted = trades
    .filter((trade) => trade.status === "PENDING_ENTRY" && trade.fundingMode === "CONFIRMED_SELL_PROCEEDS")
    .reduce((sum, trade) => sum + (Number(trade.plannedAllocation) || 0), 0);
  const summary = portfolioSummary(trades, candidates, config);
  let remainingCash = Math.max(0, summary.availableCash + funding.expectedProceeds - alreadyCommitted);
  const rules = portfolioConfig(config);
  const projectedActive = Math.max(0, summary.openPositions - funding.fullExitCount);
  let remainingSlots = Math.max(0, rules.maxOpenPositions - projectedActive - summary.pendingEntries);
  const projectedSectorExposure = { ...summary.sectorExposure };
  for (const source of funding.sources) {
    projectedSectorExposure[source.sector] = Math.max(
      0,
      (Number(projectedSectorExposure[source.sector]) || 0) - source.exposureRelease
    );
  }

  for (const candidate of [...candidates].sort((left, right) => right.rank - left.rank)) {
    if (remainingCash <= 0 || remainingSlots <= 0) break;
    const row = scopeRowBySymbol.get(candidate.yahooSymbol || candidate.symbol);
    if (!row || findAnyActiveTrade(trades, row)) continue;
    const decision = candidateEntryDecision(candidate, row, config, {
      qualityPass: rowPassesTradeQuality(row, settings),
      forRotation: Boolean(candidate.rotation?.sourceTradeId)
    });
    applyCandidateDecision(candidate, decision, scan);
    if (!decision.actionable) continue;
    const current = portfolioSummary(trades, candidates, config);
    const plan = buildPositionPlan(row, row.close, {
      ...current,
      availableCash: remainingCash,
      openSlots: remainingSlots,
      sectorExposure: projectedSectorExposure
    }, config);
    if (!plan.eligible) continue;

    const trade = createPendingEntry(row, scan, config, settings, plan, null, candidate);
    trade.fundingMode = "CONFIRMED_SELL_PROCEEDS";
    trade.fundingSources = funding.sources.map((source) => ({ ...source }));
    trade.expectedSellProceeds = round(funding.expectedProceeds);
    if (candidate.rotation?.sourceTradeId) {
      trade.rotationSourceTradeId = candidate.rotation.sourceTradeId;
      trade.rotationSourceSymbol = candidate.rotation.sourceSymbol ||
        funding.sources.find((source) => source.tradeId === candidate.rotation.sourceTradeId)?.symbol || null;
      trade.rotationFundingCommitment = {
        sourceTradeId: candidate.rotation.sourceTradeId,
        sourceSymbol: trade.rotationSourceSymbol,
        rule: "CONFIRMED_SELL_THEN_BUY_SAME_0917_SLOT"
      };
    }
    trade.entryReason.push(
      `Order funding is locked to the same 09:17 batch: confirmed sells are expected to release Rs ${round(funding.expectedProceeds)} before this buy is filled.`
    );
    trades.push(trade);
    candidates = candidates.filter((item) => item !== candidate);
    remainingCash = Math.max(0, remainingCash - plan.allocation);
    remainingSlots -= 1;
    projectedSectorExposure[plan.sector] =
      (Number(projectedSectorExposure[plan.sector]) || 0) + plan.allocation;
    events.push({ type: "ENTRY_SIGNAL_PENDING", trade });
    candidateDecisionLog = recordCandidateDecision(
      candidateDecisionLog,
      candidate,
      { ...decision, reasons: [...decision.reasons, "Funded by confirmed same-batch sell proceeds."] },
      scan,
      "COMMITTED_SELL_FUNDED_ENTRY"
    );
  }
  return { candidates, candidateDecisionLog };
}

export function projectedSellFunding(trades = []) {
  const sources = [];
  for (const trade of trades) {
    const price = Number(trade.lastPrice) || Number(trade.exitSnapshot?.close) || Number(trade.entryPrice) || 0;
    const quantity = Number(trade.quantity) || 0;
    if (!(price > 0 && quantity > 0)) continue;
    let sellQuantity = 0;
    let kind = "";
    if (trade.status === "PENDING_EXIT") {
      sellQuantity = quantity;
      kind = "FULL_EXIT";
    } else if (trade.status === "PENDING_PARTIAL_EXIT" && quantity >= 2) {
      sellQuantity = Math.max(1, Math.min(
        quantity - 1,
        Math.floor(quantity * (Number(trade.pendingPartialExitPct) || 50) / 100)
      ));
      kind = "PARTIAL_EXIT";
    }
    if (sellQuantity < 1) continue;
    const expectedProceeds = round(price * sellQuantity);
    const exposureRelease = kind === "FULL_EXIT"
      ? Number(trade.investedValue) || expectedProceeds
      : round((Number(trade.investedValue) || price * quantity) * sellQuantity / quantity);
    sources.push({
      tradeId: trade.id,
      symbol: trade.symbol,
      kind,
      expectedQuantity: sellQuantity,
      expectedProceeds,
      exposureRelease,
      sector: String(trade.industry || "Unclassified")
    });
  }
  return {
    expectedProceeds: round(sources.reduce((sum, source) => sum + source.expectedProceeds, 0)),
    fullExitCount: sources.filter((source) => source.kind === "FULL_EXIT").length,
    sources
  };
}

export function publishPortfolioActionEvents(events = [], trades = [], occurredAt, options = {}) {
  const operationalEvents = (events || []).filter((event) => !isPublishableAction(event));
  if (options.enabled !== true) {
    for (const event of events || []) {
      if (String(event.type || "").toUpperCase() === "DIVIDEND_CREDIT" && event.corporateAction) {
        event.corporateAction.notificationPending = true;
      }
    }
    return operationalEvents;
  }

  const actionEvents = [
    ...(events || []).filter(isPublishableAction),
    ...currentPendingActionEvents(trades)
  ];
  const published = [];
  const seen = new Set();
  for (const event of actionEvents) {
    const key = actionPublicationKey(event);
    if (!key || !actionCanBePublished(event, occurredAt) || seen.has(key) || actionWasPublished(event, key)) continue;
    seen.add(key);
    markActionPublished(event, key, occurredAt);
    published.push(event);
  }
  return [...operationalEvents, ...published];
}

function currentPendingActionEvents(trades = []) {
  const output = [];
  for (const trade of trades || []) {
    if (trade.status === "PENDING_ENTRY") {
      output.push({ type: "ENTRY_SIGNAL_PENDING", trade });
    } else if (trade.status === "PENDING_EXIT") {
      const type = trade.exitType === "QUALITY_ROTATION"
        ? "ROTATION_EXIT_PENDING"
        : ["SCOPE_REBALANCE", "CAPITAL_REBALANCE"].includes(trade.exitType)
          ? "PORTFOLIO_EXIT_PENDING"
          : "EXIT_SIGNAL_PENDING";
      output.push({ type, trade });
    } else if (trade.status === "PENDING_PARTIAL_EXIT") {
      output.push({ type: "PARTIAL_EXIT_PENDING", trade });
    }
    if (trade.pendingAdd) {
      output.push({
        type: trade.pendingAdd.kind === "CONTROLLED_RETEST"
          ? "CONTROLLED_RETEST_ADD_PENDING"
          : "PYRAMID_ADD_PENDING",
        trade
      });
    }
    for (const action of trade.corporateActions || []) {
      if (String(action.type || "").toUpperCase() === "DIVIDEND" && action.notificationPending === true) {
        output.push({ type: "DIVIDEND_CREDIT", trade, corporateAction: action });
      }
    }
  }
  return output;
}

function isPublishableAction(event = {}) {
  return PUBLISHABLE_ACTION_TYPES.has(String(event.type || "").toUpperCase());
}

function actionPublicationKey(event = {}) {
  const type = String(event.type || "").toUpperCase();
  const trade = event.trade || {};
  const action = event.corporateAction || {};
  const actionDate = type === "ENTRY_SIGNAL_PENDING" ? trade.entrySignalDate
    : type === "PARTIAL_EXIT_PENDING" ? trade.partialExitSignalDate
      : ["PYRAMID_ADD_PENDING", "CONTROLLED_RETEST_ADD_PENDING"].includes(type) ? trade.pendingAdd?.signalDate
        : type === "DIVIDEND_CREDIT" ? action.exDate
          : trade.exitSignalDate;
  const identity = action.id || trade.id || event.candidate?.id || event.candidate?.symbol;
  return identity && actionDate ? `${type}:${identity}:${actionDate}` : "";
}

function actionWasPublished(event, key) {
  return Boolean(event.trade?.actionAlertPublications?.[key]);
}

function markActionPublished(event, key, occurredAt) {
  if (!event.trade) return;
  event.trade.actionAlertPublications = {
    ...(event.trade.actionAlertPublications || {}),
    [key]: occurredAt || new Date().toISOString()
  };
  if (event.corporateAction) event.corporateAction.notificationPending = false;
  const type = String(event.type || "").toUpperCase();
  if (type === "ENTRY_SIGNAL_PENDING") {
    event.trade.orderState = "CONFIRMED_FOR_0917";
    event.trade.capitalReservedAt = event.trade.capitalReservedAt || occurredAt;
    event.trade.riskReservedAt = event.trade.riskReservedAt || occurredAt;
  } else if (["EXIT_SIGNAL_PENDING", "PORTFOLIO_EXIT_PENDING", "ROTATION_EXIT_PENDING"].includes(type)) {
    event.trade.exitOrderState = "CONFIRMED_FOR_0917";
  } else if (type === "PARTIAL_EXIT_PENDING") {
    event.trade.partialExitOrderState = "CONFIRMED_FOR_0917";
  } else if (["PYRAMID_ADD_PENDING", "CONTROLLED_RETEST_ADD_PENDING"].includes(type) && event.trade.pendingAdd) {
    event.trade.pendingAdd.orderState = "CONFIRMED_FOR_0917";
  }
}

function actionCanBePublished(event, occurredAt) {
  const type = String(event.type || "").toUpperCase();
  const trade = event.trade || {};
  const afterDate = type === "ENTRY_SIGNAL_PENDING" ? trade.entryExecutionAfterDate
    : type === "PARTIAL_EXIT_PENDING" ? trade.partialExitExecutionAfterDate
      : ["PYRAMID_ADD_PENDING", "CONTROLLED_RETEST_ADD_PENDING"].includes(type) ? trade.pendingAdd?.executionAfterDate
        : type === "DIVIDEND_CREDIT" ? null
          : trade.exitExecutionAfterDate;
  if (!afterDate) return true;
  return istDate(occurredAt) > String(afterDate).slice(0, 10);
}

function istDate(value) {
  const time = Date.parse(String(value || ""));
  if (!Number.isFinite(time)) return "";
  return new Date(time + 330 * 60 * 1000).toISOString().slice(0, 10);
}

function repairRetroactiveEntryFills(trades, repairedAt) {
  for (const trade of trades) {
    if (!isRepairableRetroactiveEntry(trade)) continue;
    const invalidFill = {
      entryDate: trade.entryDate,
      entryTime: trade.entryTime,
      entryPrice: trade.entryPrice,
      quantity: trade.quantity,
      investedValue: trade.investedValue,
      entrySignalScanAt: trade.entrySignalScanAt
    };
    trade.status = "PENDING_ENTRY";
    trade.entryExecutionAfterDate = trade.entryDate;
    trade.plannedQuantity = Number(trade.quantity) || Number(trade.originalQuantity) || null;
    trade.plannedAllocation = Number(trade.investedValue) || Number(trade.originalInvestedValue) || null;
    trade.plannedRisk = Number(trade.initialRiskAmount) || Number(trade.plannedRisk) || 0;
    trade.entryDate = null;
    trade.entryTime = null;
    trade.entryActualFillTime = null;
    trade.entryPrice = null;
    trade.initialEntryPrice = null;
    trade.quantity = null;
    trade.originalQuantity = null;
    trade.initialQuantity = null;
    trade.investedValue = null;
    trade.originalInvestedValue = null;
    trade.currentValue = null;
    trade.unrealizedPnl = null;
    trade.unrealizedPnlPct = null;
    trade.pnl = null;
    trade.pnlPct = null;
    trade.executionError =
      `Impossible historical 09:17 fill was removed. This order can execute only after ${trade.entryExecutionAfterDate}.`;
    trade.retroactiveFillRepair = { repairedAt, invalidFill };
  }
}

function isRepairableRetroactiveEntry(trade) {
  if (!["OPEN", "PENDING_EXIT", "PENDING_PARTIAL_EXIT"].includes(String(trade?.status || ""))) return false;
  if (!isRetroactiveExecution(trade.entrySignalScanAt, trade.entryDate, trade.entryTime)) return false;
  if ((trade.partialExits || []).length || (trade.addOns || []).length) return false;
  return Math.abs(Number(trade.realizedPnlToDate) || 0) < 0.005;
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

function indexRowsByInstrument(rows = []) {
  const index = new Map();
  for (const row of rows) {
    for (const key of [row.yahooSymbol, row.symbol].filter(Boolean)) {
      if (!index.has(key)) index.set(key, row);
    }
  }
  for (const row of rows) {
    const base = normalizedInstrumentSymbol(row.symbol || row.yahooSymbol);
    if (!base) continue;
    for (const alias of [base, `${base}.NS`, `${base}.BO`]) {
      if (!index.has(alias)) index.set(alias, row);
    }
  }
  return index;
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
  if (!row?.asOf) return;
  const entryDate = String(trade.entryDate || trade.entrySignalDate || "").slice(0, 10);
  if (!entryDate || row.asOf >= entryDate) {
    trade.managementCloseDates = Array.from(new Set([
      ...(trade.managementCloseDates || []),
      row.asOf
    ])).slice(-30);
  }
  const raisedTrailingStop =
    Number(trade.trailingStopPrice) > Number(trade.initialStopPrice) &&
    Number(row.close) <= Number(trade.trailingStopPrice);
  trade.trailingStopBreachDates = raisedTrailingStop
    ? Array.from(new Set([...(trade.trailingStopBreachDates || []), row.asOf])).slice(-5)
    : [];
  trade.dailyLongRsBelowZeroDates = Number(row.dailyLongRs) < 0
    ? Array.from(new Set([...(trade.dailyLongRsBelowZeroDates || []), row.asOf])).slice(-5)
    : [];

  const qualificationVersion = 3;
  const currentVersion = Number(trade.rotationReview?.qualificationVersion) || 0;
  if (
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
  target.latestSnapshot = snapshot(row);
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
      "CAPITAL_REBALANCE",
      config
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
  if (trade.yahooSymbol && row.yahooSymbol && trade.yahooSymbol === row.yahooSymbol) return true;
  const tradeSymbol = normalizedInstrumentSymbol(trade.symbol || trade.yahooSymbol);
  const rowSymbol = normalizedInstrumentSymbol(row.symbol || row.yahooSymbol);
  return Boolean(tradeSymbol && rowSymbol && tradeSymbol === rowSymbol);
}

function normalizedInstrumentSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^NSE:/, "")
    .replace(/\.(NS|BO)$/i, "")
    .replace(/[^A-Z0-9&_-]/g, "");
}

function calculateQuantity(price, config) {
  if (Number.isFinite(config.trade.capitalPerStock) && config.trade.capitalPerStock > 0) {
    return Math.max(1, Math.floor(config.trade.capitalPerStock / price));
  }
  return config.trade.defaultQty;
}

async function writeXlsx(journal, filePath) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Techno Funda PMS";
  workbook.created = new Date();

  const pending = journal.trades.filter(
    (trade) => trade.status.startsWith("PENDING_") || Boolean(trade.pendingAdd)
  );
  const open = journal.trades.filter((trade) => trade.status === "OPEN");
  const closed = journal.trades.filter((trade) => trade.status === "CLOSED");
  const realizedPnl = totalRealizedPnl(journal.trades);
  const dividendPnl = journal.trades.reduce((sum, trade) => sum + (Number(trade.dividendRealizedPnl) || 0), 0);
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
    { metric: "Trading Realized P&L", value: round(realizedPnl - dividendPnl) },
    { metric: "Dividend Realized P&L", value: round(dividendPnl) },
    { metric: "Unrealized P&L", value: round(unrealizedPnl) },
    { metric: "Unrealized P&L %", value: portfolio.unrealizedPnlPct },
    { metric: "Charges Included", value: journal.chargeRules?.enabled ? "Yes" : "No" },
    { metric: "Actual Charges", value: portfolio.actualCharges || 0 },
    { metric: "Realized Charges", value: portfolio.realizedCharges || 0 },
    { metric: "Open Buy Charges", value: portfolio.openBuyCharges || 0 },
    { metric: "Estimated Exit Charges", value: portfolio.estimatedExitCharges || 0 },
    { metric: "Brokerage Model", value: journal.chargeRules?.brokerageMode || "FLAT_PER_ORDER" },
    { metric: "Fixed Brokerage / Order", value: journal.chargeRules?.brokerageFlatPerOrder ?? 0 },
    { metric: "Brokerage % Turnover", value: journal.chargeRules?.brokeragePercent ?? 0 },
    { metric: "DP Charge / Delivery Sell", value: journal.chargeRules?.dpChargePerSell ?? 0 },
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
  addTransactionLedgerWorksheet(workbook, journal.trades);
  addCorporateActionWorksheet(workbook, journal.trades);
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

function addTransactionLedgerWorksheet(workbook, trades) {
  const sheet = workbook.addWorksheet("Transactions & Charges");
  sheet.columns = [
    { header: "Symbol", key: "Symbol", width: 14 },
    { header: "Transaction", key: "Transaction", width: 18 },
    { header: "Side", key: "Side", width: 10 },
    { header: "Date", key: "Date", width: 14 },
    { header: "Time", key: "Time", width: 14 },
    { header: "Price", key: "Price", width: 14 },
    { header: "Quantity", key: "Quantity", width: 12 },
    { header: "Turnover", key: "Turnover", width: 16 },
    { header: "Brokerage", key: "Brokerage", width: 14 },
    { header: "STT", key: "STT", width: 14 },
    { header: "Exchange Charges", key: "Exchange Charges", width: 18 },
    { header: "SEBI Charges", key: "SEBI Charges", width: 14 },
    { header: "Stamp Duty", key: "Stamp Duty", width: 14 },
    { header: "IPFT", key: "IPFT", width: 12 },
    { header: "GST", key: "GST", width: 12 },
    { header: "DP Charge", key: "DP Charge", width: 14 },
    { header: "Total Charges", key: "Total Charges", width: 16 },
    { header: "Gross P&L", key: "Gross P&L", width: 16 },
    { header: "Allocated Buy Charges", key: "Allocated Buy Charges", width: 22 },
    { header: "Net P&L", key: "Net P&L", width: 16 }
  ];
  const rows = [];
  for (const trade of trades) {
    for (const transaction of trade.transactions || []) {
      const charges = transaction.charges || {};
      rows.push({
        Symbol: trade.symbol,
        Transaction: transaction.type,
        Side: transaction.side,
        Date: transaction.date || "",
        Time: transaction.time || "",
        Price: transaction.price,
        Quantity: transaction.quantity,
        Turnover: transaction.turnover,
        Brokerage: charges.brokerage || 0,
        STT: charges.stt || 0,
        "Exchange Charges": charges.exchangeTransactionCharge || 0,
        "SEBI Charges": charges.sebiTurnoverCharge || 0,
        "Stamp Duty": charges.stampDuty || 0,
        IPFT: charges.ipft || 0,
        GST: charges.gst || 0,
        "DP Charge": charges.dpCharge || 0,
        "Total Charges": charges.total || 0,
        "Gross P&L": transaction.grossPnl ?? "",
        "Allocated Buy Charges": transaction.allocatedBuyCharges ?? "",
        "Net P&L": transaction.netPnl ?? ""
      });
    }
  }
  sheet.addRows(rows);
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  formatSheet(sheet);
}

function addCorporateActionWorksheet(workbook, trades) {
  const sheet = workbook.addWorksheet("Corporate Actions");
  sheet.columns = [
    { header: "Symbol", key: "Symbol", width: 15 },
    { header: "Type", key: "Type", width: 18 },
    { header: "Status", key: "Status", width: 28 },
    { header: "Ex Date", key: "Ex Date", width: 14 },
    { header: "Record Date", key: "Record Date", width: 14 },
    { header: "Purpose", key: "Purpose", width: 70 },
    { header: "Entitled Quantity", key: "Entitled Quantity", width: 20 },
    { header: "Quantity Before", key: "Quantity Before", width: 18 },
    { header: "Quantity After", key: "Quantity After", width: 18 },
    { header: "Factor", key: "Factor", width: 12 },
    { header: "Dividend Per Share", key: "Dividend Per Share", width: 22 },
    { header: "Dividend Realized P&L", key: "Dividend Realized P&L", width: 24 },
    { header: "Fractional Entitlement", key: "Fractional Entitlement", width: 23 },
    { header: "Review / Accounting Note", key: "Review / Accounting Note", width: 70 },
    { header: "Source", key: "Source", width: 24 }
  ];
  const rows = [];
  for (const trade of trades) {
    for (const action of trade.corporateActions || []) {
      rows.push({
        Symbol: trade.symbol,
        Type: action.type,
        Status: action.status,
        "Ex Date": action.exDate || "",
        "Record Date": action.recordDate || "",
        Purpose: action.purpose || "",
        "Entitled Quantity": action.entitledQuantity ?? "",
        "Quantity Before": action.quantityBefore ?? "",
        "Quantity After": action.quantityAfter ?? "",
        Factor: action.factor ?? "",
        "Dividend Per Share": action.dividendPerShare ?? "",
        "Dividend Realized P&L": action.amount ?? "",
        "Fractional Entitlement": action.fractionalEntitlement ?? "",
        "Review / Accounting Note": action.reviewReason || action.accountingNote || "",
        Source: action.source || "NSE Corporate Actions"
      });
    }
  }
  sheet.addRows(rows);
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
    { header: "Gross Unrealized P&L", key: "Gross Unrealized P&L", width: 22 },
    { header: "Open Buy Charges", key: "Open Buy Charges", width: 18 },
    { header: "Estimated Exit Charges", key: "Estimated Exit Charges", width: 22 },
    { header: "Exit Signal Date", key: "Exit Signal Date", width: 18 },
    { header: "Exit Date", key: "Exit Date", width: 14 },
    { header: "Exit Time", key: "Exit Time", width: 13 },
    { header: "Exit Actual Fill Time", key: "Exit Actual Fill Time", width: 22 },
    { header: "Exit Price", key: "Exit Price", width: 14 },
    { header: "Exit Execution Method", key: "Exit Execution Method", width: 30 },
    { header: "Realized P&L", key: "Realized P&L", width: 16 },
    { header: "Realized P&L %", key: "Realized P&L %", width: 18 },
    { header: "Gross Realized P&L", key: "Gross Realized P&L", width: 21 },
    { header: "Actual Charges", key: "Actual Charges", width: 16 },
    { header: "Realized Charges", key: "Realized Charges", width: 18 },
    { header: "Charges Included", key: "Charges Included", width: 17 },
    { header: "Holding Days", key: "Holding Days", width: 14 },
    { header: "Execution Window", key: "Execution Window", width: 20 },
    { header: "Position Rank", key: "Position Rank", width: 14 },
    { header: "Current Rank", key: "Current Rank", width: 14 },
    { header: "Initial Stop", key: "Initial Stop", width: 14 },
    { header: "Trailing Stop", key: "Trailing Stop", width: 14 },
    { header: "Completed Weekly Close", key: "Completed Weekly Close", width: 24 },
    { header: "Weekly EMA13 (Low Source)", key: "Weekly EMA13 (Low Source)", width: 26 },
    { header: "Weekly Close vs EMA13 (Low)", key: "Weekly Close vs EMA13 (Low)", width: 30 },
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
    { header: "Trading Realized P&L", key: "Trading Realized P&L", width: 22 },
    { header: "Dividend Realized P&L", key: "Dividend Realized P&L", width: 23 },
    { header: "Corporate Action Count", key: "Corporate Action Count", width: 22 },
    { header: "Corporate Action History", key: "Corporate Action History", width: 80 },
    { header: "Transaction & Charge History", key: "Transaction & Charge History", width: 80 },
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
  const currentSnapshot = trade.currentSnapshot || trade.latestSnapshot || trade.entrySnapshot || {};
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
    "Gross Unrealized P&L": trade.chargeSummary?.grossUnrealizedPnl ?? trade.unrealizedPnl ?? "",
    "Open Buy Charges": trade.chargeSummary?.unallocatedBuyCharges ?? 0,
    "Estimated Exit Charges": trade.chargeSummary?.estimatedExitCharges ?? 0,
    "Exit Signal Date": trade.exitSignalDate || "",
    "Exit Date": trade.exitDate || "",
    "Exit Time": trade.exitTime || "",
    "Exit Actual Fill Time": trade.exitActualFillTime || trade.exitTime || "",
    "Exit Price": trade.exitPrice ?? "",
    "Exit Execution Method": trade.exitExecutionMethod || "",
    "Realized P&L": trade.pnl ?? "",
    "Realized P&L %": trade.pnlPct ?? "",
    "Gross Realized P&L": trade.chargeSummary?.grossRealizedPnl ?? trade.pnl ?? "",
    "Actual Charges": trade.chargeSummary?.actualCharges ?? 0,
    "Realized Charges": trade.chargeSummary?.realizedCharges ?? 0,
    "Charges Included": trade.chargeSummary?.enabled ? "Yes" : "No",
    "Holding Days": trade.holdingDays ?? "",
    "Execution Window": trade.executionWindow || "",
    "Position Rank": trade.positionRank ?? "",
    "Current Rank": trade.currentRank ?? "",
    "Initial Stop": trade.initialStopPrice ?? "",
    "Trailing Stop": trade.trailingStopPrice ?? "",
    "Completed Weekly Close": currentSnapshot.weeklyClose ?? "",
    "Weekly EMA13 (Low Source)": currentSnapshot.weeklyEma13 ?? "",
    "Weekly Close vs EMA13 (Low)": currentSnapshot.weeklyPriceAboveEma13 === true
      ? "Above"
      : currentSnapshot.weeklyPriceAboveEma13 === false
        ? "Below - exit"
        : "NA",
    "Initial Risk": trade.initialRiskAmount ?? trade.plannedRisk ?? "",
    "Current R": trade.currentRewardR ?? "",
    "Controlled Retest Add Count": (trade.addOns || []).filter((add) => add.kind === "CONTROLLED_RETEST").length,
    "Winner Pyramid Add Count": (trade.addOns || []).filter((add) => add.kind !== "CONTROLLED_RETEST").length,
    "Add-On Count": trade.addOns?.length || 0,
    "Pending Add Type": trade.pendingAdd?.kind || "",
    "Pending Add": trade.pendingAdd ? "Yes" : "No",
    "Last Add Date": trade.lastAddDate || "",
    "Last Add Time": trade.lastAddTime || "",
    "Last Add Price": trade.lastAddPrice ?? "",
    "Last Add Quantity": trade.addOns?.at(-1)?.quantity ?? "",
    "Add-On History": (trade.addOns || []).map((add) =>
      `${add.kind || "PYRAMID"} #${add.number} signal ${add.signalDate}; fill ${add.date} ${add.time} @ ${add.price}; qty ${add.quantity}; stop ${add.trailingStop}; drawdown ${add.drawdownRAtSignal ?? "NA"}R; support ${add.supportSource || "NA"} @ ${add.supportReference ?? "NA"}; swing high ${add.swingHighDate || "NA"} @ ${add.breakoutLevel ?? "NA"}; pullback low ${add.pullbackLowDate || "NA"} @ ${add.pullbackLow ?? "NA"} (${add.pullbackDepthPct ?? "NA"}%); ${add.breakoutType || "reclaim"}`
    ).join(" | "),
    "Add-On Decision": trade.pendingAdd
      ? (trade.pendingAdd.reason || []).join(" ")
      : (trade.lastControlledRetestDecision?.eligible
          ? trade.lastControlledRetestDecision?.reasons
          : trade.lastPyramidDecision?.reasons || trade.lastControlledRetestDecision?.reasons || []).join(" "),
    "Partial Exit Count": trade.partialExits?.length || 0,
    "Partial Realized P&L": trade.tradeRealizedPnlToDate ?? trade.realizedPnlToDate ?? 0,
    "Trading Realized P&L": trade.tradeRealizedPnlToDate ?? 0,
    "Dividend Realized P&L": trade.dividendRealizedPnl ?? 0,
    "Corporate Action Count": trade.corporateActions?.length || 0,
    "Corporate Action History": (trade.corporateActions || []).map((item) =>
      `${item.exDate || "NA"} ${item.type} ${item.status}; ${item.purpose}; entitled ${item.entitledQuantity ?? "NA"}; before ${item.quantityBefore ?? "NA"}; after ${item.quantityAfter ?? "NA"}; dividend ${item.amount ?? 0}; ${item.reviewReason || item.accountingNote || ""}`
    ).join(" | "),
    "Transaction & Charge History": (trade.transactions || []).map((item) =>
      `${item.date || "NA"} ${item.time || ""} ${item.type} ${item.side} ${item.quantity} @ ${item.price}; turnover ${item.turnover}; brokerage ${item.charges?.brokerage || 0}; STT ${item.charges?.stt || 0}; exchange ${item.charges?.exchangeTransactionCharge || 0}; SEBI ${item.charges?.sebiTurnoverCharge || 0}; stamp ${item.charges?.stampDuty || 0}; GST ${item.charges?.gst || 0}; DP ${item.charges?.dpCharge || 0}; total ${item.charges?.total || 0}; net P&L ${item.netPnl ?? "NA"}`
    ).join(" | "),
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
    symbol: row.symbol,
    yahooSymbol: row.yahooSymbol,
    name: row.name,
    industry: row.industry || "Unknown",
    listLabel: row.listLabel,
    status: row.status,
    signalReason: row.signalReason,
    close: row.close,
    asOf: row.asOf,
    weeklyAsOf: row.weeklyAsOf,
    dailyRsi: row.dailyRsi,
    weeklyRsi: row.weeklyRsi,
    weeklyRs: row.weeklyRs,
    dailyLongRs: row.dailyLongRs,
    dailyShortRs: row.dailyShortRs,
    dailySupertrend: row.dailySupertrend,
    weeklyClose: row.weeklyClose,
    weeklyEma13: row.weeklyEma13,
    weeklyEma13Source: row.weeklyEma13Source || "low",
    weeklyPriceAboveEma13: row.weeklyPriceAboveEma13,
    weeklyEma13Rising: row.weeklyEma13Rising,
    weeklyEma13Reclaim: row.weeklyEma13Reclaim,
    weeklyEma13BelowCloses: row.weeklyEma13BelowCloses,
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
