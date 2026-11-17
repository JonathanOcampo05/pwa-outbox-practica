// sw.js - Service Worker: App Shell + Background Sync (sin async/await)

// Mini-wrapper de IndexedDB en el contexto del Service Worker (ruta relativa)
importScripts('./db-helper.js');

const CACHE_STATIC_NAME = 'static-outbox-v3';
const STATIC_FILES = [
  './',
  './index.html',
  './styles.css',
  './db-helper.js',
  './app.js',
  './manifest.json',
  './icon.svg'
];

const ENDPOINT_SW = 'https://jsonplaceholder.typicode.com/posts';

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

// ---------- postMessage hacia las pestanas abiertas ----------
function notificarClientesActualizacion() {
  return self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((clientes) => {
      clientes.forEach((cliente) => {
        cliente.postMessage({
          tipo: 'OUTBOX_SINCRONIZADO',
          timestamp: Date.now()
        });
      });
    });
}

// ---------- Motor de sincronizacion en segundo plano ----------
function sincronizarPendientesSW() {
  console.log('[SW-Sync] Ejecutando barrido de transacciones pendientes...');

  return obtenerTodosLosRegistros().then((registros) => {
    const pendientes = registros.filter((item) => item.estado === 'pendiente');

    if (pendientes.length === 0) {
      console.log('[SW-Sync] Cola limpia. Nada por sincronizar.');
      return;
    }

    const promesasDeEnvio = pendientes.map((item) => {
      return fetch(ENDPOINT_SW, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: item.titulo,
          body: item.descripcion
        })
      }).then((respuesta) => {
        if (!respuesta.ok) {
          throw new Error('Error HTTP ' + respuesta.status + ' al sincronizar ID ' + item.id);
        }
        return actualizarEstadoRegistro(item.id, 'sincronizado');
      });
    });

    return Promise.all(promesasDeEnvio).then(() => notificarClientesActualizacion());
  });
}

// ---------- Evento sync ----------
self.addEventListener('sync', (event) => {
  console.log('[SW-Sync] Evento sync disparado con etiqueta:', event.tag);

  if (event.tag === 'sync-reportes') {
    event.waitUntil(
      sincronizarPendientesSW().catch((error) => {
        console.error('[SW-Sync] Falla en sincronización; el navegador reintentará luego:', error);
        // Relanzar el error indica al navegador que debe programar un reintento
        throw error;
      })
    );
  }
});
