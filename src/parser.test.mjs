import { parsearComprobante, _internos } from './parser.js';

// Texto tal como Vision lo devolvería (orden de lectura de arriba a abajo)
const TEXTO_BAC = `BAC
Notificación de transferencia
SINPE Móvil
Hola,
Le informamos que DIEGO ALEJANDRO
HERNANDEZ GARCIA realizó una
transferencia por medio de SINPE Móvil al
teléfono Nº 70180075 a nombre de
ESTEBAN JAVIER BARBOZA RIVERA.
Referencia
20260916102840005210721 69
Fecha
16 septiembre 2026
Hora
2:43 PM
Monto
₡6,000.00
Detalle
Camisa chamo`;

const TEXTO_BCR = `BCR
SOMOS EL BANCO DE COSTA RICA
12 de septiembre, 2026
19:03
Comprobante
Transferencia SINPE Móvil
Documento
48723877
Referencia
20260912152830004 48723877
Cuenta origen
AH CR59015202909005529336
VALERIO PEREZ CINTHYA VANESSA
SINPE Móvil destino
Esteban Javier Barboza
Rivera
7018-0075
Monto debitado
₡6.000,00
Comisión
₡0,00
Monto transferido
₡6.000,00
Motivo
Fernanda Hernandez`;

let fallas = 0;
function revisar(etiqueta, real, esperado) {
  const ok = String(real) === String(esperado);
  if (!ok) fallas++;
  console.log(`${ok ? '  ok  ' : ' FALLA'} ${etiqueta}: ${JSON.stringify(real)}${ok ? '' : `  (esperado ${JSON.stringify(esperado)})`}`);
}

console.log('\n=== Formatos de monto ===');
revisar('₡6,000.00 (BAC)', _internos.parsearMonto('₡6,000.00'), 6000);
revisar('₡6.000,00 (BCR)', _internos.parsearMonto('₡6.000,00'), 6000);
revisar('₡125.500,50', _internos.parsearMonto('₡125.500,50'), 125500.5);
revisar('₡125,500.50', _internos.parsearMonto('₡125,500.50'), 125500.5);
revisar('₡15000', _internos.parsearMonto('₡15000'), 15000);
revisar('₡0,00', _internos.parsearMonto('₡0,00'), 0);
revisar('₡1.000', _internos.parsearMonto('₡1.000'), 1000);

console.log('\n=== Fechas ===');
revisar('16 septiembre 2026', _internos.parsearFecha('16 septiembre 2026'), '2026-09-16');
revisar('12 de septiembre, 2026', _internos.parsearFecha('12 de septiembre, 2026'), '2026-09-12');
revisar('setiembre (grafía CR)', _internos.parsearFecha('3 de setiembre de 2026'), '2026-09-03');
revisar('16/09/2026', _internos.parsearFecha('16/09/2026'), '2026-09-16');

console.log('\n=== Comprobante BAC ===');
const bac = parsearComprobante(TEXTO_BAC);
console.log(JSON.stringify(bac, null, 2));
revisar('banco', bac.banco, 'BAC');
revisar('fecha', bac.campos.fecha, '2026-09-16');
revisar('monto', bac.campos.monto, 6000);
revisar('detalle', bac.campos.detalle, 'Camisa chamo');
revisar('referencia', bac.campos.referencia, '2026091610284000521072169');
revisar('remitente', bac.campos.remitente, 'DIEGO ALEJANDRO HERNANDEZ GARCIA');

console.log('\n=== Comprobante BCR ===');
const bcr = parsearComprobante(TEXTO_BCR);
console.log(JSON.stringify(bcr, null, 2));
revisar('banco', bcr.banco, 'BCR');
revisar('fecha', bcr.campos.fecha, '2026-09-12');
revisar('monto (no la comisión)', bcr.campos.monto, 6000);
revisar('detalle', bcr.campos.detalle, 'Fernanda Hernandez');
revisar('referencia', bcr.campos.referencia, '2026091215283000448723877');
revisar('remitente', bcr.campos.remitente, 'VALERIO PEREZ CINTHYA VANESSA');
revisar('cuenta origen', bcr.campos.cuenta_origen, 'AH CR59015202909005529336 — VALERIO PEREZ CINTHYA VANESSA');

console.log('\n=== Variantes reales del OCR (BAC) ===');

// El BAC imprime los centavos en letra más chica: Vision a veces
// los devuelve en una línea aparte, o con un espacio de por medio.
const BAC_CENTAVOS_PARTIDOS = `BAC
Referencia
20260916102840005210721 69
Fecha
16 septiembre 2026
Hora
2:43 PM
Monto
\u20A16,000.
00
Detalle
Camisa chamo`;

const r1 = parsearComprobante(BAC_CENTAVOS_PARTIDOS);
revisar('centavos en línea aparte', r1.campos.monto, 6000);
revisar('  y la fecha sigue bien', r1.campos.fecha, '2026-09-16');

const BAC_CENTAVOS_ESPACIO = BAC_CENTAVOS_PARTIDOS.replace('\u20A16,000.\n00', '\u20A16,000. 00');
revisar('centavos con espacio', parsearComprobante(BAC_CENTAVOS_ESPACIO).campos.monto, 6000);

// Vision puede leer el símbolo de colón como C o ¢
revisar('simbolo leido como C', parsearComprobante(BAC_CENTAVOS_PARTIDOS.replace('\u20A1','C')).campos.monto, 6000);
revisar('simbolo leido como ¢', parsearComprobante(BAC_CENTAVOS_PARTIDOS.replace('\u20A1','¢')).campos.monto, 6000);

// Vision suele devolver las tablas por columnas: primero todas
// las etiquetas, después todos los valores.
const BAC_POR_COLUMNAS = `BAC
Referencia
20260916102840005210721 69
Fecha
Hora
Monto
Detalle
16 septiembre 2026
2:43 PM
\u20A16,000.00
Camisa chamo`;

const r2 = parsearComprobante(BAC_POR_COLUMNAS);
revisar('leido por columnas', r2.campos.monto, 6000);
revisar('  no confunde con el día', r2.campos.monto !== 16, true);

console.log('\n=== Texto vacío / basura ===');
const vacio = parsearComprobante('');
revisar('sin texto no revienta', vacio.campos.referencia, null);
const basura = parsearComprobante('foto de un gato\nmiau');
revisar('basura no inventa referencia', basura.campos.referencia, null);

console.log(fallas === 0 ? '\nTodas las pruebas pasaron.\n' : `\n${fallas} pruebas fallaron.\n`);
process.exit(fallas === 0 ? 0 : 1);
