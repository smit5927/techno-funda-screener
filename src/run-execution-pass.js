import { pushCloudState } from "./cloud-sync.js";
import { attemptCloud, hydrateCloudRuntime } from "./cloud-runtime.js";
import { runExecutionPass } from "./screener.js";
import { syncMultiUserRuntime } from "./multi-user-runtime.js";

try {
  await hydrateCloudRuntime({ includeCustomList: false });
  const result = await runExecutionPass({ sendTelegram: false });
  const pushed = await attemptCloud(
    () => pushCloudState(result),
    { ok: false, reason: "cloud state upload unavailable" }
  );
  console.log(pushed.ok ? "Cloud state updated" : `Cloud state skipped: ${pushed.reason}`);
  const multiUser = await attemptCloud(
    () => syncMultiUserRuntime(result, { executionOnly: true, sendTelegram: false }),
    { ok: false, reason: "multi-user execution sync unavailable", processed: 0 }
  );
  console.log(
    multiUser.ok
      ? `Multi-user execution updated: ${multiUser.processed} portfolios`
      : `Multi-user execution skipped/partial: ${multiUser.reason || `${multiUser.failed || 0} failed`}`
  );
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
