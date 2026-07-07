import { appConfig } from "./config.js";
import { pullCloudCustomList, pullCloudTelegramConfig, pushCloudState } from "./cloud-sync.js";
import { runScreener } from "./screener.js";

try {
  const pulled = await pullCloudCustomList();
  console.log(
    pulled.ok
      ? `Cloud custom list loaded: ${pulled.count} symbols`
      : `Cloud custom list skipped: ${pulled.reason}`
  );

  const telegram = await pullCloudTelegramConfig();
  if (telegram.ok && telegram.telegram?.enabled !== false) {
    appConfig.telegram.botToken = appConfig.telegram.botToken || telegram.telegram?.botToken || "";
    appConfig.telegram.chatId = appConfig.telegram.chatId || telegram.telegram?.chatId || "";
  }

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
