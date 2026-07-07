import fs from "node:fs";
import ExcelJS from "exceljs";
import { appConfig } from "./config.js";
import { readTrades, saveTrades } from "./storage.js";

export async function updateTradeJournal(scan, config = appConfig) {
  const journal = readTrades();
  const liveMode = config.trade.onlyNewSignals !== false;
  const firstLiveScan = liveMode && !journal.liveModeStartedAt;
  const trades = firstLiveScan ? [] : Array.isArray(journal.trades) ? journal.trades : [];
  const signalState = journal.signalState && typeof journal.signalState === "object"
    ? journal.signalState
    : {};
  const nextSignalState = { ...signalState };
  const events = [];

  const scannedIds = new Set(scan.scannedListIds || Object.keys(scan.lists || {}));
  for (const list of Object.values(scan.lists || {})) {
    if (!scannedIds.has(list.id)) continue;
    for (const row of list.results || []) {
      const signalKey = `${row.listId}:${row.symbol}`;
      const previousStatus = signalState[signalKey]?.status || null;
      const openTrade = trades.find(
        (trade) =>
          trade.status === "OPEN" &&
          trade.listId === row.listId &&
          trade.symbol === row.symbol
      );

      if (!firstLiveScan && row.status === "ENTRY" && previousStatus !== "ENTRY" && !openTrade) {
        const quantity = calculateQuantity(row.close, config);
        const trade = {
          id: `${row.listId}-${row.symbol}-${row.asOf}`,
          listId: row.listId,
          listLabel: row.listLabel,
          symbol: row.symbol,
          name: row.name,
          status: "OPEN",
          entryDate: row.asOf,
          entryScanAt: scan.scannedAt,
          entryPrice: round(row.close),
          quantity,
          investedValue: round(quantity * row.close),
          entryReason: row.signalReason || row.entryReason || [],
          entrySnapshot: snapshot(row),
          exitDate: null,
          exitScanAt: null,
          exitPrice: null,
          exitReason: [],
          pnl: null,
          pnlPct: null,
          holdingDays: null
        };
        trades.push(trade);
        events.push({ type: "ENTRY_TRADE_OPENED", trade });
      }

      if (!firstLiveScan && row.status === "EXIT" && openTrade) {
        openTrade.status = "CLOSED";
        openTrade.exitDate = row.asOf;
        openTrade.exitScanAt = scan.scannedAt;
        openTrade.exitPrice = round(row.close);
        openTrade.exitReason = row.signalReason || row.exitReason || [];
        openTrade.exitSnapshot = snapshot(row);
        openTrade.pnl = round((row.close - openTrade.entryPrice) * openTrade.quantity);
        openTrade.pnlPct = round(((row.close / openTrade.entryPrice) - 1) * 100);
        openTrade.holdingDays = holdingDays(openTrade.entryDate, row.asOf);
        events.push({ type: "EXIT_TRADE_CLOSED", trade: openTrade });
      }

      nextSignalState[signalKey] = {
        status: row.status,
        asOf: row.asOf,
        scannedAt: scan.scannedAt
      };
    }
  }

  const nextJournal = {
    updatedAt: new Date().toISOString(),
    liveModeStartedAt: journal.liveModeStartedAt || (liveMode ? new Date().toISOString() : null),
    baselineInitialized: true,
    baselineScanAt: journal.baselineScanAt || (firstLiveScan ? scan.scannedAt : null),
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

function calculateQuantity(close, config) {
  if (Number.isFinite(config.trade.capitalPerStock) && config.trade.capitalPerStock > 0) {
    return Math.max(1, Math.floor(config.trade.capitalPerStock / close));
  }
  return config.trade.defaultQty;
}

async function writeXlsx(journal, filePath) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Techno Funda Screener";
  workbook.created = new Date();

  const summary = workbook.addWorksheet("Summary");
  summary.columns = [
    { header: "Metric", key: "metric", width: 28 },
    { header: "Value", key: "value", width: 22 }
  ];
  const openTrades = journal.trades.filter((trade) => trade.status === "OPEN");
  const closedTrades = journal.trades.filter((trade) => trade.status === "CLOSED");
  const totalPnl = closedTrades.reduce((sum, trade) => sum + (trade.pnl || 0), 0);
  summary.addRows([
    { metric: "Updated At", value: journal.updatedAt },
    { metric: "Open Trades", value: openTrades.length },
    { metric: "Closed Trades", value: closedTrades.length },
    { metric: "Total Realized P&L", value: totalPnl },
    { metric: "Capital Per Stock", value: journal.tradeCapitalPerStock }
  ]);

  const tradesSheet = workbook.addWorksheet("Trades");
  tradesSheet.columns = tradeColumns();
  tradesSheet.addRows(journal.trades.map(tradeToRow));
  tradesSheet.views = [{ state: "frozen", ySplit: 1 }];
  formatSheet(tradesSheet);

  const openSheet = workbook.addWorksheet("Open Trades");
  openSheet.columns = tradeColumns();
  openSheet.addRows(openTrades.map(tradeToRow));
  openSheet.views = [{ state: "frozen", ySplit: 1 }];
  formatSheet(openSheet);

  const closedSheet = workbook.addWorksheet("Closed Trades");
  closedSheet.columns = tradeColumns();
  closedSheet.addRows(closedTrades.map(tradeToRow));
  closedSheet.views = [{ state: "frozen", ySplit: 1 }];
  formatSheet(closedSheet);

  await workbook.xlsx.writeFile(filePath);
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
    { header: "List", key: "List", width: 18 },
    { header: "Symbol", key: "Symbol", width: 14 },
    { header: "Name", key: "Name", width: 28 },
    { header: "Status", key: "Status", width: 12 },
    { header: "Entry Date", key: "Entry Date", width: 14 },
    { header: "Entry Price", key: "Entry Price", width: 14 },
    { header: "Quantity", key: "Quantity", width: 10 },
    { header: "Invested Value", key: "Invested Value", width: 16 },
    { header: "Exit Date", key: "Exit Date", width: 14 },
    { header: "Exit Price", key: "Exit Price", width: 14 },
    { header: "P&L", key: "P&L", width: 14 },
    { header: "P&L %", key: "P&L %", width: 12 },
    { header: "Holding Days", key: "Holding Days", width: 14 },
    { header: "Entry Reason", key: "Entry Reason", width: 54 },
    { header: "Exit Reason", key: "Exit Reason", width: 54 }
  ];
}

function tradeToRow(trade) {
  return {
    List: trade.listLabel,
    Symbol: trade.symbol,
    Name: trade.name,
    Status: trade.status,
    "Entry Date": trade.entryDate,
    "Entry Price": trade.entryPrice,
    Quantity: trade.quantity,
    "Invested Value": trade.investedValue,
    "Exit Date": trade.exitDate || "",
    "Exit Price": trade.exitPrice ?? "",
    "P&L": trade.pnl ?? "",
    "P&L %": trade.pnlPct ?? "",
    "Holding Days": trade.holdingDays ?? "",
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
    const pnlCell = row.getCell("P&L");
    if (Number(pnlCell.value) > 0) pnlCell.font = { color: { argb: "FF147A52" } };
    if (Number(pnlCell.value) < 0) pnlCell.font = { color: { argb: "FFB4232A" } };
  }
}

function snapshot(row) {
  return {
    close: row.close,
    dailyRsi: row.dailyRsi,
    weeklyRsi: row.weeklyRsi,
    weeklyRs: row.weeklyRs,
    dailyLongRs: row.dailyLongRs,
    dailyShortRs: row.dailyShortRs,
    dailySupertrend: row.dailySupertrend,
    dailyPriceAboveSupertrend: row.dailyPriceAboveSupertrend,
    fundamentalScore: row.fundamentalScore,
    score: row.score
  };
}

function sortTrades(a, b) {
  if (a.status !== b.status) return a.status === "OPEN" ? -1 : 1;
  return String(b.entryDate).localeCompare(String(a.entryDate));
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
