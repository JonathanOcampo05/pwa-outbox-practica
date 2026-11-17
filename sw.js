// sw.js - Service Worker: App Shell con rutas relativas (sin async/await)

const CACHE_STATIC_NAME = 'static-outbox-v1';
const STATIC_FILES = [
  './',
  './index.html',
  './styles.css',
  './db-helper.js',
  './app.js',
  './manifest.json',
  './icon.svg'
];

// ---------- install: precache del App Shell ----------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_STATIC_NAME)
      .then((cache) => cache.addAll(STATIC_FILES))
      .then(() => self.skipWaiting())
  );
});

// ---------- activate: limpiar caches antiguos ----------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((nombres) =>
        Promise.all(
          nombres
            .filter((nombre) => nombre !== CACHE_STATIC_NAME)
            .map((nombre) => caches.delete(nombre))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ---------- fetch: cache-first solo para GET del mismo origen ----------
self.addEventListener('fetch', (event) => {
  const peticion = event.request;
  const url = new URL(peticion.url);

  if (peticion.method !== 'GET' || url.origin !== self.location.origin) {
    return; // POST a la API y otros origenes pasan directo a la red
  }

  event.respondWith(
    caches.match(peticion).then((enCache) => {
      if (enCache) return enCache;

      return fetch(peticion).then((respuesta) => {
        if (respuesta && respuesta.ok) {
          const copia = respuesta.clone();
          caches.open(CACHE_STATIC_NAME).then((cache) => cache.put(peticion, copia));
        }
        return respuesta;
      });
    }).catch(() => caches.match('./index.html'))
  );
});
