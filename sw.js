/* Service Worker — Ruta San Simón
   Estrategia: network-first para el HTML (para no quedarte con datos viejos),
   cache-first para el resto (íconos, manifest, tiles ya vistos). */

const CACHE_NAME = 'ruta-san-simon-v8';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './manifest-conductor.json',
  './manifest-dueno.json',
  './icon-192.png',
  './icon-512.png',
  './firebase-config.js',
  './conductor.html',
  './dueno.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const isAppShell = request.url.startsWith(self.location.origin);

  if (isAppShell && request.mode === 'navigate') {
    // network-first para el documento principal
    event.respondWith(
      fetch(request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return res;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // cache-first para todo lo demás (tiles del mapa, fuentes, íconos, etc.)
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return networkRes;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
