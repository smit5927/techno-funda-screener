export function isTelegramConfigured(config) {
  return Boolean(config.telegram.botToken && config.telegram.chatId);
}

export async function sendTelegramSummary(scan, config) {
  if (!isTelegramConfigured(config)) {
    return { sent: false, reason: "telegram not configured" };
  }

  const events = scan.tradeEvents || [];

  if (events.length === 0 && !config.telegram.sendEmpty) {
    return { sent: false, reason: "no new entry/exit trade events" };
  }

  const text = buildMessage(scan, events);
  const chunks = splitTelegramMessage(text);

  for (const chunk of chunks) {
    const response = await fetch(
      `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: config.telegram.chatId,
          text: chunk,
          disable_web_page_preview: true
        })
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram error ${response.status}: ${body}`);
    }
  }

  return { sent: true, chunks: chunks.length };
}

function buildMessage(scan, events) {
  const lines = [
    "Techno Funda Screener",
    `Scan: ${scan.scannedAt}`,
    `New trade alerts: ${events.length}`,
    `Market snapshot: Total ${scan.summary.total} | Entry candidates ${scan.summary.entry} | Exit candidates ${scan.summary.exit} | Watch ${scan.summary.watch}`,
    `Trade sheet: ${scan.tradeSettings?.scopeLabel || "All NSE Market"} | ${scan.tradeSettings?.qualityLabel || "Best only (A+/A)"}`,
    `Positions open ${scan.tradeSummary?.open ?? 0} | Pending buy ${scan.tradeSummary?.pendingEntry ?? 0} | Pending sell ${scan.tradeSummary?.pendingExit ?? 0}`,
    `P&L realized ${fmt(scan.tradeSummary?.realizedPnl)} | unrealized ${fmt(scan.tradeSummary?.unrealizedPnl)}`,
    ""
  ];

  addListSummary(lines, scan);
  if (events.length === 0) lines.push("", "No new entry/exit trade events after go-live baseline.");
  else addTradeEvents(lines, events);

  return lines.join("\n");
}

function addListSummary(lines, scan) {
  lines.push("LIST SUMMARY");
  for (const list of Object.values(scan.lists || {})) {
    lines.push(
      `${list.label}: Total ${list.summary.total}, Entry ${list.summary.entry}, Exit ${list.summary.exit}, Watch ${list.summary.watch}, Error ${list.summary.error}`
    );
  }
}

function addTradeEvents(lines, events) {
  if (events.length === 0) return;
  lines.push("", "TRADE SHEET UPDATES");
  for (const event of events) {
    const trade = event.trade;
    if (event.type === "ENTRY_TRADE_OPENED") {
      const score = trade.entrySnapshot?.score;
      const setupScore = trade.entrySnapshot?.setupStrengthScore;
      lines.push(
        `BUY FILLED ${trade.symbol} (${trade.listLabel}) signal ${trade.entrySignalDate} | ${trade.entryDate} ${trade.entryTime} @ ${fmt(trade.entryPrice)} | qty ${trade.quantity} | invested ${fmt(trade.investedValue)} | grade ${trade.entrySnapshot?.setupGrade || "NA"} | score ${fmt(score)} setup ${fmt(setupScore)}`
      );
      lines.push(`   Reason: ${(trade.entryReason || []).join(" ")}`);
    }
    if (event.type === "EXIT_TRADE_CLOSED") {
      lines.push(
        `SELL FILLED ${trade.symbol} (${trade.listLabel}) signal ${trade.exitSignalDate} | ${trade.exitDate} ${trade.exitTime} @ ${fmt(trade.exitPrice)} | P&L ${fmt(trade.pnl)} (${fmt(trade.pnlPct)}%)`
      );
      lines.push(`   Reason: ${(trade.exitReason || []).join(" ")}`);
    }
    if (event.type === "ENTRY_SIGNAL_PENDING") {
      lines.push(
        `BUY PENDING ${trade.symbol} | closing signal ${trade.entrySignalDate} | waiting for next session 09:15-09:20 price`
      );
      lines.push(`   Reason: ${(trade.entryReason || []).join(" ")}`);
    }
    if (event.type === "EXIT_SIGNAL_PENDING") {
      lines.push(
        `SELL PENDING ${trade.symbol} | closing signal ${trade.exitSignalDate} | waiting for next session 09:15-09:20 price`
      );
      lines.push(`   Reason: ${(trade.exitReason || []).join(" ")}`);
    }
  }
}

function splitTelegramMessage(text) {
  const maxLength = 3900;
  const lines = text.split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    if (`${current}\n${line}`.length > maxLength) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function fmt(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "NA";
}
