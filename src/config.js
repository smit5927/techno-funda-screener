import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, "..");

export function resolveProjectPath(value) {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.join(ROOT_DIR, value);
}

function readJson(relativePath, fallback) {
  const absolutePath = resolveProjectPath(relativePath);
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch {
    return fallback;
  }
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

const rules = readJson("config/rules.json", {});
const defaultUniverse = fs.existsSync(resolveProjectPath("config/universe.csv"))
  ? "config/universe.csv"
  : "config/watchlist.csv";
const dataDir = resolveProjectPath(process.env.DATA_DIR || "data");

export const appConfig = {
  rootDir: ROOT_DIR,
  port: numberEnv("PORT", 3000),
  rules,
  benchmarkSymbol: process.env.BENCHMARK_SYMBOL || rules.benchmark || "^CRSLDX",
  lists: [
    {
      id: "default",
      label: "Default Nifty 500",
      path: resolveProjectPath(process.env.DEFAULT_WATCHLIST_PATH || process.env.WATCHLIST_PATH || defaultUniverse),
      editable: false
    },
    {
      id: "custom",
      label: "My Custom List",
      path: resolveProjectPath(process.env.CUSTOM_WATCHLIST_PATH || "config/custom-list.csv"),
      editable: true
    }
  ],
  maxSymbols: numberEnv("MAX_SYMBOLS", 0),
  scanConcurrency: Math.max(1, numberEnv("SCAN_CONCURRENCY", 6)),
  dataDir,
  latestResultPath: path.join(dataDir, "results.json"),
  fundamentalsCachePath: path.join(dataDir, "fundamentals-cache.json"),
  tradesPath: path.join(dataDir, "trades.json"),
  tradeSheetPath: path.join(dataDir, "techno-funda-trade-sheet.xlsx"),
  tradeCsvPath: path.join(dataDir, "techno-funda-trade-sheet.csv"),
  trade: {
    capitalPerStock: numberEnv("TRADE_CAPITAL_PER_STOCK", 100000),
    defaultQty: Math.max(1, numberEnv("TRADE_DEFAULT_QTY", 1)),
    onlyNewSignals: boolEnv("TRADE_ONLY_NEW_SIGNALS", true)
  },
  fundamentals: {
    enabled: boolEnv("FUNDAMENTALS_ENABLED", true),
    cacheDays: Math.max(0, numberEnv("FUNDAMENTALS_CACHE_DAYS", 7))
  },
  schedule: {
    enabled: boolEnv("SCHEDULE_ENABLED", true),
    cron: process.env.SCAN_CRON || "15 8 * * 1-5",
    timezone: process.env.SCAN_TIMEZONE || "Asia/Kolkata"
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID || "",
    sendEmpty: boolEnv("TELEGRAM_SEND_EMPTY", true)
  }
};
