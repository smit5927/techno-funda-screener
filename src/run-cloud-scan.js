import { appConfig } from "./config.js";
import {
  pullCloudCustomList,
  pullCloudTelegramConfig,
  pullCloudTradeSettings,
  pushCloudState
} from "./cloud-sync.js";
import { runScreener } from "./screener.js";

try {
  const pulled = await attemptCloud(
    () => pullCloudCustomList(),
    { ok: false, reason: "cloud custom list unavailable", count: 0 }
  );
  console.log(
    pulled.ok
      ? `Cloud custom list loaded: ${pulled.count} symbols`
      : `Cloud custom list skipped: ${pulled.reason}`
  );

  const telegram = await attemptCloud(
    () => pullCloudTelegramConfig(),
    { ok: false, reason: "cloud Telegram settings unavailable", telegram: null }
  );
  if (telegram.ok && telegram.telegram?.enabled !== false) {
    appConfig.telegram.botToken = telegram.telegram?.botToken || appConfig.telegram.botToken || "";
    appConfig.telegram.chatId = telegram.telegram?.chatId || appConfig.telegram.chatId || "";
  }

  const tradeSettings = await attemptCloud(
    () => pullCloudTradeSettings(),
    { ok: false, reason: "cloud trade settings unavailable", tradeSettings: null }
  );
  if (tradeSettings.ok && tradeSettings.tradeSettings) {
    appConfig.trade.scopeListId =
      tradeSettings.tradeSettings.scopeListId || appConfig.trade.scopeListId;
    appConfig.trade.qualityMode =
      tradeSettings.tradeSettings.qualityMode || appConfig.trade.qualityMode;
    console.log(
      `Trade settings loaded: ${appConfig.trade.scopeListId} / ${appConfig.trade.qualityMode}`
    );
  } else {
    console.log(`Trade settings skipped: ${tradeSettings.reason}`);
  }

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

async function attemptCloud(operation, fallback) {
  try {
    return await operation();
  } catch (error) {
    return {
      ...fallback,
      reason: error.message || String(error)
    };
  }
}
