/* Simple offline cache for the Study Tracker PWA. Bump CACHE on each release. */
const CACHE = "study-tracker-v13";
const ASSETS = [
  "index.html",
  "styles.css",
  "app.js",
  "supabase-config.js",
  "manifest.webmanifest",
  "icon.svg",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png",
];

self.addEventListener("install", (e) => {
  // NICHT mehr sofort skipWaiting: Die App zeigt stattdessen einen Update-Hinweis.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Die App kann den wartenden SW auffordern, sofort zu übernehmen (Update-Button),
// und nach seiner Version fragen (um einen weggeklickten Hinweis zu merken).
self.addEventListener("message", (e) => {
  if (e.data === "SKIP_WAITING") self.skipWaiting();
  if (e.data === "GET_VERSION" && e.ports && e.ports[0]) {
    e.ports[0].postMessage(CACHE);
  }
});

// Cache-first for our own assets; fall back to network otherwise.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).catch(() => hit))
  );
});
