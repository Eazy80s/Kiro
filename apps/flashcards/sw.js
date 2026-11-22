/* Simple offline cache for the Karteikarten PWA. Bump CACHE on each release. */
const CACHE = "flashcards-v1";

// Eigene Assets (same-origin) — werden beim Install vorab gecacht.
const ASSETS = [
  "index.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "icon.svg",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png",
];

self.addEventListener("install", (e) => {
  // Neue Version sofort übernehmen (automatische Updates, ohne Hinweis).
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;

  let url;
  try { url = new URL(e.request.url); } catch (_) { return; }

  // Nur eigene Assets behandeln; alles andere unangetastet ans Netz durchreichen.
  if (url.origin !== self.location.origin) return;

  // Cache-first, Netz als Fallback.
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).catch(() => hit))
  );
});
