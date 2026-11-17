// app.js - Interfaz, envio resiliente (Outbox) y sincronizacion al volver la red.
// Sin async/await: solo new Promise, .then(), .catch() y Promise.all().

const ENDPOINT = 'https://jsonplaceholder.typicode.com/posts';

const formulario = document.getElementById('form-incidencia');
const listaOutbox = document.getElementById('lista-outbox');
const btnPurgar = document.getElementById('btn-purgar');
const badgeRed = document.getElementById('badge-red');

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
      console.warn('[Outbox] Sin conexión. Encolando transacción localmente...');
      // Falla de red: guardar en IndexedDB como pendiente para reenvio posterior
      return guardarRegistro({
        ...datosFormulario,
        estado: 'pendiente',
        fechaCreacion: Date.now()
      });
    })
    .then(() => renderizarColaOutbox());
}

// ---------- UPDATE: barrido y reenvio de pendientes ----------
function sincronizarPendientes() {
  console.log('[Outbox] Conexión detectada. Buscando registros pendientes...');

  return obtenerTodosLosRegistros()
    .then((registros) => {
      const pendientes = registros.filter((item) => item.estado === 'pendiente');

      if (pendientes.length === 0) {
        console.log('[Outbox] No hay transacciones pendientes por sincronizar.');
        return;
      }

      // Convertir cada registro pendiente en una promesa de envio + actualizacion
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

      // Esperar a que todos los reenvios concluyan
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
  sincronizarPendientes();
});

window.addEventListener('offline', actualizarIndicadorRed);

// ---------- Registro del Service Worker (ruta relativa) ----------
if ('serviceWorker' in navigator) {
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
renderizarColaOutbox()
  .then(() => {
    // Si la pagina abre con red y quedaron pendientes, reenviarlos
    if (navigator.onLine) {
      return sincronizarPendientes();
    }
  })
  .catch((error) => console.error('[Outbox] Error al iniciar:', error));
