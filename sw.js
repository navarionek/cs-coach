// Network-first: the app is always fresh online, the cache is only an offline fallback.
// Bump the version when the ASSETS list changes.
const CACHE_NAME = 'granko-v9';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './js/main.js',
  './js/core.js',
  './js/gate.js',
  './js/stats.js',
  './js/live.js',
  './js/tactics.js',
  './js/lineups.js',
  './js/radar.js',
  './js/preview.js',
  './js/voice.js',
  './js/mapdata.js',
  './manifest.json',
  './icon-192x192.png',
  './icon-512x512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  // Supabase, CDN and fonts go straight to the network.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  const cacheKey = req.mode === 'navigate' ? './' : req;
  // no-cache: always revalidate, bypassing GitHub Pages' max-age=600.
  const netReq = req.mode === 'navigate'
    ? new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' })
    : new Request(req, { cache: 'no-cache' });

  event.respondWith(
    fetch(netReq)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, copy));
        }
        return res;
      })
      .catch(() => caches.match(cacheKey))
  );
});
