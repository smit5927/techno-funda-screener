import express from "express";
import path from "node:path";
import fs from "node:fs";
import { appConfig } from "./config.js";
import { readLatestScan, readTrades } from "./storage.js";
import { runScreener } from "./screener.js";
import { startScheduler } from "./scheduler.js";
import { loadWatchlist, saveCustomWatchlist } from "./watchlist.js";
import { tradeSettingsSummary, writeTradeSheets } from "./trade-journal.js";
import { importSymbolsFromUpload } from "./import-symbols.js";

const app = express();
let activeScan = null;

app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(appConfig.rootDir, "public")));

app.get("/api/config", (_request, response) => {
  response.json({
    benchmark: appConfig.benchmarkSymbol,
    benchmarkLabel: appConfig.benchmarkLabel,
    lists: appConfig.lists.map((list) => ({
      id: list.id,
      label: list.label,
      editable: list.editable,
      path: list.path
    })),
    schedule: appConfig.schedule,
    trade: appConfig.trade,
    rules: appConfig.rules
  });
});

app.get("/api/results", (request, response) => {
  const payload = readLatestScan() || emptyResult();
  const listId = request.query.list;
  if (listId && listId !== "all") {
    response.json({
      scannedAt: payload.scannedAt,
      benchmark: payload.benchmark,
      benchmarkLabel: payload.benchmarkLabel,
      rules: payload.rules,
      tradeSummary: payload.tradeSummary,
      ...(payload.lists?.[listId] || emptyList(listId))
    });
    return;
  }
  response.json(payload);
});

app.get("/api/scan/status", (_request, response) => {
  response.json({ running: Boolean(activeScan) });
});

app.get("/api/watchlists", (_request, response) => {
  response.json({
    lists: appConfig.lists.map((list) => {
      const symbols = loadWatchlist(list.path, 0);
      return {
        id: list.id,
        label: list.label,
        editable: list.editable,
        count: symbols.length,
        symbols
      };
    })
  });
});

app.post("/api/watchlists/custom", (request, response) => {
  const customList = appConfig.lists.find((list) => list.id === "custom");
  if (!customList) {
    response.status(404).json({ error: "custom list not configured" });
    return;
  }

  const count = saveCustomWatchlist(customList.path, request.body?.symbols || "");
  response.json({ ok: true, count });
});

app.post("/api/watchlists/custom/import", async (request, response) => {
  const customList = appConfig.lists.find((list) => list.id === "custom");
  if (!customList) {
    response.status(404).json({ error: "custom list not configured" });
    return;
  }

  try {
    const filename = request.body?.filename || "symbols.xlsx";
    const dataBase64 = request.body?.dataBase64;
    if (!dataBase64) {
      response.status(400).json({ error: "dataBase64 is required" });
      return;
    }

    const buffer = Buffer.from(dataBase64, "base64");
    const symbols = await importSymbolsFromUpload(filename, buffer);
    const count = saveCustomWatchlist(customList.path, symbols.join("\n"));

    if (request.body?.scan === true) {
      if (activeScan) {
        response.status(409).json({ error: "scan already running", imported: count, symbols });
        return;
      }

      activeScan = runScreener({
        sendTelegram: request.body?.telegram === true,
        listId: "custom"
      });
      try {
        const scan = await activeScan;
        response.json({ ok: true, count, symbols, scan });
      } finally {
        activeScan = null;
      }
      return;
    }

    response.json({ ok: true, count, symbols });
  } catch (error) {
    response.status(400).json({ error: error.message || String(error) });
  }
});

app.get("/api/trades", (_request, response) => {
  response.json(readTrades());
});

app.get("/api/trades/download", async (_request, response) => {
  const journal = readTrades();
  await writeTradeSheets(journal, appConfig);
  if (!fs.existsSync(appConfig.tradeSheetPath)) {
    response.status(404).json({ error: "trade sheet not generated yet" });
    return;
  }
  response.download(appConfig.tradeSheetPath, "techno-funda-trade-sheet.xlsx");
});

app.get("/api/trades/download.csv", async (_request, response) => {
  const journal = readTrades();
  await writeTradeSheets(journal, appConfig);
  if (!fs.existsSync(appConfig.tradeCsvPath)) {
    response.status(404).json({ error: "trade sheet not generated yet" });
    return;
  }
  response.download(appConfig.tradeCsvPath, "techno-funda-trade-sheet.csv");
});

app.post("/api/scan", async (request, response) => {
  if (activeScan) {
    response.status(409).json({ error: "scan already running" });
    return;
  }

  const sendTelegram = request.query.telegram === "1" || request.body?.telegram === true;
  const listId = request.query.list || request.body?.listId || "all";
  activeScan = runScreener({ sendTelegram, listId });

  try {
    const result = await activeScan;
    response.json(result);
  } catch (error) {
    response.status(500).json({ error: error.message || String(error) });
  } finally {
    activeScan = null;
  }
});

startScheduler(appConfig, async () => {
  if (activeScan) return;
  activeScan = runScreener({ sendTelegram: true });
  try {
    await activeScan;
  } finally {
    activeScan = null;
  }
});

app.listen(appConfig.port, () => {
  console.log(`Techno Funda PMS running at http://localhost:${appConfig.port}`);
});

function emptyResult() {
  const lists = Object.fromEntries(appConfig.lists.map((list) => [list.id, emptyList(list.id)]));
  return {
    scannedAt: null,
    benchmark: appConfig.benchmarkSymbol,
    benchmarkLabel: appConfig.benchmarkLabel,
    lists,
    summary: { total: 0, entry: 0, exit: 0, watch: 0, error: 0 },
    results: [],
    tradeSummary: { open: 0, closed: 0, realizedPnl: 0 },
    tradeSettings: tradeSettingsSummary(appConfig),
    rules: appConfig.rules
  };
}

function emptyList(listId) {
  const config = appConfig.lists.find((list) => list.id === listId);
  return {
    id: listId,
    label: config?.label || listId,
    editable: Boolean(config?.editable),
    summary: { total: 0, entry: 0, exit: 0, watch: 0, error: 0 },
    results: []
  };
}
