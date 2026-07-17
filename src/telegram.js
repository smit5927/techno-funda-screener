import { tradeActionAllocation } from "./alert-allocation.js";

const MORNING_TELEGRAM_TYPES = new Set([
  "ENTRY_SIGNAL_PENDING",
  "EXIT_SIGNAL_PENDING",
  "PORTFOLIO_EXIT_PENDING",
  "ROTATION_EXIT_PENDING"
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
    return { sent: false, reason: "no new buy entry or full exit alerts" };
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
    : { sent: false, reason: "no sizeable buy entry or full exit alerts" };
}

function buildStockActionMessage(event, totalFund) {
  const type = String(event.type || "").toUpperCase();
  const trade = event.trade || {};
  const symbol = escapeTelegramHtml(trade.symbol || event.candidate?.symbol || "NA");
  const allocation = tradeActionAllocation(event, totalFund);
  if (!allocation) return "";
  const isBuy = type === "ENTRY_SIGNAL_PENDING";
  const action = isBuy ? "CONFIRMED BUY ORDER" : "CONFIRMED FULL EXIT";
  const quantityLabel = isBuy ? "Approx Buy Qty" : "Approx Sell Qty";
  const percentage = Number.isFinite(allocation.fundPct)
    ? `${formatNumber(allocation.fundPct)}%`
    : "NA";
  return [
    `<b>${action} | ${symbol}</b>`,
    `${quantityLabel}: <b>${formatNumber(allocation.quantity)}</b>`,
    `Order Value: <b>Rs ${formatNumber(allocation.value)}</b>`,
    `Fund Allocation: <b>${percentage}</b>`,
    `<i>Capital/risk reserved | Execution: next valid session 09:17 IST</i>`
  ].join("\n");
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
