import { tradeActionAllocation } from "./alert-allocation.js";

const MORNING_TELEGRAM_TYPES = new Set([
  "ENTRY_SIGNAL_PENDING",
  "EXIT_SIGNAL_PENDING",
  "PORTFOLIO_EXIT_PENDING",
  "ROTATION_EXIT_PENDING",
  "PARTIAL_EXIT_PENDING",
  "PYRAMID_ADD_PENDING",
  "CONTROLLED_RETEST_ADD_PENDING",
  "DIVIDEND_CREDIT"
]);

export function isTelegramConfigured(config) {
  return Boolean(config.telegram.botToken && config.telegram.chatId);
}

export async function sendTelegramSummary(scan, config) {
  if (!isTelegramConfigured(config)) {
    return { sent: false, reason: "telegram not configured" };
  }

  const events = (scan.tradeEvents || []).filter((event) =>
    MORNING_TELEGRAM_TYPES.has(String(event.type || "").toUpperCase())
  );
  if (events.length === 0) {
    return { sent: false, reason: "no new actionable portfolio alerts" };
  }

  const totalFund = scan.portfolioSummary?.totalCapital;
  let sent = 0;
  for (const event of events) {
    const text = buildStockActionMessage(event, totalFund);
    if (!text) continue;
    const response = await fetch(
      `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: config.telegram.chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true
        })
      }
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram error ${response.status}: ${body}`);
    }
    sent += 1;
  }
  return sent > 0
    ? { sent: true, messages: sent, chunks: sent }
    : { sent: false, reason: "no actionable portfolio alerts with usable details" };
}

function buildStockActionMessage(event, totalFund) {
  const type = String(event.type || "").toUpperCase();
  const trade = event.trade || {};
  const symbol = escapeTelegramHtml(trade.symbol || event.candidate?.symbol || "NA");
  if (type === "DIVIDEND_CREDIT") return buildDividendMessage(event, symbol);
  const allocation = tradeActionAllocation(event, totalFund);
  if (!allocation) return "";
  const action = actionLabel(type);
  const quantityLabel = allocation.side.includes("BUY") ? "Approx Buy Qty" : "Approx Sell Qty";
  const percentage = Number.isFinite(allocation.fundPct)
    ? `${formatNumber(allocation.fundPct)}%`
    : "NA";
  const lines = [
    `<b>${action} | ${symbol}</b>`,
    `${quantityLabel}: <b>${formatNumber(allocation.quantity)}</b>`,
    `Order Value: <b>Rs ${formatNumber(allocation.value)}</b>`,
    `Fund Allocation: <b>${percentage}</b>`
  ];
  const reason = actionReason(type, event);
  if (reason) lines.push(`Reason: ${escapeTelegramHtml(reason)}`);
  lines.push(`<i>Approved at 08:30 | Execution: next valid session 09:17 IST</i>`);
  return lines.join("\n");
}

function actionLabel(type) {
  return {
    ENTRY_SIGNAL_PENDING: "CONFIRMED BUY ORDER",
    EXIT_SIGNAL_PENDING: "CONFIRMED FULL EXIT",
    PORTFOLIO_EXIT_PENDING: "CONFIRMED PORTFOLIO EXIT",
    ROTATION_EXIT_PENDING: "CONFIRMED ROTATION EXIT",
    PARTIAL_EXIT_PENDING: "CONFIRMED PARTIAL EXIT",
    PYRAMID_ADD_PENDING: "CONFIRMED PYRAMID ADD",
    CONTROLLED_RETEST_ADD_PENDING: "CONFIRMED RETEST ADD"
  }[type] || "CONFIRMED PORTFOLIO ACTION";
}

function actionReason(type, event) {
  const trade = event.trade || {};
  const values = type === "PARTIAL_EXIT_PENDING"
    ? trade.pendingPartialExitReason
    : ["PYRAMID_ADD_PENDING", "CONTROLLED_RETEST_ADD_PENDING"].includes(type)
      ? trade.pendingAdd?.reason
      : type.includes("EXIT")
        ? trade.exitReason
        : trade.entryReason;
  const first = (Array.isArray(values) ? values : [values]).find((value) => String(value || "").trim());
  return first ? String(first).trim().slice(0, 240) : "";
}

function buildDividendMessage(event, symbol) {
  const action = event.corporateAction || {};
  const trade = event.trade || {};
  const lines = [`<b>DIVIDEND CREDIT | ${symbol}</b>`];
  if (action.exDate) lines.push(`Ex-date: <b>${escapeTelegramHtml(action.exDate)}</b>`);
  if (Number.isFinite(Number(action.entitledQuantity))) {
    lines.push(`Entitled Qty: <b>${formatNumber(action.entitledQuantity)}</b>`);
  }
  if (Number.isFinite(Number(action.dividendPerShare))) {
    lines.push(`Dividend/Share: <b>Rs ${formatNumber(action.dividendPerShare)}</b>`);
  }
  if (Number.isFinite(Number(action.amount))) {
    lines.push(`Realized Dividend: <b>Rs ${formatNumber(action.amount)}</b>`);
  }
  const reason = action.purpose || action.accountingNote || trade.dividendNote;
  if (reason) lines.push(`Details: ${escapeTelegramHtml(String(reason).slice(0, 240))}`);
  lines.push(`<i>Included separately in booked realized P&amp;L</i>`);
  return lines.join("\n");
}

function escapeTelegramHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(Number(value));
}
