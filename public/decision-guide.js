const MAX_EXECUTION_GAP_PCT = 3;

export function buildDecisionGuide(row = {}, trade = null, candidate = null) {
  const currentPrice = firstFinite(row.close, candidate?.latestClose, trade?.lastPrice);
  const stop = firstFinite(
    trade?.trailingStopPrice,
    trade?.initialStopPrice,
    candidate?.plannedStopPrice,
    structuralReference(row, currentPrice)
  );
  const action = decisionAction(row, trade, candidate);
  const entry = entryGuide(row, trade, candidate, currentPrice);
  const review = reviewGuide(row, stop, currentPrice);

  return {
    ...action,
    levels: [
      {
        label: trade ? "Position Entry" : "Entry Range",
        value: entry.value,
        note: entry.note,
        tone: "entry"
      },
      exitGuide(trade, action, stop),
      {
        label: "Stop-loss",
        value: finite(stop) ? money(stop) : "Not available",
      note: finite(stop) ? "Weekly EMA13-Low structural stop at entry; any later trailing stop never moves downward." : "Awaiting a valid Weekly EMA13-Low structural level.",
        tone: "stop"
      },
      {
        label: "Review Range",
        value: review.value,
        note: review.note,
        tone: "review"
      }
    ],
    currentPrice: finite(currentPrice) ? currentPrice : null,
    stopPrice: finite(stop) ? stop : null,
    supportSources: review.sources
  };
}

function decisionAction(row, trade, candidate) {
  const status = String(trade?.status || candidate?.status || row.status || "WATCH").toUpperCase();
  const management = trade?.latestManagementDecision || {};
  const trendHealthy = healthyTrend(row);

  if (status === "PENDING_EXIT" || management.action === "FULL_EXIT") {
    return actionSummary("FULL EXIT", "exit", "Why exit", compactReasons(trade?.exitReason, row.signalReason) ||
      "A compulsory close-basis exit or structural stop rule has triggered; execute at the next actual 09:17 session price.");
  }
  if (status === "PENDING_PARTIAL_EXIT" || management.action === "PARTIAL_EXIT") {
    return actionSummary("PARTIAL EXIT", "partial", "Why reduce", compactReasons(trade?.pendingPartialExitReason, management.reasons) ||
      "Confirmed multi-factor deterioration requires risk reduction while the balance remains on a trailing stop.");
  }
  if (trade?.pendingAdd?.kind === "CONTROLLED_RETEST") {
    return actionSummary("ADD RETEST", "add", "Why add", compactReasons(trade?.pendingAdd?.reason, trade?.lastControlledRetestDecision?.reasons) ||
      "A single planned retest tranche is confirmed after support and reclaim, with combined stock risk capped at 1%.");
  }
  if (trade?.pendingAdd || management.action === "ADD") {
    return actionSummary("ADD WINNER", "add", "Why add", compactReasons(trade?.pendingAdd?.reason, trade?.lastPyramidDecision?.reasons) ||
      "A controlled post-entry pullback and fresh swing-high closing break are confirmed with risk capacity available.");
  }
  if (status === "PENDING_ENTRY") {
    return actionSummary("BUY AT 09:17", "buy", "Why buy", buySummary(row));
  }
  if (trade && status === "OPEN") {
    if (trendHealthy) {
      return actionSummary("RIDE TREND", "hold", "Why hold", "Weekly and daily leadership, RSI and Supertrend structure remain healthy. Keep trailing the stop; add only after a valid pullback swing-high closing break.");
    }
    const weakness = trade.currentWeakness || {};
    return actionSummary("REVIEW / HOLD", "review", "Why review", compactReasons(management.reasons, weakness.reasons) ||
      "The position is under review, but confirmed full or partial exit conditions are not yet complete.");
  }
  if (candidate) {
    const reason = String(candidate.skipReason || candidate.lastDecision?.reason || "");
    if (/cash|capital|fund|slot|risk capacity|portfolio allocation/i.test(reason)) {
      return actionSummary("WAIT FOR FUNDS", "wait", "Why waiting", shortText(reason) ||
        "The entry remains in the queue, but portfolio cash or risk capacity is currently unavailable.");
    }
    if (/confirm/i.test(status) || /confirm/i.test(reason)) {
      return actionSummary("WAIT CONFIRMATION", "wait", "Why waiting", shortText(reason) ||
        "The setup needs another valid completed-close confirmation before it can be funded.");
    }
    if (row.status === "ENTRY") {
      return actionSummary("BUY READY", "buy", "Why buy", buySummary(row, candidate));
    }
    return actionSummary("REVIEW CANDIDATE", "review", "Why review", shortText(reason) ||
      `The latest completed-candle status is ${row.status || "unavailable"}; buy conditions must be valid again before execution.`);
  }
  if (row.status === "EXIT") {
    return actionSummary("EXIT SIGNAL", "exit", "Why exit", compactReasons(row.signalReason) || "A compulsory exit rule has triggered on the completed close.");
  }
  if (row.status === "ENTRY") {
    return actionSummary("BUY SETUP", "buy", "Why buy", buySummary(row));
  }
  return actionSummary("WATCH", "review", "Why watch", compactReasons(row.signalReason) || "The setup is not actionable yet.");
}

function actionSummary(label, tone, reasonLabel, summary) {
  return { label, tone, reasonLabel, summary: shortText(summary, 280) };
}

function entryGuide(row, trade, candidate, currentPrice) {
  if (trade) {
    const fills = [...new Set([trade.initialEntryPrice, trade.entryPrice, ...(trade.addOns || []).map((add) => add.price)]
      .map(number)
      .filter(finite))];
    return {
      value: range(fills),
      note: fills.length > 1 ? "Actual base, controlled-retest and winner-add fill range." : "Actual average/base fill price."
    };
  }

  const values = row.setupStrength?.values || {};
  const style = String(candidate?.entryStyle?.type || row.entryStyle?.type || "");
  if (style === "RETRACEMENT_BUY" && finite(number(values.retracementSupportReference))) {
    const support = number(values.retracementSupportReference);
    const tolerancePct = finite(number(values.retracementSupportProximityPct))
      ? number(values.retracementSupportProximityPct)
      : 3;
    return {
      value: moneyRange(support, support * (1 + tolerancePct / 100)),
      note: "Preferred support/reclaim band; latest ENTRY and 09:17 risk checks must remain valid."
    };
  }

  const breakoutLevels = [values.priorRecentHigh, values.priorBaseHigh, candidate?.firstSignalClose]
    .map(number)
    .filter(finite);
  const breakout = breakoutLevels.length ? Math.max(...breakoutLevels) : null;
  const reference = finite(breakout) ? breakout : currentPrice;
  if (!finite(reference)) return { value: "09:17 recheck", note: "No reliable completed-close price range is available." };
  return {
    value: moneyRange(reference, reference * (1 + MAX_EXECUTION_GAP_PCT / 100)),
    note: "Reference breakout band; actual 09:17 price is revalidated and position-sized before entry."
  };
}

function exitGuide(trade, action, stop) {
  if (action.label === "FULL EXIT") {
    return {
      label: "Exit Range",
      value: "Next session 09:17",
      note: "Use the actual 09:17 one-minute candle open after the close-basis signal.",
      tone: "exit"
    };
  }
  if (action.label === "PARTIAL EXIT") {
    const pct = number(trade?.pendingPartialExitPct);
    return {
      label: "Exit Range",
      value: `${finite(pct) ? `${pct}% at ` : ""}next 09:17`,
      note: "Reduce only the approved quantity and trail the remaining winner.",
      tone: "partial"
    };
  }
  return {
    label: "Exit Range",
    value: finite(stop) ? `Daily close <= ${money(stop)}` : "Rule based",
    note: action.tone === "hold" ? "No fixed profit target; ride the trend until a hard exit trigger." : "Exit only after the configured close-basis rule is confirmed.",
    tone: "exit"
  };
}

function reviewGuide(row, stop, currentPrice) {
  const values = row.setupStrength?.values || {};
  const atr = number(values.atr);
  if (finite(stop) && finite(atr) && atr > 0) {
    const upper = finite(currentPrice) && currentPrice > stop
      ? Math.min(currentPrice, stop + atr)
      : stop + atr;
    return {
      value: moneyRange(stop, upper),
      note: "Stop to one-ATR early-warning band. Entering this zone means review, not an automatic exit.",
      sources: ["stop", "ATR warning band"]
    };
  }
  const candidates = [
    [stop, "stop"],
    [row.weeklyEma13, "Weekly EMA13-Low"],
    [row.dailySupertrend, "Supertrend"],
    [values.smaFast, "50-DMA"],
    [values.fourCandleLow, "4-candle low"],
    [values.fibonacciSupportNearby ? values.fibonacciNearestPrice : null, "Fibonacci support"]
  ]
    .map(([value, source]) => [number(value), source])
    .filter(([value]) => finite(value) && (!finite(currentPrice) || value <= currentPrice * 1.01))
    .sort((a, b) => b[0] - a[0]);
  const unique = [];
  for (const item of candidates) {
    if (!unique.some(([value]) => Math.abs(value - item[0]) < 0.005)) unique.push(item);
    if (unique.length === 2) break;
  }
  if (!unique.length) return { value: "No range", note: "Structural review references are unavailable.", sources: [] };
  const prices = unique.map(([value]) => value);
  return {
    value: range(prices),
    note: `Support cluster: ${unique.map(([, source]) => source).join(" + ")}. Entering this zone means review, not an automatic exit.`,
    sources: unique.map(([, source]) => source)
  };
}

function buySummary(row, candidate = null) {
  const style = candidate?.entryStyle?.label || row.entryStyle?.label || "qualified setup";
  return `Compulsory momentum is valid: weekly/daily RSI above 50, Weekly RS21 and Daily RS55/RS21 above zero, price above Supertrend, and the completed week above Weekly EMA13-Low. ${style}; actual entry still requires the 09:17 structural-risk recheck.`;
}

function structuralReference(row, currentPrice) {
  const values = row.setupStrength?.values || {};
  const weeklyEma = number(row.weeklyEma13 ?? values.weeklyEma13);
  const weeklyAtr = number(row.weeklyAtr ?? values.weeklyAtr);
  if (finite(weeklyEma) && (!finite(currentPrice) || weeklyEma < currentPrice)) {
    const buffer = Math.max(
      finite(currentPrice) ? currentPrice * 0.005 : 0,
      finite(weeklyAtr) ? weeklyAtr * 0.2 : 0
    );
    return weeklyEma - buffer;
  }
  const supports = [row.dailySupertrend, values.fourCandleLow, values.twoCandleLow, values.fibonacciSupportNearby ? values.fibonacciNearestPrice : null]
    .map(number)
    .filter((value) => finite(value) && (!finite(currentPrice) || value < currentPrice));
  return supports.length ? Math.max(...supports) : null;
}

function healthyTrend(row) {
  const values = row.setupStrength?.values || {};
  const smaFast = number(values.smaFast);
  const smaSlow = number(values.smaSlow);
  const weeklyClose = number(row.weeklyClose);
  const weeklyEma = number(row.weeklyEma13);
  return Number(row.weeklyRs) > 0 &&
    Number(row.dailyLongRs) > 0 &&
    Number(row.dailyShortRs) > 0 &&
    Number(row.dailyRsi) >= 50 &&
    Number(row.close) > Number(row.dailySupertrend) &&
    (!finite(weeklyClose) || !finite(weeklyEma) || weeklyClose >= weeklyEma) &&
    (!finite(smaFast) || Number(row.close) > smaFast) &&
    (!finite(smaSlow) || Number(row.close) > smaSlow);
}

function compactReasons(...groups) {
  const values = groups.flatMap((group) => Array.isArray(group) ? group : group ? [group] : []);
  return shortText(values.filter(Boolean).map(String).join(" "));
}

function shortText(value, max = 230) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const clipped = text.slice(0, max);
  const sentence = clipped.lastIndexOf(".");
  return `${clipped.slice(0, sentence > 80 ? sentence + 1 : max).trim()}...`;
}

function range(values) {
  const prices = values.map(number).filter(finite);
  if (!prices.length) return "Not available";
  return moneyRange(Math.min(...prices), Math.max(...prices));
}

function moneyRange(low, high) {
  if (!finite(Number(low))) return "Not available";
  if (!finite(Number(high)) || Math.abs(Number(high) - Number(low)) < 0.005) return money(low);
  return `${money(low)} - ${money(high)}`;
}

function money(value) {
  return `Rs ${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function firstFinite(...values) {
  return values.map(number).find(finite);
}

function number(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return finite(parsed) ? parsed : null;
}

function finite(value) {
  return Number.isFinite(value);
}
