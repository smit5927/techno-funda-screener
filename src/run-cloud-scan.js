import { pushCloudState } from "./cloud-sync.js";
import { attemptCloud, hydrateCloudRuntime } from "./cloud-runtime.js";
import { runScreener } from "./screener.js";

try {
  await hydrateCloudRuntime({ includeCustomList: true });

  const result = await runScreener({ sendTelegram: true });
  const pushed = await attemptCloud(
    () => pushCloudState(result),
    { ok: false, reason: "cloud state upload unavailable" }
  );
  console.log(pushed.ok ? "Cloud state updated" : `Cloud state skipped: ${pushed.reason}`);
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
