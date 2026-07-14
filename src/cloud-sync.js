import { appConfig } from "./config.js";
import { saveCustomWatchlist } from "./watchlist.js";

export async function pullCloudCustomList(config = appConfig) {
  const cloud = cloudConfig();
  if (!cloud.enabled) {
    return { ok: false, reason: "cloud sync not configured", count: 0 };
  }

  const payload = await postCloud(cloud, {
    action: "get-custom-list",
    internalKey: cloud.internalKey
  });
  const customList = config.lists.find((list) => list.id === "custom");
  if (!customList) throw new Error("Custom list is not configured.");

  const symbols = Array.isArray(payload.symbols) ? payload.symbols : [];
  const count = saveCustomWatchlist(customList.path, symbols.join("\n"));
  return { ok: true, count, symbols };
}

export async function pullCloudTelegramConfig() {
  const cloud = cloudConfig();
  if (!cloud.enabled) {
    return { ok: false, reason: "cloud sync not configured", telegram: null };
  }

  const payload = await postCloud(cloud, {
    action: "get-telegram-config",
    internalKey: cloud.internalKey
  });

  return { ok: true, telegram: payload.telegram || null };
}

export async function pullCloudTradeSettings() {
  const cloud = cloudConfig();
  if (!cloud.enabled) {
    return { ok: false, reason: "cloud sync not configured", tradeSettings: null };
  }

  const payload = await postCloud(cloud, {
    action: "get-trade-settings",
    internalKey: cloud.internalKey
  });

  return { ok: true, tradeSettings: payload.tradeSettings || null };
}

export async function pushCloudState(state) {
  const cloud = cloudConfig();
  if (!cloud.enabled) {
    return { ok: false, reason: "cloud sync not configured" };
  }

  await postCloud(cloud, {
    action: "save-state",
    internalKey: cloud.internalKey,
    state: compactCloudState(state)
  });
  return { ok: true };
}

export function compactCloudState(state = {}) {
  const lists = Object.fromEntries(
    Object.entries(state.lists || {}).map(([id, list]) => [
      id,
      {
        id: list.id || id,
        label: list.label || id,
        editable: list.editable === true,
        summary: list.summary || {}
      }
    ])
  );
  return {
    scannedAt: state.scannedAt,
    benchmark: state.benchmark,
    benchmarkLabel: state.benchmarkLabel,
    summary: state.summary,
    lists,
    marketContext: state.marketContext,
    institutionalContext: state.institutionalContext,
    tradeSettings: state.tradeSettings,
    tradeSummary: state.tradeSummary,
    portfolioSummary: state.portfolioSummary,
    portfolioRules: state.portfolioRules,
    trades: state.trades || [],
    waitingCandidates: state.waitingCandidates || [],
    candidateDecisionLog: state.candidateDecisionLog || [],
    tradeEvents: state.tradeEvents || [],
    telegram: state.telegram
  };
}

function cloudConfig() {
  const apiUrl = process.env.TECHNO_FUNDA_CLOUD_API_URL || "";
  const internalKey = process.env.TECHNO_FUNDA_INTERNAL_KEY || "";
  return {
    enabled: Boolean(apiUrl && internalKey),
    apiUrl,
    internalKey
  };
}

async function postCloud(cloud, body) {
  const response = await fetch(cloud.apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new Error(payload.error || `Cloud API failed with ${response.status}`);
  }
  return payload;
}
