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
    rotationMinimumHoldingDays: integer(trade.rotationMinimumHoldingDays, 5),
    pyramidingEnabled: trade.pyramidingEnabled !== false,
    pyramidMaxAddOns: integer(trade.pyramidMaxAddOns, 2),
    pyramidMaxPositionPct: positive(trade.pyramidMaxPositionPct, 15),
    pyramidAddMaxPct: positive(trade.pyramidAddMaxPct, 2.5),
    pyramidAddRiskPct: positive(trade.pyramidAddRiskPct, 0.5),
    pyramidMinimumRewardR: positive(trade.pyramidMinimumRewardR, 1)
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
  const pendingAddCapital = active.reduce(
    (sum, trade) => sum + (Number(trade.pendingAdd?.plannedAllocation) || 0),
    0
  );
  const reservedCapital = pendingEntries.reduce(
    (sum, trade) => sum + (Number(trade.plannedAllocation) || Number(trade.investedValue) || 0),
    0
  ) + pendingAddCapital;
  const realizedPnl =
    closed.reduce((sum, trade) => sum + (Number(trade.pnl) || 0), 0) +
    active.reduce((sum, trade) => sum + (Number(trade.realizedPnlToDate) || 0), 0);
  const unrealizedPnl = active.reduce(
    (sum, trade) => sum + (Number(trade.unrealizedPnl) || 0),
    0
  );
  const portfolioRisk =
    active.reduce((sum, trade) => sum + remainingTradeRisk(trade), 0) +
    pendingEntries.reduce((sum, trade) => sum + (Number(trade.plannedRisk) || 0), 0) +
    active.reduce((sum, trade) => sum + (Number(trade.pendingAdd?.plannedRisk) || 0), 0);
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
      (Number(trade.investedValue) || Number(trade.plannedAllocation) || 0) +
      (Number(trade.pendingAdd?.plannedAllocation) || 0);
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
    pendingAdds: active.filter((trade) => trade.pendingAdd).length,
    openSlots: Math.max(0, rules.maxOpenPositions - active.length - pendingEntries.length),
    maxOpenPositions: rules.maxOpenPositions,
    capitalUtilizationPct: round((investedCapital + reservedCapital) / rules.totalCapital * 100),
    overallocatedCapital: round(Math.max(0, investedCapital + reservedCapital - rules.totalCapital)),
    waitingCandidates: candidates.length,
    sectorExposure
  };
}

export function breakoutContinuationState(row = {}) {
  const checks = row.setupStrength?.checks || {};
  const values = row.setupStrength?.values || {};
  const recent = checks.recentHighBreakout === true;
  const yearly = checks.yearHighBreakout === true;
  return {
    breakout: recent || yearly,
    type: yearly ? "52_WEEK_BREAKOUT" : recent ? "55_DAY_BREAKOUT" : null,
    level: yearly ? values.priorYearHigh : recent ? values.priorRecentHigh : null
  };
}

export function pyramidAddDecision(trade, row, portfolio = {}, config = {}) {
  const rules = portfolioConfig(config);
  const checks = row?.setupStrength?.checks || {};
  const values = row?.setupStrength?.values || {};
  const breakout = breakoutContinuationState(row);
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
  if ((trade?.addOns?.length || 0) >= rules.pyramidMaxAddOns) {
    reasons.push(`Maximum ${rules.pyramidMaxAddOns} add-ons already used.`);
  }
  if (row?.status !== "ENTRY") reasons.push("All compulsory entry conditions are no longer valid.");
  if (!["A+", "A"].includes(String(row?.setupGrade || "").toUpperCase())) {
    reasons.push("Current setup is below A grade.");
  }
  if (!breakout.breakout) reasons.push("No fresh 55-day or 52-week closing breakout.");
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
      `${breakout.type === "52_WEEK_BREAKOUT" ? "52-week" : "55-day"} closing breakout at ${round(close)} above ${round(breakout.level)}.`,
      `Winning position is ${round(rewardR)}R above average cost with a protected trailing stop.`,
      "Weekly RS and daily RS55 are rising; compulsory entry, A-grade quality, market and supply checks remain favorable."
    ] : [plan.reason],
    breakout,
    rewardR: round(rewardR)
  };
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
  let reason = "Capital, position, sector and risk limits allow a winner add-on.";
  if (!Number.isFinite(riskPerShare) || riskPerShare <= 0) {
    reason = "Actual price is not above the protected trailing stop; add-on skipped.";
  } else if (positionCapacity < price) reason = "Winner has reached its 15% total position cap.";
  else if (availableCash < price) reason = "Available portfolio cash is insufficient for an add-on.";
  else if (sectorCapacity < price) reason = `Sector exposure limit reached for ${sector}.`;
  else if (availablePortfolioRisk < riskPerShare) reason = "Aggregate portfolio-risk room is insufficient.";
  else if (totalTradeRiskCapacity < riskPerShare) reason = "Total position risk would exceed the 1% trade-risk cap.";
  else if (quantity < 1) reason = "Risk-sized add-on quantity is below one share.";

  return {
    eligible: quantity > 0,
    quantity,
    allocation: round(allocation),
    plannedRisk: round(plannedRisk),
    riskPerShare: round(riskPerShare),
    trailingStop: round(trailingStop),
    maximumPositionAllocation: round(maximumPositionAllocation),
    addAllocationCap: round(addAllocationCap),
    sector,
    rank: candidateRank(row),
    reason
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
