/*
 * Minimal Service Worker (PR3) — just enough to make the PWA installable and to
 * keep the app shell available offline. Intentionally NO Web Push handler: push
 * notifications land in PR4 (see prd "实施计划"). Web Push, when added, will
 * register `push` / `notificationclick` listeners here.
 *
 * Strategy:
 *   - Precache the app shell (the bundled HTML/JS/CSS are content-hashed by Vite,
 *     so we cache them at runtime rather than hard-coding hashed names here).
 *   - Navigations: network-first, falling back to the cached shell when offline
 *     so a backgrounded/airplane-mode launch still opens the terminal UI.
 *   - Other GETs (the hashed JS/CSS chunks): cache-first, since their URLs change
 *     on every build and can never go stale.
 *   - The WebSocket to the bridge is NOT cached/intercepted — `ws:`/`wss:` never
 *     hit `fetch`, and the live terminal must always go to the network.
 */

const CACHE = "mobile-ssh-shell-v1";
const SHELL = ["/", "/index.html", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  // Cache the shell, then take over immediately on the next load.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  // Drop stale caches from older shell versions, then claim open clients.
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle same-origin GETs; let everything else (the bridge WebSocket,
  // cross-origin requests, POSTs) go straight to the network.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  if (req.mode === "navigate") {
    // Network-first for navigations: fresh when online, cached shell when not.
    event.respondWith(
      fetch(req).catch(() => caches.match("/index.html").then((r) => r || caches.match("/"))),
    );
    return;
  }

  // Cache-first for hashed static assets.
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req).then((res) => {
          // Cache successful, basic (same-origin) responses for next time.
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
