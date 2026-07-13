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
    `Positions open ${scan.tradeSummary?.open ?? 0} | Pending buy ${scan.tradeSummary?.pendingEntry ?? 0} | Pending winner add ${scan.portfolioSummary?.pendingAdds ?? 0} | Pending sell ${scan.tradeSummary?.pendingExit ?? 0}`,
    `P&L realized ${fmt(scan.tradeSummary?.realizedPnl)} | unrealized ${fmt(scan.tradeSummary?.unrealizedPnl)} (${fmt(scan.portfolioSummary?.unrealizedPnlPct)}%)`,
    `Portfolio capital ${fmt(scan.portfolioSummary?.totalCapital)} | deployed ${fmt(scan.portfolioSummary?.deployedCapital)} | cash ${fmt(scan.portfolioSummary?.availableCash)} | risk ${fmt(scan.portfolioSummary?.portfolioRisk)} (${fmt(scan.portfolioSummary?.portfolioRiskPct)}%)`,
    `Portfolio slots ${scan.portfolioSummary?.openPositions ?? 0}/${scan.portfolioSummary?.maxOpenPositions ?? 15} | waiting ranked entries ${scan.portfolioSummary?.waitingCandidates ?? 0}`,
    `Market risk ${scan.portfolioSummary?.marketRiskMode || "NA"} | exposure cap ${fmt(scan.portfolioSummary?.effectiveExposureCapPct)}% | drawdown ${fmt(scan.portfolioSummary?.drawdownPct)}%`,
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
      const coverage = conceptCoverageText(trade);
      const entryStyle = trade.entrySnapshot?.entryStyle?.label || "Entry style NA";
      const gtf = trade.entrySnapshot?.gtfContext || {};
      const buyLabel = trade.rotationSourceSymbol ? "ROTATION BUY FILLED" : "BUY FILLED";
      lines.push(
        `${buyLabel} ${trade.symbol} (${trade.listLabel}) signal ${trade.entrySignalDate} | ${trade.entryDate} ${trade.entryTime} @ ${fmt(trade.entryPrice)} | qty ${trade.quantity} | invested ${fmt(trade.investedValue)} | stop ${fmt(trade.initialStopPrice)} | risk ${fmt(trade.initialRiskAmount)} | rank ${fmt(trade.positionRank)} | ${entryStyle} | grade ${trade.entrySnapshot?.setupGrade || "NA"} | score ${fmt(score)} setup ${fmt(setupScore)} | GTF ${gtf.dataAvailable ? `${fmt(gtf.score)}/${fmt(gtf.maxScore)} ${gtf.grade || ""}` : "NA"} | RHTF ${gtf.reactingFromHtf?.active ? gtf.reactingFromHtf.zone?.timeframe || "YES" : "NO"} | concepts ${coverage}`
      );
      if (trade.rotationSourceSymbol) {
        lines.push(`   Atomic rotation: sold ${trade.rotationSourceSymbol} and bought ${trade.symbol} in the same ${trade.entryDate} ${trade.entryTime} execution slot; released cash was reused immediately.`);
      }
      lines.push(`   Reason: ${(trade.entryReason || []).join(" ")}`);
    }
    if (event.type === "EXIT_TRADE_CLOSED") {
      const sellLabel = trade.exitType === "QUALITY_ROTATION" ? "ROTATION SELL FILLED" : "SELL FILLED";
      lines.push(
        `${sellLabel} ${trade.symbol} (${trade.listLabel}) signal ${trade.exitSignalDate} | ${trade.exitDate} ${trade.exitTime} @ ${fmt(trade.exitPrice)} | P&L ${fmt(trade.pnl)} (${fmt(trade.pnlPct)}%) | replacement ${trade.replacementCandidateSymbol || "NA"}`
      );
      lines.push(`   Reason: ${(trade.exitReason || []).join(" ")}`);
    }
    if (event.type === "ENTRY_SIGNAL_PENDING") {
      lines.push(
        `BUY PENDING ${trade.symbol} | closing signal ${trade.entrySignalDate} | ${trade.entrySnapshot?.entryStyle?.label || "Entry style NA"} | waiting for next actual market session exact 09:17 one-minute candle open (weekends/holidays skipped) | concepts ${conceptCoverageText(trade)}`
      );
      const gtf = trade.entrySnapshot?.gtfContext || {};
      if (gtf.dataAvailable) lines.push(`   GTF: ${fmt(gtf.score)}/${fmt(gtf.maxScore)} ${gtf.grade || ""}. ${(gtf.reasons || []).join(" ")}`);
      if (trade.rotationSourceSymbol) lines.push(`   Same-slot rotation from ${trade.rotationSourceSymbol}; buy cannot move to a fictional later session.`);
      lines.push(`   Reason: ${(trade.entryReason || []).join(" ")}`);
    }
    if (event.type === "EXIT_SIGNAL_PENDING") {
      lines.push(
        `SELL PENDING ${trade.symbol} | closing signal ${trade.exitSignalDate} | waiting for next actual market session exact 09:17 one-minute candle open (weekends/holidays skipped)`
      );
      lines.push(`   Reason: ${(trade.exitReason || []).join(" ")}`);
    }
    if (["PORTFOLIO_EXIT_PENDING", "ROTATION_EXIT_PENDING"].includes(event.type)) {
      lines.push(
        `PORTFOLIO SELL PENDING ${trade.symbol} | type ${trade.exitType || "REBALANCE"} | replacement ${trade.replacementCandidateSymbol || event.candidate?.symbol || "NA"} | next market session 09:17 IST`
      );
      lines.push(`   Reason: ${(trade.exitReason || []).join(" ")}`);
    }
    if (event.type === "PARTIAL_EXIT_PENDING") {
      lines.push(
        `PARTIAL SELL PENDING ${trade.symbol} | ${trade.pendingPartialExitPct || 50}% | next market session 09:17 IST`
      );
      lines.push(`   Reason: ${(trade.pendingPartialExitReason || []).join(" ")}`);
    }
    if (event.type === "PARTIAL_EXIT_FILLED") {
      const leg = trade.partialExits?.[trade.partialExits.length - 1];
      lines.push(
        `PARTIAL SELL FILLED ${trade.symbol} | ${leg?.date || ""} @ ${fmt(leg?.price)} | qty ${leg?.quantity ?? "NA"} | leg P&L ${fmt(leg?.pnl)} | remaining qty ${trade.quantity}`
      );
    }
    if (event.type === "ENTRY_SKIPPED") {
      const candidate = event.candidate || {};
      lines.push(
        `ENTRY WAITING ${candidate.symbol || trade?.symbol || "NA"} | grade ${candidate.grade || "NA"} | rank ${fmt(candidate.rank)} | no buy executed`
      );
      lines.push(`   Reason: ${candidate.skipReason || trade?.skipReason || "Portfolio constraint"}`);
    }
    if (event.type === "PYRAMID_ADD_PENDING") {
      const add = trade.pendingAdd || {};
      lines.push(
        `WINNER ADD PENDING ${trade.symbol} | breakout signal ${add.signalDate || "NA"} | ${add.breakoutType || "BREAKOUT"} above ${fmt(add.breakoutLevel)} | planned qty ${add.plannedQuantity ?? "NA"} allocation ${fmt(add.plannedAllocation)} risk ${fmt(add.plannedRisk)} | next actual session exact 09:17`
      );
      lines.push(`   Reason: ${(add.reason || []).join(" ")}`);
    }
    if (event.type === "PYRAMID_ADD_FILLED") {
      const add = trade.addOns?.[trade.addOns.length - 1];
      lines.push(
        `WINNER ADD FILLED ${trade.symbol} | add #${add?.number ?? "NA"} | ${add?.date || ""} ${add?.time || ""} @ ${fmt(add?.price)} | qty ${add?.quantity ?? "NA"} | blended average ${fmt(trade.entryPrice)} | total qty ${trade.quantity} | trailing stop ${fmt(trade.trailingStopPrice)}`
      );
    }
    if (event.type === "PYRAMID_ADD_SKIPPED") {
      lines.push(
        `WINNER ADD SKIPPED ${trade.symbol} | no buy executed | ${trade.executionError || trade.lastPyramidDecision?.reasons?.join(" ") || "Risk constraint"}`
      );
    }
  }
}

function conceptCoverageText(trade) {
  const coverage = trade.entrySnapshot?.conceptCoverage;
  if (!coverage?.applicable) return "NA";
  return `${coverage.passed}/${coverage.applicable}`;
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
