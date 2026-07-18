export function remainingOpenLotPerformance(unrealizedPnl, investedValue, openBuyCharges = 0) {
  const pnl = Number.isFinite(Number(unrealizedPnl)) ? Number(unrealizedPnl) : 0;
  const basis = Number(investedValue) + (Number(openBuyCharges) || 0);
  return {
    pnl,
    basis: Number.isFinite(basis) && basis > 0 ? basis : null,
    pnlPct: Number.isFinite(basis) && basis > 0 ? pnl / basis * 100 : null
  };
}

export function tradeSheetPositionPnl({ closed = false, finalRealizedPnl = null, unrealizedPnl = 0 } = {}) {
  return closed ? Number(finalRealizedPnl || 0) : Number(unrealizedPnl || 0);
}
