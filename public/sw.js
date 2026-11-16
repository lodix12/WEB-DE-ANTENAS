/* RadioMapa España — App-Shell Service Worker */
const CACHE_NAME = 'radiomapa-shell-v1';

const PRECACHE_RELATIVE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.svg',
  './icons/pwa-192x192.png',
  './icons/pwa-512x512.png',
  './icons/pwa-maskable-192x192.png',
  './icons/pwa-maskable-512x512.png',
  './icons/apple-touch-icon.png',
];

function resolveScopeUrl(relativePath) {
  return new URL(relativePath, self.registration.scope).toString();
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const urls = PRECACHE_RELATIVE_URLS.map(resolveScopeUrl);
      await Promise.allSettled(
        urls.map(async (url) => {
          const response = await fetch(url, { cache: 'no-cache' });
          if (response && response.ok) {
            await cache.put(url, response);
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name.startsWith('radiomapa-shell-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never intercept cross-origin requests (OpenFreeMap tiles, Google Fonts, GitHub API/raw)
  if (url.origin !== self.location.origin) return;

  // Never cache live daily census data (/data/antenas.json, /data/novedades.json, etc.)
  if (url.pathname.includes('/data/')) return;

  // Navigation requests: Network-First with offline app-shell fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const indexUrl = resolveScopeUrl('./index.html');
        const rootUrl = resolveScopeUrl('./');
        try {
          const networkResponse = await fetch(request);
          if (networkResponse && networkResponse.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(indexUrl, networkResponse.clone());
          }
          return networkResponse;
        } catch {
          const cache = await caches.open(CACHE_NAME);
          return (
            (await cache.match(indexUrl)) ||
            (await cache.match(rootUrl)) ||
            (await cache.match(request)) ||
            new Response(
              'Sin conexión a Internet. Vuelve a intentar cuando recuperes cobertura.',
              {
                status: 503,
                statusText: 'Service Unavailable',
                headers: { 'Content-Type': 'text/plain; charset=utf-8' },
              }
            )
          );
        }
      })()
    );
    return;
  }

  // Same-origin static shell assets: Stale-While-Revalidate
  const isStaticShellAsset =
    url.pathname.includes('/assets/') ||
    url.pathname.includes('/icons/') ||
    url.pathname.endsWith('/manifest.webmanifest') ||
    url.pathname.endsWith('/favicon.svg');

  if (isStaticShellAsset) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cachedResponse =
          (await cache.match(request)) || (await cache.match(url.toString()));

        const networkUpdate = fetch(request)
          .then(async (networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              await cache.put(request, networkResponse.clone());
            }
            return networkResponse;
          })
          .catch(() => undefined);

        if (cachedResponse) {
          event.waitUntil(networkUpdate);
          return cachedResponse;
        }

        const freshResponse = await networkUpdate;
        if (freshResponse) {
          return freshResponse;
        }

        return new Response('', { status: 504, statusText: 'Gateway Timeout' });
      })()
    );
  }
});
