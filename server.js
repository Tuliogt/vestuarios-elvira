// ============================================================
// Servidor de "Vestuarios Elvira"
//
//   GET  /               formulario público
//   GET  /admin          panel de doña Elvira
//   GET  /config.js      configuración (artistas, login del panel)
//   POST /api/registrar  OCR del comprobante + guardado
//   GET  /health         chequeo de salud
//
// Dos principios de diseño:
//
//   1. Las imágenes NO se almacenan. Llegan, van a Google Vision,
//      y se descartan. Nunca tocan disco ni ningún bucket.
//
//   2. El OCR manda. La persona solo escribe su nombre y elige
//      el vestuario; monto, fecha y referencia salen de la
//      imagen. Si no se pueden leer, no se guarda nada.
// ============================================================

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parsearComprobante } from './src/parser.js';
import {
  crearLimitador, ipCliente, detectarTipoImagen,
  textoLimpio, numeroLimpio, fechaLimpia, referenciaLimpia,
} from './src/seguridad.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARPETA_PUBLICA = path.join(__dirname, 'public');

const PUERTO = Number(process.env.PORT) || 3000;
const MODELO_RESPALDO = 'claude-haiku-4-5-20251001';
const LIMITE_CUERPO = 6 * 1024 * 1024;
const LIMITE_IMAGEN = 4 * 1024 * 1024;
const CONFIAR_PROXY = process.env.CONFIAR_EN_PROXY !== 'false';

// Solo se aceptan comprobantes dirigidos a esta línea SINPE.
// Es lo que evita que alguien suba el pago de otra cosa.
const SINPE_TELEFONO = (process.env.SINPE_TELEFONO || '').replace(/\D/g, '');
const SINPE_TITULAR = (process.env.SINPE_TITULAR || '').trim();

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const limiteRegistro = crearLimitador({ maximo: 12, ventanaMs: 10 * 60 * 1000 });

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  `connect-src 'self' ${SUPABASE_URL}`.trim(),
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function cabeceras(extra = {}) {
  return {
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'geolocation=(), microphone=(), payment=()',
    ...extra,
  };
}

// ------------------------------------------------------------
const servidor = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const ruta = url.pathname;

    if (ruta === '/health') return json(res, { ok: true });

    if (ruta === '/api/registrar') {
      if (req.method !== 'POST') return json(res, { error: 'Método no permitido.' }, 405);
      return await manejarRegistro(req, res);
    }

    if (ruta === '/config.js') return servirConfig(res);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, { error: 'Método no permitido.' }, 405);
    }

    let archivo = ruta;
    if (archivo === '/') archivo = '/index.html';
    else if (archivo === '/admin' || archivo === '/admin/') archivo = '/admin.html';

    return await servirEstatico(archivo, res);
  } catch (e) {
    console.error('Error no controlado:', e);
    if (!res.headersSent) json(res, { error: 'Error interno.' }, 500);
    else res.end();
  }
});

// Red de seguridad: un fallo aislado no debe tumbar el servicio
// y dejar a todo el mundo sin poder registrar su pago.
process.on('unhandledRejection', (r) => console.error('Promesa sin manejar:', r));
process.on('uncaughtException', (e) => console.error('Excepción no capturada:', e));

servidor.listen(PUERTO, '0.0.0.0', () => {
  console.log(`Vestuarios Elvira escuchando en el puerto ${PUERTO}`);
  const faltan = [];
  if (!process.env.GOOGLE_VISION_API_KEY) faltan.push('GOOGLE_VISION_API_KEY');
  if (!SUPABASE_URL) faltan.push('SUPABASE_URL');
  if (!SERVICE_KEY) faltan.push('SUPABASE_SERVICE_ROLE_KEY');
  if (faltan.length) console.warn('AVISO: faltan variables:', faltan.join(', '));
});

// ------------------------------------------------------------
// Archivos estáticos
// ------------------------------------------------------------
async function servirEstatico(archivo, res) {
  const destino = path.join(CARPETA_PUBLICA, path.normalize(archivo));

  // La comparación incluye el separador: sin él, una carpeta
  // hermana llamada "public-privado" pasaría el filtro.
  if (destino !== CARPETA_PUBLICA && !destino.startsWith(CARPETA_PUBLICA + path.sep)) {
    res.writeHead(403, cabeceras()).end('Prohibido');
    return;
  }

  try {
    const contenido = await fs.readFile(destino);
    const tipo = TIPOS[path.extname(destino)] || 'application/octet-stream';
    res.writeHead(200, cabeceras({ 'content-type': tipo, 'cache-control': 'no-cache' }));
    res.end(contenido);
  } catch {
    res.writeHead(404, cabeceras({ 'content-type': 'text/html; charset=utf-8' }));
    res.end('<p>Página no encontrada.</p>');
  }
}

// ------------------------------------------------------------
// config.js generado desde las variables de entorno
// ------------------------------------------------------------
function servirConfig(res) {
  const cuerpo = `window.SUPABASE_URL = ${JSON.stringify(SUPABASE_URL)};
window.SUPABASE_ANON_KEY = ${JSON.stringify(process.env.SUPABASE_ANON_KEY || '')};
window.ARTISTAS = ${JSON.stringify(listaArtistas())};
`;
  res.writeHead(200, cabeceras({
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'no-cache',
  }));
  res.end(cuerpo);
}

function listaArtistas() {
  return (process.env.ARTISTAS || 'Daddy Yankee,Shakira,Marc Anthony,Selena,Karol G,Celia Cruz')
    .split(',').map((a) => a.trim()).filter(Boolean);
}

// ------------------------------------------------------------
// POST /api/registrar — OCR y guardado en un solo paso
// ------------------------------------------------------------
async function manejarRegistro(req, res) {
  const ip = ipCliente(req, CONFIAR_PROXY);

  const permiso = limiteRegistro(ip);
  if (!permiso.ok) {
    return json(res, {
      error: `Demasiados intentos. Espera ${Math.ceil(permiso.esperaSegundos / 60)} minutos.`,
    }, 429);
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json(res, { error: 'El servidor no tiene configurada la base de datos.' }, 500);
  }
  if (!process.env.GOOGLE_VISION_API_KEY) {
    return json(res, { error: 'El servidor no tiene configurado el lector de comprobantes.' }, 500);
  }

  let cuerpo;
  try {
    cuerpo = await leerJson(req);
  } catch (e) {
    return json(res, { error: String(e.message || e) }, 413);
  }

  const nombre = textoLimpio(cuerpo.nombre, 120);
  const artista = textoLimpio(cuerpo.artista, 80);

  if (!nombre) return json(res, { error: 'Escribe tu nombre.' }, 400);
  if (!artista || !listaArtistas().includes(artista)) {
    return json(res, { error: 'Selecciona un vestuario de la lista.' }, 400);
  }

  let imagen;
  try {
    imagen = Buffer.from(String(cuerpo.imagenBase64 || ''), 'base64');
  } catch {
    return json(res, { error: 'La imagen no es válida.' }, 400);
  }

  if (imagen.length === 0) return json(res, { error: 'Falta la imagen del comprobante.' }, 400);
  if (imagen.length > LIMITE_IMAGEN) {
    return json(res, { error: 'La imagen es demasiado grande (máximo 4 MB).' }, 413);
  }
  if (!detectarTipoImagen(imagen)) {
    return json(res, { error: 'El archivo no es una imagen (JPG, PNG o WEBP).' }, 400);
  }

  let textoOcr;
  try {
    textoOcr = await leerConVision(imagen.toString('base64'), process.env.GOOGLE_VISION_API_KEY);
  } catch (e) {
    console.error('Vision:', e.message);
    return json(res, { error: 'No se pudo leer la imagen. Intenta de nuevo en un momento.' }, 502);
  }

  imagen = null; // la imagen se descarta aquí; nunca se guarda

  // Diagnóstico: con DEBUG_OCR=true se imprime el texto que leyó
  // Vision, para poder ajustar el parser ante un banco nuevo.
  // Dejar apagado en uso normal: los logs mostrarían nombres y
  // montos de la gente.
  if (process.env.DEBUG_OCR === 'true') {
    console.log('--- TEXTO OCR (inicio) ---');
    console.log(textoOcr);
    console.log('--- TEXTO OCR (fin) ---');
  }

  if (!textoOcr || !textoOcr.trim()) {
    return json(res, { error: 'No se detectó texto en la imagen. Sube una captura más clara.' }, 422);
  }

  const { campos, banco } = parsearComprobante(textoOcr);

  if (process.env.DEBUG_OCR === 'true') {
    console.log('--- CAMPOS EXTRAIDOS ---', JSON.stringify({ ...campos, banco }));
  }

  if (!campos.referencia && process.env.ANTHROPIC_API_KEY) {
    const rescatado = await rescatarConClaude(textoOcr, process.env.ANTHROPIC_API_KEY);
    if (rescatado) {
      for (const clave of Object.keys(campos)) {
        if (campos[clave] == null && rescatado[clave] != null) campos[clave] = rescatado[clave];
      }
    }
  }

  // ¿El comprobante va dirigido a doña Elvia?
  //
  // El teléfono manda: es exacto y el OCR lo lee bien. El nombre
  // solo se usa si no se pudo leer el teléfono, porque los
  // bancos lo escriben de formas distintas.
  if (SINPE_TELEFONO) {
    const tel = String(campos.destino_telefono || '').replace(/\D/g, '');
    const titular = normalizarNombre(campos.destino_titular);
    const esperado = normalizarNombre(SINPE_TITULAR);

    let valido;
    if (tel) {
      valido = tel === SINPE_TELEFONO;
    } else if (titular && esperado) {
      // Sin teléfono, se compara por apellidos y nombre
      valido = comparteNombre(titular, esperado);
    } else {
      valido = false;   // no se pudo determinar: se rechaza
    }

    if (!valido) {
      const aQuien = SINPE_TITULAR || `la línea ${SINPE_TELEFONO}`;
      return json(res, {
        error: `Este comprobante no corresponde a un pago para ${aQuien}. `
             + 'Solo se pueden subir comprobantes de pagos hechos a '
             + `${aQuien}.`,
      }, 422);
    }
  }

  // Sin referencia y monto no se guarda nada: es lo que evita
  // que alguien declare un monto que el comprobante no dice.
  const referencia = referenciaLimpia(campos.referencia);
  const monto = numeroLimpio(campos.monto);

  if (!referencia) {
    return json(res, { error: 'No pudimos leer el número de referencia. Sube una captura donde se vea completo.' }, 422);
  }
  if (monto == null || monto <= 0) {
    return json(res, { error: 'No pudimos leer el monto del comprobante. Sube una captura más clara.' }, 422);
  }

  const registro = {
    nombre,
    artista,
    fecha_comprobante: fechaLimpia(campos.fecha),
    remitente: textoLimpio(campos.remitente, 150),
    cuenta_origen: textoLimpio(campos.cuenta_origen, 200),
    monto,
    detalle: textoLimpio(campos.detalle, 300),
    referencia,
    banco: textoLimpio(banco, 40),
    ip_origen: ip,
  };

  let respuesta;
  try {
    respuesta = await fetch(`${SUPABASE_URL}/rest/v1/pagos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: SERVICE_KEY,
        authorization: `Bearer ${SERVICE_KEY}`,
        prefer: 'return=minimal',
      },
      body: JSON.stringify(registro),
    });
  } catch (e) {
    console.error('Supabase inalcanzable:', e.message);
    return json(res, { error: 'No se pudo guardar el pago. Intenta de nuevo.' }, 502);
  }

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    if (detalle.includes('23505') || detalle.includes('duplicate')) {
      return json(res, { error: 'Este comprobante ya fue registrado antes.' }, 409);
    }
    console.error('Supabase insert:', detalle);
    return json(res, { error: 'No se pudo guardar el pago.' }, 502);
  }

  return json(res, {
    ok: true,
    resumen: {
      nombre, artista, monto, referencia,
      fecha: registro.fecha_comprobante,
      detalle: registro.detalle,
    },
  });
}

// ------------------------------------------------------------
// Google Cloud Vision — autenticación por API key (?key=)
// ------------------------------------------------------------
async function leerConVision(imagenBase64, apiKey) {
  const respuesta = await fetch(
    'https://vision.googleapis.com/v1/images:annotate?key=' + encodeURIComponent(apiKey),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content: imagenBase64 },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
          imageContext: { languageHints: ['es'] },
        }],
      }),
    }
  );

  const data = await respuesta.json().catch(() => null);
  if (!respuesta.ok) throw new Error((data?.error?.message) || `error ${respuesta.status}`);

  const r = data?.responses?.[0];
  if (r?.error?.message) throw new Error(r.error.message);
  if (r?.fullTextAnnotation?.text) return r.fullTextAnnotation.text;
  if (r?.textAnnotations?.[0]) return r.textAnnotations[0].description;
  return '';
}

// ------------------------------------------------------------
// Respaldo opcional: Claude ordena el TEXTO que sacó Vision
// ------------------------------------------------------------
async function rescatarConClaude(textoOcr, apiKey) {
  const instruccion = `A continuación está el texto extraído por OCR de un comprobante de transferencia SINPE Móvil de un banco de Costa Rica.

Devuelve ÚNICAMENTE un objeto JSON válido, sin explicaciones y sin bloques de código:

{"fecha": "YYYY-MM-DD o null", "remitente": "nombre o null", "cuenta_origen": "cuenta o titular, o null", "monto": numero_o_null, "detalle": "motivo o null", "referencia": "numero de referencia o null"}

Reglas estrictas:
- Copia los números EXACTAMENTE como aparecen. No corrijas ni completes dígitos.
- Monto con punto decimal, sin separadores de miles. Algunos bancos escriben 6.000,00 y otros 6,000.00; ambos valen seis mil.
- No confundas la comisión con el monto del pago.
- Si un dato no está, usa null. No inventes.

TEXTO OCR:
"""
${textoOcr.slice(0, 4000)}
"""`;

  try {
    const respuesta = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODELO_RESPALDO,
        max_tokens: 500,
        messages: [{ role: 'user', content: instruccion }],
      }),
    });

    if (!respuesta.ok) return null;

    const data = await respuesta.json();
    const bloque = (data.content || []).find((b) => b.type === 'text');
    if (!bloque) return null;

    const obj = JSON.parse(bloque.text.replace(/```json|```/g, '').trim());

    // El modelo no puede inventar una referencia que no esté en el OCR
    if (obj.referencia) {
      const digitos = String(obj.referencia).replace(/\D/g, '');
      if (digitos.length < 8 || !textoOcr.replace(/\D/g, '').includes(digitos)) obj.referencia = null;
    }
    if (obj.monto != null) {
      const n = Number(obj.monto);
      obj.monto = Number.isFinite(n) && n > 0 ? n : null;
    }
    return obj;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------
function leerJson(req) {
  return new Promise((resolve, reject) => {
    const trozos = [];
    let tamano = 0;

    req.on('data', (t) => {
      tamano += t.length;
      if (tamano > LIMITE_CUERPO) {
        reject(new Error('El envío es demasiado grande.'));
        req.destroy();
        return;
      }
      trozos.push(t);
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(trozos).toString('utf8')));
      } catch {
        reject(new Error('Datos inválidos.'));
      }
    });

    req.on('error', reject);
  });
}

function json(res, obj, estado = 200) {
  res.writeHead(estado, cabeceras({ 'content-type': 'application/json; charset=utf-8' }));
  res.end(JSON.stringify(obj));
}
