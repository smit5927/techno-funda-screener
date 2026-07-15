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

test("a BSE fallback trade uses the latest NSE-alias row for hard exit decisions", async () => {
  const trade = {
    id: "NEXUSSURGL-open",
    symbol: "NEXUSSURGL",
    yahooSymbol: "NEXUSSURGL.BO",
    status: "OPEN",
    tradeScope: "custom",
    listId: "custom",
    entrySignalDate: "2026-07-09",
    entryDate: "2026-07-10",
    entryPrice: 19.59,
    initialEntryPrice: 19.59,
    quantity: 16,
    originalQuantity: 31,
    initialQuantity: 31,
    investedValue: 313.44,
    originalInvestedValue: 607.29,
    initialStopPrice: 19.01,
    trailingStopPrice: 19.01,
    partialExits: [],
    partialExitTags: [],
    addOns: [],
    entrySnapshot: {
      weeklyRs: 0.2,
      dailyLongRs: 0.05,
      dailyShortRs: 0.01,
      dailyRsi: 55,
      setupGrade: "A"
    }
  };
  const row = {
    listId: "custom",
    listLabel: "My Custom List",
    symbol: "NEXUSSURGL",
    yahooSymbol: "NEXUSSURGL.NS",
    status: "WATCH",
    asOf: "2026-07-15",
    close: 17.83,
    weeklyRs: 0.21,
    weeklyRsi: 58,
    dailyLongRs: -0.16,
    dailyShortRs: -0.09,
    dailyRsi: 45,
    dailySupertrend: 19.01,
    setupGrade: "WATCH",
    setupStrength: { checks: {}, values: { smaFast: 20 } },
    fundamentalScore: 3
  };
  const journal = await updateTradeJournal(
    {
      scannedAt: "2026-07-15T11:32:00.000Z",
      scannedListIds: ["custom"],
      marketContext: { asOf: "2026-07-15", riskMode: "BULL", exposureCapPct: 100 },
      lists: {
        custom: { id: "custom", label: "My Custom List", results: [row] }
      }
    },
    {
      ...appConfig,
      trade: {
        ...appConfig.trade,
        scopeListId: "custom",
        qualityMode: "ALL_ENTRIES",
        executionPriceFetcher: async () => null
      }
    },
    {
      journal: {
        portfolioEngineStartedAt: "2026-07-01T00:00:00.000Z",
        pyramidingStartedAt: "2026-07-01T00:00:00.000Z",
        pyramidSwingEngineStartedAt: "2026-07-01T00:00:00.000Z",
        liveModeStartedAt: "2026-07-01T00:00:00.000Z",
        candidates: [],
        trades: [trade]
      },
      persist: false,
      writeSheets: false
    }
  );
  const updated = journal.trades.find((item) => item.symbol === "NEXUSSURGL");

  assert.equal(updated.status, "PENDING_EXIT");
  assert.equal(updated.currentSnapshot.close, 17.83);
  assert.equal(updated.currentSnapshot.dailyLongRs, -0.16);
  assert.match(updated.exitReason.join(" "), /RS55 is below zero/i);
  assert.match(updated.executionError, /09:17/i);
});
