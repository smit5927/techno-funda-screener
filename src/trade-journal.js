import fs from "node:fs";
import ExcelJS from "exceljs";
import { appConfig } from "./config.js";
import { readTrades, saveTrades } from "./storage.js";
import { fetchOpeningWindowPrice } from "./yahoo.js";

const TRADE_SCOPE_LABELS = {
  "all-market": "All NSE Market",
  default: "Nifty 500",
  custom: "My List"
};

const TRADE_QUALITY_LABELS = {
  BEST_ONLY: "Best only (A+/A)",
  STRONG_OR_BETTER: "Strong and best (A+/A/B)",
  ALL_ENTRIES: "All entry signals"
};

export async function updateTradeJournal(scan, config = appConfig) {
  const journal = readTrades();
  const settings = tradeSettingsSummary(config);
  const liveMode = config.trade.onlyNewSignals !== false;
  const firstLiveScan = liveMode && !journal.liveModeStartedAt;
  const trades = firstLiveScan ? [] : Array.isArray(journal.trades) ? journal.trades : [];
  const signalState =
    journal.signalState && typeof journal.signalState === "object" ? journal.signalState : {};
  const nextSignalState = { ...signalState };
  const events = [];
  const rows = uniqueScannedRows(scan, settings.scopeListId);

  migrateTradeMetadata(trades);
  await migrateLegacyOpeningPrices(trades, config);

  for (const row of rows) {
    const key = signalStateKey(settings.scopeListId, row);
    const previousStatus = previousSymbolStatus(signalState, key, row, settings.scopeListId);
    let activeTrade = findActiveTrade(trades, row, settings);

    if (activeTrade?.status === "PENDING_ENTRY") {
      const filled = await fillEntry(activeTrade, row, config);
      if (filled) events.push({ type: "ENTRY_TRADE_OPENED", trade: activeTrade });
    }

    if (activeTrade?.status === "OPEN") {
      markToMarket(activeTrade, row);
    }

    if (activeTrade?.status === "PENDING_EXIT") {
      const filled = await fillExit(activeTrade, row);
      if (filled) events.push({ type: "EXIT_TRADE_CLOSED", trade: activeTrade });
    }

    activeTrade = findActiveTrade(trades, row, settings);

    const isEstablishedSignal = previousStatus != null;
    if (
      !firstLiveScan &&
      isEstablishedSignal &&
      row.status === "ENTRY" &&
      previousStatus !== "ENTRY" &&
      !activeTrade &&
      rowPassesTradeQuality(row, settings)
    ) {
      const trade = createPendingEntry(row, scan, config, settings);
      trades.push(trade);
      const filled = await fillEntry(trade, row, config);
      events.push({
        type: filled ? "ENTRY_TRADE_OPENED" : "ENTRY_SIGNAL_PENDING",
        trade
      });
      activeTrade = trade;
    }

    if (row.status === "EXIT" && activeTrade?.status === "OPEN") {
      preparePendingExit(activeTrade, row, scan);
      const filled = await fillExit(activeTrade, row);
      events.push({
        type: filled ? "EXIT_TRADE_CLOSED" : "EXIT_SIGNAL_PENDING",
        trade: activeTrade
      });
    }

    nextSignalState[key] = {
      status: row.status,
      asOf: row.asOf,
      scannedAt: scan.scannedAt,
      scopeListId: settings.scopeListId
    };
  }

  const nextJournal = {
    updatedAt: new Date().toISOString(),
    liveModeStartedAt: journal.liveModeStartedAt || (liveMode ? new Date().toISOString() : null),
    baselineInitialized: true,
    baselineScanAt: journal.baselineScanAt || (firstLiveScan ? scan.scannedAt : null),
    executionRule: {
      signalBasis: "completed daily/weekly closing candle",
      sessionRule: "first actual exchange session after the signal date; weekends and market holidays are skipped",
      window: `${config.trade.executionWindowStart}-${config.trade.executionWindowEnd} IST`,
      priceSource: config.trade.executionPriceSource
    },
    signalState: nextSignalState,
    tradeCapitalPerStock: config.trade.capitalPerStock,
    tradeSettings: settings,
    trades: trades.sort(sortTrades)
  };
  saveTrades(nextJournal);
  const visibleTrades = visibleTradesForSettings(nextJournal.trades, settings);
  await writeTradeSheets({ ...nextJournal, trades: visibleTrades }, config);
  return { ...nextJournal, visibleTrades, events };
}

export async function writeTradeSheets(journal, config = appConfig) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const settings = journal.tradeSettings || tradeSettingsSummary(config);
  const sheetJournal = {
    ...journal,
    tradeSettings: settings,
    trades: visibleTradesForSettings(journal.trades || [], settings)
  };
  await writeXlsx(sheetJournal, config.tradeSheetPath);
  writeCsv(sheetJournal, config.tradeCsvPath);
}

export function tradeSettingsSummary(config = appConfig) {
  const scopeListId = normalizeTradeScope(config.trade?.scopeListId);
  const qualityMode = normalizeTradeQuality(config.trade?.qualityMode);
  return {
    scopeListId,
    scopeLabel: TRADE_SCOPE_LABELS[scopeListId],
    qualityMode,
    qualityLabel: TRADE_QUALITY_LABELS[qualityMode],
    capitalPerStock: config.trade?.capitalPerStock ?? 100000,
    executionWindow: `${config.trade?.executionWindowStart || "09:15"}-${config.trade?.executionWindowEnd || "09:20"} IST`
  };
}

export function rowPassesTradeQuality(row, settingsOrConfig = appConfig) {
  const settings = settingsOrConfig.trade ? tradeSettingsSummary(settingsOrConfig) : settingsOrConfig;
  const mode = normalizeTradeQuality(settings.qualityMode);
  if (mode === "ALL_ENTRIES") return true;
  const grade = String(row.setupGrade || "").toUpperCase();
  if (mode === "STRONG_OR_BETTER") return ["A+", "A", "B"].includes(grade);
  return ["A+", "A"].includes(grade);
}

function createPendingEntry(row, scan, config, settings) {
  const sourceLists = row.sourceLists || [row.listLabel].filter(Boolean);
  return {
    id: `${row.symbol}-${row.asOf}-${Date.now()}`,
    listId: row.listId,
    listLabel: sourceLists.join(", "),
    sourceLists,
    tradeScope: settings.scopeListId,
    tradeScopeLabel: settings.scopeLabel,
    tradeQualityMode: settings.qualityMode,
    tradeQualityLabel: settings.qualityLabel,
    symbol: row.symbol,
    yahooSymbol: row.yahooSymbol,
    name: row.name,
    status: "PENDING_ENTRY",
    entrySignalDate: row.asOf,
    entrySignalScanAt: scan.scannedAt,
    entryDate: null,
    entryTime: null,
    entryPrice: null,
    executionWindow: `${config.trade.executionWindowStart}-${config.trade.executionWindowEnd} IST`,
    executionMethod: config.trade.executionPriceSource,
    quantity: null,
    investedValue: null,
    entryReason: [
      ...(row.signalReason || row.entryReason || []),
      `Trade sheet filter: ${settings.scopeLabel}, ${settings.qualityLabel}.`,
      `Closing signal dated ${row.asOf}; buy fill must come from the next actual market session 09:15-09:20 IST window, after skipping weekends and exchange holidays.`
    ],
    entrySnapshot: snapshot(row),
    exitSignalDate: null,
    exitSignalScanAt: null,
    exitDate: null,
    exitTime: null,
    exitPrice: null,
    exitReason: [],
    lastPrice: row.close,
    lastPriceDate: row.asOf,
    unrealizedPnl: null,
    unrealizedPnlPct: null,
    pnl: null,
    pnlPct: null,
    holdingDays: null
  };
}

function preparePendingExit(trade, row, scan) {
  trade.status = "PENDING_EXIT";
  trade.exitSignalDate = row.asOf;
  trade.exitSignalScanAt = scan.scannedAt;
  trade.exitReason = [
    ...(row.signalReason || row.exitReason || []),
    `Closing exit signal dated ${row.asOf}; sell fill must come from the next actual market session 09:15-09:20 IST window, after skipping weekends and exchange holidays.`
  ];
  trade.exitSnapshot = snapshot(row);
  markToMarket(trade, row);
}

async function fillEntry(trade, row, config) {
  try {
    const fill = await fetchOpeningWindowPrice(
      trade.yahooSymbol || row.yahooSymbol,
      trade.entrySignalDate
    );
    if (!fill) {
      trade.executionError =
        "Next market-session 09:15 candle is not available yet; pending through weekends and NSE holidays.";
      return false;
    }
    const quantity = calculateQuantity(fill.price, config);
    trade.status = "OPEN";
    trade.entryDate = fill.date;
    trade.entryTime = "09:15 IST";
    trade.entryPrice = round(fill.price);
    trade.quantity = quantity;
    trade.investedValue = round(quantity * fill.price);
    trade.executionMethod = fill.source;
    trade.executionWindow = fill.window;
    trade.executionError = null;
    markToMarket(trade, row);
    return true;
  } catch (error) {
    trade.executionError = error.message || String(error);
    return false;
  }
}

async function fillExit(trade, row) {
  try {
    const fill = await fetchOpeningWindowPrice(
      trade.yahooSymbol || row.yahooSymbol,
      trade.exitSignalDate
    );
    if (!fill) {
      trade.executionError =
        "Next market-session 09:15 candle is not available yet; pending through weekends and NSE holidays.";
      return false;
    }
    trade.status = "CLOSED";
    trade.exitDate = fill.date;
    trade.exitTime = "09:15 IST";
    trade.exitPrice = round(fill.price);
    trade.executionError = null;
    trade.pnl = round((fill.price - trade.entryPrice) * trade.quantity);
    trade.pnlPct = round(((fill.price / trade.entryPrice) - 1) * 100);
    trade.holdingDays = holdingDays(trade.entryDate, fill.date);
    trade.lastPrice = round(fill.price);
    trade.lastPriceDate = fill.date;
    trade.unrealizedPnl = null;
    trade.unrealizedPnlPct = null;
    return true;
  } catch (error) {
    trade.executionError = error.message || String(error);
    return false;
  }
}

function markToMarket(trade, row) {
  if (!Number.isFinite(row.close)) return;
  trade.lastPrice = round(row.close);
  trade.lastPriceDate = row.asOf;
  if (!Number.isFinite(trade.entryPrice) || !Number.isFinite(trade.quantity)) return;
  trade.unrealizedPnl = round((row.close - trade.entryPrice) * trade.quantity);
  trade.unrealizedPnlPct = round(((row.close / trade.entryPrice) - 1) * 100);
}

async function migrateLegacyOpeningPrices(trades, config) {
  for (const trade of trades) {
    if (trade.entrySignalDate || !trade.entryDate || !Number.isFinite(trade.entryPrice)) continue;
    const oldSignalDate = trade.entryDate;
    trade.entrySignalDate = oldSignalDate;
    trade.entrySignalScanAt = trade.entryScanAt || null;
    trade.yahooSymbol = trade.yahooSymbol || `${trade.symbol}.NS`;
    try {
      const fill = await fetchOpeningWindowPrice(trade.yahooSymbol, oldSignalDate);
      if (!fill) {
        trade.executionMethod = "legacy_closing_price";
        continue;
      }
      trade.entryDate = fill.date;
      trade.entryTime = "09:15 IST";
      trade.entryPrice = round(fill.price);
      trade.quantity = calculateQuantity(fill.price, config);
      trade.investedValue = round(trade.quantity * fill.price);
      trade.executionMethod = fill.source;
      trade.executionWindow = fill.window;
      trade.migratedToOpeningWindow = true;
    } catch {
      trade.executionMethod = "legacy_closing_price";
    }
  }
}

function migrateTradeMetadata(trades) {
  for (const trade of trades) {
    trade.tradeScope = inferTradeScope(trade);
    trade.tradeScopeLabel = TRADE_SCOPE_LABELS[trade.tradeScope];
    trade.tradeQualityMode = trade.tradeQualityMode || "LEGACY";
    trade.tradeQualityLabel = trade.tradeQualityLabel || "Legacy trade";
  }
}

function uniqueScannedRows(scan, scopeListId) {
  const scannedIds = new Set(scan.scannedListIds || Object.keys(scan.lists || {}));
  const primary = scan.lists?.[scopeListId];
  if (!primary || !scannedIds.has(scopeListId)) return [];

  const sourceListsByKey = new Map();
  for (const list of Object.values(scan.lists || {})) {
    if (!scannedIds.has(list.id)) continue;
    for (const row of list.results || []) {
      const key = row.yahooSymbol || row.symbol;
      if (!key) continue;
      const labels = sourceListsByKey.get(key) || [];
      if (row.listLabel && !labels.includes(row.listLabel)) labels.push(row.listLabel);
      sourceListsByKey.set(key, labels);
    }
  }

  const grouped = new Map();
  for (const row of primary.results || []) {
    const key = row.yahooSymbol || row.symbol;
    if (!key || grouped.has(key)) continue;
    grouped.set(key, {
      ...row,
      sourceLists: sourceListsByKey.get(key) || [row.listLabel].filter(Boolean)
    });
  }
  return [...grouped.values()];
}

function signalStateKey(scopeListId, row) {
  return `${scopeListId}:${row.yahooSymbol || row.symbol}`;
}

function previousSymbolStatus(signalState, scopedKey, row, scopeListId) {
  if (signalState[scopedKey]?.status) return signalState[scopedKey].status;
  const yahooSymbol = row.yahooSymbol || row.symbol;
  const displaySymbol = row.symbol;
  const exactKeys = [`${scopeListId}:${displaySymbol}`, `${scopeListId}:${yahooSymbol}`];
  if (scopeListId === "all-market") exactKeys.push(yahooSymbol, displaySymbol);
  for (const key of exactKeys) {
    if (signalState[key]?.status) return signalState[key].status;
  }

  const suffixes = [`:${displaySymbol}`, `:${yahooSymbol}`];
  for (const [key, value] of Object.entries(signalState)) {
    if (
      key.startsWith(`${scopeListId}:`) &&
      suffixes.some((suffix) => key.endsWith(suffix)) &&
      value?.status
    ) {
      return value.status;
    }
  }
  return null;
}

function findActiveTrade(trades, row, settings) {
  return trades.find(
    (trade) =>
      ["PENDING_ENTRY", "OPEN", "PENDING_EXIT"].includes(trade.status) &&
      sameInstrument(trade, row) &&
      tradeMatchesSettings(trade, settings)
  );
}

function visibleTradesForSettings(trades, settings) {
  return trades.filter((trade) => tradeMatchesSettings(trade, settings));
}

function tradeMatchesSettings(trade, settings) {
  return (
    inferTradeScope(trade) === settings.scopeListId &&
    tradePassesQuality(trade, settings.qualityMode)
  );
}

function tradePassesQuality(trade, qualityMode) {
  const mode = normalizeTradeQuality(qualityMode);
  if (mode === "ALL_ENTRIES") return true;
  const grade = String(trade.entrySnapshot?.setupGrade || "").toUpperCase();
  if (mode === "STRONG_OR_BETTER") return ["A+", "A", "B"].includes(grade);
  return ["A+", "A"].includes(grade);
}

function inferTradeScope(trade) {
  if (TRADE_SCOPE_LABELS[trade.tradeScope]) return trade.tradeScope;
  if (TRADE_SCOPE_LABELS[trade.listId]) return trade.listId;
  const source = [trade.listLabel, ...(trade.sourceLists || [])].join(" ").toLowerCase();
  if (source.includes("my custom") || source.includes("my list")) return "custom";
  if (source.includes("nifty")) return "default";
  if (source.includes("all nse")) return "all-market";
  return "default";
}

function sameInstrument(trade, row) {
  if (trade.yahooSymbol && row.yahooSymbol) return trade.yahooSymbol === row.yahooSymbol;
  return trade.symbol === row.symbol;
}

function calculateQuantity(price, config) {
  if (Number.isFinite(config.trade.capitalPerStock) && config.trade.capitalPerStock > 0) {
    return Math.max(1, Math.floor(config.trade.capitalPerStock / price));
  }
  return config.trade.defaultQty;
}

async function writeXlsx(journal, filePath) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Techno Funda Screener";
  workbook.created = new Date();

  const pending = journal.trades.filter((trade) => trade.status.startsWith("PENDING_"));
  const open = journal.trades.filter((trade) => trade.status === "OPEN");
  const closed = journal.trades.filter((trade) => trade.status === "CLOSED");
  const realizedPnl = closed.reduce((sum, trade) => sum + (trade.pnl || 0), 0);
  const unrealizedPnl = open.reduce((sum, trade) => sum + (trade.unrealizedPnl || 0), 0);

  const summary = workbook.addWorksheet("Summary");
  summary.columns = [
    { header: "Metric", key: "metric", width: 34 },
    { header: "Value", key: "value", width: 32 }
  ];
  summary.addRows([
    { metric: "Updated At", value: journal.updatedAt },
    { metric: "Pending Orders", value: pending.length },
    { metric: "Open Positions", value: open.length },
    { metric: "Closed Trades", value: closed.length },
    { metric: "Realized P&L", value: round(realizedPnl) },
    { metric: "Unrealized P&L", value: round(unrealizedPnl) },
    { metric: "Capital Per Stock", value: journal.tradeCapitalPerStock },
    { metric: "Trade Scope", value: journal.tradeSettings?.scopeLabel || "" },
    { metric: "Trade Quality", value: journal.tradeSettings?.qualityLabel || "" },
    { metric: "Signal Basis", value: journal.executionRule?.signalBasis || "" },
    { metric: "Session Rule", value: journal.executionRule?.sessionRule || "Skip weekends and market holidays" },
    { metric: "Execution Window", value: journal.executionRule?.window || "09:15-09:20 IST" },
    { metric: "Execution Price", value: "First 5-minute candle open (09:15)" }
  ]);

  addTradeWorksheet(workbook, "Open Positions", open);
  addTradeWorksheet(workbook, "Pending Orders", pending);
  addTradeWorksheet(workbook, "Closed Trades", closed);
  addTradeWorksheet(workbook, "All Trades", journal.trades);

  await workbook.xlsx.writeFile(filePath);
}

function addTradeWorksheet(workbook, name, trades) {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = tradeColumns();
  sheet.addRows(trades.map(tradeToRow));
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  formatSheet(sheet);
}

function writeCsv(journal, filePath) {
  const headers = tradeColumns().map((column) => column.header);
  const lines = [headers.join(",")];
  for (const trade of journal.trades) {
    const row = tradeToRow(trade);
    lines.push(headers.map((header) => csvValue(row[header])).join(","));
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function tradeColumns() {
  return [
    { header: "Trade Scope", key: "Trade Scope", width: 18 },
    { header: "Trade Quality", key: "Trade Quality", width: 22 },
    { header: "Source Lists", key: "Source Lists", width: 28 },
    { header: "Symbol", key: "Symbol", width: 14 },
    { header: "Name", key: "Name", width: 28 },
    { header: "Status", key: "Status", width: 16 },
    { header: "Entry Signal Date", key: "Entry Signal Date", width: 18 },
    { header: "Entry Date", key: "Entry Date", width: 14 },
    { header: "Entry Time", key: "Entry Time", width: 13 },
    { header: "Entry Price", key: "Entry Price", width: 14 },
    { header: "Quantity", key: "Quantity", width: 10 },
    { header: "Invested Value", key: "Invested Value", width: 16 },
    { header: "Last Close", key: "Last Close", width: 14 },
    { header: "Unrealized P&L", key: "Unrealized P&L", width: 16 },
    { header: "Unrealized P&L %", key: "Unrealized P&L %", width: 18 },
    { header: "Exit Signal Date", key: "Exit Signal Date", width: 18 },
    { header: "Exit Date", key: "Exit Date", width: 14 },
    { header: "Exit Time", key: "Exit Time", width: 13 },
    { header: "Exit Price", key: "Exit Price", width: 14 },
    { header: "Realized P&L", key: "Realized P&L", width: 16 },
    { header: "Realized P&L %", key: "Realized P&L %", width: 18 },
    { header: "Holding Days", key: "Holding Days", width: 14 },
    { header: "Execution Window", key: "Execution Window", width: 20 },
    { header: "Entry Style", key: "Entry Style", width: 26 },
    { header: "Setup Grade", key: "Setup Grade", width: 13 },
    { header: "Setup Score", key: "Setup Score", width: 14 },
    { header: "Fundamental Score", key: "Fundamental Score", width: 18 },
    { header: "Institutional Score", key: "Institutional Score", width: 18 },
    { header: "Index Context", key: "Index Context", width: 34 },
    { header: "Derivatives Context", key: "Derivatives Context", width: 34 },
    { header: "Options Context", key: "Options Context", width: 34 },
    { header: "Commodity Context", key: "Commodity Context", width: 34 },
    { header: "Concept Score", key: "Concept Score", width: 16 },
    { header: "Strong Concepts", key: "Strong Concepts", width: 42 },
    { header: "Weak Concepts", key: "Weak Concepts", width: 42 },
    { header: "Data Gaps", key: "Data Gaps", width: 30 },
    { header: "Excluded Playbooks", key: "Excluded Playbooks", width: 36 },
    { header: "Sector Breadth", key: "Sector Breadth", width: 18 },
    { header: "Near 52W High", key: "Near 52W High", width: 14 },
    { header: "55D Breakout", key: "55D Breakout", width: 14 },
    { header: "Volume Ratio", key: "Volume Ratio", width: 14 },
    { header: "ATR %", key: "ATR %", width: 12 },
    { header: "Risk To ST %", key: "Risk To ST %", width: 14 },
    { header: "Retracement Buy", key: "Retracement Buy", width: 18 },
    { header: "Pullback Depth %", key: "Pullback Depth %", width: 18 },
    { header: "Pullback Support", key: "Pullback Support", width: 20 },
    { header: "Pullback Risk %", key: "Pullback Risk %", width: 18 },
    { header: "Pullback Volume Ratio", key: "Pullback Volume Ratio", width: 22 },
    { header: "Reclaim Volume Ratio", key: "Reclaim Volume Ratio", width: 22 },
    { header: "Candle Pattern", key: "Candle Pattern", width: 24 },
    { header: "Previous Low", key: "Previous Low", width: 14 },
    { header: "2 Candle Low", key: "2 Candle Low", width: 14 },
    { header: "4 Candle Low", key: "4 Candle Low", width: 14 },
    { header: "Entry Reason", key: "Entry Reason", width: 60 },
    { header: "Exit Reason", key: "Exit Reason", width: 60 }
  ];
}

function tradeToRow(trade) {
  const setup = trade.entrySnapshot?.setupStrength || {};
  const values = setup.values || {};
  const checks = setup.checks || {};
  const sector = trade.entrySnapshot?.sectorStrength || {};
  const coverage = trade.entrySnapshot?.conceptCoverage || {};
  const institutional = trade.entrySnapshot?.institutionalContext || {};
  return {
    "Trade Scope": trade.tradeScopeLabel || TRADE_SCOPE_LABELS[inferTradeScope(trade)] || "",
    "Trade Quality": trade.tradeQualityLabel || "",
    "Source Lists": (trade.sourceLists || [trade.listLabel]).filter(Boolean).join(", "),
    Symbol: trade.symbol,
    Name: trade.name,
    Status: trade.status,
    "Entry Signal Date": trade.entrySignalDate || "",
    "Entry Date": trade.entryDate || "",
    "Entry Time": trade.entryTime || "",
    "Entry Price": trade.entryPrice ?? "",
    Quantity: trade.quantity ?? "",
    "Invested Value": trade.investedValue ?? "",
    "Last Close": trade.lastPrice ?? "",
    "Unrealized P&L": trade.unrealizedPnl ?? "",
    "Unrealized P&L %": trade.unrealizedPnlPct ?? "",
    "Exit Signal Date": trade.exitSignalDate || "",
    "Exit Date": trade.exitDate || "",
    "Exit Time": trade.exitTime || "",
    "Exit Price": trade.exitPrice ?? "",
    "Realized P&L": trade.pnl ?? "",
    "Realized P&L %": trade.pnlPct ?? "",
    "Holding Days": trade.holdingDays ?? "",
    "Execution Window": trade.executionWindow || "",
    "Entry Style": trade.entrySnapshot?.entryStyle?.label || "",
    "Setup Grade": trade.entrySnapshot?.setupGrade || "",
    "Setup Score": trade.entrySnapshot?.setupStrengthScore ?? "",
    "Fundamental Score": trade.entrySnapshot?.fundamentalScore ?? "",
    "Institutional Score": institutional.maxScore ? `${institutional.score}/${institutional.maxScore}` : "",
    "Index Context": institutional.index?.reason || "",
    "Derivatives Context": institutional.derivatives?.reason || "",
    "Options Context": institutional.options?.reason || "",
    "Commodity Context": institutional.commodity?.reason || "",
    "Concept Score": coverage.applicable ? `${coverage.passed}/${coverage.applicable}` : "",
    "Strong Concepts": (coverage.passLabels || []).join("; "),
    "Weak Concepts": (coverage.weakLabels || []).join("; "),
    "Data Gaps": (coverage.dataGapLabels || []).join("; "),
    "Excluded Playbooks": (coverage.excludedLabels || []).join("; "),
    "Sector Breadth": Number.isFinite(sector.breadthPct)
      ? `${round(sector.breadthPct)}% (${sector.strong}/${sector.total})`
      : "",
    "Near 52W High": checks.nearYearHigh ? "Yes" : "No",
    "55D Breakout": checks.recentHighBreakout ? "Yes" : "No",
    "Volume Ratio": Number.isFinite(values.volumeRatio) ? round(values.volumeRatio) : "",
    "ATR %": Number.isFinite(values.atrPct) ? round(values.atrPct) : "",
    "Risk To ST %": Number.isFinite(values.riskToSupertrendPct)
      ? round(values.riskToSupertrendPct)
      : "",
    "Retracement Buy": checks.retracementBuyZone ? "Yes" : "No",
    "Pullback Depth %": Number.isFinite(values.retracementPullbackDepthPct)
      ? round(values.retracementPullbackDepthPct)
      : "",
    "Pullback Support": values.retracementSupportSource || "",
    "Pullback Risk %": Number.isFinite(values.retracementSupportDistancePct)
      ? round(values.retracementSupportDistancePct)
      : "",
    "Pullback Volume Ratio": Number.isFinite(values.retracementPullbackVolumeRatio)
      ? round(values.retracementPullbackVolumeRatio)
      : "",
    "Reclaim Volume Ratio": Number.isFinite(values.retracementCurrentVolumeRatio)
      ? round(values.retracementCurrentVolumeRatio)
      : "",
    "Candle Pattern": values.candlePattern || "",
    "Previous Low": Number.isFinite(values.previousLow) ? round(values.previousLow) : "",
    "2 Candle Low": Number.isFinite(values.twoCandleLow) ? round(values.twoCandleLow) : "",
    "4 Candle Low": Number.isFinite(values.fourCandleLow) ? round(values.fourCandleLow) : "",
    "Entry Reason": (trade.entryReason || []).join(" "),
    "Exit Reason": (trade.exitReason || []).join(" ")
  };
}

function formatSheet(sheet) {
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF182026" }
  };
  sheet.autoFilter = {
    from: "A1",
    to: `${sheet.getColumn(sheet.columns.length).letter}1`
  };
  for (const row of sheet.getRows(2, Math.max(0, sheet.rowCount - 1)) || []) {
    for (const key of ["Unrealized P&L", "Realized P&L"]) {
      const cell = row.getCell(key);
      if (Number(cell.value) > 0) cell.font = { color: { argb: "FF147A52" } };
      if (Number(cell.value) < 0) cell.font = { color: { argb: "FFB4232A" } };
    }
  }
}

function snapshot(row) {
  return {
    close: row.close,
    asOf: row.asOf,
    dailyRsi: row.dailyRsi,
    weeklyRsi: row.weeklyRsi,
    weeklyRs: row.weeklyRs,
    dailyLongRs: row.dailyLongRs,
    dailyShortRs: row.dailyShortRs,
    dailySupertrend: row.dailySupertrend,
    dailyPriceAboveSupertrend: row.dailyPriceAboveSupertrend,
    entryStyle: row.entryStyle,
    setupStrength: row.setupStrength,
    setupStrengthScore: row.setupStrengthScore,
    setupGrade: row.setupGrade,
    sectorStrength: row.sectorStrength,
    sectorStrengthScore: row.sectorStrengthScore,
    institutionalContext: row.institutionalContext,
    institutionalScore: row.institutionalScore,
    conceptCoverage: row.conceptCoverage,
    fundamentalScore: row.fundamentalScore,
    fundamental: row.fundamental,
    score: row.score
  };
}

function sortTrades(a, b) {
  const rank = { PENDING_EXIT: 0, PENDING_ENTRY: 1, OPEN: 2, CLOSED: 3 };
  const rankDifference = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
  if (rankDifference !== 0) return rankDifference;
  return String(b.entrySignalDate || b.entryDate || "").localeCompare(
    String(a.entrySignalDate || a.entryDate || "")
  );
}

function holdingDays(entryDate, exitDate) {
  const entry = new Date(entryDate).getTime();
  const exit = new Date(exitDate).getTime();
  if (!Number.isFinite(entry) || !Number.isFinite(exit)) return null;
  return Math.max(0, Math.round((exit - entry) / (24 * 60 * 60 * 1000)));
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function csvValue(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function normalizeTradeScope(scopeListId) {
  return TRADE_SCOPE_LABELS[scopeListId] ? scopeListId : "all-market";
}

function normalizeTradeQuality(qualityMode) {
  return TRADE_QUALITY_LABELS[qualityMode] ? qualityMode : "BEST_ONLY";
}
