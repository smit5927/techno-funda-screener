import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveRequestUrl } from "../public/auth-request.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("authenticated fetch routing recognizes URL objects", () => {
  const target = new URL("https://example.supabase.co/functions/v1/app?view=meta");
  assert.equal(resolveRequestUrl(target, "https://example.test/").href, target.href);
});

test("authenticated fetch routing recognizes strings and Request-like objects", () => {
  assert.equal(resolveRequestUrl("/api/state", "https://example.test/").href, "https://example.test/api/state");
  assert.equal(
    resolveRequestUrl({ url: "https://example.supabase.co/functions/v1/app" }, "https://example.test/").href,
    "https://example.supabase.co/functions/v1/app"
  );
});

test("static website build publishes the authentication helper", () => {
  const buildSource = fs.readFileSync(path.join(rootDir, "src", "build-static-site.js"), "utf8");
  assert.match(buildSource, /"auth-request\.js"/);
  assert.match(buildSource, /"detail-evidence\.js"/);
  assert.match(buildSource, /"decision-guide\.js"/);
});

test("portfolio summary exposes live today and total unrealized P&L", () => {
  const html = fs.readFileSync(path.join(rootDir, "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(rootDir, "public", "app.js"), "utf8");
  assert.match(html, /id="todayUnrealizedPnl"/);
  assert.match(html, /Total Unrealized P&amp;L/);
  assert.match(html, /id="realizedPnlLabel"/);
  assert.match(html, /Techno Funda PMS/);
  assert.doesNotMatch(html, /id="dividendRealizedPnl"/);
  assert.match(html, /id="realizedPnlBreakdown"/);
  assert.match(html, /id="portfolioReturn"/);
  assert.match(html, /id="portfolioReturnBasis"/);
  assert.match(html, /id="removeCapitalInput"/);
  assert.match(html, /Overall Portfolio Return/);
  assert.match(html, /class="pnlPerformanceSection"/);
  assert.match(html, /class="pnlPerformanceGrid"/);
  assert.match(html, /id="dashboardPositionFilter"/);
  assert.match(html, /id="dashboardPositionSortSelect"/);
  assert.match(html, /id="dashboardPositionSortDirection"/);
  assert.match(app, /summary\.dayPnl/);
  assert.match(app, /summary\.dayPnlPct/);
  assert.match(app, /portfolioReturnPerformance/);
  assert.match(app, /removeCapital/);
  assert.match(app, /Flow-adjusted NAV/);
  assert.match(app, /renderSummaryPnl\(elements\.realizedPnl/);
  assert.match(app, /renderRealizedBreakdown\(payload\)/);
  assert.match(app, /Gross Trading P&L/);
  assert.match(app, /Dividend Income/);
  assert.match(app, /Charges \$\{compact\(-Math\.abs\(realizedCharges\)\)\}/);
  assert.match(app, /renderSummaryPnl\(elements\.unrealizedPnl/);
  assert.match(app, /pnlGainPulse/);
  assert.match(app, /pnlLossPulse/);
  assert.match(app, /metricPulseGain/);
  assert.match(app, /metricPulseLoss/);
  assert.match(app, /tfDashboardPositionFilter/);
});

test("alert center supports durable history, account clear and notification deep links", () => {
  const html = fs.readFileSync(path.join(rootDir, "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(rootDir, "public", "app.js"), "utf8");
  const worker = fs.readFileSync(path.join(rootDir, "public", "service-worker.js"), "utf8");
  const api = fs.readFileSync(path.join(rootDir, "supabase", "functions", "techno-funda-app-api", "index.ts"), "utf8");
  assert.match(html, /id="alertsNavButton"/);
  assert.match(html, /id="clearAlertsButton"/);
  assert.match(html, /id="alertsActionStatus"/);
  assert.match(app, /clear-alert-history/);
  assert.match(app, /processAlertNotifications/);
  assert.match(app, /Alert history is already empty/);
  assert.match(app, /No alerts are available to mark as read/);
  assert.match(app, /Notifications are blocked/);
  assert.match(fs.readFileSync(path.join(rootDir, "public", "styles.css"), "utf8"), /#alertsEmpty \{ position: static;/);
  assert.match(worker, /notificationclick/);
  assert.match(worker, /view=alerts/);
  assert.match(api, /ALERT_HISTORY_CLEARED/);
});
