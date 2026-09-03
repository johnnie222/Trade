/**
 * Service worker.
 *
 * Cache-first for the shell. This app has no server and no remote data in
 * Phase 1, so once it is installed there is nothing that needs the network and
 * it should never wait on one.
 *
 * The version string is the cache key: bump it to ship an update. Old caches
 * are deleted on activate, so a stale shell cannot survive a release.
 */

const VERSION = 'tj-v5';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './src/ui/styles.css',
  './src/ui/app.js',
  './src/ui/registry.js',
  './src/ui/format.js',
  './src/ui/screens/home.js',
  './src/ui/screens/newTrade.js',
  './src/ui/screens/trades.js',
  './src/ui/screens/tradeDetail.js',
  './src/ui/screens/log.js',
  './src/ui/screens/stats.js',
  './src/ui/screens/settings.js',
  './src/core/money.js',
  './src/core/events.js',
  './src/core/engine.js',
  './src/core/stopRules.js',
  './src/core/metrics.js',
  './src/core/stats.js',
  './src/data/store.js',
  './src/data/repo.js',
  './src/data/backup.js',
  './src/data/browserBackup.js',
  './src/data/marketData.js',
  './src/export/csv.js',
  './src/export/markdown.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ??
        fetch(e.request)
          .then((res) => {
            // Cache same-origin successes so a file missed at install still lands.
            if (res.ok && new URL(e.request.url).origin === location.origin) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(e.request, copy));
            }
            return res;
          })
          .catch(() => caches.match('./index.html'))
    )
  );
});
