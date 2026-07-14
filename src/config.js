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

function choiceEnv(name, fallback, allowed) {
  const value = String(process.env[name] || "").trim();
  return allowed.includes(value) ? value : fallback;
}

const rules = readJson("config/rules.json", {});
const defaultUniverse = fs.existsSync(resolveProjectPath("config/universe.csv"))
  ? "config/universe.csv"
  : "config/watchlist.csv";
const dataDir = resolveProjectPath(process.env.DATA_DIR || "data");
const tradeScopeOptions = ["all-market", "default", "custom"];
const tradeQualityOptions = ["BEST_ONLY", "STRONG_OR_BETTER", "ALL_ENTRIES"];

export const appConfig = {
  rootDir: ROOT_DIR,
  port: numberEnv("PORT", 3000),
  rules,
  benchmarkSymbol: process.env.BENCHMARK_SYMBOL || rules.benchmark || "^CRSLDX",
  benchmarkLabel: process.env.BENCHMARK_LABEL || rules.benchmarkLabel || "NIFTY 500",
  priceHistoryYears: Math.max(3, numberEnv("PRICE_HISTORY_YEARS", 5)),
  lists: [
    {
      id: "all-market",
      label: "All NSE Market",
      path: resolveProjectPath(process.env.ALL_MARKET_WATCHLIST_PATH || "config/all-market.csv"),
      editable: false
    },
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
    totalCapital: numberEnv("TRADE_TOTAL_CAPITAL", 1000000),
    maxOpenPositions: Math.max(1, numberEnv("TRADE_MAX_OPEN_POSITIONS", 15)),
    autoPositionBreadth: boolEnv("TRADE_AUTO_POSITION_BREADTH", true),
    maxPositionPct: numberEnv("TRADE_MAX_POSITION_PCT", 10),
    riskPerTradePct: numberEnv("TRADE_RISK_PER_TRADE_PCT", 1),
    maxPortfolioRiskPct: numberEnv("TRADE_MAX_PORTFOLIO_RISK_PCT", 6),
    maxSectorExposurePct: numberEnv("TRADE_MAX_SECTOR_EXPOSURE_PCT", 25),
    minimumStopPct: numberEnv("TRADE_MINIMUM_STOP_PCT", 1.5),
    maximumStopPct: numberEnv("TRADE_MAXIMUM_STOP_PCT", 8),
    partialExitPct: numberEnv("TRADE_PARTIAL_EXIT_PCT", 50),
    partialProfitR: numberEnv("TRADE_PARTIAL_PROFIT_R", 2),
    rotationMinRankAdvantage: numberEnv("TRADE_ROTATION_MIN_RANK_ADVANTAGE", 15),
    rotationMinimumHoldingDays: numberEnv("TRADE_ROTATION_MIN_HOLDING_DAYS", 5),
    rotationConfirmationCloses: Math.max(1, numberEnv("TRADE_ROTATION_CONFIRMATION_CLOSES", 2)),
    rotationCandidateConfirmationCloses: Math.max(1, numberEnv("TRADE_ROTATION_CANDIDATE_CONFIRMATION_CLOSES", 2)),
    candidateMaxWaitDays: Math.max(1, numberEnv("TRADE_CANDIDATE_MAX_WAIT_DAYS", 30)),
    candidateMaxRunupPct: numberEnv("TRADE_CANDIDATE_MAX_RUNUP_PCT", 8),
    candidateMaxExecutionGapPct: numberEnv("TRADE_CANDIDATE_MAX_EXECUTION_GAP_PCT", 3),
    candidateMaxSupertrendDistancePct: numberEnv("TRADE_CANDIDATE_MAX_SUPERTREND_DISTANCE_PCT", 7),
    candidateMaxAtrExtension: numberEnv("TRADE_CANDIDATE_MAX_ATR_EXTENSION", 3),
    candidateMaxRankDecay: numberEnv("TRADE_CANDIDATE_MAX_RANK_DECAY", 15),
    pyramidingEnabled: boolEnv("TRADE_PYRAMIDING_ENABLED", true),
    pyramidMaxAddOns: Math.max(1, numberEnv("TRADE_PYRAMID_MAX_ADD_ONS", 2)),
    pyramidMaxPositionPct: numberEnv("TRADE_PYRAMID_MAX_POSITION_PCT", 15),
    pyramidAddMaxPct: numberEnv("TRADE_PYRAMID_ADD_MAX_PCT", 2.5),
    pyramidAddRiskPct: numberEnv("TRADE_PYRAMID_ADD_RISK_PCT", 0.5),
    pyramidMinimumRewardR: numberEnv("TRADE_PYRAMID_MINIMUM_REWARD_R", 1),
    pyramidMinimumAdvancePct: numberEnv("TRADE_PYRAMID_MINIMUM_ADVANCE_PCT", 2),
    pyramidPullbackMinPct: numberEnv("TRADE_PYRAMID_PULLBACK_MIN_PCT", 2),
    pyramidPullbackMaxPct: numberEnv("TRADE_PYRAMID_PULLBACK_MAX_PCT", 15),
    defaultQty: Math.max(1, numberEnv("TRADE_DEFAULT_QTY", 1)),
    onlyNewSignals: boolEnv("TRADE_ONLY_NEW_SIGNALS", true),
    scopeListId: choiceEnv("TRADE_SCOPE_LIST_ID", "all-market", tradeScopeOptions),
    qualityMode: choiceEnv("TRADE_QUALITY_MODE", "BEST_ONLY", tradeQualityOptions),
    executionTime: "09:17",
    executionWindowStart: "09:17",
    executionWindowEnd: "09:17",
    executionPriceSource: "09:17_one_minute_candle_open"
  },
  fundamentals: {
    enabled: boolEnv("FUNDAMENTALS_ENABLED", true),
    cacheDays: Math.max(0, numberEnv("FUNDAMENTALS_CACHE_DAYS", 7))
  },
  schedule: {
    enabled: boolEnv("SCHEDULE_ENABLED", true),
    cron: process.env.SCAN_CRON || "0 8 * * 1-5",
    timezone: process.env.SCAN_TIMEZONE || "Asia/Kolkata"
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID || "",
    sendEmpty: boolEnv("TELEGRAM_SEND_EMPTY", true),
    retryFailedEventsMaxHours: Math.max(0, numberEnv("TELEGRAM_RETRY_FAILED_EVENTS_MAX_HOURS", 12))
  }
};
