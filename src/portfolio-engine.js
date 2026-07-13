const ACTIVE_STATUSES = new Set(["OPEN", "PENDING_EXIT", "PENDING_PARTIAL_EXIT"]);

export function portfolioConfig(config = {}) {
  const trade = config.trade || config;
  return {
    totalCapital: positive(trade.totalCapital, 1_000_000),
    maxOpenPositions: integer(trade.maxOpenPositions, 10),
    maxPositionPct: positive(trade.maxPositionPct, 10),
    riskPerTradePct: positive(trade.riskPerTradePct, 1),
    maxPortfolioRiskPct: positive(trade.maxPortfolioRiskPct, 6),
    maxSectorExposurePct: positive(trade.maxSectorExposurePct, 25),
    minimumStopPct: positive(trade.minimumStopPct, 1.5),
    maximumStopPct: positive(trade.maximumStopPct, 8),
    partialExitPct: positive(trade.partialExitPct, 50),
    partialProfitR: positive(trade.partialProfitR, 1.5),
    rotationMinRankAdvantage: positive(trade.rotationMinRankAdvantage, 15),
    rotationMinimumHoldingDays: integer(trade.rotationMinimumHoldingDays, 5)
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
  const styleBonus = ["RETRACEMENT_BUY", "BREAKOUT_BUY"].includes(row.entryStyle?.type) ? 8 : 3;
  const rsPoints =
    clamp((Number(row.weeklyRs) || 0) * 35, -10, 25) +
    clamp((Number(row.dailyLongRs) || 0) * 30, -8, 18) +
    clamp((Number(row.dailyShortRs) || 0) * 20, -5, 10);
  const trendPoints = [
    checks.weeklyRsRising,
    checks.dailyLongRsRising,
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
    (coverage.dataGaps || 0) * 1.5;

  return round(
    (gradePoints[String(row.setupGrade || "").toUpperCase()] || 0) +
      (Number(row.setupStrengthScore) || 0) * 1.5 +
      (Number(row.fundamentalScore) || 0) * 2 +
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
  const candidates = [
    row.dailySupertrend,
    values.fourCandleLow,
    values.twoCandleLow,
    values.fibonacciSupportNearby ? values.fibonacciNearestPrice : null,
    row.gtfContext?.structuralStop
  ].filter((value) => Number.isFinite(value) && value > 0 && value < price);
  const raw = candidates.length ? Math.max(...candidates) : price * (1 - rules.maximumStopPct / 100);
  const closestAllowed = price * (1 - rules.minimumStopPct / 100);
  const furthestAllowed = price * (1 - rules.maximumStopPct / 100);
  return round(Math.min(closestAllowed, Math.max(furthestAllowed, raw)));
}

export function buildPositionPlan(row, price, portfolio = {}, config = {}) {
  const rules = portfolioConfig(config);
  const stopPrice = structuralStop(row, price, rules);
  const riskPerShare = Number.isFinite(stopPrice) ? price - stopPrice : null;
  const maxAllocation = rules.totalCapital * rules.maxPositionPct / 100;
  const riskBudget = rules.totalCapital * rules.riskPerTradePct / 100;
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
  let reason = "Risk and capital limits allow entry.";
  if ((Number(portfolio.openSlots) || 0) <= 0) reason = "Maximum open-position limit reached.";
  else if (availableCash < price) reason = "Available portfolio cash is insufficient.";
  else if (sectorAvailable < price) reason = `Sector exposure limit reached for ${sector}.`;
  else if (availableRisk < riskPerShare) reason = "Maximum aggregate portfolio risk reached.";
  else if (quantity < 1) reason = "Risk-sized quantity is below one share.";

  return {
    eligible: quantity > 0 && (Number(portfolio.openSlots) || 0) > 0,
    quantity,
    allocation: round(allocation),
    stopPrice,
    stopDistancePct: round((price - stopPrice) / price * 100),
    riskPerShare: round(riskPerShare),
    plannedRisk: round(plannedRisk),
    riskBudget: round(riskBudget),
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
  const active = trades.filter((trade) => ACTIVE_STATUSES.has(trade.status));
  const pendingEntries = trades.filter((trade) => trade.status === "PENDING_ENTRY");
  const closed = trades.filter((trade) => trade.status === "CLOSED");
  const investedCapital = active.reduce(
    (sum, trade) => sum + (Number(trade.investedValue) || 0),
    0
  );
  const reservedCapital = pendingEntries.reduce(
    (sum, trade) => sum + (Number(trade.plannedAllocation) || Number(trade.investedValue) || 0),
    0
  );
  const realizedPnl =
    closed.reduce((sum, trade) => sum + (Number(trade.pnl) || 0), 0) +
    active.reduce((sum, trade) => sum + (Number(trade.realizedPnlToDate) || 0), 0);
  const unrealizedPnl = active.reduce(
    (sum, trade) => sum + (Number(trade.unrealizedPnl) || 0),
    0
  );
  const portfolioRisk =
    active.reduce((sum, trade) => sum + remainingTradeRisk(trade), 0) +
    pendingEntries.reduce((sum, trade) => sum + (Number(trade.plannedRisk) || 0), 0);
  const riskLimit = rules.totalCapital * rules.maxPortfolioRiskPct / 100;
  const availableCash = Math.max(
    0,
    rules.totalCapital + realizedPnl - investedCapital - reservedCapital
  );
  const sectorExposure = {};
  for (const trade of [...active, ...pendingEntries]) {
    const sector = normalizedSector(trade.industry || trade.entrySnapshot?.industry);
    sectorExposure[sector] =
      (sectorExposure[sector] || 0) +
      (Number(trade.investedValue) || Number(trade.plannedAllocation) || 0);
  }

  return {
    totalCapital: round(rules.totalCapital),
    investedCapital: round(investedCapital),
    reservedCapital: round(reservedCapital),
    deployedCapital: round(investedCapital + reservedCapital),
    availableCash: round(availableCash),
    realizedPnl: round(realizedPnl),
    unrealizedPnl: round(unrealizedPnl),
    totalEquity: round(rules.totalCapital + realizedPnl + unrealizedPnl),
    portfolioRisk: round(portfolioRisk),
    portfolioRiskPct: round(portfolioRisk / rules.totalCapital * 100),
    riskLimit: round(riskLimit),
    availableRisk: round(Math.max(0, riskLimit - portfolioRisk)),
    openPositions: active.length,
    pendingEntries: pendingEntries.length,
    openSlots: Math.max(0, rules.maxOpenPositions - active.length - pendingEntries.length),
    maxOpenPositions: rules.maxOpenPositions,
    capitalUtilizationPct: round((investedCapital + reservedCapital) / rules.totalCapital * 100),
    overallocatedCapital: round(Math.max(0, investedCapital + reservedCapital - rules.totalCapital)),
    waitingCandidates: candidates.length,
    sectorExposure
  };
}

export function nextTrailingStop(trade, row, config = {}) {
  const rules = portfolioConfig(config);
  const close = Number(row?.close);
  if (!Number.isFinite(close) || close <= 0) return trade.trailingStopPrice || trade.initialStopPrice;
  const values = row.setupStrength?.values || {};
  const candidates = [
    trade.initialStopPrice,
    trade.trailingStopPrice,
    row.dailySupertrend,
    values.fourCandleLow,
    values.fibonacciSupportNearby ? values.fibonacciNearestPrice : null,
    row.gtfContext?.structuralStop
  ].filter((value) => Number.isFinite(value) && value > 0 && value < close);
  if (!candidates.length) return structuralStop(row, close, rules);
  const raw = Math.max(...candidates);
  return round(Math.min(raw, close * (1 - rules.minimumStopPct / 100)));
}

export function positionExitDecision(trade, row, config = {}) {
  if (!row || trade.status !== "OPEN") return { action: "HOLD", reasons: [] };
  const rules = portfolioConfig(config);
  const values = row.setupStrength?.values || {};
  const close = Number(row.close);
  const trailingStop = nextTrailingStop(trade, row, rules);
  const fullReasons = [];
  if (Number(row.weeklyRs) < 0) {
    fullReasons.push(`Completed-week RS ${percent(row.weeklyRs)} is below zero.`);
  }
  if (Number(row.dailyLongRs) < 0 && close < Number(row.dailySupertrend)) {
    fullReasons.push("Daily RS55 is below zero and daily close is below Supertrend.");
  }
  if (
    Number.isFinite(values.smaSlow) &&
    close < values.smaSlow &&
    Number(row.dailyLongRs) < 0
  ) {
    fullReasons.push("Price is below 200-DMA with negative daily RS55.");
  }
  if (Number.isFinite(trailingStop) && close <= trailingStop) {
    fullReasons.push(`Daily close ${round(close)} breached trailing structural stop ${trailingStop}.`);
  }
  if (fullReasons.length) {
    return { action: "FULL_EXIT", reasons: fullReasons, trailingStop };
  }

  if (trade.lastRiskActionSignalDate === row.asOf) {
    return { action: "HOLD", reasons: [], trailingStop };
  }

  const weakness = positionWeakness(row);
  const initialRisk = Math.max(0, Number(trade.entryPrice) - Number(trade.initialStopPrice));
  const rewardR = initialRisk > 0 ? (close - Number(trade.entryPrice)) / initialRisk : null;
  const partialReasons = [];
  if (
    Number.isFinite(rewardR) &&
    rewardR >= rules.partialProfitR &&
    !trade.partialExitTags?.includes("PROFIT_LOCK")
  ) {
    partialReasons.push(`Profit reached ${round(rewardR)}R; lock ${rules.partialExitPct}% and trail the balance.`);
  }
  if (
    weakness.score >= 2 &&
    !trade.partialExitTags?.includes("EARLY_WEAKNESS")
  ) {
    partialReasons.push(`Early deterioration: ${weakness.reasons.join("; ")}.`);
  }
  const entryFundamental = Number(trade.entrySnapshot?.fundamentalScore);
  const currentFundamental = Number(row.fundamentalScore);
  if (
    Number.isFinite(entryFundamental) &&
    Number.isFinite(currentFundamental) &&
    entryFundamental - currentFundamental >= 2 &&
    currentFundamental <= 2 &&
    !trade.partialExitTags?.includes("FUNDAMENTAL_DETERIORATION")
  ) {
    partialReasons.push("Fundamental score materially deteriorated from the entry snapshot.");
  }
  if (partialReasons.length && Number(trade.quantity) >= 2) {
    return {
      action: "PARTIAL_EXIT",
      reasons: partialReasons,
      trailingStop,
      rewardR: round(rewardR),
      partialPct: rules.partialExitPct,
      tag: partialReasons[0].startsWith("Profit")
        ? "PROFIT_LOCK"
        : partialReasons[0].startsWith("Fundamental")
          ? "FUNDAMENTAL_DETERIORATION"
          : "EARLY_WEAKNESS"
    };
  }
  return { action: "HOLD", reasons: weakness.reasons, trailingStop, rewardR: round(rewardR) };
}

export function positionWeakness(row = {}) {
  const checks = row.setupStrength?.checks || {};
  const values = row.setupStrength?.values || {};
  const reasons = [];
  if (Number(row.dailyShortRs) < 0) reasons.push("daily RS21 below zero");
  if (Number(row.dailyLongRs) < 0) reasons.push("daily RS55 below zero");
  if (Number(row.dailyRsi) < 50) reasons.push("daily RSI below 50");
  if (Number(row.close) < Number(row.dailySupertrend)) reasons.push("close below Supertrend");
  if (Number.isFinite(values.smaFast) && Number(row.close) < values.smaFast) {
    reasons.push("close below 50-DMA");
  }
  if (!checks.marketRegimeStrong) reasons.push("broad-market regime not strong");
  if (row.gtfContext?.supplyBlocked) reasons.push("GTF opposing supply is blocking price");
  if (row.gtfContext?.checks?.roomForTwoR === false) reasons.push("GTF opposing supply leaves less than 2R room");
  if (["B", "C", "WATCH"].includes(String(row.setupGrade || "").toUpperCase())) {
    reasons.push(`setup grade ${row.setupGrade}`);
  }
  return { score: reasons.length, reasons };
}

export function rotationDecision(candidateRow, trades, rowBySymbol, config = {}) {
  const rules = portfolioConfig(config);
  const challengerRank = candidateRank(candidateRow);
  const eligible = trades
    .filter((trade) => trade.status === "OPEN")
    .map((trade) => {
      const row = rowBySymbol.get(trade.yahooSymbol || trade.symbol);
      if (!row) return null;
      const weakness = positionWeakness(row);
      return {
        trade,
        row,
        rank: candidateRank(row),
        weakness,
        holdingDays: calendarDays(trade.entryDate, row.asOf)
      };
    })
    .filter(Boolean)
    .filter((item) =>
      item.weakness.score >= 2 &&
      (item.holdingDays >= rules.rotationMinimumHoldingDays || item.weakness.score >= 3)
    )
    .sort((a, b) => a.rank - b.rank);
  const weakest = eligible[0];
  if (!weakest) {
    return { rotate: false, challengerRank, reason: "No weak open position qualifies for rotation." };
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
    reason: `${candidateRow.symbol} rank ${challengerRank} is ${round(advantage)} points above weak position ${weakest.trade.symbol} rank ${weakest.rank}.`
  };
}

function remainingTradeRisk(trade) {
  const entry = Number(trade.entryPrice);
  const stop = Number(trade.trailingStopPrice || trade.initialStopPrice);
  const quantity = Number(trade.quantity);
  if (![entry, stop, quantity].every(Number.isFinite)) return 0;
  return Math.max(0, entry - stop) * Math.max(0, quantity);
}

function calendarDays(start, end) {
  const startMs = new Date(start || 0).getTime();
  const endMs = new Date(end || 0).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, Math.floor((endMs - startMs) / 86_400_000));
}

function positive(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
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

function percent(value) {
  return Number.isFinite(Number(value)) ? `${round(Number(value) * 100)}%` : "NA";
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}
