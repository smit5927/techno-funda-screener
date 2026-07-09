import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "../src/config.js";
import { parseCsv, stringifyCsv } from "../src/csv.js";

const url = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";
const outputPath = path.join(ROOT_DIR, "config", "all-market.csv");
const niftyPath = path.join(ROOT_DIR, "config", "universe.csv");

const response = await fetch(url, {
  headers: {
    "User-Agent": "Mozilla/5.0",
    Accept: "text/csv,*/*",
    Referer: "https://www.nseindia.com/market-data/securities-available-for-trading"
  }
});

if (!response.ok) {
  throw new Error(`NSE equity master download failed: ${response.status} ${response.statusText}`);
}

const niftyIndustries = new Map();
if (fs.existsSync(niftyPath)) {
  for (const record of parseCsv(fs.readFileSync(niftyPath, "utf8"))) {
    const symbol = String(record.symbol || "").trim().toUpperCase();
    if (symbol) niftyIndustries.set(symbol, record.industry || "");
  }
}

const rows = parseCsv(await response.text())
  .map((record) => {
    const symbol = String(record.symbol || "").trim().toUpperCase();
    return {
      symbol,
      name: record.name_of_company || symbol,
      industry: niftyIndustries.get(symbol) || "NSE Equity",
      series: record.series || "",
      isin: record.isin_number || "",
      enabled: "true"
    };
  })
  .filter((record) => record.symbol);

fs.writeFileSync(
  outputPath,
  stringifyCsv(rows, ["symbol", "name", "industry", "series", "isin", "enabled"]),
  "utf8"
);

console.log(`Saved ${rows.length} NSE equity symbols to ${outputPath}`);
