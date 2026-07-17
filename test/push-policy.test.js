import assert from "node:assert/strict";
import test from "node:test";
import {
  mayRetryDelivery,
  normalizePushSubscription,
  PUSH_TTL_SECONDS,
  pushPayloadForAlert,
  recentPushAlerts
} from "../supabase/functions/techno-funda-app-api/push-policy.js";

const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/example-token",
  keys: {
    p256dh: "B".repeat(87),
    auth: "a".repeat(22)
  }
};

test("push subscriptions require HTTPS and valid browser keys", () => {
  assert.equal(normalizePushSubscription(subscription).endpoint, subscription.endpoint);
  assert.throws(() => normalizePushSubscription({ ...subscription, endpoint: "http://example.com/push" }), /HTTPS/);
  assert.throws(() => normalizePushSubscription({ ...subscription, keys: { p256dh: "short", auth: "short" } }), /invalid/);
});

test("background push includes only recent actionable decisions and dividend", () => {
  const now = Date.parse("2026-07-17T03:00:00.000Z");
  const alerts = [
    { id: "entry", type: "ENTRY_SIGNAL_PENDING", occurredAt: "2026-07-17T03:00:00.000Z" },
    { id: "dividend", type: "DIVIDEND_CREDIT", occurredAt: "2026-07-16T03:00:00.000Z" },
    { id: "skipped", type: "ENTRY_SKIPPED", occurredAt: "2026-07-17T03:00:00.000Z" },
    { id: "fill", type: "ENTRY_TRADE_OPENED", occurredAt: "2026-07-17T03:00:00.000Z" },
    { id: "old", type: "EXIT_SIGNAL_PENDING", occurredAt: "2026-07-14T03:00:00.000Z" }
  ];
  assert.deepEqual(recentPushAlerts(alerts, now).map((alert) => alert.id), ["dividend", "entry"]);
  assert.equal(PUSH_TTL_SECONDS, 172800);
});

test("push payload deep-links to the exact actionable alert", () => {
  const payload = pushPayloadForAlert({
    id: "entry-ABC-1",
    type: "ENTRY_SIGNAL_PENDING",
    symbol: "ABC",
    title: "Entry signal ready",
    allocationSummary: "APPROX BUY: Qty 100",
    summary: "Weekly and daily leadership confirmed."
  });
  assert.equal(payload.title, "ABC | Entry signal ready");
  assert.match(payload.body, /Qty 100.*leadership/i);
  assert.match(payload.data.url, /view=alerts&alert=entry-ABC-1/);
});

test("failed delivery retries are bounded and sent alerts never duplicate", () => {
  const now = Date.parse("2026-07-17T04:00:00.000Z");
  assert.equal(mayRetryDelivery({ status: "sent", attempts: 1 }, now), false);
  assert.equal(mayRetryDelivery({ status: "failed", attempts: 2, updated_at: "2026-07-17T03:40:00.000Z" }, now), true);
  assert.equal(mayRetryDelivery({ status: "failed", attempts: 5, updated_at: "2026-07-17T03:00:00.000Z" }, now), false);
});
