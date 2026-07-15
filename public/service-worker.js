const CACHE = "techno-funda-shell-v9";
const SHELL = [
  "./",
  "./styles.css",
  "./auth.js",
  "./auth-request.js",
  "./app.js",
  "./decision-guide.js",
  "./mobile-config.js",
  "./manifest.webmanifest",
  "./app-icon.svg",
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
