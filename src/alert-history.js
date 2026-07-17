import { tradeActionAllocation, tradeActionAllocationText } from "./alert-allocation.js";

const MAX_ALERTS = 500;
const ALERT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIONABLE_ALERT_TYPES = new Set([
  "ENTRY_SIGNAL_PENDING",
  "EXIT_SIGNAL_PENDING",
  "PORTFOLIO_EXIT_PENDING",
  "ROTATION_EXIT_PENDING",
  "PARTIAL_EXIT_PENDING",
  "PYRAMID_ADD_PENDING",
  "DIVIDEND_CREDIT"
]);

export function updateAlertHistory(existing = [], events = [], occurredAt = new Date().toISOString(), context = {}) {
  const referenceTime = normalizedTime(occurredAt);
  const cutoffTime = referenceTime - ALERT_RETENTION_DAYS * DAY_MS;
  const output = Array.isArray(existing)
    ? existing.filter((item) => validAlert(item) && Date.parse(item.occurredAt) > cutoffTime).map((item) => ({ ...item }))
    : [];
  const seen = new Set(output.map((item) => item.id));
  for (const event of events || []) {
    const alert = alertFromTradeEvent(event, occurredAt, context);
    if (!alert || seen.has(alert.id)) continue;
    seen.add(alert.id);
    output.push(alert);
  }
  return output
    .sort((left, right) => String(right.occurredAt).localeCompare(String(left.occurredAt)))
    .slice(0, MAX_ALERTS);
}

export function alertFromTradeEvent(event = {}, occurredAt = new Date().toISOString(), context = {}) {
  const type = String(event.type || "").trim().toUpperCase();
  if (!ACTIONABLE_ALERT_TYPES.has(type)) return null;
  const trade = event.trade || {};
  const candidate = event.candidate || {};
  const action = event.corporateAction || {};
  const symbol = String(trade.symbol || candidate.symbol || action.symbol || "").trim().toUpperCase();
  const definition = alertDefinition(type, trade);
  if (!type || !definition || !symbol) return null;
  const eventDate = relevantDate(type, trade, action, occurredAt);
  const reasons = alertReasons(type, event, trade, candidate, action);
  const allocation = tradeActionAllocation(event, context.totalFund);
  const allocationSummary = tradeActionAllocationText(allocation);
  const details = alertDetails(type, trade, candidate, action, allocation);
  const identity = [
    type,
    trade.id || candidate.id || "",
    symbol,
    action.id || "",
    eventDate || "",
    details.price ?? "",
    details.quantity ?? "",
    details.addNumber ?? ""
  ].join("|");
  return {
    id: `alert-${stableHash(identity)}`,
    type,
    category: definition.category,
    severity: definition.severity,
    title: definition.title,
    symbol,
    name: trade.name || candidate.name || action.company || "",
    tradeId: trade.id || null,
    listLabel: trade.tradeScopeLabel || trade.listLabel || candidate.listLabel || "",
    occurredAt: normalizeTimestamp(occurredAt),
    actionDate: eventDate,
    summary: reasons[0] || definition.fallback,
    reasons,
    allocationSummary: allocationSummary || null,
    details
  };
}

function alertDefinition(type, trade) {
  const definitions = {
    ENTRY_SIGNAL_PENDING: ["ENTRY", "info", "Entry signal ready", "Waiting for the next valid 09:17 execution."],
    ENTRY_TRADE_OPENED: ["ENTRY", "success", "Position opened", "Entry filled successfully."],
    ENTRY_SKIPPED: ["ENTRY", "warning", "Entry moved to waiting", "Portfolio or execution constraint prevented the buy."],
    EXIT_SIGNAL_PENDING: ["EXIT", "danger", "Full exit signal", "Exit is waiting for the next valid 09:17 execution."],
    EXIT_SIGNAL_CANCELLED: ["EXIT", "info", "Exit signal cancelled", "The position remains open under the balanced confirmation policy."],
    PORTFOLIO_EXIT_PENDING: ["EXIT", "danger", "Portfolio exit signal", "Portfolio rule scheduled a full exit."],
    ROTATION_EXIT_PENDING: ["EXIT", "warning", "Rotation exit signal", "A stronger replacement initiated rotation review."],
    EXIT_TRADE_CLOSED: ["EXIT", "danger", trade.exitType === "QUALITY_ROTATION" ? "Rotation sell filled" : "Position closed", "Exit filled successfully."],
    PARTIAL_EXIT_PENDING: ["PARTIAL_EXIT", "warning", "Partial exit signal", "Risk reduction is waiting for 09:17 execution."],
    PARTIAL_EXIT_FILLED: ["PARTIAL_EXIT", "warning", "Partial exit filled", "Part of the position was booked."],
    PYRAMID_ADD_PENDING: ["PYRAMID", "info", "Pyramid add signal", "Winner add is waiting for 09:17 execution."],
    PYRAMID_ADD_FILLED: ["PYRAMID", "success", "Pyramid add filled", "The strong position was increased."],
    PYRAMID_ADD_SKIPPED: ["PYRAMID", "warning", "Pyramid add skipped", "Latest risk or execution checks rejected the add."],
    ROTATION_CANCELLED: ["PORTFOLIO", "info", "Rotation cancelled", "The existing position remains open."],
    DIVIDEND_CREDIT: ["CORPORATE", "success", "Dividend entitlement posted", "Dividend was included in booked realized P&L."],
    CORPORATE_ACTION_ADJUSTED: ["CORPORATE", "info", "Corporate action adjusted", "Open-position quantity and price references were adjusted."],
    CORPORATE_ACTION_REVIEW: ["CORPORATE", "warning", "Corporate action needs review", "No unconfirmed financial adjustment was posted."]
  };
  const item = definitions[type];
  return item ? { category: item[0], severity: item[1], title: item[2], fallback: item[3] } : null;
}

function alertReasons(type, event, trade, candidate, action) {
  const values = [];
  if (type === "DIVIDEND_CREDIT") {
    values.push(
      action.exDate
        ? `Dividend ex-date ${action.exDate}.${action.purpose ? ` ${action.purpose}` : ""}`
        : action.purpose,
      action.accountingNote,
      action.reviewReason
    );
  } else if (type.startsWith("CORPORATE_ACTION")) {
    values.push(action.purpose, action.accountingNote, action.reviewReason);
  } else if (type.includes("PARTIAL_EXIT")) {
    values.push(...asArray(trade.pendingPartialExitReason));
    values.push(...asArray(trade.partialExits?.at(-1)?.reason));
  } else if (type.includes("PYRAMID_ADD")) {
    values.push(...asArray(trade.pendingAdd?.reason));
    values.push(...asArray(trade.addOns?.at(-1)?.reason));
    values.push(trade.executionError);
  } else if (type.includes("EXIT") || type === "ROTATION_CANCELLED") {
    values.push(...asArray(trade.exitReason));
    values.push(event.reason, trade.riskActionNote);
  } else {
    values.push(...asArray(trade.entryReason));
    values.push(candidate.skipReason, trade.skipReason, trade.executionError);
  }
  return uniqueText(values).slice(0, 10);
}

function alertDetails(type, trade, candidate, action, allocation) {
  const partial = trade.partialExits?.at(-1) || {};
  const add = trade.addOns?.at(-1) || trade.pendingAdd || {};
  const details = {
    actionSide: allocation?.side || null,
    actionQuantity: allocation?.quantity ?? null,
    actionValue: allocation?.value ?? null,
    actionFundPct: allocation?.fundPct ?? null,
    exDate: action.exDate || null,
    status: trade.status || candidate.status || action.status || "",
    price: numeric(
      type === "PARTIAL_EXIT_FILLED" ? partial.price
        : type === "PYRAMID_ADD_FILLED" ? add.price
          : type === "EXIT_TRADE_CLOSED" ? trade.exitPrice
            : trade.entryPrice
    ),
    quantity: numeric(
      type === "PARTIAL_EXIT_FILLED" ? partial.quantity
        : type.includes("PYRAMID_ADD") ? (add.quantity ?? add.plannedQuantity)
          : trade.quantity
    ),
    pnl: numeric(type === "PARTIAL_EXIT_FILLED" ? partial.pnl : type === "EXIT_TRADE_CLOSED" ? trade.pnl : null),
    remainingQuantity: numeric(trade.quantity),
    stopPrice: numeric(trade.trailingStopPrice || trade.initialStopPrice),
    rank: numeric(trade.currentRank || trade.positionRank || candidate.rank),
    addNumber: numeric(add.number),
    dividendPerShare: numeric(action.dividendPerShare),
    dividendAmount: numeric(action.amount),
    entitledQuantity: numeric(action.entitledQuantity),
    quantityBefore: numeric(action.quantityBefore),
    quantityAfter: numeric(action.quantityAfter),
    factor: numeric(action.factor),
    corporateStatus: action.status || null,
    replacementSymbol: trade.replacementCandidateSymbol || eventReplacement(candidate) || null
  };
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== null && value !== ""));
}

function relevantDate(type, trade, action, fallback) {
  if (type.startsWith("CORPORATE_ACTION") || type === "DIVIDEND_CREDIT") return action.exDate || dateOnly(fallback);
  if (type === "ENTRY_TRADE_OPENED") return trade.entryDate || trade.entrySignalDate || dateOnly(fallback);
  if (type === "EXIT_TRADE_CLOSED") return trade.exitDate || trade.exitSignalDate || dateOnly(fallback);
  if (type === "PARTIAL_EXIT_FILLED") return trade.partialExits?.at(-1)?.date || trade.partialExitSignalDate || dateOnly(fallback);
  if (type === "PYRAMID_ADD_FILLED") return trade.addOns?.at(-1)?.date || trade.pendingAdd?.signalDate || dateOnly(fallback);
  return trade.exitSignalDate || trade.partialExitSignalDate || trade.pendingAdd?.signalDate || trade.entrySignalDate || dateOnly(fallback);
}

function eventReplacement(candidate) {
  return candidate?.symbol || null;
}

function uniqueText(values) {
  return [...new Set(values.flatMap(asArray).map((value) => String(value || "").trim()).filter(Boolean))]
    .map((value) => value.slice(0, 600));
}

function asArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function validAlert(alert) {
  return Boolean(
    alert &&
    typeof alert === "object" &&
    alert.id &&
    ACTIONABLE_ALERT_TYPES.has(String(alert.type || "").toUpperCase()) &&
    alert.symbol
  );
}

function normalizeTimestamp(value) {
  return new Date(normalizedTime(value)).toISOString();
}

function normalizedTime(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : Date.now();
}

function dateOnly(value) {
  return normalizeTimestamp(value).slice(0, 10);
}
