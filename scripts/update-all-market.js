import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT_DIR } from "../src/config.js";
import { parseCsv } from "../src/csv.js";
import { buildIndianEquityUniverse } from "../src/indian-market-universe.js";
import {
  formatUniverseChanges,
  readExistingUniverse,
  universeChanges,
  validateUniverseSnapshot,
  writeUniverseAtomically
} from "../src/universe-refresh.js";

const nseUrl = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";
const bseUrl = "https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=&industry=&segment=Equity&status=Active";
const outputPath = path.join(ROOT_DIR, "config", "all-market.csv");
const niftyPath = path.join(ROOT_DIR, "config", "universe.csv");
const previousRows = readExistingUniverse(outputPath);

const nseResponse = await fetch(nseUrl, {
  headers: {
    "User-Agent": "Mozilla/5.0",
    Accept: "text/csv,*/*",
    Referer: "https://www.nseindia.com/market-data/securities-available-for-trading"
  }
});

if (!nseResponse.ok) {
  throw new Error(`NSE equity master download failed: ${nseResponse.status} ${nseResponse.statusText}`);
}

// BSE's Akamai response currently includes non-standard header whitespace that
// strict Node HTTP parsers reject. curl accepts the official response on both
// Windows and GitHub's Ubuntu runner and gives us deterministic retries.
const bseRecords = JSON.parse(execFileSync("curl", [
  "--location", "--fail", "--silent", "--show-error",
  "--retry", "3", "--retry-delay", "2",
  "--user-agent", "Mozilla/5.0",
  "--referer", "https://www.bseindia.com/",
  bseUrl
], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }));
if (!Array.isArray(bseRecords)) throw new Error("BSE equity master returned an invalid payload");

const niftyIndustries = new Map();
if (fs.existsSync(niftyPath)) {
  for (const record of parseCsv(fs.readFileSync(niftyPath, "utf8"))) {
    const symbol = String(record.symbol || "").trim().toUpperCase();
    if (symbol) niftyIndustries.set(symbol, record.industry || "");
  }
}

const rows = buildIndianEquityUniverse(
  parseCsv(await nseResponse.text()),
  bseRecords,
  niftyIndustries
);

validateUniverseSnapshot(rows, {
  label: "All Indian Market",
  minRows: 3000,
  maxRows: 15000,
  maxDropPct: 20,
  previousRows
});
writeUniverseAtomically(
  outputPath,
  rows,
  [
    "symbol", "name", "industry", "series", "isin", "exchange",
    "trading_symbol", "scrip_code", "search_aliases", "enabled"
  ]
);

const nseCount = rows.filter((row) => row.exchange === "NSE").length;
const bseOnlyCount = rows.filter((row) => row.exchange === "BSE").length;
console.log(`Saved ${rows.length} unique Indian equities (${nseCount} NSE, ${bseOnlyCount} BSE-only) to ${outputPath}`);
console.log(formatUniverseChanges(universeChanges(previousRows, rows)));
