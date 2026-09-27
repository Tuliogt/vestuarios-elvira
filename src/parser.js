// ============================================================
// Parser de comprobantes SINPE Móvil
//
// Recibe el TEXTO plano que devuelve Google Cloud Vision y saca
// los campos. Es determinista: no inventa datos. Si no encuentra
// un campo, devuelve null y la persona lo llena a mano.
//
// Carpetas que empiezan con "_" no se publican como rutas en
// Cloudflare Pages, así que este archivo es solo interno.
// ============================================================

const MESES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12,
};

// ------------------------------------------------------------
// Normalización
// ------------------------------------------------------------
function sinTildes(t) {
  return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizar(texto) {
  let t = String(texto).replace(/\r/g, '');

  // El OCR puede leer el símbolo de colón de varias formas
  // (C con barra, ¢, C/, o simplemente "C" pegada a un número).
  // Se unifican todas a ₡ para que el resto del parser no tenga
  // que conocer cada variante.
  t = t.replace(/[¢₵C]\/?(?=\s?\d)/g, '\u20A1');

  return t
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

// ------------------------------------------------------------
// Montos — maneja los dos formatos que usan los bancos de CR:
//   BAC:  ₡6,000.00   (coma = miles, punto = decimal)
//   BCR:  ₡6.000,00   (punto = miles, coma = decimal)
// Regla: el separador que aparece de ÚLTIMO y va seguido de
// exactamente 2 dígitos al final es el decimal.
// ------------------------------------------------------------
function parsearMonto(crudo) {
  if (!crudo) return null;
  let s = String(crudo).replace(/[₡$€\s]/g, '').replace(/CRC/gi, '');
  if (!/\d/.test(s)) return null;

  const ultimaComa = s.lastIndexOf(',');
  const ultimoPunto = s.lastIndexOf('.');

  if (ultimaComa > -1 && ultimoPunto > -1) {
    if (ultimaComa > ultimoPunto) {
      s = s.replace(/\./g, '').replace(',', '.');   // 6.000,00
    } else {
      s = s.replace(/,/g, '');                      // 6,000.00
    }
  } else if (ultimaComa > -1) {
    const despues = s.length - ultimaComa - 1;
    s = despues === 2 ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (ultimoPunto > -1) {
    const despues = s.length - ultimoPunto - 1;
    if (despues !== 2) s = s.replace(/\./g, '');
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------
// Fechas — "16 septiembre 2026", "12 de septiembre, 2026",
//          "16/09/2026", "2026-09-16"
// ------------------------------------------------------------
function parsearFecha(texto) {
  const t = sinTildes(texto.toLowerCase());

  // 16 [de] septiembre[,] [de] 2026
  const conMes = t.match(
    /(\d{1,2})\s*(?:de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)[,\s]+(?:de\s+)?(\d{4})/
  );
  if (conMes) {
    return armarFecha(Number(conMes[3]), MESES[conMes[2]], Number(conMes[1]));
  }

  // 2026-09-16
  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return armarFecha(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // 16/09/2026  (día primero, como se usa en Costa Rica)
  const barras = t.match(/(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})/);
  if (barras) return armarFecha(Number(barras[3]), Number(barras[2]), Number(barras[1]));

  return null;
}

function armarFecha(anio, mes, dia) {
  if (!anio || !mes || !dia) return null;
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

// ------------------------------------------------------------
// Referencia — el dato más importante (evita duplicados).
// Las referencias SINPE son cadenas largas de dígitos que
// empiezan con la fecha en formato AAAAMMDD.
// ------------------------------------------------------------
function parsearReferencia(texto) {
  const lineas = texto.split('\n');

  // 1. Buscar el rótulo "Referencia" y tomar los dígitos que siguen
  //    (en la misma línea o en la siguiente).
  for (let i = 0; i < lineas.length; i++) {
    const l = sinTildes(lineas[i].toLowerCase());
    if (/\breferencia\b/.test(l) && !/documento/.test(l)) {
      const mismaLinea = lineas[i].match(/(\d[\d\s-]{12,})/);
      if (mismaLinea) {
        const limpio = mismaLinea[1].replace(/[\s-]/g, '');
        if (limpio.length >= 13) return limpio;
      }
      if (lineas[i + 1]) {
        const siguiente = lineas[i + 1].match(/(\d[\d\s-]{12,})/);
        if (siguiente) {
          const limpio = siguiente[1].replace(/[\s-]/g, '');
          if (limpio.length >= 13) return limpio;
        }
      }
    }
  }

  // 2. Sin rótulo: la cadena de dígitos más larga que empiece
  //    con una fecha AAAAMMDD plausible.
  const candidatos = (texto.match(/\d{13,}/g) || []);
  const conFecha = candidatos.filter((c) => {
    const anio = Number(c.slice(0, 4));
    const mes = Number(c.slice(4, 6));
    const dia = Number(c.slice(6, 8));
    return anio >= 2020 && anio <= 2100 && mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31;
  });
  if (conFecha.length) return conFecha.sort((a, b) => b.length - a.length)[0];

  // 3. Último recurso: la cadena de dígitos más larga.
  if (candidatos.length) return candidatos.sort((a, b) => b.length - a.length)[0];

  return null;
}

// Las referencias SINPE traen la fecha en los primeros 8 dígitos
function fechaDesdeReferencia(ref) {
  if (!ref || ref.length < 8) return null;
  const anio = Number(ref.slice(0, 4));
  const mes = Number(ref.slice(4, 6));
  const dia = Number(ref.slice(6, 8));
  if (anio < 2020 || anio > 2100) return null;
  return armarFecha(anio, mes, dia);
}

// ------------------------------------------------------------
// Monto — evita confundirse con "Comisión" y prefiere el
// "Monto transferido" sobre el "Monto debitado".
// ------------------------------------------------------------
function extraerMonto(texto) {
  const lineas = texto.split('\n');
  const candidatos = [];

  for (let i = 0; i < lineas.length; i++) {
    const l = sinTildes(lineas[i].toLowerCase());
    if (/comision/.test(l)) continue;                  // nunca es el monto del pago

    if (/\bmonto\b|\bimporte\b|\btotal\b/.test(l)) {
      const prioridad = /transferido|transferencia/.test(l) ? 3
        : /debitado|enviado/.test(l) ? 2 : 1;

      let m = lineas[i].match(/[₡$]?\s*[\d.,]+\d/);
      if (!m && lineas[i + 1]) m = lineas[i + 1].match(/[₡$]?\s*[\d.,]+\d/);
      if (m) {
        const valor = parsearMonto(m[0]);
        if (valor != null && valor > 0) candidatos.push({ valor, prioridad });
      }
    }
  }

  if (candidatos.length) {
    candidatos.sort((a, b) => b.prioridad - a.prioridad);
    return candidatos[0].valor;
  }

  // Sin rótulo: cualquier cifra precedida por el símbolo de colón
  const conColon = texto.match(/₡\s*[\d.,]+\d/g);
  if (conColon) {
    const valores = conColon.map(parsearMonto).filter((v) => v != null && v > 0);
    if (valores.length) return Math.max(...valores);
  }

  return null;
}

// ------------------------------------------------------------
// Campos de texto con rótulo ("Detalle", "Motivo", etc.)
// ------------------------------------------------------------
function valorDeRotulo(texto, rotulos) {
  const lineas = texto.split('\n');
  for (let i = 0; i < lineas.length; i++) {
    const l = sinTildes(lineas[i].toLowerCase());
    for (const rotulo of rotulos) {
      const r = sinTildes(rotulo.toLowerCase());
      if (l.startsWith(r) || l.includes(r)) {
        // ¿El valor viene en la misma línea, después del rótulo?
        const idx = l.indexOf(r) + r.length;
        const resto = lineas[i].slice(idx).replace(/^[:\s]+/, '').trim();
        if (resto && resto.length > 1) return resto;
        // Si no, en la línea siguiente
        if (lineas[i + 1] && !esRotulo(lineas[i + 1])) return lineas[i + 1].trim();
      }
    }
  }
  return null;
}

function esRotulo(linea) {
  const l = sinTildes(linea.toLowerCase().trim());
  return /^(fecha|hora|monto|comision|detalle|motivo|referencia|documento|cuenta|sinpe|descripcion|estado|tipo)\b/.test(l);
}

// ------------------------------------------------------------
// Cuenta origen (IBAN de Costa Rica) y el nombre que la acompaña
//
// Ojo: el patrón usa [^\S\n] (espacios pero NO saltos de línea)
// porque \s sí cruza líneas y se tragaría la línea del nombre.
// ------------------------------------------------------------
const RE_IBAN = /\bCR[^\S\n]?\d[\d[^\S\n]]{15,25}/i;
const RE_IBAN_CON_TIPO = /\b(?:AH|CC|CO)[^\S\n]+CR[^\S\n]?\d[\d ]{15,25}/i;

function ubicarCuenta(texto) {
  const lineas = texto.split('\n');
  for (let i = 0; i < lineas.length; i++) {
    const m = lineas[i].match(RE_IBAN_CON_TIPO) || lineas[i].match(/\bCR[^\S\n]?\d[\d ]{15,25}/i);
    if (m) {
      const cuenta = m[0].replace(/\s+/g, ' ').trim();

      // ¿Queda un nombre en la misma línea, después del número?
      let nombre = lineas[i].replace(m[0], '').replace(/cuenta\s*(de)?\s*origen/i, '').trim();

      // Si no, el nombre suele venir en la línea siguiente
      if (nombre.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, '').length < 4) {
        nombre = '';
        if (lineas[i + 1] && !esRotulo(lineas[i + 1]) && !RE_IBAN.test(lineas[i + 1])) {
          const cand = lineas[i + 1].trim();
          if (cand.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, '').length >= 4) nombre = cand;
        }
      }

      return { cuenta, nombre: limpiarNombre(nombre) };
    }
  }
  return null;
}

function extraerCuentaOrigen(texto) {
  const ubic = ubicarCuenta(texto);
  if (ubic) return ubic.nombre ? `${ubic.cuenta} — ${ubic.nombre}` : ubic.cuenta;

  const porRotulo = valorDeRotulo(texto, ['cuenta origen', 'cuenta de origen']);
  return porRotulo ? limpiarNombre(porRotulo) : null;
}

// ------------------------------------------------------------
// Remitente — quién envía el dinero
// ------------------------------------------------------------
function extraerRemitente(texto) {
  // Formato BAC: "Le informamos que NOMBRE realizó una transferencia".
  // El nombre puede venir partido en varias líneas, así que el
  // patrón sí debe cruzar saltos de línea aquí.
  const bac = texto.match(/informamos que\s+([\s\S]{3,90}?)\s+realiz/i);
  if (bac) return limpiarNombre(bac[1]);

  // Formato BCR y similares: el titular de la cuenta origen
  const ubic = ubicarCuenta(texto);
  if (ubic && ubic.nombre) return ubic.nombre;

  const porRotulo = valorDeRotulo(texto, ['remitente', 'enviado por', 'ordenante', 'de:']);
  if (porRotulo) {
    const limpio = limpiarNombre(quitarNumeroCuenta(porRotulo));
    if (limpio) return limpio;
  }

  return null;
}

function quitarNumeroCuenta(t) {
  return String(t || '')
    .replace(/\b(?:AH|CC|CO)[^\S\n]+/i, '')
    .replace(/\bCR[^\S\n]?\d[\d ]{15,25}/i, '')
    .trim();
}

function limpiarNombre(t) {
  const limpio = String(t || '')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:]+$/, '')
    .trim()
    .slice(0, 120);
  return limpio.length >= 2 ? limpio : null;
}

// ------------------------------------------------------------
// El BAC imprime los centavos en letra más chica, y el OCR a
// veces los separa del resto del monto:
//     ₡6,000.        →  ₡6,000.00
//     00
// También cubre el caso en que quedan en la misma línea con un
// espacio de por medio: "₡6,000. 00".
// ------------------------------------------------------------
function unirCentavosPartidos(texto) {
  const lineas = texto.split('\n');
  const salida = [];

  for (let i = 0; i < lineas.length; i++) {
    const actual = lineas[i];
    const siguiente = lineas[i + 1];

    // Una línea que termina en separador decimal seguida de dos
    // dígitos solos: son los centavos del monto anterior.
    if (/[\d][.,]\s*$/.test(actual) && siguiente && /^\d{2}$/.test(siguiente.trim())) {
      salida.push(actual.trim() + siguiente.trim());
      i++; // la siguiente ya se consumió
      continue;
    }

    // Mismo caso pero dentro de una sola línea
    salida.push(actual.replace(/([\d][.,])\s+(\d{2})\b/g, '$1$2'));
  }

  return salida.join('\n');
}

// ------------------------------------------------------------
// Detectar el banco (solo informativo, para depurar)
// ------------------------------------------------------------
function detectarBanco(texto) {
  const t = sinTildes(texto.toLowerCase());
  if (/\bbac\b|credomatic/.test(t)) return 'BAC';
  if (/\bbcr\b|banco de costa rica/.test(t)) return 'BCR';
  if (/banco nacional|\bbn\b|bncr/.test(t)) return 'BN';
  if (/scotiabank/.test(t)) return 'Scotiabank';
  if (/davivienda/.test(t)) return 'Davivienda';
  if (/promerica/.test(t)) return 'Promérica';
  if (/coopeande|coope/.test(t)) return 'Cooperativa';
  return null;
}

// ------------------------------------------------------------
// Función principal
// ------------------------------------------------------------
export function parsearComprobante(textoCrudo) {
  const texto = unirCentavosPartidos(normalizar(textoCrudo || ''));
  if (!texto) {
    return { campos: vacio(), avisos: ['No se detectó texto en la imagen.'], banco: null };
  }

  const avisos = [];
  const referencia = parsearReferencia(texto);
  let fecha = parsearFecha(texto);

  // Cruzar la fecha contra la que viene dentro de la referencia
  const fechaRef = fechaDesdeReferencia(referencia);
  if (fechaRef && !fecha) {
    fecha = fechaRef;
  } else if (fechaRef && fecha && fechaRef !== fecha) {
    avisos.push('La fecha visible y la fecha dentro del número de referencia no coinciden. Verifica cuál es la correcta.');
  }

  const campos = {
    fecha: fecha,
    remitente: extraerRemitente(texto),
    cuenta_origen: extraerCuentaOrigen(texto),
    monto: extraerMonto(texto),
    detalle: valorDeRotulo(texto, ['detalle', 'motivo', 'descripcion', 'descripción', 'concepto', 'nota']),
    referencia: referencia,
  };

  if (!campos.referencia) avisos.push('No se encontró el número de referencia. Escríbelo a mano tal como aparece en el comprobante.');
  if (campos.monto == null) avisos.push('No se pudo leer el monto.');

  return { campos, avisos, banco: detectarBanco(texto) };
}

export function vacio() {
  return { fecha: null, remitente: null, cuenta_origen: null, monto: null, detalle: null, referencia: null };
}

// Exportadas para las pruebas
export const _internos = { parsearMonto, parsearFecha, parsearReferencia, normalizar };
