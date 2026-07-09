import fs from "node:fs";
import ExcelJS from "exceljs";
import { appConfig } from "./config.js";
import { readTrades, saveTrades } from "./storage.js";
import { fetchOpeningWindowPrice } from "./yahoo.js";

export async function updateTradeJournal(scan, config = appConfig) {
  const journal = readTrades();
  const liveMode = config.trade.onlyNewSignals !== false;
  const firstLiveScan = liveMode && !journal.liveModeStartedAt;
  const trades = firstLiveScan ? [] : Array.isArray(journal.trades) ? journal.trades : [];
  const signalState =
    journal.signalState && typeof journal.signalState === "object" ? journal.signalState : {};
  const nextSignalState = { ...signalState };
  const events = [];
  const rows = uniqueScannedRows(scan);

  await migrateLegacyOpeningPrices(trades, config);

  for (const row of rows) {
    const key = row.yahooSymbol || row.symbol;
    const previousStatus = previousSymbolStatus(signalState, key, row.symbol);
    let activeTrade = trades.find(
      (trade) =>
        ["PENDING_ENTRY", "OPEN", "PENDING_EXIT"].includes(trade.status) &&
        sameInstrument(trade, row)
    );

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

    activeTrade = trades.find(
      (trade) =>
        ["PENDING_ENTRY", "OPEN", "PENDING_EXIT"].includes(trade.status) &&
        sameInstrument(trade, row)
    );

    const isEstablishedSignal = previousStatus != null;
    if (
      !firstLiveScan &&
      isEstablishedSignal &&
      row.status === "ENTRY" &&
      previousStatus !== "ENTRY" &&
      !activeTrade
    ) {
      const trade = createPendingEntry(row, scan, config);
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
      scannedAt: scan.scannedAt
    };
  }

  const nextJournal = {
    updatedAt: new Date().toISOString(),
    liveModeStartedAt: journal.liveModeStartedAt || (liveMode ? new Date().toISOString() : null),
    baselineInitialized: true,
    baselineScanAt: journal.baselineScanAt || (firstLiveScan ? scan.scannedAt : null),
    executionRule: {
      signalBasis: "completed daily/weekly closing candle",
      window: `${config.trade.executionWindowStart}-${config.trade.executionWindowEnd} IST`,
      priceSource: config.trade.executionPriceSource
    },
    signalState: nextSignalState,
    tradeCapitalPerStock: config.trade.capitalPerStock,
    trades: trades.sort(sortTrades)
  };
  saveTrades(nextJournal);
  await writeTradeSheets(nextJournal, config);
  return { ...nextJournal, events };
}

export async function writeTradeSheets(journal, config = appConfig) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  await writeXlsx(journal, config.tradeSheetPath);
  writeCsv(journal, config.tradeCsvPath);
}

function createPendingEntry(row, scan, config) {
  const sourceLists = row.sourceLists || [row.listLabel].filter(Boolean);
  return {
    id: `${row.symbol}-${row.asOf}-${Date.now()}`,
    listId: row.listId,
    listLabel: sourceLists.join(", "),
    sourceLists,
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
      `Closing signal dated ${row.asOf}; buy fill must come from the next session 09:15-09:20 IST window.`
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
    `Closing exit signal dated ${row.asOf}; sell fill must come from the next session 09:15-09:20 IST window.`
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
      trade.executionError = "Next-session 09:15 candle is not available yet.";
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
      trade.executionError = "Next-session 09:15 candle is not available yet.";
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

function uniqueScannedRows(scan) {
  const scannedIds = new Set(scan.scannedListIds || Object.keys(scan.lists || {}));
  const grouped = new Map();
  for (const list of Object.values(scan.lists || {})) {
    if (!scannedIds.has(list.id)) continue;
    for (const row of list.results || []) {
      const key = row.yahooSymbol || row.symbol;
      if (!key) continue;
      if (!grouped.has(key)) {
        grouped.set(key, {
          ...row,
          sourceLists: [row.listLabel].filter(Boolean)
        });
      } else {
        const current = grouped.get(key);
        if (row.listLabel && !current.sourceLists.includes(row.listLabel)) {
          current.sourceLists.push(row.listLabel);
        }
        if (current.industry === "NSE Equity" && row.industry !== "NSE Equity") {
          Object.assign(current, row, { sourceLists: current.sourceLists });
        }
      }
    }
  }
  return [...grouped.values()];
}

function previousSymbolStatus(signalState, yahooSymbol, displaySymbol) {
  if (signalState[yahooSymbol]?.status) return signalState[yahooSymbol].status;
  const suffixes = [`:${displaySymbol}`, `:${yahooSymbol}`];
  for (const [key, value] of Object.entries(signalState)) {
    if (suffixes.some((suffix) => key.endsWith(suffix)) && value?.status) return value.status;
  }
  return null;
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
    { metric: "Signal Basis", value: journal.executionRule?.signalBasis || "" },
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
    { header: "Setup Grade", key: "Setup Grade", width: 13 },
    { header: "Setup Score", key: "Setup Score", width: 14 },
    { header: "Fundamental Score", key: "Fundamental Score", width: 18 },
    { header: "Sector Breadth", key: "Sector Breadth", width: 18 },
    { header: "Near 52W High", key: "Near 52W High", width: 14 },
    { header: "55D Breakout", key: "55D Breakout", width: 14 },
    { header: "Volume Ratio", key: "Volume Ratio", width: 14 },
    { header: "ATR %", key: "ATR %", width: 12 },
    { header: "Risk To ST %", key: "Risk To ST %", width: 14 },
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
  return {
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
    "Setup Grade": trade.entrySnapshot?.setupGrade || "",
    "Setup Score": trade.entrySnapshot?.setupStrengthScore ?? "",
    "Fundamental Score": trade.entrySnapshot?.fundamentalScore ?? "",
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
    setupStrength: row.setupStrength,
    setupStrengthScore: row.setupStrengthScore,
    setupGrade: row.setupGrade,
    sectorStrength: row.sectorStrength,
    sectorStrengthScore: row.sectorStrengthScore,
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
