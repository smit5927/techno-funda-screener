import fs from "node:fs";
import path from "node:path";
import { appConfig } from "./config.js";

export function readLatestScan() {
  return readJsonFile(appConfig.latestResultPath, null);
}

export function saveLatestScan(payload) {
  writeJsonFile(appConfig.latestResultPath, payload);
}

export function readFundamentalsCache() {
  return readJsonFile(appConfig.fundamentalsCachePath, {});
}

export function saveFundamentalsCache(payload) {
  writeJsonFile(appConfig.fundamentalsCachePath, payload);
}

export function readTrades() {
  return readJsonFile(appConfig.tradesPath, { updatedAt: null, trades: [] });
}

export function saveTrades(payload) {
  writeJsonFile(appConfig.tradesPath, payload);
}

export function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}
