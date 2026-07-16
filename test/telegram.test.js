import assert from "node:assert/strict";
import test from "node:test";
import { sendTelegramSummary } from "../src/telegram.js";

test("Telegram highlights order quantity, value and current portfolio percentage", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true };
  };
  try {
    const scan = {
      scannedAt: "2026-07-16T03:00:00.000Z",
      summary: { total: 1, entry: 1, exit: 0, watch: 0 },
      tradeSettings: { scopeLabel: "My List", qualityLabel: "Best only (A+/A)" },
      tradeSummary: {},
      portfolioSummary: { totalCapital: 1_000_000, totalEquity: 1_100_000 },
      lists: {},
      tradeEvents: [{
        type: "ENTRY_SIGNAL_PENDING",
        trade: {
          id: "ABC-entry",
          symbol: "ABC",
          listLabel: "My List",
          entrySignalDate: "2026-07-15",
          plannedQuantity: 100,
          plannedAllocation: 99_500,
          entryReason: ["Weekly & daily leadership confirmed."],
          entrySnapshot: {}
        }
      }]
    };
    const result = await sendTelegramSummary(scan, {
      telegram: { botToken: "test-token", chatId: "test-chat", sendEmpty: false }
    });
    assert.equal(result.sent, true);
    assert.equal(requestBody.parse_mode, "HTML");
    assert.match(requestBody.text, /<b>APPROX BUY: Qty 100 \| Rs 99,500 \| 9\.05% of current portfolio value \(cash \+ holdings\)<\/b>/);
    assert.match(requestBody.text, /Weekly &amp; daily leadership confirmed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
