const NSE_ACTIONS_PAGE = "https://www.nseindia.com/companies-listing/corporate-filings-actions";
const NSE_ACTIONS_API = "https://www.nseindia.com/api/corporates-corporateActions";
const ACTIVE_STATUSES = new Set(["OPEN", "PENDING_EXIT", "PENDING_PARTIAL_EXIT"]);
const cache = new Map();

export async function updateOpenPositionCorporateActions(
  trades = [],
  scan = {},
  config = {},
  options = {}
) {
  const settings = corporateActionSettings(config);
  const active = trades.filter((trade) => ACTIVE_STATUSES.has(trade?.status) && trade.entryDate);
  // Entitlement starts on the calendar ex-date, even before that day's market close exists.
  const asOf = isoDate(scan.scannedAt || scan.marketContext?.asOf || new Date());
  if (!settings.enabled || !active.length || !asOf) {
    return statusResult({ enabled: settings.enabled, asOf, reason: active.length ? "disabled" : "no open positions" });
  }

  const earliestEntry = active.map((trade) => isoDate(trade.entryDate)).filter(Boolean).sort()[0];
  const fallbackFrom = addDays(asOf, -settings.lookbackDays);
  const fromDate = earliestEntry && earliestEntry < fallbackFrom ? earliestEntry : fallbackFrom;
  let rows;
  try {
    rows = Array.isArray(options.actions)
      ? options.actions
      : await fetchNseCorporateActions({ fromDate, toDate: asOf, fetcher: options.fetcher });
  } catch (error) {
    return statusResult({
      enabled: true,
      asOf,
      fromDate,
      reason: error?.message || String(error),
      dataAvailable: false
    });
  }

  const actions = rows.map(parseCorporateAction).filter(Boolean);
  const bySymbol = groupBySymbol(actions);
  const events = [];
  let appliedCount = 0;
  let reviewCount = 0;
  let dividendAmount = 0;

  for (const trade of active) {
    const symbol = normalizeSymbol(trade.symbol || trade.yahooSymbol);
    const matches = (bySymbol.get(symbol) || [])
      .filter((action) => action.exDate <= asOf && action.exDate > isoDate(trade.entryDate))
      .sort((left, right) => left.exDate.localeCompare(right.exDate) || left.id.localeCompare(right.id));
    for (const action of matches) {
      const outcome = applyCorporateActionToTrade(trade, action, scan.scannedAt || new Date().toISOString());
      if (!outcome.applied) continue;
      appliedCount += 1;
      if (outcome.ledger.status === "REVIEW_REQUIRED") reviewCount += 1;
      if (outcome.ledger.type === "DIVIDEND") dividendAmount += Number(outcome.ledger.amount) || 0;
      events.push({ type: outcome.eventType, trade, corporateAction: outcome.ledger });
    }
  }

  return {
    enabled: true,
    source: "NSE Corporate Actions",
    sourceUrl: NSE_ACTIONS_PAGE,
    fetchedAt: new Date().toISOString(),
    asOf,
    fromDate,
    dataAvailable: true,
    fetchedActions: actions.length,
    appliedCount,
    reviewCount,
    dividendAmount: round(dividendAmount),
    events,
    reason: appliedCount ? `${appliedCount} new corporate action ledger entries` : "no new eligible open-position actions"
  };
}

export async function fetchNseCorporateActions({ fromDate, toDate, fetcher = fetch }) {
  const key = `${fromDate}:${toDate}`;
  if (cache.has(key)) return structuredClone(await cache.get(key));
  const request = fetchNseCorporateActionsUncached(fromDate, toDate, fetcher)
    .catch((error) => {
      cache.delete(key);
      throw error;
    });
  cache.set(key, request);
  return structuredClone(await request);
}

async function fetchNseCorporateActionsUncached(fromDate, toDate, fetcher) {
  const baseHeaders = {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
    "accept-language": "en-US,en;q=0.9",
    accept: "application/json,text/plain,*/*"
  };
  const landing = await fetcher(NSE_ACTIONS_PAGE, { headers: baseHeaders });
  const cookie = responseCookies(landing);
  const url = new URL(NSE_ACTIONS_API);
  url.searchParams.set("index", "equities");
  url.searchParams.set("from_date", nseDate(fromDate));
  url.searchParams.set("to_date", nseDate(toDate));
  const response = await fetcher(url, {
    headers: {
      ...baseHeaders,
      referer: NSE_ACTIONS_PAGE,
      ...(cookie ? { cookie } : {})
    }
  });
  if (!response.ok) throw new Error(`NSE corporate actions HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error("NSE corporate actions returned an invalid payload");
  return payload;
}

export function parseCorporateAction(row = {}) {
  const symbol = normalizeSymbol(row.symbol);
  const subject = String(row.subject || row.purpose || "").trim();
  const exDate = parseNseDate(row.exDate || row.ex_date);
  if (!symbol || !subject || !exDate) return null;
  const normalized = subject.replace(/\s+/g, " ").trim();
  const base = {
    id: actionId(symbol, exDate, normalized),
    symbol,
    company: String(row.comp || row.companyName || "").trim(),
    series: String(row.series || "").trim(),
    isin: String(row.isin || "").trim(),
    purpose: normalized,
    exDate,
    recordDate: parseNseDate(row.recDate || row.recordDate),
    source: "NSE Corporate Actions",
    sourceUrl: NSE_ACTIONS_PAGE
  };

  if (/dividend/i.test(normalized)) {
    const amounts = [...normalized.matchAll(/(?:Rs\.?|Re\.?|INR)\s*([0-9]+(?:\.[0-9]+)?)/gi)]
      .map((match) => Number(match[1]))
      .filter((value) => Number.isFinite(value) && value >= 0);
    if (amounts.length) return { ...base, type: "DIVIDEND", dividendPerShare: round(amounts.reduce((sum, value) => sum + value, 0)) };
  }

  const bonus = normalized.match(/bonus\s+(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/i);
  if (bonus) {
    const newShares = Number(bonus[1]);
    const heldShares = Number(bonus[2]);
    if (heldShares > 0) return { ...base, type: "BONUS", ratio: `${newShares}:${heldShares}`, factor: 1 + newShares / heldShares };
  }

  const split = normalized.match(/from\s+(?:Rs\.?|Re\.?)\s*([0-9]+(?:\.[0-9]+)?)[^0-9]+to\s+(?:Rs\.?|Re\.?)\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (split && /split|sub-division|consolidation/i.test(normalized)) {
    const oldFaceValue = Number(split[1]);
    const newFaceValue = Number(split[2]);
    if (oldFaceValue > 0 && newFaceValue > 0) {
      return {
        ...base,
        type: oldFaceValue >= newFaceValue ? "SPLIT" : "CONSOLIDATION",
        oldFaceValue,
        newFaceValue,
        factor: oldFaceValue / newFaceValue
      };
    }
  }

  return { ...base, type: "REVIEW", reviewReason: "Complex corporate action needs confirmed entitlement/consideration before accounting." };
}

export function applyCorporateActionToTrade(trade, action, appliedAt = new Date().toISOString()) {
  if (!ACTIVE_STATUSES.has(trade?.status) || !action?.id || !trade.entryDate) return { applied: false };
  if (action.exDate <= isoDate(trade.entryDate)) return { applied: false };
  trade.corporateActions = Array.isArray(trade.corporateActions) ? trade.corporateActions : [];
  if (trade.corporateActions.some((item) => item.id === action.id)) return { applied: false };

  const entitledQuantity = quantityHeldBeforeDate(trade, action.exDate);
  if (!(entitledQuantity > 0)) return { applied: false };
  const ledger = { ...action, appliedAt, entitledQuantity, status: "APPLIED" };
  let eventType = "CORPORATE_ACTION_ADJUSTED";

  if (action.type === "DIVIDEND") {
    ledger.amount = round(entitledQuantity * action.dividendPerShare);
    ledger.status = "DIVIDEND_ENTITLED";
    ledger.accountingNote = "Gross dividend entitlement recognized separately on ex-date; tax/TDS, if any, is not deducted.";
    eventType = "DIVIDEND_CREDIT";
  } else if (["SPLIT", "BONUS", "CONSOLIDATION"].includes(action.type) && action.factor > 0) {
    const exactQuantity = entitledQuantity * action.factor;
    const adjustedQuantity = Math.floor(exactQuantity + 1e-9);
    if (adjustedQuantity < 1) {
      ledger.status = "REVIEW_REQUIRED";
      ledger.reviewReason = "Adjustment produces no whole tradable share; fractional settlement needs broker confirmation.";
      eventType = "CORPORATE_ACTION_REVIEW";
    } else {
      ledger.quantityBefore = entitledQuantity;
      ledger.quantityAfter = adjustedQuantity;
      ledger.fractionalEntitlement = roundTo(exactQuantity - adjustedQuantity, 6);
      ledger.priceAdjustmentFactor = entitledQuantity / adjustedQuantity;
      preserveRawEntryAccounting(trade);
      adjustLivePositionReferences(trade, ledger.priceAdjustmentFactor, adjustedQuantity, entitledQuantity);
      if (ledger.fractionalEntitlement > 0) {
        ledger.status = "APPLIED_WITH_FRACTION_REVIEW";
        ledger.reviewReason = "Whole shares adjusted automatically; fractional entitlement awaits broker cash/share settlement.";
      }
    }
  } else {
    ledger.status = "REVIEW_REQUIRED";
    eventType = "CORPORATE_ACTION_REVIEW";
  }

  trade.corporateActions.push(ledger);
  trade.corporateActions.sort((left, right) => left.exDate.localeCompare(right.exDate) || left.id.localeCompare(right.id));
  trade.lastCorporateActionAt = appliedAt;
  return { applied: true, ledger, eventType };
}

export function dividendRealizedPnl(trades = []) {
  return round(trades.reduce((sum, trade) => sum + (Number(trade?.dividendRealizedPnl) || 0), 0));
}

function preserveRawEntryAccounting(trade) {
  if (!Number.isFinite(Number(trade.accountingInitialEntryPrice))) {
    trade.accountingInitialEntryPrice = Number(trade.initialEntryPrice || trade.entryPrice) || null;
  }
  if (!Number.isFinite(Number(trade.accountingInitialQuantity))) {
    trade.accountingInitialQuantity = Number(trade.initialQuantity || trade.originalQuantity || trade.quantity) || null;
  }
}

function adjustLivePositionReferences(trade, priceFactor, adjustedQuantity, entitledQuantity) {
  const currentQuantity = Number(trade.quantity) || entitledQuantity;
  const currentExact = currentQuantity * (adjustedQuantity / entitledQuantity);
  trade.quantity = Math.floor(currentExact + 1e-9);
  for (const field of [
    "entryPrice", "initialEntryPrice", "initialStopPrice", "trailingStopPrice",
    "riskPerShare", "lastAddPrice", "lastPartialExitPrice"
  ]) {
    if (Number.isFinite(Number(trade[field]))) trade[field] = round(Number(trade[field]) * priceFactor);
  }
  if (Number.isFinite(Number(trade.originalQuantity))) {
    trade.originalQuantity = Math.floor(Number(trade.originalQuantity) / priceFactor + 1e-9);
  }
  if (Number.isFinite(Number(trade.initialQuantity))) {
    trade.initialQuantity = Math.floor(Number(trade.initialQuantity) / priceFactor + 1e-9);
  }
  if (trade.pendingAdd) {
    for (const field of ["plannedStop", "breakoutLevel", "pullbackLow"]) {
      if (Number.isFinite(Number(trade.pendingAdd[field]))) trade.pendingAdd[field] = round(Number(trade.pendingAdd[field]) * priceFactor);
    }
  }
  trade.investedValue = round((Number(trade.entryPrice) || 0) * trade.quantity);
  trade.currentValue = Number.isFinite(Number(trade.lastPrice))
    ? round(Number(trade.lastPrice) * trade.quantity)
    : trade.currentValue;
}

function quantityHeldBeforeDate(trade, beforeDate) {
  let quantity = Number(trade.accountingInitialQuantity || trade.initialQuantity || trade.originalQuantity || 0);
  const events = [];
  for (const item of trade.addOns || []) {
    if (isoDate(item.date) < beforeDate) events.push({ date: isoDate(item.date), order: 2, delta: Number(item.quantity) || 0 });
  }
  for (const item of trade.partialExits || []) {
    if (isoDate(item.date) < beforeDate) events.push({ date: isoDate(item.date), order: 3, delta: -(Number(item.quantity) || 0) });
  }
  for (const item of trade.corporateActions || []) {
    if (item.exDate < beforeDate && Number(item.quantityAfter) >= 0) {
      events.push({ date: item.exDate, order: 1, absolute: Number(item.quantityAfter) });
    }
  }
  events.sort((left, right) => left.date.localeCompare(right.date) || left.order - right.order);
  for (const event of events) quantity = Number.isFinite(event.absolute) ? event.absolute : quantity + event.delta;
  return Math.max(0, quantity);
}

function corporateActionSettings(config) {
  return {
    enabled: config.corporateActions?.enabled !== false,
    lookbackDays: Math.max(30, Number(config.corporateActions?.lookbackDays) || 400)
  };
}

function groupBySymbol(actions) {
  const map = new Map();
  for (const action of actions) {
    if (!map.has(action.symbol)) map.set(action.symbol, []);
    map.get(action.symbol).push(action);
  }
  return map;
}

function statusResult(values) {
  return {
    enabled: false,
    source: "NSE Corporate Actions",
    sourceUrl: NSE_ACTIONS_PAGE,
    fetchedAt: new Date().toISOString(),
    dataAvailable: true,
    fetchedActions: 0,
    appliedCount: 0,
    reviewCount: 0,
    dividendAmount: 0,
    events: [],
    ...values
  };
}

function responseCookies(response) {
  if (typeof response?.headers?.getSetCookie === "function") {
    return response.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
  }
  return String(response?.headers?.get?.("set-cookie") || "")
    .split(/,(?=[^;,]+=)/)
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

function actionId(symbol, exDate, subject) {
  const key = subject.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${symbol}:${exDate}:${key}`;
}

function normalizeSymbol(value) {
  return String(value || "").trim().toUpperCase().replace(/^NSE:/, "").replace(/\.(NS|BO)$/i, "");
}

function parseNseDate(value) {
  const text = String(value || "").trim();
  if (!text || text === "-") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{4})$/);
  if (!match) return isoDate(text);
  const month = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"].indexOf(match[2].toUpperCase()) + 1;
  return month ? `${match[3]}-${String(month).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}` : null;
}

function isoDate(value) {
  const text = String(value || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function nseDate(date) {
  const [year, month, day] = date.split("-");
  return `${day}-${month}-${year}`;
}

function round(value) {
  return roundTo(value, 2);
}

function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}
