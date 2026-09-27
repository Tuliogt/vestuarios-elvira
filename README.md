# Vestuarios Elvira — registro de pagos SINPE

Dos partes:

- **`public/index.html`** — formulario público, sin login. La persona escribe su nombre, elige el vestuario y sube la captura de su comprobante SINPE. En un solo paso.
- **`public/admin.html`** — panel privado para doña Elvira: elige una persona, le agrega items, ve el saldo, y descarga todo en Excel.

## Cómo funciona

1. La persona sube la captura del comprobante.
2. El servidor la manda a **Google Cloud Vision**, que devuelve el texto exacto de la imagen.
3. Un **parser propio** (`src/parser.js`) extrae fecha, monto, referencia, remitente y detalle. Está probado contra los formatos de BAC y BCR.
4. Se guarda la fila en Supabase y **la imagen se descarta**. Nunca toca disco ni ningún bucket.

Dos decisiones que definen el diseño:

**Las imágenes no se almacenan.** Viven unos segundos en memoria mientras se procesan y se van. No hay bucket, no hay nada que se llene, y no quedan comprobantes bancarios de nadie guardados.

**El OCR manda.** La persona solo aporta su nombre y el vestuario; monto, fecha y referencia salen de la imagen y no se pueden editar. Si el OCR no logra leer el monto o la referencia, el pago se rechaza con un mensaje pidiendo una captura más clara. Así nadie puede declarar un monto que el comprobante no dice.

## 1. Crear el proyecto en Supabase

1. Creá un proyecto **nuevo y aparte** de tus otros proyectos. La `service_role` key salta las políticas de seguridad de todo el proyecto, así que conviene que esta app no comparta base con nada más.
2. Al crearlo, desactivá "Automatically expose new tables" y activá "Enable automatic RLS".
3. Abrí `schema.sql`, cambiá `elvira@vestuarios.local` por el usuario real, y corré todo en **SQL Editor → New query → Run**.

> El usuario tiene forma de correo porque Supabase lo exige, pero nunca se manda nada ahí: la cuenta se crea auto-confirmada. Para ella es simplemente "su usuario".

## 2. Crear la cuenta y cerrar el registro

- **Authentication → Users → Add user**: el mismo usuario del paso anterior, su contraseña, y **Auto Confirm User activado**.
- **Authentication → Sign In / Providers**: desactivá "Allow new users to sign up".

## 3. Copiar las tres llaves

En **Project Settings → API**: Project URL, llave `anon` y llave `service_role` (viene oculta).

## 4. Crear la llave de Google Vision

1. En `console.cloud.google.com`, creá un proyecto.
2. Habilitá la **Cloud Vision API** (pide asociar facturación aunque no pagues nada).
3. **APIs & Services → Credentials → Create credentials → API key**.
4. **Restrict key** → en "API restrictions", limitala solo a Cloud Vision API.

**Costo:** las primeras 1.000 imágenes al mes son gratis; después, $1.50 por cada 1.000.

## 5. Desplegar en Coolify

La app es un servidor Node **sin dependencias externas** — no hay `npm install` que pueda fallar.

1. Subí el proyecto a un repositorio y apuntá Coolify ahí.
2. Build Pack: **Dockerfile**. Port: `3000`. Health check: `/health`.
3. En Environment Variables, lo que está en `.env.example`:

   | Variable | Obligatoria | Para qué |
   |---|---|---|
   | `SUPABASE_URL` | sí | Base de datos |
   | `SUPABASE_ANON_KEY` | sí | Login del panel |
   | `SUPABASE_SERVICE_ROLE_KEY` | sí | **Secreta.** El servidor escribe con esta llave |
   | `GOOGLE_VISION_API_KEY` | sí | OCR del comprobante |
   | `ANTHROPIC_API_KEY` | no | Respaldo cuando el parser no reconoce el banco |
   | `ARTISTAS` | no | Lista separada por comas |
   | `PORT` | no | Por defecto `3000` |

4. Poné el dominio. Puede ser el subdominio del VPS: `https://vestuarios.srvXXXXXX.hstgr.cloud`.

Rutas: `/` es el formulario, `/admin` es el panel.

### Correrlo local

```bash
cp .env.example .env
node --env-file=.env server.js
```

### Probar el parser

```bash
npm test
```

## Seguridad

- El navegador del público **no habla con la base de datos**: solo con el servidor, que valida todo. La llave `anon` no tiene ningún permiso.
- Límite de 12 peticiones por IP cada 10 minutos, validación real de que lo subido sea una imagen (magic bytes, no el content-type), y tope de 4 MB.
- Para entrar al panel hace falta cuenta válida **y** estar en `usuarios_autorizados`.
- Cabeceras de seguridad: CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`.
- `supabase-js` y `SheetJS` están dentro del proyecto en versión fija, no vienen de un CDN.

## Decisiones que podés ajustar

- **Precios de items en múltiplos de ₡5.000 hasta ₡100.000.** Se cambia en `public/admin.html`, buscando `PASO_PRECIO` y `MAX_PRECIO`.
- **El parser está probado con BAC y BCR.** Si aparece otro banco y los campos no salen, el pago se rechaza con un mensaje claro en vez de guardar datos malos. Mandame el texto del comprobante y le agrego el patrón.
- **La referencia SINPE empieza con la fecha en formato AAAAMMDD.** El parser usa eso para identificar cuál número largo es la referencia y para validar la fecha.
- **Los bancos escriben los montos al revés entre sí**: BAC usa `₡6,000.00`, BCR usa `₡6.000,00`. El parser detecta cuál separador es el decimal en vez de asumir.
