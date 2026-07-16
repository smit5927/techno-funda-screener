import assert from "node:assert/strict";
import test from "node:test";
import { buildIndianEquityUniverse } from "../src/indian-market-universe.js";

test("Indian universe prefers NSE and adds only BSE-only ISINs", () => {
  const rows = buildIndianEquityUniverse(
    [{ symbol: "ABC", name_of_company: "ABC Limited", series: "EQ", isin_number: "INE000A01001" }],
    [
      { SCRIP_CD: "500001", scrip_id: "ABC", Scrip_Name: "ABC Ltd", Status: "Active", Segment: "Equity", ISIN_NUMBER: "INE000A01001", GROUP: "A" },
      { SCRIP_CD: "500002", scrip_id: "ONLYBSE", Scrip_Name: "Only BSE Ltd", Status: "Active", Segment: "Equity", ISIN_NUMBER: "INE000B01001", GROUP: "X" }
    ],
    new Map([["ABC", "Industrials"]])
  );

  assert.equal(rows.length, 2);
  const nse = rows.find((row) => row.isin === "INE000A01001");
  assert.equal(nse.exchange, "NSE");
  assert.match(nse.search_aliases, /500001/);
  const bse = rows.find((row) => row.exchange === "BSE");
  assert.equal(bse.symbol, "BSE:500002");
  assert.match(bse.search_aliases, /ONLYBSE/);
  assert.match(bse.search_aliases, /INE000B01001/);
});

test("Indian universe excludes inactive and non-equity BSE records", () => {
  const rows = buildIndianEquityUniverse([], [
    { SCRIP_CD: "1", Status: "Suspended", Segment: "Equity" },
    { SCRIP_CD: "2", Status: "Active", Segment: "Debt" },
    { SCRIP_CD: "3", Status: "Active", Segment: "Equity", Scrip_Name: "Valid" }
  ]);
  assert.deepEqual(rows.map((row) => row.symbol), ["BSE:3"]);
});
