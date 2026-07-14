import { pushCloudState } from "./cloud-sync.js";
import { attemptCloud, hydrateCloudRuntime } from "./cloud-runtime.js";
import { runExecutionPass } from "./screener.js";

try {
  await hydrateCloudRuntime({ includeCustomList: false });
  const result = await runExecutionPass({ sendTelegram: true });
  const pushed = await attemptCloud(
    () => pushCloudState(result),
    { ok: false, reason: "cloud state upload unavailable" }
  );
  console.log(pushed.ok ? "Cloud state updated" : `Cloud state skipped: ${pushed.reason}`);
  console.log(
    [
      `Execution pass: ${result.executionPass?.status || "completed"}`,
      `Updated at: ${result.executionPassAt || result.scannedAt}`,
      `Open: ${result.tradeSummary?.open ?? 0}`,
      `Pending buy: ${result.tradeSummary?.pendingEntry ?? 0}`,
      `Pending sell: ${result.tradeSummary?.pendingExit ?? 0}`,
      `Pending partial sell: ${result.tradeSummary?.pendingPartialExit ?? 0}`,
      `Telegram: ${result.telegram?.sent ? "sent" : result.telegram?.reason}`
    ].join("\n")
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
