export const PUSH_TTL_SECONDS = 48 * 60 * 60;
export const PUSH_MAX_AGE_MS = PUSH_TTL_SECONDS * 1000;
const ACTIONABLE_PUSH_TYPES = new Set([
  "ENTRY_SIGNAL_PENDING",
  "EXIT_SIGNAL_PENDING",
  "PORTFOLIO_EXIT_PENDING",
  "ROTATION_EXIT_PENDING",
  "PARTIAL_EXIT_PENDING",
  "PYRAMID_ADD_PENDING",
  "DIVIDEND_CREDIT"
]);

export function normalizePushSubscription(input = {}) {
  const endpoint = String(input?.endpoint || "").trim();
  const p256dh = String(input?.keys?.p256dh || "").trim();
  const auth = String(input?.keys?.auth || "").trim();
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Valid push endpoint is required");
  }
  if (url.protocol !== "https:") throw new Error("Push endpoint must use HTTPS");
  if (endpoint.length > 2048 || p256dh.length < 40 || auth.length < 8) {
    throw new Error("Push subscription keys are invalid");
  }
  const expiration = Number(input?.expirationTime);
  return {
    endpoint,
    keys: { p256dh, auth },
    expirationTime: Number.isFinite(expiration) && expiration > 0 ? Math.trunc(expiration) : null
  };
}

export function recentPushAlerts(alerts = [], now = Date.now()) {
  const cutoff = now - PUSH_MAX_AGE_MS;
  return (Array.isArray(alerts) ? alerts : [])
    .filter((alert) => {
      const occurred = Date.parse(String(alert?.occurredAt || ""));
      return Boolean(alert?.id) &&
        ACTIONABLE_PUSH_TYPES.has(String(alert?.type || "").toUpperCase()) &&
        Number.isFinite(occurred) &&
        occurred >= cutoff &&
        occurred <= now + 60_000;
    })
    .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
}

export function pushPayloadForAlert(alert = {}) {
  const symbol = clean(alert.symbol || "Portfolio").slice(0, 30);
  const action = clean(alert.title || alert.type || "Action required").slice(0, 70);
  const allocation = clean(alert.allocationSummary || "");
  const reason = clean(alert.summary || alert.reasons?.[0] || "Portfolio action recorded.");
  const body = [allocation, reason].filter(Boolean).join(" | ").slice(0, 220);
  const alertId = clean(alert.id).slice(0, 180);
  return {
    title: `${symbol} | ${action}`,
    body,
    icon: "./app-icon-192.png",
    badge: "./app-icon-192.png",
    tag: alertId,
    data: {
      alertId,
      url: `./?view=alerts&alert=${encodeURIComponent(alertId)}`
    }
  };
}

export function mayRetryDelivery(delivery = {}, now = Date.now()) {
  if (delivery?.status === "sent") return false;
  const attempts = Number(delivery?.attempts) || 0;
  if (attempts >= 5) return false;
  const updatedAt = Date.parse(String(delivery?.updated_at || delivery?.updatedAt || ""));
  return !Number.isFinite(updatedAt) || now - updatedAt >= 10 * 60 * 1000;
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
