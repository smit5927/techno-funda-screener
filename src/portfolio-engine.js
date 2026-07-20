import { portfolioChargeSummary } from "./charges.js";

const ACTIVE_STATUSES = new Set(["OPEN", "PENDING_EXIT", "PENDING_PARTIAL_EXIT"]);

export function isFilledHolding(trade = {}) {
  return ACTIVE_STATUSES.has(String(trade.status || ""));
}

export function isConfirmedPendingEntry(trade = {}) {
  return trade.status === "PENDING_ENTRY" &&
    ["APPROVED_FOR_0917", "CONFIRMED_FOR_0917"].includes(String(trade.orderState || ""));
}

export function isConfirmedPendingAdd(trade = {}) {
  return Boolean(trade.pendingAdd) &&
    ["APPROVED_FOR_0917", "CONFIRMED_FOR_0917"].includes(String(trade.pendingAdd.orderState || ""));
}

export function portfolioConfig(config = {}) {
  const trade = config.trade || config;
  const totalCapital = positive(trade.totalCapital, 1_000_000);
  const pyramidPullbackMinPct = positive(trade.pyramidPullbackMinPct, 2);
  const maxPositionPct = positive(trade.maxPositionPct, 10);
  const riskPerTradePct = positive(trade.riskPerTradePct, 1);
  return {
    totalCapital,
    minimumInitialAllocation: positive(trade.minimumInitialAllocation, 10_000),
    maxOpenPositions: trade.autoPositionBreadth === false
      ? integer(trade.maxOpenPositions, adaptivePositionCount(totalCapital))
      : adaptivePositionCount(totalCapital),
    maxPositionPct,
    riskPerTradePct,
    initialMaxPositionPct: Math.min(positive(trade.initialMaxPositionPct, 7.5), maxPositionPct),
    initialRiskPct: Math.min(positive(trade.initialRiskPct, 0.7), riskPerTradePct),
    maxPortfolioRiskPct: positive(trade.maxPortfolioRiskPct, 6),
    maxSectorExposurePct: positive(trade.maxSectorExposurePct, 25),
    minimumStopPct: positive(trade.minimumStopPct, 1.5),
    maximumStopPct: positive(trade.maximumStopPct, 8),
    partialExitPct: positive(trade.partialExitPct, 50),
    partialProfitR: positive(trade.partialProfitR, 2),
    partialWeaknessConfirmationCloses: integer(trade.partialWeaknessConfirmationCloses, 3),
    minimumManagementCloses: integer(trade.minimumManagementCloses, 5),
    severeWeaknessConfirmationCloses: integer(trade.severeWeaknessConfirmationCloses, 2),
    trailingStopConfirmationCloses: integer(trade.trailingStopConfirmationCloses, 2),
    dailyLongRsConfirmationCloses: integer(trade.dailyLongRsConfirmationCloses, 2),
    dailyLongRsHardExitThreshold: negative(trade.dailyLongRsHardExitThreshold, -0.1),
    rotationMinRankAdvantage: positive(trade.rotationMinRankAdvantage, 15),
    rotationMinimumHoldingDays: integer(trade.rotationMinimumHoldingDays, 5),
    rotationConfirmationCloses: integer(trade.rotationConfirmationCloses, 3),
    rotationCooldownCloses: integer(trade.rotationCooldownCloses, 3),
    rotationCandidateConfirmationCloses: integer(trade.rotationCandidateConfirmationCloses, 2),
    candidateMaxWaitDays: integer(trade.candidateMaxWaitDays, 30),
    candidateMaxRunupPct: positive(trade.candidateMaxRunupPct, 8),
    candidateMaxExecutionGapPct: positive(trade.candidateMaxExecutionGapPct, 3),
    candidateMaxSupertrendDistancePct: positive(trade.candidateMaxSupertrendDistancePct, 7),
    candidateMaxAtrExtension: positive(trade.candidateMaxAtrExtension, 3),
    candidateMaxRankDecay: positive(trade.candidateMaxRankDecay, 15),
    pyramidingEnabled: trade.pyramidingEnabled !== false,
    controlledRetestEnabled: trade.controlledRetestEnabled !== false,
    controlledRetestAddMaxPct: positive(trade.controlledRetestAddMaxPct, 2.5),
    controlledRetestAddRiskPct: positive(trade.controlledRetestAddRiskPct, 0.3),
    controlledRetestMaxPositionPct: positive(trade.controlledRetestMaxPositionPct, 10),
    controlledRetestMinDrawdownR: positive(trade.controlledRetestMinDrawdownR, 0.25),
    controlledRetestMaxDrawdownR: positive(trade.controlledRetestMaxDrawdownR, 0.75),
    pyramidMaxAddOns: integer(trade.pyramidMaxAddOns, 2),
    pyramidMaxPositionPct: positive(trade.pyramidMaxPositionPct, 15),
    pyramidAddMaxPct: positive(trade.pyramidAddMaxPct, 2.5),
    pyramidAddRiskPct: positive(trade.pyramidAddRiskPct, 0.5),
    pyramidMinimumRewardR: positive(trade.pyramidMinimumRewardR, 1),
    pyramidMinimumAdvancePct: positive(trade.pyramidMinimumAdvancePct, 2),
    pyramidPullbackMinPct,
    pyramidPullbackMaxPct: Math.max(
      pyramidPullbackMinPct,
      positive(trade.pyramidPullbackMaxPct, 15)
    ),
    marketRiskMode: config.marketContext?.riskMode || "UNRESTRICTED",
    marketExposureCapPct: positive(config.marketContext?.exposureCapPct, 100)
  };
}

export function candidateRank(row = {}) {
  const gradePoints = { "A+": 100, A: 85, B: 68, C: 48, WATCH: 25 };
  const setup = row.setupStrength || {};
  const checks = setup.checks || {};
  const values = setup.values || {};
  const coverage = row.conceptCoverage || {};
  const institutional = row.institutionalContext || {};
  const gtf = row.gtfContext || {};
  const coverageRatio = coverage.applicable > 0 ? coverage.passed / coverage.applicable : 0;
  const styleBonus = [
    "RETRACEMENT_BUY",
    "BREAKOUT_BUY",
    "BREAKOUT_RECLAIM_BUY",
    "WEEKLY_TREND_RECLAIM"
  ].includes(row.entryStyle?.type) ? 8 : 3;
  const rsPoints =
    clamp((Number(row.weeklyRs) || 0) * 35, -10, 25) +
    clamp((Number(row.dailyLongRs) || 0) * 30, -8, 18) +
    clamp((Number(row.dailyShortRs) || 0) * 20, -5, 10);
  const trendPoints = [
    checks.weeklyRsRising,
    checks.dailyLongRsRising,
    checks.weeklyCloseAboveEma13,
    checks.weeklyEma13Rising,
    checks.closeAboveSmaFast,
    checks.closeAboveSmaSlow,
    checks.smaFastAboveSlow,
    checks.volumeExpansion,
    checks.bullishCandleConfirmation,
    row.sectorStrength?.ok,
    checks.marketRegimeStrong
  ].filter(Boolean).length * 2;
  const riskPenalty =
    (Number(values.atrPct) > 6 ? 6 : 0) +
    (Number(values.riskToSupertrendPct) > 8 ? 6 : 0) +
    (checks.weeklyCloseAboveEma13 === false && Number.isFinite(Number(values.weeklyEma13)) ? 8 : 0) +
    (coverage.dataGaps || 0) * 1.5;
  const fundamentalChecks = Object.values(row.fundamental?.checks || {});
  const fundamentalFailures = fundamentalChecks.filter((check) => check?.ok === false).length;
  const fundamentalEvidence = fundamentalChecks.filter((check) => check?.ok === true || check?.ok === false).length;
  const fundamentalPenalty = fundamentalEvidence >= 3 ? fundamentalFailures * 1.5 : 0;

  return round(
    (gradePoints[String(row.setupGrade || "").toUpperCase()] || 0) +
      (Number(row.setupStrengthScore) || 0) * 1.5 +
      (Number(row.fundamentalScore) || 0) * 3 -
      fundamentalPenalty +
      clamp(Number(row.aiScore) || 0, -2, 2) * 2 +
      (Number(institutional.score) || 0) * 3 +
      (Number(gtf.rankAdjustment) || 0) +
      coverageRatio * 20 +
      rsPoints +
      trendPoints +
      styleBonus -
      riskPenalty
  );
}

export function structuralStop(row = {}, price, config = {}) {
  const rules = portfolioConfig(config);
  const values = row.setupStrength?.values || {};
  const closestAllowed = price * (1 - rules.minimumStopPct / 100);
  const furthestAllowed = price * (1 - rules.maximumStopPct / 100);
  const candidates = [
    row.dailySupertrend,
    values.fourCandleLow,
    values.twoCandleLow,
    values.fibonacciSupportNearby ? values.fibonacciNearestPrice : null
  ].filter((value) => Number.isFinite(value) && value > 0 && value < price);
  const breakoutStyle = [
    "BREAKOUT_BUY",
    "BREAKOUT_RECLAIM_BUY",
    "WEEKLY_TREND_RECLAIM"
  ].includes(row.entryStyle?.type);
  const breakoutSupports = [
    row.dailySupertrend,
    row.weeklyEma13
  ].filter((value) =>
    Number.isFinite(value) && value >= furthestAllowed && value < price
  );
  const raw = breakoutStyle && breakoutSupports.length
    ? Math.min(...breakoutSupports)
    : candidates.length
      ? Math.max(...candidates)
      : price * (1 - rules.maximumStopPct / 100);
  return round(Math.min(closestAllowed, Math.max(furthestAllowed, raw)));
}

export function buildPositionPlan(row, price, portfolio = {}, config = {}) {
  const rules = portfolioConfig(config);
  const stopPrice = structuralStop(row, price, rules);
  const riskPerShare = Number.isFinite(stopPrice) ? price - stopPrice : null;
  const maxAllocation = rules.totalCapital * rules.initialMaxPositionPct / 100;
  const riskBudget = rules.totalCapital * rules.initialRiskPct / 100;
  const availableCash = Math.max(0, Number(portfolio.availableCash) || 0);
  const availableRisk = Math.max(0, Number(portfolio.availableRisk) || 0);
  const sector = normalizedSector(row.industry);
  const sectorClassified = sector !== "Unclassified";
  const sectorUsed = Number(portfolio.sectorExposure?.[sector]) || 0;
  const sectorLimit = sectorClassified
    ? rules.totalCapital * rules.maxSectorExposurePct / 100
    : rules.totalCapital;
  const sectorAvailable = Math.max(0, sectorLimit - sectorUsed);
  const allocationBudget = Math.min(maxAllocation, availableCash, sectorAvailable);
  const riskCapacity = Math.min(riskBudget, availableRisk);
  const quantityByCapital = Number.isFinite(price) && price > 0
    ? Math.floor(allocationBudget / price)
    : 0;
  const quantityByRisk = Number.isFinite(riskPerShare) && riskPerShare > 0
    ? Math.floor(riskCapacity / riskPerShare)
    : 0;
  const quantity = Math.max(0, Math.min(quantityByCapital, quantityByRisk));
  const allocation = quantity * price;
  const plannedRisk = quantity * riskPerShare;
  const minimumAllocationMet = allocation >= rules.minimumInitialAllocation;
  let reason = "Staged initial-entry risk and capital limits allow entry.";
  if ((Number(portfolio.openSlots) || 0) <= 0) reason = "Maximum open-position limit reached.";
  else if (availableCash < price) reason = "Available portfolio cash is insufficient.";
  else if (sectorAvailable < price) reason = `Sector exposure limit reached for ${sector}.`;
  else if (availableRisk < riskPerShare) reason = "Maximum aggregate portfolio risk reached.";
  else if (quantity < 1) reason = "Risk-sized quantity is below one share.";
  else if (!minimumAllocationMet) {
    reason = `Planned investment Rs ${round(allocation)} is below the minimum initial buy value Rs ${round(rules.minimumInitialAllocation)}; residual cash or sector capacity is not used for an uneconomical tiny position.`;
  }

  return {
    eligible: quantity > 0 && minimumAllocationMet && (Number(portfolio.openSlots) || 0) > 0,
    quantity,
    allocation: round(allocation),
    stopPrice,
    stopDistancePct: round((price - stopPrice) / price * 100),
    riskPerShare: round(riskPerShare),
    plannedRisk: round(plannedRisk),
    riskBudget: round(riskBudget),
    minimumInitialAllocation: round(rules.minimumInitialAllocation),
    maxAllocation: round(maxAllocation),
    sector,
    sectorUsed: round(sectorUsed),
    sectorLimit: round(sectorLimit),
    rank: candidateRank(row),
    reason
  };
}

export function portfolioSummary(trades = [], candidates = [], config = {}) {
  const rules = portfolioConfig(config);
  const active = trades.filter(isFilledHolding);
  const proposedEntries = trades.filter((trade) => trade.status === "PENDING_ENTRY");
  const pendingEntries = proposedEntries.filter(isConfirmedPendingEntry);
  const investedCapital = active.reduce(
    (sum, trade) => sum + (Number(trade.investedValue) || 0),
    0
  );
  const pendingAddCapital = active.reduce(
    (sum, trade) => sum + (isConfirmedPendingAdd(trade) ? Number(trade.pendingAdd?.plannedAllocation) || 0 : 0),
    0
  );
  const reservedCapital = pendingEntries.reduce(
    (sum, trade) => sum + (Number(trade.plannedAllocation) || Number(trade.investedValue) || 0),
    0
  ) + pendingAddCapital;
  const realizedPnl = totalRealizedPnl(trades);
  const unrealizedPnl = active.reduce(
    (sum, trade) => sum + (Number(trade.unrealizedPnl) || 0),
    0
  );
  const charges = portfolioChargeSummary(trades);
  const grossRealizedPnl = realizedPnl + charges.realizedCharges;
  const dividendPnl = round(trades.reduce((sum, trade) => sum + (Number(trade.dividendRealizedPnl) || 0), 0));
  const portfolioRisk =
    active.reduce((sum, trade) => sum + remainingTradeRisk(trade), 0) +
    pendingEntries.reduce((sum, trade) => sum + (Number(trade.plannedRisk) || 0), 0) +
    active.reduce((sum, trade) => sum + (isConfirmedPendingAdd(trade) ? Number(trade.pendingAdd?.plannedRisk) || 0 : 0), 0);
  const riskLimit = rules.totalCapital * rules.maxPortfolioRiskPct / 100;
  const deployedCapital = investedCapital + charges.openBuyCharges;
  const actualCash = Math.max(
    0,
    rules.totalCapital + realizedPnl - deployedCapital
  );
  const totalEquity = rules.totalCapital + realizedPnl + unrealizedPnl;
  const drawdownPct = Math.max(0, ((rules.totalCapital - totalEquity) / rules.totalCapital) * 100);
  const drawdownExposureCapPct = drawdownPct >= 8 ? 0 : drawdownPct >= 5 ? 50 : 100;
  const effectiveExposureCapPct = Math.min(
    rules.marketExposureCapPct,
    drawdownExposureCapPct
  );
  const exposureLimit = rules.totalCapital * effectiveExposureCapPct / 100;
  const exposureRoom = Math.max(0, exposureLimit - deployedCapital - reservedCapital);
  const availableCash = Math.min(Math.max(0, actualCash - reservedCapital), exposureRoom);
  const sectorExposure = {};
  for (const trade of [...active, ...pendingEntries]) {
    const sector = normalizedSector(trade.industry || trade.entrySnapshot?.industry);
    sectorExposure[sector] =
      (sectorExposure[sector] || 0) +
      (Number(trade.investedValue) || Number(trade.plannedAllocation) || 0) +
      (isConfirmedPendingAdd(trade) ? Number(trade.pendingAdd?.plannedAllocation) || 0 : 0);
  }

  return {
    totalCapital: round(rules.totalCapital),
    investedCapital: round(investedCapital),
    reservedCapital: round(reservedCapital),
    deployedCapital: round(deployedCapital),
    committedCapital: round(deployedCapital + reservedCapital),
    availableCash: round(availableCash),
    actualCash: round(actualCash),
    realizedPnl: round(realizedPnl),
    tradeRealizedPnl: round(realizedPnl - dividendPnl),
    dividendRealizedPnl: dividendPnl,
    grossRealizedPnl: round(grossRealizedPnl),
    unrealizedPnl: round(unrealizedPnl),
    chargesEnabled: config.trade?.chargesEnabled === true,
    actualCharges: round(charges.actualCharges),
    realizedCharges: round(charges.realizedCharges),
    openBuyCharges: round(charges.openBuyCharges),
    estimatedExitCharges: round(charges.estimatedExitCharges),
    totalEquity: round(totalEquity),
    unrealizedPnlPct: investedCapital > 0 ? round(unrealizedPnl / investedCapital * 100) : 0,
    drawdownPct: round(drawdownPct),
    marketRiskMode: rules.marketRiskMode,
    marketExposureCapPct: round(rules.marketExposureCapPct),
    drawdownExposureCapPct: round(drawdownExposureCapPct),
    effectiveExposureCapPct: round(effectiveExposureCapPct),
    exposureLimit: round(exposureLimit),
    portfolioRisk: round(portfolioRisk),
    portfolioRiskPct: round(portfolioRisk / rules.totalCapital * 100),
    riskLimit: round(riskLimit),
    availableRisk: round(Math.max(0, riskLimit - portfolioRisk)),
    openPositions: active.length,
    pendingEntries: pendingEntries.length,
    proposedEntries: proposedEntries.length,
    pendingAdds: active.filter(isConfirmedPendingAdd).length,
    openSlots: Math.max(0, rules.maxOpenPositions - active.length - pendingEntries.length),
    maxOpenPositions: rules.maxOpenPositions,
    capitalUtilizationPct: round(deployedCapital / rules.totalCapital * 100),
    committedCapitalPct: round((deployedCapital + reservedCapital) / rules.totalCapital * 100),
    overallocatedCapital: round(Math.max(0, deployedCapital - rules.totalCapital)),
    waitingCandidates: candidates.length,
    sectorExposure
  };
}

export function breakoutContinuationState(row = {}) {
  const checks = row.setupStrength?.checks || {};
  const values = row.setupStrength?.values || {};
  const base = checks.baseBreakout === true && checks.higherLowStructure === true;
  const recent = checks.recentHighBreakout === true;
  const yearly = checks.yearHighBreakout === true;
  return {
    breakout: base || recent || yearly,
    type: yearly ? "52_WEEK_BREAKOUT" : recent ? "55_DAY_BREAKOUT" : base ? "20_DAY_BASE_BREAKOUT" : null,
    level: yearly ? values.priorYearHigh : recent ? values.priorRecentHigh : base ? values.priorBaseHigh : null
  };
}

export function totalRealizedPnl(trades = []) {
  return round(trades.reduce((sum, trade) => {
    if (trade.status === "CLOSED") return sum + (Number(trade.pnl) || 0);
    return sum + (Number(trade.realizedPnlToDate) || 0);
  }, 0));
}

export function candidateEntryDecision(candidate = {}, row = {}, config = {}, options = {}) {
  const rules = portfolioConfig(config);
  const values = row.setupStrength?.values || {};
  const checks = row.setupStrength?.checks || {};
  const currentRank = candidateRank(row);
  const firstSignalClose = Number(candidate.firstSignalClose ?? candidate.signalClose);
  const currentClose = Number(row.close);
  const executionPrice = Number(options.executionPrice);
  const referencePrice = Number.isFinite(executionPrice) ? executionPrice : currentClose;
  const peakRank = Number(candidate.peakRank ?? candidate.rank ?? currentRank);
  const signalAgeDays = calendarDays(candidate.firstSignalDate, row.asOf);
  const runupPct =
    Number.isFinite(firstSignalClose) && firstSignalClose > 0 && Number.isFinite(referencePrice)
      ? (referencePrice - firstSignalClose) / firstSignalClose * 100
      : null;
  const executionGapPct =
    Number.isFinite(executionPrice) && Number.isFinite(currentClose) && currentClose > 0
      ? (executionPrice - currentClose) / currentClose * 100
      : null;
  const supertrendDistancePct =
    Number.isFinite(referencePrice) && referencePrice > 0 && Number.isFinite(Number(row.dailySupertrend))
      ? (referencePrice - Number(row.dailySupertrend)) / referencePrice * 100
      : Number(values.riskToSupertrendPct);
  const atrExtension =
    Number.isFinite(referencePrice) &&
    Number.isFinite(Number(values.smaFast)) &&
    Number.isFinite(Number(values.atr)) &&
    Number(values.atr) > 0
      ? Math.max(0, (referencePrice - Number(values.smaFast)) / Number(values.atr))
      : null;
  const rankDecay = Math.max(0, peakRank - currentRank);
  const confirmedEntryCloses = new Set(candidate.entryCloseDates || []).size;
  const reasons = [];
  const warnings = [];
  let disposition = "ACTIONABLE";

  if (row.status !== "ENTRY") {
    reasons.push(`Latest completed-candle status is ${row.status || "unavailable"}, not ENTRY.`);
    disposition = "EXPIRED";
  }
  if (options.qualityPass === false) {
    reasons.push(`Current setup grade ${row.setupGrade || "NA"} no longer passes the selected trade-quality filter.`);
    disposition = "EXPIRED";
  }
  if (checks.liquidEnough === false) {
    reasons.push(
      `Automated entry is blocked because 20-day average turnover Rs ${round(values.averageTurnover)} is below the compulsory liquidity standard; execution and exit costs are not reliable enough.`
    );
    if (disposition === "ACTIONABLE") disposition = "WAITING_RECONFIRMATION";
  }
  if (row.exchangeFallback === true) {
    reasons.push(
      `Automated entry is blocked because requested ${row.requestedYahooSymbol || "NSE symbol"} resolved only through ${row.yahooSymbol || row.resolvedYahooSymbol || "a cross-exchange fallback"}; exchange-consistent live and 09:17 execution coverage is required.`
    );
    if (disposition === "ACTIONABLE") disposition = "WAITING_RECONFIRMATION";
  }
  if (signalAgeDays > rules.candidateMaxWaitDays) {
    warnings.push(
      `Candidate has waited ${signalAgeDays} days; age is informational because the latest completed close still decides entry validity.`
    );
  }
  if (Number.isFinite(runupPct) && runupPct > rules.candidateMaxRunupPct) {
    warnings.push(
      `Price is ${round(runupPct)}% above the first signal close; this is informational and does not block entry while current structure and execution risk remain valid.`
    );
  }
  if (
    Number.isFinite(supertrendDistancePct) &&
    (supertrendDistancePct < 0 || supertrendDistancePct > rules.candidateMaxSupertrendDistancePct)
  ) {
    if (supertrendDistancePct < 0) {
      reasons.push("Current/09:17 price is below daily Supertrend.");
      if (disposition === "ACTIONABLE") disposition = "WAITING_RECONFIRMATION";
    } else {
      warnings.push(
        `Price is ${round(supertrendDistancePct)}% above Supertrend; extension is recorded but does not override a valid current ENTRY.`
      );
    }
  }
  if (Number.isFinite(atrExtension) && atrExtension > rules.candidateMaxAtrExtension) {
    warnings.push(
      `Price is ${round(atrExtension)} ATR above the 50-DMA; extension is recorded but does not override a valid current ENTRY.`
    );
  }
  if (rankDecay > rules.candidateMaxRankDecay) {
    warnings.push(`Candidate rank deteriorated ${round(rankDecay)} points from its waiting-period peak.`);
  }
  if (row.institutionalContext?.operator?.distribution) {
    warnings.push("Latest official NSE delivery context shows distribution; this remains additional evidence, not a compulsory entry override.");
  }
  if (row.weeklyPriceAboveEma13 === false) {
    warnings.push(
      `Completed weekly close ${round(row.weeklyClose)} is below low-source EMA13 ${round(row.weeklyEma13)}; fresh entry requires extra caution until a weekly reclaim.`
    );
  }
  if (
    Number.isFinite(executionGapPct) &&
    executionGapPct > rules.candidateMaxExecutionGapPct
  ) {
    warnings.push(
      `Actual 09:17 price is ${round(executionGapPct)}% above the signal close; the gap is informational while latest ENTRY, Supertrend structure and actual-price position sizing remain valid.`
    );
  }
  if (options.forRotation) {
    if (confirmedEntryCloses < rules.rotationCandidateConfirmationCloses) {
      reasons.push(
        `Rotation requires ${rules.rotationCandidateConfirmationCloses} distinct valid ENTRY closes; candidate has ${confirmedEntryCloses}.`
      );
      if (disposition === "ACTIONABLE") disposition = "WAITING_CONFIRMATION";
    }
    if (checks.marketRegimeStrong !== true) {
      reasons.push("Broad-market regime is not strong enough to justify an optional quality rotation.");
      if (disposition === "ACTIONABLE") disposition = "WAITING_CONFIRMATION";
    }
    if (row.weeklyPriceAboveEma13 === false) {
      reasons.push("Optional rotation is blocked because the completed weekly candle is below low-source EMA13.");
      if (disposition === "ACTIONABLE") disposition = "WAITING_CONFIRMATION";
    }
  }

  return {
    actionable: reasons.length === 0,
    disposition,
    reasons,
    warnings,
    metrics: {
      signalAgeDays,
      firstSignalClose: Number.isFinite(firstSignalClose) ? round(firstSignalClose) : null,
      currentClose: Number.isFinite(currentClose) ? round(currentClose) : null,
      executionPrice: Number.isFinite(executionPrice) ? round(executionPrice) : null,
      runupPct: round(runupPct),
      executionGapPct: round(executionGapPct),
      supertrendDistancePct: round(supertrendDistancePct),
      atrExtension: round(atrExtension),
      currentRank,
      peakRank: round(peakRank),
      rankDecay: round(rankDecay),
      confirmedEntryCloses
    }
  };
}

export function postEntryPyramidState(trade = {}, row = {}, config = {}) {
  const rules = portfolioConfig(config);
  const structure = row.pyramidStructure || row.setupStrength?.pyramidStructure || {};
  const points = Array.isArray(structure.points)
    ? structure.points
        .filter((point) => point?.date && ["HIGH", "LOW"].includes(point.type) && Number.isFinite(Number(point.price)))
        .map((point) => ({ ...point, date: dateOnly(point.date), price: Number(point.price) }))
        .sort((a, b) => a.date.localeCompare(b.date))
    : [];
  const anchorDate = dateOnly(trade.lastAddDate || trade.entryDate || trade.entrySignalDate);
  const anchorPrice = Number(trade.lastAddPrice || trade.initialEntryPrice || trade.entryPrice);
  const latestDate = dateOnly(row.asOf || structure.latestDate);
  const close = Number(row.close ?? structure.latestClose);
  const previousClose = Number(structure.previousClose);
  const initialStructureStop = Number(trade.initialStopPrice);
  const baseState = {
    breakout: false,
    setupReady: false,
    type: "POST_ENTRY_PULLBACK_SWING_HIGH_CLOSE_BREAK",
    level: null,
    anchorDate: anchorDate || null,
    anchorPrice: Number.isFinite(anchorPrice) ? round(anchorPrice) : null,
    swingHighDate: null,
    pullbackLowDate: null,
    pullbackLow: null,
    pullbackDepthPct: null,
    advancePct: null,
    previousClose: Number.isFinite(previousClose) ? round(previousClose) : null
  };

  if (!anchorDate || !Number.isFinite(anchorPrice) || !Number.isFinite(close)) return baseState;
  const postAnchor = points.filter((point) => point.date > anchorDate && (!latestDate || point.date < latestDate));
  const highs = postAnchor.filter((point) => point.type === "HIGH").reverse();

  for (const high of highs) {
    const advancePct = (high.price - anchorPrice) / anchorPrice * 100;
    if (advancePct < rules.pyramidMinimumAdvancePct) continue;
    const lows = postAnchor
      .filter((point) => point.type === "LOW" && point.date > high.date)
      .reverse();
    for (const low of lows) {
      const pullbackDepthPct = (high.price - low.price) / high.price * 100;
      const pullbackValid =
        pullbackDepthPct >= rules.pyramidPullbackMinPct &&
        pullbackDepthPct <= rules.pyramidPullbackMaxPct;
      const initialStructureIntact =
        !Number.isFinite(initialStructureStop) || low.price > initialStructureStop;
      if (!pullbackValid || !initialStructureIntact) continue;

      return {
        ...baseState,
        breakout:
          Boolean(latestDate && latestDate > low.date) &&
          Number.isFinite(previousClose) &&
          previousClose <= high.price &&
          close > high.price,
        setupReady: true,
        level: round(high.price),
        swingHighDate: high.date,
        pullbackLowDate: low.date,
        pullbackLow: round(low.price),
        pullbackDepthPct: round(pullbackDepthPct),
        advancePct: round(advancePct)
      };
    }
  }

  return baseState;
}

export function controlledRetestAddDecision(trade, row, portfolio = {}, config = {}) {
  const rules = portfolioConfig(config);
  const checks = row?.setupStrength?.checks || {};
  const values = row?.setupStrength?.values || {};
  const close = Number(row?.close);
  const initialEntry = Number(trade?.initialEntryPrice || trade?.entryPrice);
  const initialStop = Number(trade?.initialStopPrice);
  const initialRiskPerShare = initialEntry - initialStop;
  const drawdownR = initialRiskPerShare > 0 ? (initialEntry - close) / initialRiskPerShare : null;
  const retestAdds = controlledRetestAdds(trade);
  const winnerAdds = winnerPyramidAdds(trade);
  const entryFundamental = Number(trade?.entrySnapshot?.fundamentalScore);
  const currentFundamental = Number(row?.fundamentalScore);
  const fundamentalDeteriorated =
    Number.isFinite(entryFundamental) &&
    Number.isFinite(currentFundamental) &&
    entryFundamental - currentFundamental >= 2 &&
    currentFundamental <= 2;
  const gtfChecks = row?.gtfContext?.checks || {};
  const gtfDemandConfidence = Boolean(
    gtfChecks.dailyDemandQualified === true ||
    gtfChecks.weeklyDemandQualified === true ||
    gtfChecks.demandRetest === true ||
    gtfChecks.reactingFromHtf === true ||
    row?.gtfContext?.reactingFromHtf?.active === true
  );
  const reasons = [];

  if (!rules.controlledRetestEnabled) reasons.push("Controlled retest adds are disabled.");
  if (trade?.status !== "OPEN") reasons.push("Only an open position can receive a controlled retest add.");
  if (trade?.pendingAdd) reasons.push("Another add order is already pending.");
  if (retestAdds.length >= 1) reasons.push("The one permitted controlled retest add has already been used.");
  if (winnerAdds.length > 0) reasons.push("A controlled retest add cannot be introduced after winner pyramiding has started.");
  if (!row?.asOf || dateOnly(row.asOf) <= dateOnly(trade?.entryDate)) {
    reasons.push("Retest confirmation must occur on a completed close after the initial fill date.");
  }
  if (row?.status !== "ENTRY") reasons.push("All compulsory entry conditions are no longer valid.");
  if (!['A+', 'A'].includes(String(row?.setupGrade || '').toUpperCase())) {
    reasons.push("Current setup is below A grade.");
  }
  if (!(Number(row?.weeklyRsi) > 50 && Number(row?.dailyRsi) > 50)) {
    reasons.push("Weekly and daily RSI must both remain above 50.");
  }
  if (!(Number(row?.weeklyRs) > 0 && Number(row?.dailyLongRs) > 0 && Number(row?.dailyShortRs) > 0)) {
    reasons.push("Weekly RS, daily RS55 and daily RS21 must all remain above zero.");
  }
  if (!(Number(row?.close) > Number(row?.dailySupertrend))) {
    reasons.push("Daily close must remain above Supertrend.");
  }
  if (!(Number(row?.weeklyClose) > Number(row?.weeklyEma13))) {
    reasons.push("Completed weekly close must remain above weekly EMA13 (Low source).");
  }
  if (!(close < initialEntry)) reasons.push("Retest price is not below the initial fill, so no averaging benefit exists.");
  if (!Number.isFinite(drawdownR) || drawdownR < rules.controlledRetestMinDrawdownR) {
    reasons.push(`Pullback has not reached the planned ${rules.controlledRetestMinDrawdownR}R retest depth.`);
  }
  if (Number.isFinite(drawdownR) && drawdownR > rules.controlledRetestMaxDrawdownR) {
    reasons.push(`Pullback exceeds the safe ${rules.controlledRetestMaxDrawdownR}R retest limit.`);
  }
  if (checks.retracementBuyZone !== true) {
    reasons.push("Support, controlled volume and bullish reclaim-candle confirmation are not complete.");
  }
  if (checks.marketRegimeStrong !== true || rules.marketRiskMode === "RISK_OFF") {
    reasons.push("Broad-market regime is not supportive for averaging exposure.");
  }
  if (row?.sectorStrength?.ok === false) reasons.push("Sector breadth is weak.");
  if (row?.gtfContext?.supplyBlocked) reasons.push("Fresh GTF opposing supply blocks the retest add.");
  if (row?.institutionalContext?.operator?.distribution) {
    reasons.push("Official NSE delivery evidence shows distribution.");
  }
  if (checks.liquidEnough === false) reasons.push("Compulsory liquidity is insufficient.");
  if (row?.exchangeFallback === true) reasons.push("Cross-exchange fallback data cannot authorize an automated add.");
  if (fundamentalDeteriorated) reasons.push("Material fundamental deterioration blocks additional exposure.");

  const state = {
    type: "CONTROLLED_RETEST_RECLAIM",
    eligible: reasons.length === 0,
    drawdownR: round(drawdownR),
    initialEntry: round(initialEntry),
    initialStop: round(initialStop),
    supportSource: values.retracementSupportSource || null,
    supportReference: round(Number(values.retracementSupportReference)),
    pullbackDepthPct: round(Number(values.retracementPullbackDepthPct)),
    pullbackVolumeRatio: round(Number(values.retracementPullbackVolumeRatio)),
    reclaimCloseLocationPct: round(Number(values.retracementCloseLocationPct)),
    gtfDemandConfidence,
    confidenceGrade: gtfDemandConfidence ? "HIGH_GTF_CONFLUENCE" : "CORE_RETEST_CONFIRMED"
  };
  if (reasons.length) return { eligible: false, reasons, state };

  const plan = buildControlledRetestAddPlan(trade, row, close, portfolio, rules);
  return {
    ...plan,
    eligible: plan.eligible,
    state,
    reasons: plan.eligible ? [
      `Controlled retest confirmed at ${round(drawdownR)}R below the initial fill while every compulsory weekly and daily entry rule remains valid.`,
      `Support/reclaim confirmation is active${state.supportSource ? ` near ${state.supportSource}` : ""}; the add is not placed while price is falling.`,
      gtfDemandConfidence
        ? "GTF confidence is high: a qualified demand-zone/retest or higher-timeframe demand reaction supports the averaging entry."
        : "GTF demand-zone confirmation is not present; sizing remains conservative and relies on the compulsory reclaim structure.",
      "This is the single permitted retest tranche; total position risk remains capped at 1% and the structural stop is never widened."
    ] : [plan.reason]
  };
}

export function buildControlledRetestAddPlan(trade, row, price, portfolio = {}, config = {}) {
  const rules = portfolioConfig(config);
  const stop = Math.max(
    Number(trade?.initialStopPrice) || 0,
    Number(trade?.trailingStopPrice) || 0
  );
  const riskPerShare = Number(price) - stop;
  const initialEntry = Number(trade?.initialEntryPrice || trade?.entryPrice);
  const currentAllocation = Number(trade?.investedValue) || 0;
  const maximumPositionAllocation = rules.totalCapital * rules.controlledRetestMaxPositionPct / 100;
  const addAllocationCap = rules.totalCapital * rules.controlledRetestAddMaxPct / 100;
  const positionCapacity = Math.max(0, maximumPositionAllocation - currentAllocation);
  const availableCash = Math.max(0, Number(portfolio.availableCash) || 0);
  const sector = normalizedSector(row?.industry || trade?.industry);
  const sectorClassified = sector !== "Unclassified";
  const sectorUsed = Number(portfolio.sectorExposure?.[sector]) || 0;
  const sectorLimit = sectorClassified
    ? rules.totalCapital * rules.maxSectorExposurePct / 100
    : rules.totalCapital;
  const sectorCapacity = Math.max(0, sectorLimit - sectorUsed);
  const allocationBudget = Math.min(addAllocationCap, positionCapacity, availableCash, sectorCapacity);
  const existingTradeRisk = remainingTradeRisk(trade);
  const totalTradeRiskCapacity = Math.max(
    0,
    rules.totalCapital * rules.riskPerTradePct / 100 - existingTradeRisk
  );
  const incrementalRiskCapacity = rules.totalCapital * rules.controlledRetestAddRiskPct / 100;
  const availablePortfolioRisk = Math.max(0, Number(portfolio.availableRisk) || 0);
  const riskCapacity = Math.min(incrementalRiskCapacity, totalTradeRiskCapacity, availablePortfolioRisk);
  const quantityByCapital = Number.isFinite(price) && price > 0
    ? Math.floor(allocationBudget / price)
    : 0;
  const quantityByRisk = Number.isFinite(riskPerShare) && riskPerShare > 0
    ? Math.floor(riskCapacity / riskPerShare)
    : 0;
  const quantity = Math.max(0, Math.min(quantityByCapital, quantityByRisk));
  const allocation = quantity * price;
  const plannedRisk = quantity * riskPerShare;
  const minimumAllocationMet = allocation >= rules.minimumInitialAllocation;
  let reason = "Cash, sector and combined 1% stock-risk limits allow one controlled retest add.";
  if (!(Number(price) < initialEntry)) reason = "Actual 09:17 price no longer improves the initial average; retest add skipped.";
  else if (!Number.isFinite(riskPerShare) || riskPerShare <= 0) reason = "Actual price is at or below the protected stop; add skipped.";
  else if (positionCapacity < price) reason = "Position has reached its 10% initial-plus-retest cap.";
  else if (availableCash < price) reason = "Available portfolio cash is insufficient for the retest add.";
  else if (sectorCapacity < price) reason = `Sector exposure limit reached for ${sector}.`;
  else if (availablePortfolioRisk < riskPerShare) reason = "Aggregate portfolio-risk room is insufficient.";
  else if (totalTradeRiskCapacity < riskPerShare) reason = "Combined position risk would exceed the 1% stock-risk cap.";
  else if (quantity < 1) reason = "Risk-sized retest quantity is below one share.";
  else if (!minimumAllocationMet) {
    reason = `Planned retest add Rs ${round(allocation)} is below the minimum order value Rs ${round(rules.minimumInitialAllocation)}.`;
  }

  return {
    eligible: Number(price) < initialEntry && quantity > 0 && minimumAllocationMet,
    kind: "CONTROLLED_RETEST",
    quantity,
    allocation: round(allocation),
    plannedRisk: round(plannedRisk),
    riskPerShare: round(riskPerShare),
    trailingStop: round(stop),
    maximumPositionAllocation: round(maximumPositionAllocation),
    addAllocationCap: round(addAllocationCap),
    minimumInitialAllocation: round(rules.minimumInitialAllocation),
    sector,
    rank: candidateRank(row),
    reason
  };
}

export function pyramidAddDecision(trade, row, portfolio = {}, config = {}) {
  const rules = portfolioConfig(config);
  const checks = row?.setupStrength?.checks || {};
  const values = row?.setupStrength?.values || {};
  const breakout = postEntryPyramidState(trade, row, config);
  const close = Number(row?.close);
  const entry = Number(trade?.entryPrice);
  const stop = Number(trade?.trailingStopPrice || trade?.initialStopPrice);
  const initialRiskPerShare = Math.max(
    0,
    Number(trade?.initialEntryPrice || entry) - Number(trade?.initialStopPrice)
  );
  const rewardR = initialRiskPerShare > 0 ? (close - entry) / initialRiskPerShare : null;
  const reasons = [];

  if (!rules.pyramidingEnabled) reasons.push("Winner pyramiding is disabled.");
  if (trade?.status !== "OPEN") reasons.push("Only an open position can be scaled up.");
  if (trade?.pendingAdd) reasons.push("An add-on order is already pending.");
  if (winnerPyramidAdds(trade).length >= rules.pyramidMaxAddOns) {
    reasons.push(`Maximum ${rules.pyramidMaxAddOns} add-ons already used.`);
  }
  if (row?.status !== "ENTRY") reasons.push("All compulsory entry conditions are no longer valid.");
  if (!["A+", "A"].includes(String(row?.setupGrade || "").toUpperCase())) {
    reasons.push("Current setup is below A grade.");
  }
  if (!breakout.breakout) {
    reasons.push(
      breakout.setupReady
        ? `Post-entry pullback is ready, but price has not freshly closed above swing high ${round(breakout.level)}.`
        : "No confirmed post-entry advance, controlled pullback and swing-high closing-break sequence."
    );
  }
  if (!(close > entry)) reasons.push("Position is not trading above its average cost; averaging down is prohibited.");
  if (!Number.isFinite(rewardR) || rewardR < rules.pyramidMinimumRewardR) {
    reasons.push(`Winner has not reached the required ${rules.pyramidMinimumRewardR}R profit buffer.`);
  }
  if (!Number.isFinite(stop) || stop < entry) {
    reasons.push("Trailing stop has not protected the average entry price yet.");
  }
  if (!(checks.weeklyRsRising && checks.dailyLongRsRising)) {
    reasons.push("Weekly RS and daily RS55 are not both rising.");
  }
  if (checks.marketRegimeStrong !== true) reasons.push("Broad-market regime is not supportive.");
  if (row?.sectorStrength?.ok === false) reasons.push("Sector breadth is weak.");
  if (row?.gtfContext?.supplyBlocked) reasons.push("Fresh GTF opposing supply blocks the add-on.");
  if (row?.institutionalContext?.operator?.distribution) {
    reasons.push("Official NSE delivery data shows distribution; winner add-on is blocked.");
  }
  if (checks.liquidEnough === false) {
    reasons.push("Winner add-on is blocked because compulsory liquidity is insufficient.");
  }
  if (row?.exchangeFallback === true) {
    reasons.push("Winner add-on is blocked because the instrument is using a cross-exchange data fallback.");
  }
  if (
    Number.isFinite(values.riskToSupertrendPct) &&
    values.riskToSupertrendPct > rules.maximumStopPct
  ) {
    reasons.push("Breakout is too extended from Supertrend for favorable risk-reward.");
  }

  if (reasons.length) {
    return { eligible: false, reasons, breakout, rewardR: round(rewardR) };
  }
  const plan = buildPyramidAddPlan(trade, row, close, portfolio, rules);
  return {
    ...plan,
    eligible: plan.eligible,
    reasons: plan.eligible ? [
      `After the ${breakout.anchorDate} fill, price advanced ${round(breakout.advancePct)}%, pulled back ${round(breakout.pullbackDepthPct)}% to ${round(breakout.pullbackLow)} on ${breakout.pullbackLowDate}, then closed at ${round(close)} above the confirmed ${breakout.swingHighDate} swing high ${round(breakout.level)}.`,
      `Winning position is ${round(rewardR)}R above average cost with a protected trailing stop.`,
      "Weekly RS and daily RS55 are rising; compulsory entry, A-grade quality, market and supply checks remain favorable."
    ] : [plan.reason],
    breakout,
    rewardR: round(rewardR)
  };
}

function controlledRetestAdds(trade = {}) {
  return (trade.addOns || []).filter((add) => add?.kind === "CONTROLLED_RETEST");
}

function winnerPyramidAdds(trade = {}) {
  return (trade.addOns || []).filter((add) => add?.kind !== "CONTROLLED_RETEST");
}

function dateOnly(value) {
  return value ? String(value).slice(0, 10) : "";
}

export function buildPyramidAddPlan(trade, row, price, portfolio = {}, config = {}) {
  const rules = portfolioConfig(config);
  const trailingStop = nextTrailingStop(trade, row, rules);
  const riskPerShare = Number(price) - Number(trailingStop);
  const currentAllocation = Number(trade?.investedValue) || 0;
  const maximumPositionAllocation = rules.totalCapital * rules.pyramidMaxPositionPct / 100;
  const addAllocationCap = rules.totalCapital * rules.pyramidAddMaxPct / 100;
  const positionCapacity = Math.max(0, maximumPositionAllocation - currentAllocation);
  const availableCash = Math.max(0, Number(portfolio.availableCash) || 0);
  const sector = normalizedSector(row?.industry || trade?.industry);
  const sectorClassified = sector !== "Unclassified";
  const sectorUsed = Number(portfolio.sectorExposure?.[sector]) || 0;
  const sectorLimit = sectorClassified
    ? rules.totalCapital * rules.maxSectorExposurePct / 100
    : rules.totalCapital;
  const sectorCapacity = Math.max(0, sectorLimit - sectorUsed);
  const allocationBudget = Math.min(
    addAllocationCap,
    positionCapacity,
    availableCash,
    sectorCapacity
  );
  const existingTradeRisk = remainingTradeRisk(trade);
  const totalTradeRiskCapacity = Math.max(
    0,
    rules.totalCapital * rules.riskPerTradePct / 100 - existingTradeRisk
  );
  const incrementalRiskCapacity = rules.totalCapital * rules.pyramidAddRiskPct / 100;
  const availablePortfolioRisk = Math.max(0, Number(portfolio.availableRisk) || 0);
  const riskCapacity = Math.min(
    incrementalRiskCapacity,
    totalTradeRiskCapacity,
    availablePortfolioRisk
  );
  const quantityByCapital = Number.isFinite(price) && price > 0
    ? Math.floor(allocationBudget / price)
    : 0;
  const quantityByRisk = Number.isFinite(riskPerShare) && riskPerShare > 0
    ? Math.floor(riskCapacity / riskPerShare)
    : 0;
  const quantity = Math.max(0, Math.min(quantityByCapital, quantityByRisk));
  const allocation = quantity * price;
  const plannedRisk = quantity * riskPerShare;
  const minimumAllocationMet = allocation >= rules.minimumInitialAllocation;
  let reason = "Capital, position, sector and risk limits allow a winner add-on.";
  if (!Number.isFinite(riskPerShare) || riskPerShare <= 0) {
    reason = "Actual price is not above the protected trailing stop; add-on skipped.";
  } else if (positionCapacity < price) reason = "Winner has reached its 15% total position cap.";
  else if (availableCash < price) reason = "Available portfolio cash is insufficient for an add-on.";
  else if (sectorCapacity < price) reason = `Sector exposure limit reached for ${sector}.`;
  else if (availablePortfolioRisk < riskPerShare) reason = "Aggregate portfolio-risk room is insufficient.";
  else if (totalTradeRiskCapacity < riskPerShare) reason = "Total position risk would exceed the 1% trade-risk cap.";
  else if (quantity < 1) reason = "Risk-sized add-on quantity is below one share.";
  else if (!minimumAllocationMet) {
    reason = `Planned add-on Rs ${round(allocation)} is below the minimum order value Rs ${round(rules.minimumInitialAllocation)}.`;
  }

  return {
    eligible: quantity > 0 && minimumAllocationMet,
    quantity,
    allocation: round(allocation),
    plannedRisk: round(plannedRisk),
    riskPerShare: round(riskPerShare),
    trailingStop: round(trailingStop),
    maximumPositionAllocation: round(maximumPositionAllocation),
    addAllocationCap: round(addAllocationCap),
    minimumInitialAllocation: round(rules.minimumInitialAllocation),
    sector,
    rank: candidateRank(row),
    reason
  };
}

export function nextTrailingStop(trade, row, config = {}) {
  const rules = portfolioConfig(config);
  const close = Number(row?.close);
  if (!Number.isFinite(close) || close <= 0) return trade.trailingStopPrice || trade.initialStopPrice;
  const currentStop = Math.max(
    Number(trade.initialStopPrice) || 0,
    Number(trade.trailingStopPrice) || 0
  );
  const holdingCloses = completedHoldingCloses(trade, row);
  const initialRisk = Number(trade.entryPrice) - Number(trade.initialStopPrice);
  const rewardR = initialRisk > 0 ? (close - Number(trade.entryPrice)) / initialRisk : null;
  if (
    holdingCloses < rules.minimumManagementCloses ||
    !Number.isFinite(rewardR) ||
    rewardR < 1
  ) {
    return currentStop || structuralStop(row, close, rules);
  }
  const values = row.setupStrength?.values || {};
  const candidates = [
    trade.initialStopPrice,
    trade.trailingStopPrice,
    row.dailySupertrend,
    values.fourCandleLow,
    values.fibonacciSupportNearby ? values.fibonacciNearestPrice : null
  ].filter((value) => Number.isFinite(value) && value > 0 && value < close);
  if (!candidates.length) return currentStop || structuralStop(row, close, rules);
  const raw = Math.max(...candidates);
  return round(Math.max(currentStop, Math.min(raw, close * (1 - rules.minimumStopPct / 100))));
}

export function positionExitDecision(trade, row, config = {}) {
  if (!row || trade.status !== "OPEN") return { action: "HOLD", reasons: [] };
  const rules = portfolioConfig(config);
  const close = Number(row.close);
  const trailingStop = nextTrailingStop(trade, row, rules);
  const initialStop = Number(trade.initialStopPrice);
  const holdingCloses = completedHoldingCloses(trade, row);
  const managementReady = holdingCloses >= rules.minimumManagementCloses;
  const fullReasons = [];
  if (Number(row.weeklyRs) < 0) {
    fullReasons.push(`Completed-week RS ${formatRs(row.weeklyRs)} is below zero.`);
  }
  if (
    row.weeklyPriceAboveEma13 === false &&
    Number.isFinite(Number(row.weeklyClose)) &&
    Number.isFinite(Number(row.weeklyEma13))
  ) {
    fullReasons.push(
      `Completed weekly candle ${row.weeklyAsOf || ""} closed ${round(row.weeklyClose)} below low-source EMA13 ${round(row.weeklyEma13)}; weekly momentum structure is broken.`
    );
  }
  const dailyLongRs = Number(row.dailyLongRs);
  const dailyLongRsBelowCloses = confirmedDailyLongRsBelowCloses(trade, row);
  if (dailyLongRs <= rules.dailyLongRsHardExitThreshold) {
    fullReasons.push(
      `Completed-close daily long RS55 ${formatRs(dailyLongRs)} is materially below the hard-exit threshold ${formatRs(rules.dailyLongRsHardExitThreshold)}.`
    );
  } else if (
    dailyLongRs < 0 &&
    dailyLongRsBelowCloses >= rules.dailyLongRsConfirmationCloses
  ) {
    fullReasons.push(
      `Completed-close daily long RS55 remained below zero for ${dailyLongRsBelowCloses} confirmed closes.`
    );
  }
  if (Number.isFinite(initialStop) && close <= initialStop) {
    fullReasons.push(`Daily close ${round(close)} breached original structural stop ${round(initialStop)}.`);
  }
  const trailingStopRaised = Number.isFinite(trailingStop) && trailingStop > initialStop;
  const trailingBreachCloses = confirmedTrailingStopBreachCloses(trade, row, trailingStop);
  if (
    managementReady &&
    trailingStopRaised &&
    close <= trailingStop &&
    trailingBreachCloses >= rules.trailingStopConfirmationCloses
  ) {
    fullReasons.push(
      `Daily close breached raised trailing stop ${trailingStop} on ${trailingBreachCloses} confirmed closes.`
    );
  }
  if (fullReasons.length) {
    return { action: "FULL_EXIT", reasons: fullReasons, trailingStop };
  }

  if (trade.lastRiskActionSignalDate === row.asOf) {
    return { action: "HOLD", reasons: [], trailingStop };
  }

  const weakness = positionWeakness(row);
  const trendRide = positionTrendRide(row);
  const confirmedWeakCloses = new Set(trade.rotationReview?.weakCloseDates || []).size;
  const severeWeaknessConfirmed =
    weakness.primaryScore >= 3 &&
    confirmedWeakCloses >= rules.severeWeaknessConfirmationCloses;
  const weaknessConfirmed =
    weakness.primaryScore >= 2 &&
    !trendRide.protected &&
    (
      (managementReady && confirmedWeakCloses >= rules.partialWeaknessConfirmationCloses) ||
      severeWeaknessConfirmed
    );
  const initialRisk = Math.max(0, Number(trade.entryPrice) - Number(trade.initialStopPrice));
  const rewardR = initialRisk > 0 ? (close - Number(trade.entryPrice)) / initialRisk : null;
  const partialReasons = [];
  let partialTag = null;
  if (
    Number.isFinite(rewardR) &&
    rewardR >= rules.partialProfitR &&
    managementReady &&
    (!trendRide.protected || trendRide.exhausted) &&
    !trade.partialExitTags?.includes("PROFIT_LOCK")
  ) {
    partialReasons.push(`Profit reached ${round(rewardR)}R; lock ${rules.partialExitPct}% and trail the balance.`);
    partialTag = "PROFIT_LOCK";
  }
  if (
    !partialTag &&
    weaknessConfirmed &&
    !trade.partialExitTags?.includes("EARLY_WEAKNESS")
  ) {
    partialReasons.push(
      `Confirmed deterioration on ${confirmedWeakCloses} completed closes: ${weakness.primaryReasons.join("; ")}.`
    );
    partialTag = "EARLY_WEAKNESS";
  }
  const entryFundamental = Number(trade.entrySnapshot?.fundamentalScore);
  const currentFundamental = Number(row.fundamentalScore);
  const fundamentalDeteriorated =
    Number.isFinite(entryFundamental) &&
    Number.isFinite(currentFundamental) &&
    entryFundamental - currentFundamental >= 2 &&
    currentFundamental <= 2;
  if (fundamentalDeteriorated && partialTag === "EARLY_WEAKNESS") {
    partialReasons.push("Fundamental deterioration confirms the already-established technical weakness.");
  }
  if (partialTag && partialReasons.length && Number(trade.quantity) >= 2) {
    return {
      action: "PARTIAL_EXIT",
      reasons: partialReasons,
      trailingStop,
      rewardR: round(rewardR),
      partialPct: rules.partialExitPct,
      tag: partialTag
    };
  }
  const holdReasons = [...weakness.reasons];
  if (!managementReady) {
    holdReasons.push(
      `ENTRY RETEST GRACE: ${holdingCloses}/${rules.minimumManagementCloses} completed closes observed; normal pullback is tolerated while weekly RS, daily RS55 and original stop remain valid.`
    );
  }
  if (trendRide.protected) {
    holdReasons.push(
      "TREND RIDE: weekly/daily leadership and price structure remain healthy; trail the stop instead of cutting the winner."
    );
  }
  if (dailyLongRs < 0 && dailyLongRs > rules.dailyLongRsHardExitThreshold) {
    holdReasons.push(
      `RS55 EXIT CONFIRMATION: marginal reading ${formatRs(dailyLongRs)} has ${dailyLongRsBelowCloses}/${rules.dailyLongRsConfirmationCloses} completed below-zero closes; immediate weekly, Supertrend/structural and hard-threshold protections remain active.`
    );
  }
  if (weakness.primaryScore === 1) {
    holdReasons.push("WAIT/WATCH: one primary weakness is not enough for a partial exit.");
  } else if (weakness.primaryScore >= 2 && !weaknessConfirmed) {
    holdReasons.push(
      `WAIT/WATCH: ${confirmedWeakCloses}/${rules.partialWeaknessConfirmationCloses} completed deterioration closes confirmed.`
    );
  }
  if (weakness.contextReasons.some((reason) => reason.startsWith("GTF"))) {
    holdReasons.push("GTF is secondary context only and cannot trigger an exit.");
  }
  return { action: "HOLD", reasons: holdReasons, trailingStop, rewardR: round(rewardR) };
}

export function positionTrendRide(row = {}) {
  const checks = row.setupStrength?.checks || {};
  const values = row.setupStrength?.values || {};
  const close = Number(row.close);
  const atr = Number(values.atr);
  const smaFast = Number(values.smaFast);
  const extensionAtr =
    Number.isFinite(close) && Number.isFinite(smaFast) && Number.isFinite(atr) && atr > 0
      ? (close - smaFast) / atr
      : null;
  const exhausted =
    Number(row.dailyRsi) >= 75 && Number.isFinite(extensionAtr) && extensionAtr >= 3;
  const aboveFast = !Number.isFinite(smaFast) || close > smaFast;
  const smaSlow = Number(values.smaSlow);
  const aboveSlow = !Number.isFinite(smaSlow) || close > smaSlow;
  const weeklyEmaHealthy =
    row.weeklyPriceAboveEma13 !== false ||
    !Number.isFinite(Number(row.weeklyEma13));
  const coreHealthy =
    Number(row.weeklyRs) > 0 &&
    Number(row.dailyLongRs) > 0 &&
    Number(row.dailyRsi) >= 50 &&
    close > Number(row.dailySupertrend) &&
    aboveFast &&
    aboveSlow &&
    weeklyEmaHealthy &&
    checks.marketRegimeStrong !== false &&
    row.institutionalContext?.operator?.distribution !== true;
  return {
    protected: coreHealthy && !exhausted,
    coreHealthy,
    weeklyEmaHealthy,
    exhausted,
    extensionAtr: Number.isFinite(extensionAtr) ? round(extensionAtr) : null
  };
}

export function positionWeakness(row = {}) {
  const checks = row.setupStrength?.checks || {};
  const values = row.setupStrength?.values || {};
  const primaryReasons = [];
  if (Number(row.dailyShortRs) < 0) primaryReasons.push("daily RS21 below zero");
  if (Number(row.dailyLongRs) < 0) primaryReasons.push("daily RS55 below zero");
  if (Number(row.dailyRsi) < 50) primaryReasons.push("daily RSI below 50");
  if (Number(row.close) < Number(row.dailySupertrend)) primaryReasons.push("close below Supertrend");
  if (Number.isFinite(values.smaFast) && Number(row.close) < values.smaFast) {
    primaryReasons.push("close below 50-DMA");
  }
  if (row.weeklyPriceAboveEma13 === false && Number.isFinite(Number(row.weeklyEma13))) {
    primaryReasons.push("completed weekly close below low-source EMA13");
  }
  const contextReasons = [];
  if (checks.marketRegimeStrong === false) contextReasons.push("broad-market regime not strong");
  if (row.institutionalContext?.operator?.distribution === true) {
    contextReasons.push("official NSE delivery distribution");
  }
  if (["B", "C", "WATCH"].includes(String(row.setupGrade || "").toUpperCase())) {
    contextReasons.push(`setup grade ${row.setupGrade}`);
  }
  if (row.gtfContext?.supplyBlocked) contextReasons.push("GTF opposing supply confirmation");
  if (row.gtfContext?.checks?.roomForTwoR === false) contextReasons.push("GTF confirms less than 2R room");
  const reasons = [...primaryReasons, ...contextReasons];
  return {
    score: reasons.length,
    primaryScore: primaryReasons.length,
    primaryReasons,
    contextReasons,
    reasons
  };
}

export function rotationDecision(candidateRow, trades, rowBySymbol, config = {}, candidate = {}) {
  const rules = portfolioConfig(config);
  const challengerRank = candidateRank(candidateRow);
  const candidateCheck = candidateEntryDecision(candidate, candidateRow, config, {
    forRotation: true,
    qualityPass: true
  });
  if (!candidateCheck.actionable) {
    return {
      rotate: false,
      challengerRank,
      candidateCheck,
      reason: `Replacement is not rotation-ready: ${candidateCheck.reasons.join(" ")}`
    };
  }
  const eligible = trades
    .filter((trade) => trade.status === "OPEN")
    .map((trade) => {
      const row = rowBySymbol.get(trade.yahooSymbol || trade.symbol);
      if (!row) return null;
      if (trade.lastRiskActionSignalDate === row.asOf) return null;
      const sourceDecision = rotationSourceDecision(trade, row, config);
      return {
        trade,
        row,
        rank: candidateRank(row),
        weakness: sourceDecision.weakness,
        sourceDecision
      };
    })
    .filter(Boolean)
    .filter((item) => item.sourceDecision.eligible)
    .sort((a, b) => a.rank - b.rank);
  const weakest = eligible[0];
  if (!weakest) {
    return {
      rotate: false,
      challengerRank,
      reason: `No open position has both confirmed weakness and the required ${rules.rotationConfirmationCloses} distinct deterioration closes.`
    };
  }
  const advantage = challengerRank - weakest.rank;
  if (advantage < rules.rotationMinRankAdvantage) {
    return {
      rotate: false,
      challengerRank,
      weakestRank: weakest.rank,
      advantage: round(advantage),
      reason: `Rank advantage ${round(advantage)} is below required ${rules.rotationMinRankAdvantage}.`
    };
  }
  return {
    rotate: true,
    challengerRank,
    weakestRank: weakest.rank,
    advantage: round(advantage),
    trade: weakest.trade,
    weakness: weakest.weakness,
    candidateCheck,
    reason: `${candidateRow.symbol} rank ${challengerRank} is ${round(advantage)} points above weak position ${weakest.trade.symbol} rank ${weakest.rank}; replacement and weakness are confirmed across distinct closes.`
  };
}

export function rotationSourceDecision(trade = {}, row = {}, config = {}) {
  const rules = portfolioConfig(config);
  const weakness = positionWeakness(row);
  const trendRide = positionTrendRide(row);
  const holdingCloses = completedHoldingCloses(trade, row);
  const confirmedWeakCloses = new Set(trade.rotationReview?.weakCloseDates || []).size;
  const cooldownCloses = trade.lastPartialExitDate
    ? completedClosesSince(trade.lastPartialExitDate, trade, row)
    : rules.rotationCooldownCloses;
  const reasons = [];

  if (holdingCloses < rules.minimumManagementCloses) {
    reasons.push(`Position has only ${holdingCloses}/${rules.minimumManagementCloses} completed management closes.`);
  }
  if (weakness.primaryScore < 3) {
    reasons.push(`Only ${weakness.primaryScore}/3 stock-specific weakness signals are active.`);
  }
  if (confirmedWeakCloses < rules.rotationConfirmationCloses) {
    reasons.push(
      `Weakness has only ${confirmedWeakCloses}/${rules.rotationConfirmationCloses} distinct confirmed closes.`
    );
  }
  if (cooldownCloses < rules.rotationCooldownCloses) {
    reasons.push(
      `Only ${cooldownCloses}/${rules.rotationCooldownCloses} completed closes have passed since the last partial exit.`
    );
  }
  if (trendRide.protected) reasons.push("Trend-ride protection remains active.");

  return {
    eligible: reasons.length === 0,
    reasons,
    weakness,
    trendRide,
    holdingCloses,
    confirmedWeakCloses,
    cooldownCloses
  };
}

export function remainingTradeRisk(trade) {
  const entry = Number(trade.entryPrice);
  const stop = Number(trade.trailingStopPrice || trade.initialStopPrice);
  const quantity = Number(trade.quantity);
  if (![entry, stop, quantity].every(Number.isFinite)) return 0;
  return Math.max(0, entry - stop) * Math.max(0, quantity);
}

function completedHoldingCloses(trade = {}, row = {}) {
  const entryDate = dateOnly(trade.entryDate || trade.entrySignalDate);
  const asOf = dateOnly(row.asOf);
  if (!entryDate || !asOf || asOf < entryDate) return 0;
  const dates = new Set(
    (trade.managementCloseDates || [])
      .map(dateOnly)
      .filter((date) => date && date >= entryDate && date <= asOf)
  );
  dates.add(asOf);
  return dates.size;
}

function completedClosesSince(referenceDate, trade = {}, row = {}) {
  const reference = dateOnly(referenceDate);
  const asOf = dateOnly(row.asOf);
  if (!reference || !asOf || asOf <= reference) return 0;
  const dates = new Set(
    (trade.managementCloseDates || [])
      .map(dateOnly)
      .filter((date) => date && date > reference && date <= asOf)
  );
  dates.add(asOf);
  return dates.size;
}

function confirmedTrailingStopBreachCloses(trade = {}, row = {}, trailingStop) {
  const close = Number(row.close);
  if (!Number.isFinite(close) || !Number.isFinite(trailingStop) || close > trailingStop) return 0;
  const dates = new Set((trade.trailingStopBreachDates || []).map(dateOnly).filter(Boolean));
  if (row.asOf) dates.add(dateOnly(row.asOf));
  return dates.size;
}

function confirmedDailyLongRsBelowCloses(trade = {}, row = {}) {
  if (!(Number(row.dailyLongRs) < 0)) return 0;
  const dates = new Set((trade.dailyLongRsBelowZeroDates || []).map(dateOnly).filter(Boolean));
  if (row.asOf) dates.add(dateOnly(row.asOf));
  return dates.size;
}

function calendarDays(start, end) {
  const startMs = new Date(start || 0).getTime();
  const endMs = new Date(end || 0).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, Math.floor((endMs - startMs) / 86_400_000));
}

function adaptivePositionCount(totalCapital) {
  if (totalCapital >= 50_000_000) return 50;
  if (totalCapital >= 10_000_000) return 30;
  if (totalCapital >= 5_000_000) return 25;
  if (totalCapital >= 2_500_000) return 20;
  if (totalCapital >= 1_000_000) return 15;
  return 10;
}

function positive(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
}

function negative(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) < 0 ? Number(value) : fallback;
}

function normalizedSector(industry) {
  const value = String(industry || "").trim();
  if (!value || ["unknown", "unclassified", "nse equity", "my list"].includes(value.toLowerCase())) {
    return "Unclassified";
  }
  return value;
}

function integer(value, fallback) {
  return Math.max(1, Math.floor(positive(value, fallback)));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatRs(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "NA";
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}
