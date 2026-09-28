// ============================================================
// Servidor de "Vestuarios Elvia"
//
//   GET  /               formulario público
//   GET  /admin          panel de doña Elvia
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
// Los comprobantes se guardan solo hasta esta fecha; después el
// servidor los borra solo. Vacío = no se borran nunca.
const FECHA_BORRADO = (process.env.FECHA_BORRADO || '').trim();
const BUCKET = process.env.SUPABASE_BUCKET || 'comprobantes';

const SINPE_TELEFONO = (process.env.SINPE_TELEFONO || '').replace(/\D/g, '');
const SINPE_TITULAR = (process.env.SINPE_TITULAR || '').trim();

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const limiteRegistro = crearLimitador({ maximo: 12, ventanaMs: 10 * 60 * 1000 });

// La consulta se limita más fuerte que el registro: el código
// tiene 25.000 combinaciones, así que sin este freno alguien
// podría probarlas todas y ver los pagos de los demás.
const limiteConsulta = crearLimitador({ maximo: 8, ventanaMs: 10 * 60 * 1000 });

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "manifest-src 'self'",
  "worker-src 'self'",
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

    if (ruta === '/api/consultar') {
      if (req.method !== 'POST') return json(res, { error: 'Método no permitido.' }, 405);
      return await manejarConsulta(req, res);
    }

    if (ruta.startsWith('/api/comprobante/')) {
      if (req.method !== 'GET') return json(res, { error: 'Método no permitido.' }, 405);
      return await servirComprobante(req, res, decodeURIComponent(ruta.slice('/api/comprobante/'.length)));
    }

    if (ruta === '/api/borrar-comprobantes') {
      if (req.method !== 'POST') return json(res, { error: 'Método no permitido.' }, 405);
      return await manejarBorrado(req, res);
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
  console.log(`Vestuarios Elvia escuchando en el puerto ${PUERTO}`);
  const faltan = [];
  if (!process.env.GOOGLE_VISION_API_KEY) faltan.push('GOOGLE_VISION_API_KEY');
  if (!SUPABASE_URL) faltan.push('SUPABASE_URL');
  if (!SERVICE_KEY) faltan.push('SUPABASE_SERVICE_ROLE_KEY');
  if (faltan.length) console.warn('AVISO: faltan variables:', faltan.join(', '));

  if (FECHA_BORRADO) {
    console.log(`Los comprobantes se borran automáticamente después del ${FECHA_BORRADO}.`);
    revisarVencimiento();
    const diario = setInterval(revisarVencimiento, 24 * 60 * 60 * 1000);
    diario.unref();
  } else {
    console.warn('AVISO: FECHA_BORRADO vacía — los comprobantes se guardan indefinidamente.');
  }
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

    // El service worker se sirve siempre fresco: si el navegador
    // lo cachea, los cambios de la app no llegan nunca.
    const extra = archivo === '/sw.js'
      ? { 'cache-control': 'no-store', 'service-worker-allowed': '/' }
      : { 'cache-control': 'no-cache' };

    res.writeHead(200, cabeceras({ 'content-type': tipo, ...extra }));
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
window.FECHA_BORRADO = ${JSON.stringify(FECHA_BORRADO)};
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

  // La imagen se conserva para que doña Elvia pueda verificarla.
  // Se guarda recién acá, después de que el comprobante pasó
  // todas las validaciones: así no se acumulan archivos de
  // intentos rechazados.
  const bytesImagen = imagen;
  const tipoImagen = detectarTipoImagen(imagen);
  imagen = null;

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

  let imagenPath = null;
  try {
    imagenPath = await subirImagen(bytesImagen, tipoImagen);
  } catch (e) {
    // Si falla la subida el pago se registra igual: perder el
    // registro del pago sería peor que perder la imagen.
    console.error('No se pudo guardar la imagen:', e.message);
  }

  const codigo = await generarCodigoLibre();

  const registro = {
    nombre,
    artista,
    codigo,
    fecha_comprobante: fechaLimpia(campos.fecha),
    remitente: textoLimpio(campos.remitente, 150),
    cuenta_origen: textoLimpio(campos.cuenta_origen, 200),
    monto,
    detalle: textoLimpio(campos.detalle, 300),
    referencia,
    banco: textoLimpio(banco, 40),
    imagen_path: imagenPath,
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
      nombre, artista, monto, referencia, codigo,
      fecha: registro.fecha_comprobante,
      detalle: registro.detalle,
    },
  });
}

// ------------------------------------------------------------
// Código de consulta: dos vocales + tres dígitos (ej. AE472)
//
// Aleatorio a propósito, no correlativo: si fuera 001, 002, 003
// cualquiera podría adivinar el de otra persona probando el
// número de al lado.
// ------------------------------------------------------------
const VOCALES = 'AEIOU';

function generarCodigo() {
  const azar = crypto.randomBytes(5);
  return VOCALES[azar[0] % 5]
       + VOCALES[azar[1] % 5]
       + (azar[2] % 10)
       + (azar[3] % 10)
       + (azar[4] % 10);
}

// Reintenta si el código ya existe. Con 25.000 combinaciones y
// pocos cientos de pagos, las colisiones son raras.
async function generarCodigoLibre() {
  for (let intento = 0; intento < 12; intento++) {
    const codigo = generarCodigo();
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/pagos?codigo=eq.${codigo}&select=codigo&limit=1`,
        { headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` } }
      );
      if (!r.ok) return codigo;                 // ante la duda, se usa
      const filas = await r.json();
      if (!filas.length) return codigo;
    } catch {
      return codigo;
    }
  }
  return generarCodigo();
}

// ------------------------------------------------------------
// POST /api/consultar — la persona busca SU pago por el código
//
// Devuelve solo los datos de ese pago. Nunca la lista completa,
// ni el comprobante, ni nada de otras personas.
// ------------------------------------------------------------
async function manejarConsulta(req, res) {
  const ip = ipCliente(req, CONFIAR_PROXY);

  const permiso = limiteConsulta(ip);
  if (!permiso.ok) {
    return json(res, {
      error: `Demasiadas consultas. Espera ${Math.ceil(permiso.esperaSegundos / 60)} minutos.`,
    }, 429);
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json(res, { error: 'No disponible en este momento.' }, 500);
  }

  let cuerpo;
  try {
    cuerpo = await leerJson(req);
  } catch (e) {
    return json(res, { error: String(e.message || e) }, 413);
  }

  const codigo = String((cuerpo && cuerpo.codigo) || '').trim().toUpperCase();

  if (!/^[AEIOU]{2}\d{3}$/.test(codigo)) {
    return json(res, { error: 'El código debe tener dos letras y tres números, por ejemplo AE472.' }, 400);
  }

  let filas;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/pagos?codigo=eq.${codigo}`
      + '&select=nombre,artista,monto,fecha_comprobante,referencia,detalle,codigo&limit=1',
      { headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` } }
    );
    if (!r.ok) throw new Error(await r.text());
    filas = await r.json();
  } catch (e) {
    console.error('Consulta:', e.message);
    return json(res, { error: 'No se pudo consultar en este momento.' }, 502);
  }

  if (!filas.length) {
    return json(res, { error: 'No encontramos ningún pago con ese código. Revisa que esté bien escrito.' }, 404);
  }

  const p = filas[0];
  return json(res, {
    ok: true,
    pago: {
      codigo: p.codigo,
      nombre: p.nombre,
      artista: p.artista,
      monto: p.monto,
      fecha: p.fecha_comprobante,
      referencia: p.referencia,
      detalle: p.detalle,
    },
  });
}


// ------------------------------------------------------------
// Almacenamiento de comprobantes
//
// Las imágenes viven en un bucket privado. El navegador nunca
// las pide directo a Supabase: pasan por este servidor, que
// primero valida la sesión de doña Elvia.
// ------------------------------------------------------------
async function subirImagen(buffer, tipo) {
  const ext = tipo === 'image/png' ? 'png' : tipo === 'image/webp' ? 'webp' : 'jpg';
  const nombre = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}.${ext}`;

  const respuesta = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${nombre}`, {
    method: 'POST',
    headers: {
      'content-type': tipo,
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: buffer,
  });

  if (!respuesta.ok) throw new Error((await respuesta.text()).slice(0, 200));
  return nombre;
}

// Comprueba contra Supabase que quien pide sea doña Elvia
async function sesionValida(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return false;

  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY || '', authorization: auth },
    });
    return r.ok;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
// GET /api/comprobante/:archivo — solo para el panel
// ------------------------------------------------------------
async function servirComprobante(req, res, archivo) {
  if (!SUPABASE_URL || !SERVICE_KEY) return json(res, { error: 'No disponible.' }, 500);
  if (!(await sesionValida(req))) return json(res, { error: 'No autorizado.' }, 401);

  // Solo nombres generados por subirImagen; nada de rutas raras
  if (!/^\d+_[0-9a-f]{16}\.(jpg|png|webp)$/.test(archivo)) {
    return json(res, { error: 'Ruta inválida.' }, 400);
  }

  let objeto;
  try {
    objeto = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${archivo}`, {
      headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` },
    });
  } catch (e) {
    return json(res, { error: 'No disponible.' }, 502);
  }

  if (!objeto.ok) return json(res, { error: 'El comprobante ya no está disponible.' }, 404);

  const datos = Buffer.from(await objeto.arrayBuffer());
  res.writeHead(200, cabeceras({
    'content-type': objeto.headers.get('content-type') || 'image/jpeg',
    'cache-control': 'private, max-age=300',
  }));
  res.end(datos);
}

// ------------------------------------------------------------
// POST /api/borrar-comprobantes — vacía el bucket
//
// Los pagos NO se tocan: solo desaparecen las imágenes.
// ------------------------------------------------------------
async function manejarBorrado(req, res) {
  if (!SUPABASE_URL || !SERVICE_KEY) return json(res, { error: 'No disponible.' }, 500);
  if (!(await sesionValida(req))) return json(res, { error: 'No autorizado.' }, 401);

  try {
    const cuantos = await borrarTodosLosComprobantes();
    return json(res, { ok: true, borrados: cuantos });
  } catch (e) {
    console.error('Borrado de comprobantes:', e.message);
    return json(res, { error: 'No se pudieron borrar los comprobantes.' }, 502);
  }
}

async function borrarTodosLosComprobantes() {
  let total = 0;

  // El listado viene paginado; se repite hasta vaciarlo
  for (let vuelta = 0; vuelta < 50; vuelta++) {
    const lista = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: SERVICE_KEY,
        authorization: `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({ prefix: '', limit: 100, offset: 0 }),
    });

    if (!lista.ok) throw new Error(await lista.text());

    const archivos = (await lista.json()) || [];
    const nombres = archivos.map((a) => a.name).filter(Boolean);
    if (!nombres.length) break;

    const borrado = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        apikey: SERVICE_KEY,
        authorization: `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({ prefixes: nombres }),
    });

    if (!borrado.ok) throw new Error(await borrado.text());
    total += nombres.length;
  }

  // Limpiar las referencias en la tabla
  await fetch(`${SUPABASE_URL}/rest/v1/pagos?imagen_path=not.is.null`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      prefer: 'return=minimal',
    },
    body: JSON.stringify({ imagen_path: null }),
  }).catch(() => {});

  return total;
}

// ------------------------------------------------------------
// Borrado automático al pasar la fecha
//
// Se revisa al arrancar y una vez al día. Si el contenedor
// estuviera apagado ese día, el borrado ocurre al siguiente
// arranque — nunca se saltea.
// ------------------------------------------------------------
function venceHoy() {
  if (!FECHA_BORRADO) return false;
  const hoy = new Date().toISOString().slice(0, 10);
  return hoy > FECHA_BORRADO;
}

async function revisarVencimiento() {
  if (!venceHoy() || !SUPABASE_URL || !SERVICE_KEY) return;
  try {
    const n = await borrarTodosLosComprobantes();
    if (n) console.log(`Comprobantes borrados por vencimiento (${FECHA_BORRADO}): ${n}`);
  } catch (e) {
    console.error('Borrado automático falló:', e.message);
  }
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
// Quita tildes, signos y espacios de más para poder comparar
function normalizarNombre(t) {
  return String(t || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Coinciden si comparten al menos dos palabras de 3+ letras.
// Tolera que un banco escriba "ELVIA D BRAVO VARGAS" y otro
// "Elvia Damaris Bravo Vargas".
function comparteNombre(a, b) {
  const pa = new Set(a.split(' ').filter((w) => w.length >= 3));
  const pb = b.split(' ').filter((w) => w.length >= 3);
  return pb.filter((w) => pa.has(w)).length >= 2;
}

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
