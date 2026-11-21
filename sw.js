/* Simple offline cache for the Study Tracker PWA. Bump CACHE on each release. */
const CACHE = "study-tracker-v19";

// Eigene Assets (same-origin) — werden beim Install vorab gecacht.
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

// Fremd-Skripte (CDN), die für den Sync gebraucht werden. Können beim Install
// nicht garantiert vorab geladen werden (z. B. Offline-Erststart), werden aber
// beim ersten erfolgreichen Online-Laden in den Cache übernommen, damit der
// Sync-Client danach auch offline / bei CDN-Ausfall verfügbar ist.
const RUNTIME_CACHE_HOSTS = ["cdn.jsdelivr.net"];

self.addEventListener("install", (e) => {
  // Neue Version sofort übernehmen (automatische Updates, ohne Hinweis).
  // Fremd-Skripte zusätzlich best-effort mitladen (Fehler ignorieren, falls offline).
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS).then(() => {
        return c.add("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js")
          .catch(() => {}); // kein Netz / CDN weg → später zur Laufzeit cachen
      }))
      .then(() => self.skipWaiting())
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

  const isOwnAsset = url.origin === self.location.origin;
  const isRuntimeCdn = RUNTIME_CACHE_HOSTS.includes(url.hostname);

  // Nur eigene Assets und die bekannten CDN-Skripte behandeln; alles andere
  // (z. B. Supabase-API-Aufrufe) unangetastet ans Netz durchreichen.
  if (!isOwnAsset && !isRuntimeCdn) return;

  if (isRuntimeCdn) {
    // Stale-while-revalidate: sofort aus dem Cache liefern (falls vorhanden),
    // im Hintergrund aktualisieren. Offline → Cache; Cache leer → Netz.
    e.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(e.request).then((hit) => {
          const network = fetch(e.request)
            .then((res) => { if (res && res.ok) cache.put(e.request, res.clone()); return res; })
            .catch(() => hit);
          return hit || network;
        })
      )
    );
    return;
  }

  // Eigene Assets: cache-first, Netz als Fallback.
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).catch(() => hit))
  );
});
