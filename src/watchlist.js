import fs from "node:fs";
import path from "node:path";
import { parseCsv, stringifyCsv } from "./csv.js";

export function loadWatchlist(filePath, maxSymbols = 0) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const records = parseCsv(text);
  const seen = new Set();
  const symbols = [];

  for (const record of records) {
    const enabled = String(record.enabled ?? "true").trim().toLowerCase();
    if (["false", "0", "no", "n"].includes(enabled)) continue;

    const rawSymbol =
      record.symbol ||
      record.ticker ||
      record.trading_symbol ||
      record.tradingview_symbol ||
      record.trading_view_symbol;
    if (!rawSymbol) continue;

    const yahooSymbol = toYahooNseSymbol(rawSymbol);
    if (seen.has(yahooSymbol)) continue;

    seen.add(yahooSymbol);
    const normalized = normalizeTradingViewSymbol(rawSymbol);
    symbols.push({
      symbol: normalized.displaySymbol,
      yahooSymbol,
      name: record.name || record.company_name || record.company || normalized.displaySymbol,
      industry: record.industry || record.sector || normalized.exchange || ""
    });

    if (maxSymbols > 0 && symbols.length >= maxSymbols) break;
  }

  return symbols;
}

export function saveCustomWatchlist(filePath, symbolsText) {
  const tokens = String(symbolsText || "")
    .split(/[\s,;]+/)
    .map((value) => normalizeTradingViewSymbol(value))
    .filter((value) => value.symbol)
    .filter(Boolean);
  const seen = new Set();
  const rows = [];

  for (const item of tokens) {
    const clean = item.displaySymbol;
    const yahoo = toYahooNseSymbol(clean);
    if (!clean || seen.has(yahoo)) continue;
    seen.add(yahoo);
    rows.push({
      symbol: clean,
      name: clean,
      industry: item.exchange || "My List",
      enabled: "true"
    });
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    stringifyCsv(rows, ["symbol", "name", "industry", "enabled"]),
    "utf8"
  );

  return rows.length;
}

export function toYahooNseSymbol(symbol) {
  const normalized = normalizeTradingViewSymbol(symbol);
  const clean = normalized.symbol;
  if (!clean) return clean;
  if (clean.startsWith("^")) return clean;
  if (normalized.exchange === "BSE") return `${clean}.BO`;
  if (normalized.exchange === "NSE") return `${clean}.NS`;
  if (clean.includes(".")) return clean;
  if (clean.includes("=")) return clean;
  return `${clean}.NS`;
}

export function normalizeTradingViewSymbol(value) {
  const raw = String(value || "")
    .trim()
    .replace(/["'`]/g, "")
    .toUpperCase();
  if (!raw) return { symbol: "", exchange: "", displaySymbol: "" };

  const compact = raw.replace(/\s+/g, "");
  const colonMatch = compact.match(/^([A-Z]{2,8}):([A-Z0-9&._-]+)$/);
  if (colonMatch) {
    const exchange = colonMatch[1];
    const symbol = colonMatch[2].replace(/\.(NS|BO)$/i, "");
    return {
      symbol,
      exchange,
      displaySymbol: exchange === "NSE" ? symbol : `${exchange}:${symbol}`
    };
  }

  const suffixMatch = compact.match(/^([A-Z0-9&_-]+)\.(NS|BO)$/);
  if (suffixMatch) {
    const exchange = suffixMatch[2] === "BO" ? "BSE" : "NSE";
    const symbol = suffixMatch[1];
    return {
      symbol,
      exchange,
      displaySymbol: exchange === "NSE" ? symbol : `${exchange}:${symbol}`
    };
  }

  const symbol = compact.replace(/[^A-Z0-9&_-]/g, "");
  return { symbol, exchange: "", displaySymbol: symbol };
}
