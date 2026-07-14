import { appConfig } from "./config.js";
import {
  pullCloudCustomList,
  pullCloudTelegramConfig,
  pullCloudTradeSettings
} from "./cloud-sync.js";

export async function hydrateCloudRuntime({ includeCustomList = true } = {}) {
  if (includeCustomList) {
    const pulled = await attemptCloud(
      () => pullCloudCustomList(),
      { ok: false, reason: "cloud custom list unavailable", count: 0 }
    );
    console.log(
      pulled.ok
        ? `Cloud custom list loaded: ${pulled.count} symbols`
        : `Cloud custom list skipped: ${pulled.reason}`
    );
  }

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
    if (Number.isFinite(Number(tradeSettings.tradeSettings.totalCapital))) {
      appConfig.trade.totalCapital = Number(tradeSettings.tradeSettings.totalCapital);
    }
    console.log(
      `Trade settings loaded: ${appConfig.trade.scopeListId} / ${appConfig.trade.qualityMode} / capital Rs ${appConfig.trade.totalCapital}`
    );
  } else {
    console.log(`Trade settings skipped: ${tradeSettings.reason}`);
  }
}

export async function attemptCloud(operation, fallback) {
  try {
    return await operation();
  } catch (error) {
    return {
      ...fallback,
      reason: error.message || String(error)
    };
  }
}
