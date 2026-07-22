const CACHE = "techno-funda-shell-v35-scan-freshness";
const SHELL = [
  "./",
  "./styles.css",
  "./auth.js",
  "./auth-request.js",
  "./app.js",
  "./detail-evidence.js",
  "./decision-guide.js",
  "./pnl-accounting.js",
  "./mobile-config.js",
  "./manifest.webmanifest",
  "./techno-funda-pms-bull-192-v2.png",
  "./techno-funda-pms-bull-512-v2.png",
  "./techno-funda-pms-bull-maskable-512-v2.png",
  "./vendor/supabase.js",
  "./vendor/exceljs.min.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.includes("/data/")) return;
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request)));
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {
    payload = { body: event.data?.text() || "New portfolio action is available." };
  }
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  const options = {
    body: payload.body || "New portfolio action is available.",
    icon: payload.icon || "./techno-funda-pms-bull-192-v2.png",
    badge: payload.badge || "./techno-funda-pms-bull-192-v2.png",
    tag: payload.tag || data.alertId || `tf-push-${Date.now()}`,
    data: { ...data, url: data.url || "./?view=alerts" },
    requireInteraction: true,
    renotify: false
  };
  event.waitUntil(Promise.all([
    self.registration.showNotification(payload.title || "Techno Funda PMS", options),
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => Promise.all(
      clients.map((client) => client.postMessage({ type: "TF_PUSH_DELIVERED", alertId: data.alertId || "" }))
    ))
  ]));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./?view=alerts", self.location.href).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.navigate(target);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  }));
});
