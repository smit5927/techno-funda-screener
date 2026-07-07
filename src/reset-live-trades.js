import { appConfig } from "./config.js";
import { readLatestScan, saveLatestScan, saveTrades } from "./storage.js";
import { writeTradeSheets } from "./trade-journal.js";
import { pushCloudState } from "./cloud-sync.js";

const now = new Date().toISOString();
const journal = {
  updatedAt: now,
  liveModeStartedAt: null,
  baselineInitialized: false,
  baselineScanAt: null,
  signalState: {},
  tradeCapitalPerStock: appConfig.trade.capitalPerStock,
  trades: []
};

saveTrades(journal);
await writeTradeSheets(journal, appConfig);

const latest = readLatestScan();
if (latest) {
  latest.tradeSummary = { open: 0, closed: 0, realizedPnl: 0 };
  latest.tradeEvents = [];
  latest.liveModeResetAt = now;
  saveLatestScan(latest);

  try {
    const pushed = await pushCloudState(latest);
    console.log(pushed.ok ? "Cloud state reset" : `Cloud reset skipped: ${pushed.reason}`);
  } catch (error) {
    console.log(`Cloud reset skipped: ${error.message || String(error)}`);
  }
}

console.log("Live trade journal reset. Next scan will create a fresh baseline without alerts.");
