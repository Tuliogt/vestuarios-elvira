// ============================================================
// Service worker mínimo.
//
// Android solo ofrece "Instalar app" si el sitio tiene manifiesto
// y un service worker registrado. Ese es su motivo de existir.
//
// A propósito NO cachea páginas ni datos: los pagos deben venir
// siempre frescos del servidor. Solo guarda los archivos estáticos
// pesados (las librerías) para que abra rápido.
// ============================================================

const CACHE = 'vestuarios-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((llaves) =>
      Promise.all(llaves.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Nada de la API ni de otros dominios se cachea
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Las páginas siempre a la red, para que los cambios se vean
  if (e.request.mode === 'navigate') return;

  // Solo las librerías y los iconos: cambian de nombre al
  // actualizarse, así que no hay riesgo de servir algo viejo.
  if (!/^\/(vendor|icon-)/.test(url.pathname)) return;

  e.respondWith(
    caches.match(e.request).then((guardado) =>
      guardado || fetch(e.request).then((r) => {
        const copia = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copia)).catch(() => {});
        return r;
      })
    )
  );
});
