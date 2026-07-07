import { pullCloudCustomList, pushCloudState } from "./cloud-sync.js";
import { runScreener } from "./screener.js";

try {
  const pulled = await pullCloudCustomList();
  console.log(
    pulled.ok
      ? `Cloud custom list loaded: ${pulled.count} symbols`
      : `Cloud custom list skipped: ${pulled.reason}`
  );

  const result = await runScreener({ sendTelegram: true });
  const pushed = await pushCloudState(result);
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
