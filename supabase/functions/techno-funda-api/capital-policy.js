const MINIMUM_CAPITAL = 10_000;
const MAXIMUM_CAPITAL = 1_000_000_000;

export function resolveCapitalChange({
  previousCapital,
  requestedCapital,
  addCapital,
  removeCapital,
  portfolioSummary,
  hasActivePositions = false,
  capitalHistory = [],
  now = new Date().toISOString()
} = {}) {
  const previous = boundedCapital(previousCapital);
  const add = positiveMoney(addCapital);
  const remove = positiveMoney(removeCapital);
  if (add > 0 && remove > 0) {
    throw policyError("Add Capital and Remove Capital cannot be used together. Enter only one amount.");
  }
  const requested = finiteMoney(requestedCapital);
  let next = previous;
  let type = null;
  let amount = 0;
  if (add > 0) {
    next = previous + add;
    type = "CAPITAL_ADDED";
    amount = add;
  } else if (remove > 0) {
    next = previous - remove;
    type = "CAPITAL_REMOVED";
    amount = remove;
  } else if (requested != null && requested !== previous) {
    next = requested;
    amount = Math.abs(next - previous);
    type = next < previous ? "CAPITAL_REMOVED" : "CAPITAL_SET";
  }
  if (next > MAXIMUM_CAPITAL) throw policyError(`Total capital cannot exceed Rs ${formatInr(MAXIMUM_CAPITAL)}.`);
  if (next < MINIMUM_CAPITAL) throw policyError(`At least Rs ${formatInr(MINIMUM_CAPITAL)} total capital must remain after withdrawal.`);

  const availableCash = adjustedAvailableCash(portfolioSummary, previous, hasActivePositions);
  const withdrawalAmount = next < previous ? previous - next : 0;
  if (withdrawalAmount > availableCash + 0.005) {
    const unavailable = withdrawalAmount - availableCash;
    throw policyError(
      `Requested withdrawal Rs ${formatInr(withdrawalAmount)} exceeds available free cash Rs ${formatInr(availableCash)}. ` +
      `Rs ${formatInr(unavailable)} cannot be removed because it is deployed, reserved, or unavailable under current portfolio limits.`
    );
  }
  const result = {
    type,
    amount: roundMoney(amount),
    previousCapital: previous,
    newCapital: roundMoney(next),
    availableCash,
    withdrawalLimit: roundMoney(Math.min(availableCash, Math.max(0, previous - MINIMUM_CAPITAL))),
    totalCapital: roundMoney(next)
  };
  result.event = type ? capitalFlowEvent({ ...result, portfolioSummary, capitalHistory, now }) : null;
  return result;
}

function capitalFlowEvent({ type, amount, previousCapital, newCapital, availableCash, portfolioSummary, capitalHistory, now }) {
  const summaryCapital = finiteMoney(portfolioSummary?.totalCapital);
  const summaryEquity = finiteMoney(portfolioSummary?.totalEquity);
  const netPnl = Number(portfolioSummary?.realizedPnl || 0) + Number(portfolioSummary?.unrealizedPnl || 0);
  const equityBeforeFlow = roundMoney(summaryEquity != null
    ? summaryEquity + previousCapital - (summaryCapital ?? previousCapital)
    : previousCapital + netPnl);
  const prior = [...capitalHistory].reverse().find((item) => positiveNumber(item?.unitsAfterFlow));
  const unitsBeforeFlow = prior ? Number(prior.unitsAfterFlow) : previousCapital / 100;
  const navPerUnitBeforeFlow = unitsBeforeFlow > 0 ? equityBeforeFlow / unitsBeforeFlow : 100;
  const direction = newCapital > previousCapital ? 1 : -1;
  const unitsDelta = navPerUnitBeforeFlow > 0 ? direction * amount / navPerUnitBeforeFlow : 0;
  return {
    date: now, type, amount: roundMoney(amount), previousCapital, newCapital,
    availableCashAtChange: availableCash, equityBeforeFlow,
    navPerUnitBeforeFlow: roundNumber(navPerUnitBeforeFlow, 8),
    unitsBeforeFlow: roundNumber(unitsBeforeFlow, 8),
    unitsDelta: roundNumber(unitsDelta, 8),
    unitsAfterFlow: roundNumber(unitsBeforeFlow + unitsDelta, 8)
  };
}

function adjustedAvailableCash(summary, previousCapital, hasActivePositions) {
  const summaryCash = finiteMoney(summary?.availableCash);
  const summaryCapital = finiteMoney(summary?.totalCapital);
  if (summaryCash != null) return roundMoney(Math.max(0, summaryCash + previousCapital - (summaryCapital ?? previousCapital)));
  return hasActivePositions ? 0 : previousCapital;
}
function boundedCapital(value) {
  const amount = finiteMoney(value);
  return roundMoney(Math.min(MAXIMUM_CAPITAL, Math.max(MINIMUM_CAPITAL, amount ?? 1_000_000)));
}
function finiteMoney(value) {
  if (value === "" || value == null) return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? roundMoney(amount) : null;
}
function positiveMoney(value) {
  const amount = finiteMoney(value);
  return amount != null && amount > 0 ? amount : 0;
}
function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}
function roundMoney(value) { return roundNumber(Number(value) || 0, 2); }
function roundNumber(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}
function formatInr(value) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(roundMoney(value));
}
function policyError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}
