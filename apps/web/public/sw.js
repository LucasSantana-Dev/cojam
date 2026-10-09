// CoJam service worker. Deliberately tiny: it exists so the app is installable
// and shows a friendly page when a navigation fails offline. It never caches
// app code or data. See docs/pwa.md.
//
//  - Navigation requests: network-first; on failure serve the precached /offline.
//  - Precached on install: /offline and the hashed /_next/static files it needs.
//    Only those precached files are answered from the cache (they are immutable,
//    content-hashed); every other /_next request goes to the network and the
//    browser's own HTTP cache.
//  - Everything else (API, websocket upgrade, Centrifuge, cross-origin YouTube
//    and Spotify, non-GET): untouched, the worker does not call respondWith.
//
// Bump CACHE_VERSION to force a fresh precache; old caches are deleted on activate.
const CACHE_VERSION = 'v1';
const CACHE = `cojam-offline-${CACHE_VERSION}`;
const OFFLINE_URL = '/offline';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const res = await fetch(OFFLINE_URL, { cache: 'reload' });
      if (!res.ok) throw new Error(`offline page ${res.status}`);
      const html = await res.clone().text();
      await cache.put(OFFLINE_URL, res);
      const assets = new Set(html.match(/\/_next\/static\/[^"'\s\\<>)]+/g) ?? []);
      await Promise.all([...assets].map((url) => cache.add(url).catch(() => undefined)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('cojam-') && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => (await caches.match(OFFLINE_URL)) ?? Response.error()),
    );
    return;
  }

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit ?? fetch(req)),
    );
  }
});
