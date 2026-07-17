import { pushCloudState } from "./cloud-sync.js";
import { attemptCloud, hydrateCloudRuntime } from "./cloud-runtime.js";
import { runScreener } from "./screener.js";
import { multiUserRuntimeEnabled, syncMultiUserRuntime } from "./multi-user-runtime.js";

try {
  await hydrateCloudRuntime({ includeCustomList: true });

  const morningTelegram = process.env.TELEGRAM_MORNING_ONLY === "true";
  const publishActionAlerts = process.env.MORNING_ALERTS === "true" || morningTelegram;
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
