/* Service Worker — Ruta San Simón
   1) Caché del app shell: network-first para el HTML (para no quedarte con
      datos viejos), cache-first para el resto (íconos, manifest, tiles ya
      vistos).
   2) Notificaciones push REALES: recibe el push y lo muestra como
      notificación del sistema, aunque la pestaña/app esté cerrada y el
      celular bloqueado o en reposo. */

const CACHE_NAME = 'ruta-san-simon-v9';
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

/* ============================================================
   NOTIFICACIONES PUSH REALES
   Llegan como notificación del sistema operativo aunque la
   pestaña/app esté cerrada o el celular esté bloqueado/suspendido.
   (Requiere el resto de la infraestructura de push-notifications.js,
   push_subscriptions.sql y la Edge Function send-alert-push.)
   ============================================================ */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Ruta San Simón', body: event.data ? event.data.text() : 'Tienes una nueva alerta' };
  }

  const title = data.title || '🚨 Alerta · Ruta San Simón';
  const options = {
    body: data.body || 'Toca para ver los detalles en el panel.',
    icon: data.icon || 'icon-192.png',
    badge: data.badge || 'icon-192.png',
    tag: data.tag || 'rss-alert',
    renotify: true, // si llega otra alerta con el mismo tag, vuelve a vibrar/sonar
    requireInteraction: true, // NO se cierra sola: se queda hasta que la toquen
    vibrate: data.vibrate || [300, 100, 300, 100, 300, 100, 600],
    silent: false,
    data: { url: data.url || 'dueno.html', ...(data.data || {}) },
    actions: data.actions || [],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || 'dueno.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      for (const client of clientsArr) {
        if (client.url.includes(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const newSub = await self.registration.pushManager.subscribe(
          event.oldSubscription ? event.oldSubscription.options : { userVisibleOnly: true }
        );
        const clientsArr = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        clientsArr.forEach((c) => c.postMessage({ type: 'rss-push-resubscribed', subscription: newSub.toJSON() }));
      } catch (err) {
        console.error('[sw] No se pudo renovar la suscripción push:', err);
      }
    })()
  );
});
