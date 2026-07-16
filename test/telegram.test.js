import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sendTelegramSummary } from "../src/telegram.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Telegram sends one minimal stock-wise message for each buy entry and full exit", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true };
  };
  try {
    const scan = {
      portfolioSummary: { totalCapital: 1_000_000, totalEquity: 1_100_000 },
      tradeEvents: [
        {
          type: "ENTRY_SIGNAL_PENDING",
          trade: { symbol: "ABC", plannedQuantity: 100, plannedAllocation: 99_500 }
        },
        {
          type: "EXIT_SIGNAL_PENDING",
          trade: { symbol: "XYZ", quantity: 50, lastPrice: 2_200 }
        },
        {
          type: "PARTIAL_EXIT_PENDING",
          trade: { symbol: "NOISY", quantity: 100, lastPrice: 100, pendingPartialExitPct: 50 }
        }
      ]
    };
    const result = await sendTelegramSummary(scan, {
      telegram: { botToken: "test-token", chatId: "test-chat", sendEmpty: false }
    });
    assert.equal(result.sent, true);
    assert.equal(result.messages, 2);
    assert.equal(requests.length, 2);
    assert.match(requests[0].text, /<b>BUY ENTRY \| ABC<\/b>/);
    assert.match(requests[0].text, /Approx Buy Qty: <b>100<\/b>/);
    assert.match(requests[0].text, /Fund Allocation: <b>9\.95%<\/b>/);
    assert.match(requests[1].text, /<b>FULL EXIT \| XYZ<\/b>/);
    assert.match(requests[1].text, /Approx Sell Qty: <b>50<\/b>/);
    assert.match(requests[1].text, /Fund Allocation: <b>11%<\/b>/);
    assert.ok(requests.every((request) => request.parse_mode === "HTML"));
    assert.ok(requests.every((request) => !/P&L|reason|market snapshot/i.test(request.text)));
    assert.ok(requests.every((request) => !request.text.includes("NOISY")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Telegram ignores fills, partial exits, pyramids and corporate events", async () => {
  const result = await sendTelegramSummary({
    portfolioSummary: { totalEquity: 1_000_000 },
    tradeEvents: [
      { type: "ENTRY_TRADE_OPENED", trade: { symbol: "ABC", quantity: 100, investedValue: 100_000 } },
      { type: "PARTIAL_EXIT_PENDING", trade: { symbol: "XYZ", quantity: 100, lastPrice: 100 } },
      { type: "PYRAMID_ADD_PENDING", trade: { symbol: "ADD", pendingAdd: { plannedQuantity: 20, plannedAllocation: 20_000 } } },
      { type: "DIVIDEND_CREDIT", trade: { symbol: "DIV" } }
    ]
  }, { telegram: { botToken: "test-token", chatId: "test-chat" } });
  assert.equal(result.sent, false);
  assert.match(result.reason, /no new buy entry or full exit/i);
});

test("workflow authorizes Telegram only for the scheduled 08:30 IST scan", () => {
  const workflow = fs.readFileSync(path.join(rootDir, ".github", "workflows", "daily-screener.yml"), "utf8");
  const executionRunner = fs.readFileSync(path.join(rootDir, "src", "run-execution-pass.js"), "utf8");
  const cloudRunner = fs.readFileSync(path.join(rootDir, "src", "run-cloud-scan.js"), "utf8");
  assert.match(workflow, /MORNING_ALERTS:.*event_name == 'schedule'.*event\.schedule == '0 3 \* \* 1-5'/);
  assert.match(workflow, /TELEGRAM_MORNING_ONLY:.*MORNING_ALERTS/);
  assert.match(executionRunner, /runExecutionPass\(\{ sendTelegram: false \}\)/);
  assert.match(executionRunner, /executionOnly: true, sendTelegram: false/);
  assert.match(cloudRunner, /TELEGRAM_MORNING_ONLY === "true"/);
});
