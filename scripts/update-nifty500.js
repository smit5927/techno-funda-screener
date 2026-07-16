import path from "node:path";
import { ROOT_DIR } from "../src/config.js";
import { parseCsv } from "../src/csv.js";
import {
  formatUniverseChanges,
  readExistingUniverse,
  universeChanges,
  validateUniverseSnapshot,
  writeUniverseAtomically
} from "../src/universe-refresh.js";

const url = "https://www.niftyindices.com/IndexConstituent/ind_nifty500list.csv";
const outputPath = path.join(ROOT_DIR, "config", "universe.csv");
const previousRows = readExistingUniverse(outputPath);

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

validateUniverseSnapshot(rows, {
  label: "Nifty 500",
  minRows: 450,
  maxRows: 550,
  maxDropPct: 5,
  previousRows
});
writeUniverseAtomically(
  outputPath,
  rows,
  ["symbol", "name", "industry", "enabled"]
);

console.log(`Saved ${rows.length} symbols to ${outputPath}`);
console.log(formatUniverseChanges(universeChanges(previousRows, rows)));
