import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "../src/config.js";
import { parseCsv, stringifyCsv } from "../src/csv.js";

const url = "https://www.niftyindices.com/IndexConstituent/ind_nifty500list.csv";
const outputPath = path.join(ROOT_DIR, "config", "universe.csv");

const response = await fetch(url, {
  headers: {
    "User-Agent": "Mozilla/5.0",
    Accept: "text/csv,*/*",
    Referer: "https://www.niftyindices.com/indices/equity/broad-based-indices/nifty-500"
  }
});

if (!response.ok) {
  throw new Error(`Nifty 500 download failed: ${response.status} ${response.statusText}`);
}

const text = await response.text();
const records = parseCsv(text);
const rows = records
  .map((record) => ({
    symbol: record.symbol,
    name: record.company_name,
    industry: record.industry,
    enabled: "true"
  }))
  .filter((record) => record.symbol);

fs.writeFileSync(
  outputPath,
  stringifyCsv(rows, ["symbol", "name", "industry", "enabled"]),
  "utf8"
);

console.log(`Saved ${rows.length} symbols to ${outputPath}`);
