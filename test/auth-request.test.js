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
  assert.match(buildSource, /"pnl-accounting\.js"/);
});

test("owner can securely enter and leave a managed client portfolio", () => {
  const html = fs.readFileSync(path.join(rootDir, "public", "index.html"), "utf8");
  const auth = fs.readFileSync(path.join(rootDir, "public", "auth.js"), "utf8");
  const api = fs.readFileSync(path.join(rootDir, "supabase", "functions", "techno-funda-app-api", "index.ts"), "utf8");
  assert.match(html, /id="managedUserBanner"/);
  assert.match(auth, /data-admin-action="portfolio"/);
  assert.match(auth, /X-TF-Managed-User-ID/);
  assert.match(api, /managedContextForRequest/);
  assert.match(api, /requireAdmin\(context\)/);
  assert.match(api, /managedByOwner/);
});

test("owner account reset targets one selected portfolio with explicit confirmation", () => {
  const html = fs.readFileSync(path.join(rootDir, "public", "index.html"), "utf8");
  const auth = fs.readFileSync(path.join(rootDir, "public", "auth.js"), "utf8");
  const api = fs.readFileSync(path.join(rootDir, "supabase", "functions", "techno-funda-app-api", "index.ts"), "utf8");
  const runtime = fs.readFileSync(path.join(rootDir, "src", "multi-user-runtime.js"), "utf8");
  const migration = fs.readFileSync(path.join(rootDir, "supabase", "migrations", "20260718090000_make_portfolio_reset_account_specific.sql"), "utf8");
  assert.match(html, /id="openMasterResetButton"/);
  assert.match(html, /id="masterResetUser"/);
  assert.match(html, /RESET SELECTED PORTFOLIO/);
  assert.match(auth, /admin-reset-user-portfolio/);
  assert.match(auth, /subjectUserId/);
  assert.doesNotMatch(auth, /admin-reset-all-portfolios/);
  assert.match(api, /requireMasterResetConfirmation/);
  assert.match(api, /admin_reset_user_portfolio/);
  assert.match(api, /eq\("reset_generation", resetGeneration\)/);
  assert.match(api, /portfolio-reset-superseded-scan/);
  assert.match(runtime, /resetGeneration: user\.resetGeneration/);
  assert.match(migration, /USER_PORTFOLIO_RESET/);
  assert.match(migration, /where user_id = p_subject_user_id/);
  assert.match(migration, /legacyOwnerJournalMigratedAt/);
  assert.match(migration, /grant execute on function public\.admin_reset_user_portfolio/);
  assert.match(migration, /drop function if exists public\.admin_reset_all_portfolios/);
  assert.match(migration, /to service_role/);
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

test("open positions table expands to the available viewport before scrolling", () => {
  const html = fs.readFileSync(path.join(rootDir, "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(rootDir, "public", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(rootDir, "public", "styles.css"), "utf8");
  assert.match(html, /id="openPositionsShell"/);
  assert.match(app, /function fitOpenPositionsShell/);
  assert.match(app, /viewportHeight - documentTop - 12/);
  assert.match(app, /visualViewport\?\.addEventListener\("resize", fitOpenPositionsShell/);
  assert.match(styles, /\.positionsShell\.openPositionsShell/);
  assert.match(styles, /--open-positions-max-height/);
});

test("open positions restore a compact action label and readable signal reason", () => {
  const app = fs.readFileSync(path.join(rootDir, "public", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(rootDir, "public", "styles.css"), "utf8");
  assert.match(app, /buildDecisionGuide\(detailRow, trade\)/);
  assert.match(app, /positionSignalLabel/);
  assert.match(app, /decisionGuide\.summary/);
  assert.match(styles, /\.positionSignalLabel/);
  assert.match(styles, /-webkit-line-clamp: 2/);
});

test("filled holdings and pending execution orders are presented separately", () => {
  const html = fs.readFileSync(path.join(rootDir, "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(rootDir, "public", "app.js"), "utf8");
  assert.match(html, /Deployed in Filled Holdings/);
  assert.match(html, /id="reservedCapital"/);
  assert.match(html, /id="pendingOrdersBody"/);
  assert.match(html, /id="dashboardPendingOrdersBody"/);
  assert.match(html, /No approved 09:17 orders/);
  assert.match(html, /No executed open holdings/);
  assert.match(app, /function filledHoldings/);
  assert.match(app, /function pendingOrderItems/);
  assert.match(app, /trade\.orderState === "CONFIRMED_FOR_0917"/);
  assert.doesNotMatch(app, /\["APPROVED_FOR_0917", "CONFIRMED_FOR_0917"\]\.includes/);
  assert.match(app, /dashboardPendingOrdersBody/);
  assert.match(app, /const displayStatus = "OPEN"/);
  assert.doesNotMatch(app, /\["PENDING_ENTRY", "OPEN", "PENDING_EXIT", "PENDING_PARTIAL_EXIT"\]/);
});

test("cloud state bypasses stale caches and refreshes when the installed app returns to foreground", () => {
  const html = fs.readFileSync(path.join(rootDir, "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(rootDir, "public", "app.js"), "utf8");
  const auth = fs.readFileSync(path.join(rootDir, "public", "auth.js"), "utf8");
  const worker = fs.readFileSync(path.join(rootDir, "public", "service-worker.js"), "utf8");
  assert.match(app, /tf_refresh/);
  assert.match(app, /fetch\(url, \{ cache: "no-store" \}\)/);
  assert.doesNotMatch(app, /headers:\s*\{\s*"Cache-Control"/);
  assert.match(app, /visibilitychange[\s\S]*refreshCloudState/);
  assert.match(app, /setInterval[\s\S]*refreshCloudState/);
  assert.match(app, /renderProcessStatus/);
  assert.match(auth, /20260724-branded-navigation/);
  assert.match(auth, /registration\.update\(\)/);
  assert.match(worker, /techno-funda-shell-v41-branded-navigation/);
  assert.doesNotMatch(app, /Check Updates/);
  assert.doesNotMatch(html, /id="refreshButton"/);
  assert.match(html, /<span>Market Scan<\/span><strong>Wait<\/strong>/);
  assert.match(html, /<span>08:30 Orders<\/span><strong>Wait<\/strong>/);
  assert.doesNotMatch(html, /Cloud data refreshes automatically/);
  assert.match(app, /strong\.textContent = item\.statusLabel \|\| \(completed \? "DONE" : overdue \? "MISSED" : "WAIT"\)/);
  assert.match(app, /function formatProcessTime[\s\S]*day: "2-digit",[\s\S]*month: "short"/);
  assert.match(app, /"BLOCKED"[\s\S]*"08:30 missing"/);
  assert.match(app, /"NO ORDERS"[\s\S]*"No execution needed"/);
  assert.match(app, /window\.addEventListener\("popstate", restoreAppHistory\)/);
  assert.match(app, /window\.history\.pushState\(appHistoryState/);
  assert.match(app, /nextView === HOME_VIEW[\s\S]*window\.history\.go/);
  assert.match(app, /detailSymbol[\s\S]*window\.history\.back\(\)/);
});

test("authenticated dashboard loads a lightweight portfolio first and full market rows only inside Screener", () => {
  const app = fs.readFileSync(path.join(rootDir, "public", "app.js"), "utf8");
  const api = fs.readFileSync(path.join(rootDir, "supabase", "functions", "techno-funda-app-api", "index.ts"), "utf8");
  assert.match(app, /fetchSecureCloudState\("dashboard"\)/);
  assert.match(app, /nextView === "screener"[\s\S]*ensureFullMarketState/);
  assert.match(app, /fetchSecureCloudState\("state"\)/);
  assert.match(api, /dashboardOnly: view === "dashboard"/);
  assert.match(api, /journal: _privateJournal/);
  assert.match(api, /"OPEN", "PENDING_ENTRY", "PENDING_EXIT", "PENDING_PARTIAL_EXIT"/);
  assert.match(api, /function dashboardLists/);
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
  assert.match(html, /Background Alerts: OFF/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(app, /Background Alerts: ON/);
  assert.match(app, /toggleBrowserNotifications/);
  assert.match(app, /pushVerifiedAt/);
  assert.match(app, /Date\.now\(\) - state\.pushVerifiedAt/);
  assert.match(app, /unregister-push-subscription/);
  assert.match(app, /Background alerts are OFF on this device/);
  assert.match(fs.readFileSync(path.join(rootDir, "public", "styles.css"), "utf8"), /#alertsEmpty \{ position: static;/);
  assert.match(worker, /notificationclick/);
  assert.match(worker, /view=alerts/);
  assert.match(api, /ALERT_HISTORY_CLEARED/);
});
