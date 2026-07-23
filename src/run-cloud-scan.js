import { pushCloudState } from "./cloud-sync.js";
import { attemptCloud, hydrateCloudRuntime } from "./cloud-runtime.js";
import { runScreener } from "./screener.js";
import { multiUserRuntimeEnabled, syncMultiUserRuntime } from "./multi-user-runtime.js";
import { morningApprovalStatus } from "./morning-cycle.js";

try {
  await hydrateCloudRuntime({ includeCustomList: true });

  const requestedMorningCycle = process.env.MORNING_ALERTS === "true" ||
    process.env.TELEGRAM_MORNING_ONLY === "true";
  const morningCycle = morningApprovalStatus(requestedMorningCycle, new Date());
  const publishActionAlerts = morningCycle.allowed;
  const morningTelegram = morningCycle.allowed && process.env.TELEGRAM_MORNING_ONLY === "true";
  if (morningCycle.requested && !morningCycle.allowed) {
    console.log(
      `Morning approval request ignored at ${morningCycle.clock?.time || "unknown"} IST (${morningCycle.reason}); ` +
      "no orders, Telegram alerts or push alerts will be published by this late run."
    );
  }
  const result = await runScreener({
    sendTelegram: morningTelegram && !multiUserRuntimeEnabled(),
    publishActionAlerts
  });
  const pushed = await attemptCloud(
    () => pushCloudState(result),
    { ok: false, reason: "cloud state upload unavailable" }
  );
  console.log(pushed.ok ? "Cloud state updated" : `Cloud state skipped: ${pushed.reason}`);
  const multiUser = await attemptCloud(
    () => syncMultiUserRuntime(result, { sendTelegram: morningTelegram, publishActionAlerts }),
    { ok: false, reason: "multi-user app sync unavailable", processed: 0 }
  );
  console.log(
    multiUser.ok
      ? `Multi-user app updated: ${multiUser.processed} portfolios`
      : `Multi-user app sync skipped/partial: ${multiUser.reason || `${multiUser.failed || 0} failed`}`
  );
  if (!multiUser.ok) {
    throw new Error(
      `Completed market scan could not update every portfolio (${multiUser.failed || "unknown"} failed).`
    );
  }
  console.log(
    [
      `Scan complete at ${result.scannedAt}`,
      `Entry: ${result.summary.entry}`,
      `Exit: ${result.summary.exit}`,
      `Watch: ${result.summary.watch}`,
      `Error: ${result.summary.error}`,
      `Telegram: ${result.telegram.sent ? "sent" : result.telegram.reason}`
    ].join("\n")
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
