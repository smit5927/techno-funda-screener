function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function calculatePositionMtm(trade, quote = {}) {
  const entryPrice = finiteNumber(trade?.entryPrice);
  const quantity = finiteNumber(trade?.quantity);
  const fallbackPrice = finiteNumber(trade?.lastPrice);
  const quotedPrice = finiteNumber(quote?.ltp);
  const ltp = quotedPrice && quotedPrice > 0 ? quotedPrice : fallbackPrice;
  const previousClose = finiteNumber(quote?.previousClose);
  const stopPrice = finiteNumber(trade?.trailingStopPrice) ?? finiteNumber(trade?.initialStopPrice);
  const hasPosition = entryPrice > 0 && quantity > 0 && ltp > 0;
  const unrealizedPnl = hasPosition ? (ltp - entryPrice) * quantity : null;
  const unrealizedPnlPct = hasPosition ? ((ltp / entryPrice) - 1) * 100 : null;
  const hasPreviousClose = hasPosition && previousClose > 0;
  const dayPnl = hasPreviousClose ? (ltp - previousClose) * quantity : null;
  const dayPnlPct = hasPreviousClose ? ((ltp / previousClose) - 1) * 100 : null;
  const hasStop = hasPosition && stopPrice > 0;
  const distanceToStopPct = hasStop ? ((ltp - stopPrice) / ltp) * 100 : null;
  const downsideToStop = hasStop ? Math.max(0, (ltp - stopPrice) * quantity) : null;
  const isLive = Boolean(quote?.isLive && quotedPrice && quotedPrice > 0);
  let riskState = isLive ? "NORMAL" : "STALE";
  if (hasStop && ltp <= stopPrice) riskState = "BREACHED";
  else if (hasStop && distanceToStopPct <= 1) riskState = "NEAR_STOP";
  return {
    symbol: String(trade?.symbol || ""),
    yahooSymbol: String(trade?.yahooSymbol || ""),
    status: String(trade?.status || ""),
    entryPrice: round(entryPrice),
    quantity: round(quantity, 4),
    ltp: round(ltp),
    stopPrice: round(stopPrice),
    previousClose: round(previousClose),
    dayPnl: round(dayPnl),
    dayPnlPct: round(dayPnlPct),
    unrealizedPnl: round(unrealizedPnl),
    unrealizedPnlPct: round(unrealizedPnlPct),
    investedValue: hasPosition ? round(entryPrice * quantity) : null,
    marketValue: hasPosition ? round(ltp * quantity) : null,
    distanceToStopPct: round(distanceToStopPct),
    downsideToStop: round(downsideToStop),
    riskState,
    isLive,
    asOf: quote?.asOf || null,
    source: quote?.source || "EOD fallback"
  };
}

export function summarizeLivePositions(positions, totalCapital) {
  const capital = finiteNumber(totalCapital) || 0;
  const summary = (Array.isArray(positions) ? positions : []).reduce((result, position) => {
    result.unrealizedPnl += finiteNumber(position?.unrealizedPnl) || 0;
    result.dayPnl += finiteNumber(position?.dayPnl) || 0;
    result.previousMarketValue += (finiteNumber(position?.previousClose) || 0) * (finiteNumber(position?.quantity) || 0);
    result.investedValue += finiteNumber(position?.investedValue) || 0;
    result.marketValue += finiteNumber(position?.marketValue) || 0;
    result.downsideToStops += finiteNumber(position?.downsideToStop) || 0;
    if (position?.riskState === "BREACHED") result.breachCount += 1;
    if (position?.riskState === "NEAR_STOP") result.nearStopCount += 1;
    if (position?.isLive) result.liveCount += 1;
    else result.staleCount += 1;
    return result;
  }, {
    unrealizedPnl: 0, unrealizedPnlPct: 0, dayPnl: 0, dayPnlPct: 0,
    previousMarketValue: 0, investedValue: 0, marketValue: 0,
    downsideToStops: 0, stopRiskPct: 0, breachCount: 0, nearStopCount: 0,
    liveCount: 0, staleCount: 0
  });
  summary.unrealizedPnl = round(summary.unrealizedPnl);
  summary.dayPnl = round(summary.dayPnl);
  summary.dayPnlPct = summary.previousMarketValue > 0 ? round((summary.dayPnl / summary.previousMarketValue) * 100) : 0;
  summary.previousMarketValue = round(summary.previousMarketValue);
  summary.investedValue = round(summary.investedValue);
  summary.unrealizedPnlPct = summary.investedValue > 0 ? round((summary.unrealizedPnl / summary.investedValue) * 100) : 0;
  summary.marketValue = round(summary.marketValue);
  summary.downsideToStops = round(summary.downsideToStops);
  summary.stopRiskPct = capital > 0 ? round((summary.downsideToStops / capital) * 100) : 0;
  return summary;
}
