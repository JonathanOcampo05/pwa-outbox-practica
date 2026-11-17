// app.js - Interfaz, envio resiliente (Outbox) y respaldo de sincronizacion.
// Sin async/await: solo new Promise, .then(), .catch() y Promise.all().

const ENDPOINT = 'https://jsonplaceholder.typicode.com/posts';

const formulario = document.getElementById('form-incidencia');
const listaOutbox = document.getElementById('lista-outbox');
const btnPurgar = document.getElementById('btn-purgar');
const badgeRed = document.getElementById('badge-red');

// ---------- Deteccion real de Background Sync ----------
// Algunos navegadores (ej. Brave) exponen SyncManager pero niegan el permiso,
// y sync.register() falla con NotAllowedError. Por eso no basta con
// 'SyncManager' in window: tambien se consulta el permiso 'background-sync'.
let backgroundSyncDisponible = 'serviceWorker' in navigator && 'SyncManager' in window;

function verificarBackgroundSync() {
  if (!backgroundSyncDisponible || !navigator.permissions) {
    return Promise.resolve(backgroundSyncDisponible);
  }
  return navigator.permissions
    .query({ name: 'background-sync' })
    .then((estado) => {
      backgroundSyncDisponible = estado.state === 'granted';
      return backgroundSyncDisponible;
    })
    .catch(() => backgroundSyncDisponible); // permiso no consultable: confiar en SyncManager
}

// ---------- Indicador de red ----------
function actualizarIndicadorRed() {
  if (navigator.onLine) {
    badgeRed.textContent = 'En Línea';
    badgeRed.className = 'badge online';
  } else {
    badgeRed.textContent = 'Sin Conexión';
    badgeRed.className = 'badge offline';
  }
}

// ---------- READ: dibujar la bandeja desde IndexedDB ----------
function renderizarColaOutbox() {
  return obtenerTodosLosRegistros().then((registros) => {
    listaOutbox.textContent = '';

    if (registros.length === 0) {
      const vacio = document.createElement('li');
      vacio.className = 'vacio';
      vacio.textContent = 'La bandeja está vacía.';
      listaOutbox.appendChild(vacio);
      return;
    }

    registros
      .sort((a, b) => b.fechaCreacion - a.fechaCreacion)
      .forEach((item) => {
        const li = document.createElement('li');

        const titulo = document.createElement('span');
        titulo.className = 'item-titulo';
        titulo.textContent = item.titulo;

        const meta = document.createElement('span');
        meta.className = 'item-meta';

        const estado = document.createElement('span');
        estado.className = 'estado ' + item.estado;
        estado.textContent = item.estado;

        const hora = new Date(item.fechaCreacion).toLocaleString('es-MX');
        meta.appendChild(estado);
        meta.appendChild(document.createTextNode(' · ' + hora));

        li.appendChild(titulo);
        li.appendChild(meta);
        listaOutbox.appendChild(li);
      });
  });
}

// ---------- CREATE: envio resiliente con fallback a IndexedDB ----------
function procesarEnvioReporte(datosFormulario) {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: datosFormulario.titulo,
      body: datosFormulario.descripcion
    })
  })
    .then((respuesta) => {
      if (!respuesta.ok) throw new Error('Error HTTP del servidor');
      return respuesta.json();
    })
    .then(() => {
      // Envio exitoso en vivo: bitacora local como sincronizado
      return guardarRegistro({
        ...datosFormulario,
        estado: 'sincronizado',
        fechaCreacion: Date.now()
      });
    })
    .catch(() => {
      console.warn('[Outbox] Sin conexión. Encolando en IndexedDB...');

      return guardarRegistro({
        ...datosFormulario,
        estado: 'pendiente',
        fechaCreacion: Date.now()
      }).then(() => {
        // Tema 5.3: delegar el reenvio al Service Worker si hay Background Sync
        if (backgroundSyncDisponible) {
          return navigator.serviceWorker.ready
            .then((registro) => {
              console.log('[Outbox] Registrando etiqueta sync-reportes en el SW...');
              return registro.sync.register('sync-reportes');
            })
            .catch((error) => {
              // Degradacion elegante: si el navegador rechaza el registro,
              // el reporte ya esta en IndexedDB y lo enviara el fallback 'online'.
              console.warn('[Outbox] Background Sync no disponible, se usará el fallback:', error.name);
              backgroundSyncDisponible = false;
            });
        }
      });
    })
    .then(() => renderizarColaOutbox());
}

// ---------- UPDATE (respaldo): barrido de pendientes desde la UI ----------
// Solo se usa en navegadores sin SyncManager (Safari/iOS, Firefox).
function sincronizarPendientesFallback() {
  console.log('[Outbox] Buscando registros pendientes (fallback)...');

  return obtenerTodosLosRegistros()
    .then((registros) => {
      const pendientes = registros.filter((item) => item.estado === 'pendiente');

      if (pendientes.length === 0) {
        console.log('[Outbox] No hay transacciones pendientes por sincronizar.');
        return;
      }

      const promesasDeEnvio = pendientes.map((item) => {
        return fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: item.titulo, body: item.descripcion })
        }).then((res) => {
          if (!res.ok) throw new Error('Falla al reintentar envío');
          return actualizarEstadoRegistro(item.id, 'sincronizado');
        });
      });

      return Promise.all(promesasDeEnvio);
    })
    .then(() => renderizarColaOutbox())
    .catch((error) => {
      console.error('[Outbox] Error durante la sincronización masiva:', error);
    });
}

// ---------- Eventos de red ----------
window.addEventListener('online', () => {
  actualizarIndicadorRed();

  // Degradacion elegante: solo sincronizar desde la UI si NO hay Background Sync
  // utilizable (Safari/iOS, Firefox, Brave). Con Background Sync el SW se encarga;
  // hacerlo tambien aqui duplicaria los POST.
  if (!backgroundSyncDisponible) {
    console.log('[Outbox] Sin Background Sync utilizable. Fallback por evento online...');
    sincronizarPendientesFallback();
  }
});

window.addEventListener('offline', actualizarIndicadorRed);

// ---------- Mensajes del Service Worker (postMessage) ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.tipo === 'OUTBOX_SINCRONIZADO') {
      console.log('[UI] Confirmación recibida del Service Worker. Actualizando bandeja...');
      renderizarColaOutbox();
    }
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => console.log('[SW] Registrado con scope:', reg.scope))
      .catch((err) => console.error('[SW] Falló el registro:', err));
  });
}

// ---------- Formulario (CREATE) ----------
formulario.addEventListener('submit', (e) => {
  e.preventDefault();

  const titulo = document.getElementById('titulo').value.trim();
  const descripcion = document.getElementById('descripcion').value.trim();
  if (!titulo || !descripcion) return;

  procesarEnvioReporte({ titulo, descripcion })
    .then(() => formulario.reset())
    .catch((error) => console.error('[Outbox] No se pudo procesar el reporte:', error));
});

// ---------- DELETE: purgar sincronizados ----------
btnPurgar.addEventListener('click', () => {
  obtenerTodosLosRegistros()
    .then((registros) => {
      const enviados = registros.filter((item) => item.estado === 'sincronizado');
      return Promise.all(enviados.map((item) => eliminarRegistro(item.id)));
    })
    .then(() => renderizarColaOutbox())
    .catch((error) => console.error('[Outbox] Error al purgar:', error));
});

// ---------- Arranque ----------
actualizarIndicadorRed();
Promise.all([renderizarColaOutbox(), verificarBackgroundSync()])
  .then(() => {
    console.log('[Outbox] Background Sync disponible:', backgroundSyncDisponible);
    // Si la pagina abre con red y hay pendientes, y no hay Background Sync, reenviar
    if (navigator.onLine && !backgroundSyncDisponible) {
      return sincronizarPendientesFallback();
    }
  })
  .catch((error) => console.error('[Outbox] Error al iniciar:', error));
