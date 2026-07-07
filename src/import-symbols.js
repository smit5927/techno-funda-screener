import ExcelJS from "exceljs";
import { parseCsv } from "./csv.js";
import { normalizeTradingViewSymbol } from "./watchlist.js";

const HEADER_KEYS = new Set([
  "symbol",
  "ticker",
  "trading_symbol",
  "tradingview_symbol",
  "trading_view_symbol",
  "tv_symbol",
  "scrip",
  "stock",
  "stocks"
]);

const SKIP_TOKENS = new Set([
  "SYMBOL",
  "TICKER",
  "TRADINGVIEW",
  "TRADING_VIEW",
  "TRADING_SYMBOL",
  "NAME",
  "COMPANY",
  "INDUSTRY",
  "SECTOR",
  "ENABLED",
  "EXCHANGE",
  "NSE",
  "BSE"
]);

export async function importSymbolsFromUpload(filename, buffer) {
  const lower = String(filename || "").toLowerCase();
  if (lower.endsWith(".xlsx")) return extractFromWorkbook(buffer);
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    return extractFromDelimited(buffer.toString("utf8"));
  }
  throw new Error("Only .xlsx, .csv, and .txt files are supported.");
}

async function extractFromWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];

  const headerColumns = findHeaderColumns(worksheet);
  const candidates = [];

  if (headerColumns.length > 0) {
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      for (const colNumber of headerColumns) {
        candidates.push(cellText(row.getCell(colNumber)));
      }
    });
  } else {
    worksheet.eachRow((row) => {
      row.eachCell((cell) => candidates.push(cellText(cell)));
    });
  }

  return normalizeCandidates(candidates);
}

function extractFromDelimited(text) {
  const records = parseCsv(text);
  const candidates = [];
  if (records.length > 0) {
    const keys = Object.keys(records[0]).filter((key) => HEADER_KEYS.has(key));
    if (keys.length > 0) {
      for (const record of records) {
        for (const key of keys) candidates.push(record[key]);
      }
      return normalizeCandidates(candidates);
    }
  }
  return normalizeCandidates([text]);
}

function findHeaderColumns(worksheet) {
  const headerColumns = [];
  const firstRow = worksheet.getRow(1);
  firstRow.eachCell((cell, colNumber) => {
    const key = cellText(cell)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (HEADER_KEYS.has(key)) headerColumns.push(colNumber);
  });
  return headerColumns;
}

function normalizeCandidates(candidates) {
  const seen = new Set();
  const output = [];

  for (const candidate of candidates) {
    for (const token of tokenize(candidate)) {
      const normalized = normalizeTradingViewSymbol(token);
      if (!isLikelySymbol(normalized, token)) continue;
      const key = `${normalized.exchange}:${normalized.symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(normalized.displaySymbol);
    }
  }

  return output;
}

function tokenize(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  const matches = text.match(/\b(?:NSE|BSE):[A-Z0-9&._-]+\b/gi);
  if (matches?.length) return matches;
  return text
    .split(/[\s,;|]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function isLikelySymbol(normalized, original) {
  if (!normalized.symbol) return false;
  if (SKIP_TOKENS.has(normalized.symbol)) return false;
  if (normalized.exchange === "NSE" || normalized.exchange === "BSE") return true;
  const token = String(original || "").trim();
  if (token.includes(":") || token.includes(".")) return true;
  return /^[A-Z0-9&_-]{2,20}$/.test(normalized.symbol);
}

function cellText(cell) {
  const value = cell?.value;
  if (value == null) return "";
  if (typeof value === "object") {
    if (value.text) return value.text;
    if (value.result != null) return String(value.result);
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || "").join("");
    if (value.hyperlink && value.text) return value.text;
  }
  return String(value);
}
