import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sendTelegramSummary } from "../src/telegram.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Telegram mirrors every website actionable alert as a separate stock-wise message", async () => {
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
          trade: { symbol: "TRIM", quantity: 100, lastPrice: 100, pendingPartialExitPct: 50 }
        },
        {
          type: "PYRAMID_ADD_PENDING",
          trade: { symbol: "PYRAMID", pendingAdd: { plannedQuantity: 20, plannedAllocation: 20_000 } }
        },
        {
          type: "CONTROLLED_RETEST_ADD_PENDING",
          trade: { symbol: "RETEST", pendingAdd: { plannedQuantity: 10, plannedAllocation: 10_000 } }
        },
        {
          type: "DIVIDEND_CREDIT",
          trade: { symbol: "DIV" },
          corporateAction: { exDate: "2026-07-21", entitledQuantity: 50, dividendPerShare: 5, amount: 250 }
        }
      ]
    };
    const result = await sendTelegramSummary(scan, {
      telegram: { botToken: "test-token", chatId: "test-chat", sendEmpty: false }
    });
    assert.equal(result.sent, true);
    assert.equal(result.messages, 6);
    assert.equal(requests.length, 6);
    assert.match(requests[0].text, /<b>CONFIRMED BUY ORDER \| ABC<\/b>/);
    assert.match(requests[0].text, /Approx Buy Qty: <b>100<\/b>/);
    assert.match(requests[0].text, /Order Value: <b>Rs 99,500<\/b>/);
    assert.match(requests[0].text, /Fund Allocation: <b>9\.95%<\/b>/);
    assert.match(requests[1].text, /<b>CONFIRMED FULL EXIT \| XYZ<\/b>/);
    assert.match(requests[1].text, /Approx Sell Qty: <b>50<\/b>/);
    assert.match(requests[1].text, /Fund Allocation: <b>11%<\/b>/);
    assert.match(requests[2].text, /CONFIRMED PARTIAL EXIT \| TRIM/);
    assert.match(requests[2].text, /Approx Sell Qty: <b>50<\/b>/);
    assert.match(requests[3].text, /CONFIRMED PYRAMID ADD \| PYRAMID/);
    assert.match(requests[4].text, /CONFIRMED RETEST ADD \| RETEST/);
    assert.match(requests[5].text, /DIVIDEND CREDIT \| DIV/);
    assert.match(requests[5].text, /Ex-date: <b>2026-07-21<\/b>/);
    assert.match(requests[5].text, /Realized Dividend: <b>Rs 250<\/b>/);
    assert.ok(requests.every((request) => request.parse_mode === "HTML"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Telegram sends a standalone full exit when no buy entry exists", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true };
  };
  try {
    const result = await sendTelegramSummary({
      portfolioSummary: { totalCapital: 1_000_000 },
      tradeEvents: [{
        type: "EXIT_SIGNAL_PENDING",
        trade: { symbol: "EXITONLY", quantity: 40, lastPrice: 2_500 }
      }]
    }, {
      telegram: { botToken: "test-token", chatId: "test-chat" }
    });

    assert.equal(result.sent, true);
    assert.equal(result.messages, 1);
    assert.equal(requests.length, 1);
    assert.match(requests[0].text, /CONFIRMED FULL EXIT \| EXITONLY/);
    assert.doesNotMatch(requests[0].text, /BUY ORDER/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Telegram ignores non-actionable fills while retaining the website actionable set", async () => {
  const result = await sendTelegramSummary({
    portfolioSummary: { totalEquity: 1_000_000 },
    tradeEvents: [
      { type: "ENTRY_TRADE_OPENED", trade: { symbol: "ABC", quantity: 100, investedValue: 100_000 } },
      { type: "PARTIAL_EXIT_FILLED", trade: { symbol: "XYZ", quantity: 100, lastPrice: 100 } },
      { type: "PYRAMID_ADD_FILLED", trade: { symbol: "ADD", quantity: 20, investedValue: 20_000 } },
      { type: "CORPORATE_ACTION_REVIEW", trade: { symbol: "CORP" } }
    ]
  }, { telegram: { botToken: "test-token", chatId: "test-chat" } });
  assert.equal(result.sent, false);
  assert.match(result.reason, /no new actionable portfolio alerts/i);
});

test("time-critical approval and execution use isolated lightweight workflows", () => {
  const fullScanWorkflow = fs.readFileSync(path.join(rootDir, ".github", "workflows", "daily-screener.yml"), "utf8");
  const approvalWorkflow = fs.readFileSync(path.join(rootDir, ".github", "workflows", "morning-approval.yml"), "utf8");
  const executionWorkflow = fs.readFileSync(path.join(rootDir, ".github", "workflows", "execution-pass.yml"), "utf8");
  const overnightWorkflow = fs.readFileSync(path.join(rootDir, ".github", "workflows", "overnight-portfolio-cycle.yml"), "utf8");
  const executionRunner = fs.readFileSync(path.join(rootDir, "src", "run-execution-pass.js"), "utf8");
  const cloudRunner = fs.readFileSync(path.join(rootDir, "src", "run-cloud-scan.js"), "utf8");
  const approvalRunner = fs.readFileSync(path.join(rootDir, "src", "run-morning-approval.js"), "utf8");
  assert.doesNotMatch(fullScanWorkflow, /run: npm run (approve|execute):cloud/);
  assert.match(fullScanWorkflow, /group: techno-funda-full-scan/);
  assert.match(approvalWorkflow, /cron: "50 2 \* \* 1-5"/);
  assert.match(approvalWorkflow, /wait-until-ist\.js 08:30/);
  assert.match(approvalWorkflow, /run: npm run approve:cloud/);
  assert.doesNotMatch(approvalWorkflow, /npm test|build:static|deploy-pages|git push/);
  assert.match(executionWorkflow, /cron: "40 3 \* \* 1-5"/);
  assert.match(executionWorkflow, /wait-until-ist\.js 09:18/);
  assert.match(executionWorkflow, /run: npm run execute:cloud/);
  assert.doesNotMatch(executionWorkflow, /npm test|build:static|deploy-pages|git push/);
  assert.match(approvalRunner, /approvalOnly: true/);
  assert.match(approvalRunner, /publishActionAlerts: true/);
  assert.match(approvalRunner, /sendTelegram: true/);
  assert.match(executionRunner, /runExecutionPass\(\{ sendTelegram: false \}\)/);
  assert.match(executionRunner, /executionOnly: true,[\s\S]*sendTelegram: false,[\s\S]*publishActionAlerts: false/);
  assert.match(cloudRunner, /TELEGRAM_MORNING_ONLY === "true"/);
  assert.match(cloudRunner, /morningApprovalStatus/);
  assert.match(cloudRunner, /morningCycle\.allowed/);
  assert.match(cloudRunner, /publishActionAlerts/);
  assert.match(cloudRunner, /could not update every portfolio/);
  assert.match(overnightWorkflow, /workflow_run:/);
  assert.match(overnightWorkflow, /group: techno-funda-overnight-portfolio-cycle[\s\S]*cancel-in-progress: false/);
  assert.match(overnightWorkflow, /name: next-session-0830-gate/);
  assert.match(overnightWorkflow, /wait-until-ist\.js 08:30 180/);
  assert.match(overnightWorkflow, /wait-until-ist\.js 09:18 60/);
  assert.match(overnightWorkflow, /name: post-close-1900-gate/);
  assert.match(overnightWorkflow, /gh workflow run daily-screener\.yml --ref main/);
});
