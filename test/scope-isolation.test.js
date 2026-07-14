import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appConfig } from "../src/config.js";
import { updateTradeJournal } from "../src/trade-journal.js";

test("an old all-market waiting candidate cannot enter a custom-list portfolio", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "techno-funda-scope-"));
  const original = {
    dataDir: appConfig.dataDir,
    tradesPath: appConfig.tradesPath,
    tradeSheetPath: appConfig.tradeSheetPath,
    tradeCsvPath: appConfig.tradeCsvPath
  };
  Object.assign(appConfig, {
    dataDir: temp,
    tradesPath: path.join(temp, "trades.json"),
    tradeSheetPath: path.join(temp, "trades.xlsx"),
    tradeCsvPath: path.join(temp, "trades.csv")
  });

  try {
    fs.writeFileSync(appConfig.tradesPath, `${JSON.stringify({
      portfolioEngineStartedAt: "2026-07-01T00:00:00.000Z",
      pyramidingStartedAt: "2026-07-01T00:00:00.000Z",
      pyramidSwingEngineStartedAt: "2026-07-01T00:00:00.000Z",
      liveModeStartedAt: "2026-07-01T00:00:00.000Z",
      candidates: [{
        id: "OUTSIDE-candidate",
        symbol: "OUTSIDE",
        yahooSymbol: "OUTSIDE.NS",
        tradeScope: "all-market",
        firstSignalDate: "2026-07-10",
        firstSignalClose: 100,
        rank: 200,
        peakRank: 200,
        entryCloseDates: ["2026-07-10"]
      }],
      trades: []
    }, null, 2)}\n`);

    const journal = await updateTradeJournal(
      {
        scannedAt: "2026-07-14T03:00:00.000Z",
        scannedListIds: ["all-market", "custom"],
        marketContext: { asOf: "2026-07-13", riskMode: "BULL", exposureCapPct: 100 },
        lists: {
          "all-market": {
            id: "all-market",
            label: "All NSE Market",
            results: [{
              listId: "all-market",
              listLabel: "All NSE Market",
              symbol: "OUTSIDE",
              yahooSymbol: "OUTSIDE.NS",
              status: "ENTRY",
              close: 105,
              asOf: "2026-07-13",
              setupGrade: "A+"
            }]
          },
          custom: {
            id: "custom",
            label: "My Custom List",
            results: []
          }
        }
      },
      {
        ...appConfig,
        trade: {
          ...appConfig.trade,
          scopeListId: "custom",
          qualityMode: "STRONG_OR_BETTER"
        }
      }
    );

    assert.equal(journal.candidates.some((candidate) => candidate.symbol === "OUTSIDE"), false);
    assert.equal(journal.trades.some((trade) => trade.symbol === "OUTSIDE"), false);
  } finally {
    Object.assign(appConfig, original);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
