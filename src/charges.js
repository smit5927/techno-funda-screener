const DEFAULT_CHARGE_SETTINGS = Object.freeze({
  enabled: false,
  brokerageMode: "FLAT_PER_ORDER",
  brokerageFlatPerOrder: 20,
  brokeragePercent: 0.1,
  dpChargePerSell: 15.34,
  sttBuyPct: 0.1,
  sttSellPct: 0.1,
  exchangeTransactionPct: 0.0030699,
  sebiTurnoverPct: 0.0001,
  stampDutyBuyPct: 0.015,
  ipftPct: 0.0000001,
  gstPct: 18,
  version: "NSE_EQUITY_DELIVERY_2026_07"
});

export function chargeSettings(config = {}) {
  const source = config.trade || config;
  const mode = String(source.brokerageMode || "FLAT_PER_ORDER").toUpperCase();
  return {
    ...DEFAULT_CHARGE_SETTINGS,
    enabled: source.chargesEnabled === true,
    brokerageMode: mode === "PERCENT_TURNOVER" ? mode : "FLAT_PER_ORDER",
    brokerageFlatPerOrder: nonNegative(source.brokerageFlatPerOrder, 20),
    brokeragePercent: nonNegative(source.brokeragePercent, 0.1),
    dpChargePerSell: nonNegative(source.dpChargePerSell, 15.34)
  };
}

export function calculateDeliveryCharges({ side, price, quantity }, config = {}) {
  const settings = chargeSettings(config);
  const normalizedSide = String(side || "").toUpperCase();
  const turnover = round(nonNegative(price) * nonNegative(quantity));
  if (!settings.enabled || !turnover || !["BUY", "SELL"].includes(normalizedSide)) {
    return emptyBreakdown(turnover, settings, normalizedSide);
  }

  const brokerage = settings.brokerageMode === "PERCENT_TURNOVER"
    ? turnover * settings.brokeragePercent / 100
    : settings.brokerageFlatPerOrder;
  const sttRate = normalizedSide === "BUY" ? settings.sttBuyPct : settings.sttSellPct;
  const stt = turnover * sttRate / 100;
  const exchangeTransactionCharge = turnover * settings.exchangeTransactionPct / 100;
  const sebiTurnoverCharge = turnover * settings.sebiTurnoverPct / 100;
  const stampDuty = normalizedSide === "BUY"
    ? turnover * settings.stampDutyBuyPct / 100
    : 0;
  const ipft = turnover * settings.ipftPct / 100;
  const gst = (brokerage + exchangeTransactionCharge + sebiTurnoverCharge + ipft) * settings.gstPct / 100;
  const dpCharge = normalizedSide === "SELL" ? settings.dpChargePerSell : 0;
  const total = brokerage + stt + exchangeTransactionCharge + sebiTurnoverCharge + stampDuty + ipft + gst + dpCharge;

  return {
    enabled: true,
    version: settings.version,
    side: normalizedSide,
    turnover,
    brokerage: round(brokerage),
    stt: round(stt),
    exchangeTransactionCharge: round(exchangeTransactionCharge),
    sebiTurnoverCharge: round(sebiTurnoverCharge),
    stampDuty: round(stampDuty),
    ipft: round(ipft),
    gst: round(gst),
    dpCharge: round(dpCharge),
    total: round(total)
  };
}

export function applyTradeChargeAccounting(trade, config = {}, markPrice = null) {
  if (!trade || typeof trade !== "object") return trade;
  const settings = chargeSettings(config);
  const transactions = buildTransactions(trade, config);
  let quantity = 0;
  let averagePrice = 0;
  let unallocatedBuyCharges = 0;
  let grossRealizedPnl = 0;
  let netRealizedPnl = 0;
  let actualCharges = 0;
  let buyCharges = 0;
  let sellCharges = 0;

  for (const transaction of transactions) {
    const qty = nonNegative(transaction.quantity);
    const price = nonNegative(transaction.price);
    actualCharges += transaction.charges.total;
    if (transaction.side === "BUY") {
      averagePrice = quantity + qty > 0
        ? ((averagePrice * quantity) + (price * qty)) / (quantity + qty)
        : 0;
      quantity += qty;
      buyCharges += transaction.charges.total;
      unallocatedBuyCharges += transaction.charges.total;
      transaction.grossPnl = 0;
      transaction.netPnl = round(-transaction.charges.total);
      continue;
    }

    const sold = Math.min(quantity, qty);
    const allocatedBuyCharges = quantity > 0
      ? unallocatedBuyCharges * sold / quantity
      : 0;
    const grossPnl = (price - averagePrice) * sold;
    const netPnl = grossPnl - allocatedBuyCharges - transaction.charges.total;
    quantity -= sold;
    unallocatedBuyCharges = Math.max(0, unallocatedBuyCharges - allocatedBuyCharges);
    grossRealizedPnl += grossPnl;
    netRealizedPnl += netPnl;
    sellCharges += transaction.charges.total;
    transaction.allocatedBuyCharges = round(allocatedBuyCharges);
    transaction.grossPnl = round(grossPnl);
    transaction.netPnl = round(netPnl);

    if (transaction.type === "PARTIAL_EXIT" && Number.isInteger(transaction.legIndex)) {
      const leg = trade.partialExits?.[transaction.legIndex];
      if (leg) {
        leg.grossPnl = transaction.grossPnl;
        leg.buyChargesAllocated = transaction.allocatedBuyCharges;
        leg.sellCharges = transaction.charges.total;
        leg.netPnl = transaction.netPnl;
        leg.pnl = transaction.netPnl;
      }
    }
  }

  const currentPrice = positive(markPrice) ?? positive(trade.lastPrice);
  const estimatedExit = quantity > 0 && currentPrice
    ? calculateDeliveryCharges({ side: "SELL", price: currentPrice, quantity }, config)
    : emptyBreakdown(0, settings, "SELL");
  const grossUnrealizedPnl = quantity > 0 && currentPrice
    ? (currentPrice - averagePrice) * quantity
    : 0;
  const netUnrealizedPnl = grossUnrealizedPnl - unallocatedBuyCharges - estimatedExit.total;
  const grossInvestedValue = averagePrice * quantity;
  const chargeAdjustedCostBasis = grossInvestedValue + unallocatedBuyCharges;

  trade.transactions = transactions;
  trade.chargeSettings = settings;
  trade.chargeSummary = {
    enabled: settings.enabled,
    version: settings.version,
    buyCharges: round(buyCharges),
    sellCharges: round(sellCharges),
    actualCharges: round(actualCharges),
    realizedCharges: round(grossRealizedPnl - netRealizedPnl),
    unallocatedBuyCharges: round(unallocatedBuyCharges),
    estimatedExitCharges: round(estimatedExit.total),
    openPositionCharges: round(unallocatedBuyCharges + estimatedExit.total),
    grossRealizedPnl: round(grossRealizedPnl),
    netRealizedPnl: round(netRealizedPnl),
    grossUnrealizedPnl: round(grossUnrealizedPnl),
    netUnrealizedPnl: round(netUnrealizedPnl)
  };
  trade.costBasisWithCharges = round(chargeAdjustedCostBasis);
  trade.estimatedExitCharges = round(estimatedExit.total);
  trade.realizedPnlToDate = round(netRealizedPnl);

  if (trade.status === "CLOSED") {
    trade.pnl = round(netRealizedPnl);
    const originalBasis = nonNegative(trade.originalInvestedValue) + buyCharges;
    trade.pnlPct = originalBasis > 0 ? round(netRealizedPnl / originalBasis * 100) : 0;
    trade.unrealizedPnl = null;
    trade.unrealizedPnlPct = null;
  } else if (quantity > 0 && currentPrice) {
    trade.unrealizedPnl = round(netUnrealizedPnl);
    trade.unrealizedPnlPct = chargeAdjustedCostBasis > 0
      ? round(netUnrealizedPnl / chargeAdjustedCostBasis * 100)
      : 0;
  }
  return trade;
}

export function portfolioChargeSummary(trades = []) {
  return trades.reduce((summary, trade) => {
    const charges = trade?.chargeSummary || {};
    summary.actualCharges += nonNegative(charges.actualCharges);
    summary.realizedCharges += nonNegative(charges.realizedCharges);
    summary.openBuyCharges += nonNegative(charges.unallocatedBuyCharges);
    summary.estimatedExitCharges += nonNegative(charges.estimatedExitCharges);
    return summary;
  }, { actualCharges: 0, realizedCharges: 0, openBuyCharges: 0, estimatedExitCharges: 0 });
}

function buildTransactions(trade, config) {
  const transactions = [];
  const addOns = Array.isArray(trade.addOns) ? trade.addOns : [];
  const partialExits = Array.isArray(trade.partialExits) ? trade.partialExits : [];
  const addedQuantity = addOns.reduce((sum, item) => sum + nonNegative(item.quantity), 0);
  const soldQuantity = partialExits.reduce((sum, item) => sum + nonNegative(item.quantity), 0);
  const currentQuantity = nonNegative(trade.quantity);
  const inferredInitial = Math.max(0, currentQuantity + soldQuantity - addedQuantity);
  const initialQuantity = nonNegative(trade.initialQuantity || inferredInitial || trade.originalQuantity || currentQuantity);
  if (positive(trade.entryPrice) && initialQuantity > 0 && trade.entryDate) {
    transactions.push(transaction("ENTRY_BUY", "BUY", trade.entryDate, trade.entryTime, trade.initialEntryPrice || trade.entryPrice, initialQuantity, config, 0));
  }
  addOns.forEach((item, index) => {
    transactions.push(transaction("PYRAMID_BUY", "BUY", item.date, item.time, item.price, item.quantity, config, index));
  });
  partialExits.forEach((item, index) => {
    transactions.push(transaction("PARTIAL_EXIT", "SELL", item.date, item.time, item.price, item.quantity, config, index));
  });
  if (trade.status === "CLOSED" && positive(trade.exitPrice) && currentQuantity > 0 && trade.exitDate) {
    transactions.push(transaction("FULL_EXIT", "SELL", trade.exitDate, trade.exitTime, trade.exitPrice, currentQuantity, config, 0));
  }
  return transactions.sort((left, right) => {
    const dateOrder = String(left.date || "").localeCompare(String(right.date || ""));
    if (dateOrder) return dateOrder;
    return orderFor(left.type) - orderFor(right.type) || left.legIndex - right.legIndex;
  });
}

function transaction(type, side, date, time, price, quantity, config, legIndex) {
  const charges = calculateDeliveryCharges({ side, price, quantity }, config);
  return {
    id: `${type}:${date || "NA"}:${legIndex}`,
    type,
    side,
    date: date || null,
    time: time || null,
    price: round(nonNegative(price)),
    quantity: nonNegative(quantity),
    turnover: charges.turnover,
    charges,
    legIndex
  };
}

function emptyBreakdown(turnover, settings, side) {
  return {
    enabled: false,
    version: settings.version,
    side,
    turnover: round(turnover),
    brokerage: 0,
    stt: 0,
    exchangeTransactionCharge: 0,
    sebiTurnoverCharge: 0,
    stampDuty: 0,
    ipft: 0,
    gst: 0,
    dpCharge: 0,
    total: 0
  };
}

function orderFor(type) {
  return { ENTRY_BUY: 0, PYRAMID_BUY: 1, PARTIAL_EXIT: 2, FULL_EXIT: 3 }[type] ?? 9;
}

function nonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
