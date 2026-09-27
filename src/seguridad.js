// ============================================================
// Utilidades de seguridad del servidor
// ============================================================


// ------------------------------------------------------------
// Límite de peticiones por IP (ventana deslizante en memoria)
//
// Nota: vive en memoria, así que se reinicia con el contenedor y
// no se comparte entre réplicas. Para este caso (una instancia,
// decenas de personas) es suficiente. Si algún día hay varias
// réplicas, esto hay que moverlo a Redis.
// ------------------------------------------------------------
export function crearLimitador({ maximo, ventanaMs }) {
  const registros = new Map();

  // Limpieza periódica para que el Map no crezca sin control
  const limpieza = setInterval(() => {
    const ahora = Date.now();
    for (const [ip, marcas] of registros) {
      const vigentes = marcas.filter((t) => ahora - t < ventanaMs);
      if (vigentes.length === 0) registros.delete(ip);
      else registros.set(ip, vigentes);
    }
  }, ventanaMs);
  limpieza.unref();

  return function permitir(ip) {
    const ahora = Date.now();
    const marcas = (registros.get(ip) || []).filter((t) => ahora - t < ventanaMs);

    if (marcas.length >= maximo) {
      const esperaMs = ventanaMs - (ahora - marcas[0]);
      return { ok: false, esperaSegundos: Math.ceil(esperaMs / 1000) };
    }

    marcas.push(ahora);
    registros.set(ip, marcas);
    return { ok: true, restantes: maximo - marcas.length };
  };
}

// ------------------------------------------------------------
// IP del cliente
//
// Detrás del proxy de Coolify (Traefik), la IP real viene en
// X-Forwarded-For. Se toma la PRIMERA de la lista, que es la que
// el proxy añadió; las siguientes las puede falsificar el cliente.
// ------------------------------------------------------------
export function ipCliente(req, confiarEnProxy) {
  if (confiarEnProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'desconocida';
}

// ------------------------------------------------------------
// Validar que lo recibido sea realmente una imagen
//
// No basta con confiar en el content-type que manda el cliente:
// se revisan los primeros bytes del archivo (magic bytes).
// ------------------------------------------------------------
export function detectarTipoImagen(buffer) {
  if (buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) return 'image/png';

  // WEBP: "RIFF" .... "WEBP"
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) return 'image/webp';

  return null;
}

// ------------------------------------------------------------
// Saneado de texto que escribe el público
// ------------------------------------------------------------
export function textoLimpio(valor, maximo = 200) {
  if (valor == null) return null;
  const s = String(valor)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')  // caracteres de control
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximo);
  return s.length ? s : null;
}

export function numeroLimpio(valor, { min = 0, max = 100000000 } = {}) {
  if (valor === '' || valor == null) return null;
  const n = Number(valor);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n * 100) / 100;
}

export function fechaLimpia(valor) {
  if (!valor) return null;
  const s = String(valor).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  const anio = d.getUTCFullYear();
  if (anio < 2020 || anio > 2100) return null;
  return s;
}

// Solo dígitos, para la referencia
export function referenciaLimpia(valor) {
  if (!valor) return null;
  const s = String(valor).replace(/[^\dA-Za-z-]/g, '').slice(0, 60);
  return s.length >= 6 ? s : null;
}
