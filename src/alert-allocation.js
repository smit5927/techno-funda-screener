const PENDING_TYPES = new Set([
  "ENTRY_SIGNAL_PENDING",
  "EXIT_SIGNAL_PENDING",
  "PORTFOLIO_EXIT_PENDING",
  "ROTATION_EXIT_PENDING",
  "PARTIAL_EXIT_PENDING",
  "PYRAMID_ADD_PENDING",
  "ENTRY_SKIPPED"
]);

export function tradeActionAllocation(event = {}, currentPortfolioValue = null) {
  const type = String(event.type || "").trim().toUpperCase();
  const trade = event.trade || {};
  const candidate = event.candidate || {};
  const partial = trade.partialExits?.at(-1) || {};
  const add = trade.addOns?.at(-1) || trade.pendingAdd || {};
  const referencePrice = firstPositive(
    trade.lastPrice,
    trade.currentSnapshot?.close,
    trade.exitSnapshot?.close,
    trade.entrySnapshot?.close,
    trade.entryPrice,
    candidate.close
  );
  let side = null;
  let quantity = null;
  let value = null;

  if (["ENTRY_SIGNAL_PENDING", "ENTRY_TRADE_OPENED"].includes(type)) {
    side = "BUY";
    quantity = firstPositive(trade.plannedQuantity, trade.quantity);
    value = firstPositive(trade.plannedAllocation, trade.investedValue);
  } else if (type === "ENTRY_SKIPPED") {
    side = "WAITING BUY";
    quantity = firstPositive(candidate.plannedQuantity, trade.plannedQuantity);
    value = firstPositive(candidate.plannedAllocation, trade.plannedAllocation);
  } else if (["EXIT_SIGNAL_PENDING", "PORTFOLIO_EXIT_PENDING", "ROTATION_EXIT_PENDING", "EXIT_TRADE_CLOSED"].includes(type)) {
    side = "SELL";
    quantity = firstPositive(trade.quantity);
    value = type === "EXIT_TRADE_CLOSED"
      ? multiply(quantity, trade.exitPrice)
      : multiply(quantity, referencePrice);
  } else if (type === "PARTIAL_EXIT_PENDING") {
    side = "PARTIAL SELL";
    quantity = partialExitQuantity(trade.quantity, trade.pendingPartialExitPct);
    value = multiply(quantity, referencePrice);
  } else if (type === "PARTIAL_EXIT_FILLED") {
    side = "PARTIAL SELL";
    quantity = firstPositive(partial.quantity);
    value = multiply(quantity, partial.price);
  } else if (["PYRAMID_ADD_PENDING", "PYRAMID_ADD_FILLED"].includes(type)) {
    side = "PYRAMID BUY";
    quantity = firstPositive(add.plannedQuantity, add.quantity);
    value = firstPositive(add.plannedAllocation, add.allocation, multiply(quantity, add.price));
  }

  if (!side || !Number.isFinite(quantity) || quantity <= 0) return null;
  if (!Number.isFinite(value) || value <= 0) value = multiply(quantity, referencePrice);
  const portfolioValue = firstPositive(currentPortfolioValue);
  const portfolioPct = Number.isFinite(value) && portfolioValue
    ? round(value / portfolioValue * 100, 2)
    : null;
  return {
    side,
    quantity: Math.floor(quantity),
    value: Number.isFinite(value) ? round(value, 2) : null,
    portfolioPct,
    approximate: PENDING_TYPES.has(type)
  };
}

export function tradeActionAllocationText(allocation) {
  if (!allocation) return "";
  const prefix = allocation.approximate ? "APPROX" : "ACTUAL";
  const value = Number.isFinite(allocation.value)
    ? `Rs ${formatNumber(allocation.value)}`
    : "Value pending";
  const portfolio = Number.isFinite(allocation.portfolioPct)
    ? `${formatNumber(allocation.portfolioPct)}% of current portfolio value (cash + holdings)`
    : "% available after portfolio refresh";
  return `${prefix} ${allocation.side}: Qty ${formatNumber(allocation.quantity)} | ${value} | ${portfolio}`;
}

function partialExitQuantity(quantityValue, percentageValue) {
  const quantity = Math.floor(Number(quantityValue));
  const percentage = Number(percentageValue) || 50;
  if (!Number.isFinite(quantity) || quantity < 2) return null;
  return Math.max(1, Math.min(quantity - 1, Math.floor(quantity * percentage / 100)));
}

function firstPositive(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function multiply(left, right) {
  const first = Number(left);
  const second = Number(right);
  return Number.isFinite(first) && Number.isFinite(second) && first > 0 && second > 0
    ? first * second
    : null;
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(Number(value));
}
