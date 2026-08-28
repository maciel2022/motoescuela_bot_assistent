# Migración a WhatsApp Cloud API — Fase 1 — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir un chatbot de WhatsApp sobre la API oficial (Cloud API) que responda consultas de MotoEscuela MdP usando la Responses API de OpenAI con `file_search`, persistiendo contactos, conversaciones y mensajes en MySQL.

**Architecture:** Servidor Express que expone un webhook. El webhook valida la firma HMAC de Meta, persiste el mensaje en MySQL y responde `200 OK` en milisegundos; el procesamiento lento (OpenAI + envío de respuesta) ocurre de forma asíncrona en el mismo proceso. La deduplicación de reintentos de Meta se resuelve con un índice único en `wa_message_id`. El historial de conversación vive en nuestra base, no en OpenAI.

**Tech Stack:** Node 22 (ESM), Express 4, mysql2/promise, openai (SDK oficial), test runner nativo de Node (`node --test`), supertest, cloudflared para el túnel en desarrollo.

**Spec:** `docs/superpowers/specs/2026-08-28-migracion-whatsapp-cloud-api-design.md`

## Global Constraints

- **Node 22+ con ESM.** `"type": "module"` en `package.json`. Nada de `require()`.
- **Directorio del proyecto:** `motoescuela-whatsapp/` en la raíz del repositorio, hermano de `base-baileys-memory/`. Todos los paths del plan son relativos a `motoescuela-whatsapp/`.
- **Ningún test hace llamadas reales a OpenAI ni a la Graph API de Meta.** Siempre dobles.
- **Ningún secreto se commitea.** `.gitignore` antes del primer commit.
- **Vector store de OpenAI (verificado vivo el 2026-08-28):** `vs_68f103e570d481918608039028091559`
- **Modelo por defecto:** `gpt-4o-mini` (verificado funcionando con `file_search`).
- **Zona horaria del negocio:** `America/Argentina/Buenos_Aires`.
- **Base de datos de desarrollo:** `motoescuela`. **Base de datos de tests:** `motoescuela_test`. Los tests NUNCA corren contra la base de desarrollo.
- **TDD estricto:** el test se escribe y se ve fallar antes de cada implementación.
- **Commit al final de cada tarea.**

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `src/config.js` | Lee y valida variables de entorno. Falla al arrancar si falta alguna. |
| `src/logger.js` | Logging con niveles. Sin dependencias. |
| `src/whatsapp/signature.js` | Validación HMAC-SHA256 del header de Meta. Función pura. |
| `src/whatsapp/parse.js` | Payload de Meta → objetos propios. Función pura. |
| `src/whatsapp/client.js` | Envío de mensajes y marcado de leído contra la Graph API. |
| `src/whatsapp/webhook.js` | Router de Express: `GET` verificación, `POST` recepción. |
| `src/db/pool.js` | Pool de conexiones mysql2. |
| `src/db/migrations/001_init.sql` | Esquema inicial. |
| `src/db/migrate.js` | Crea la base si no existe y aplica migraciones pendientes. |
| `src/db/repos/contacts.js` | Upsert y lectura de contactos. |
| `src/db/repos/conversations.js` | Get-or-create de conversaciones. |
| `src/db/repos/messages.js` | Inserción con deduplicación, historial, cambios de estado. |
| `src/ia/prompt.js` | Instrucciones del asistente + armado del input desde el historial. |
| `src/ia/openai.js` | Implementación con Responses API + `file_search`. |
| `src/ia/index.js` | Interfaz `responder()`. Oculta al proveedor. |
| `src/core/handleMessage.js` | Orquestador: `ingest()` síncrono, `process()` asíncrono. |
| `src/app.js` | Construye la app de Express (sin escuchar). Testeable. |
| `src/server.js` | Arranca el servidor. |

---

### Task 1: Scaffolding, repositorio y configuración

**Files:**
- Create: `.gitignore` (raíz del repositorio), `motoescuela-whatsapp/package.json`, `motoescuela-whatsapp/.env.example`, `motoescuela-whatsapp/.env`, `motoescuela-whatsapp/src/config.js`, `motoescuela-whatsapp/src/logger.js`
- Test: `motoescuela-whatsapp/test/config.test.js`

**Interfaces:**
- Consumes: nada (primera tarea)
- Produces:
  - `config` (default export de `src/config.js`): objeto congelado con `port`, `whatsapp: { verifyToken, appSecret, token, phoneNumberId, graphVersion }`, `openai: { apiKey, model, vectorStoreId }`, `mysql: { host, port, user, password, database }`, `historyLimit`, `logLevel`
  - `loadConfig(env)` (named export de `src/config.js`): construye y valida la config desde un objeto de entorno arbitrario. Lanza `Error` con el listado de variables faltantes. Existe para poder testear sin variables globales.
  - `logger` (default export de `src/logger.js`): `.debug(msg, meta)`, `.info(...)`, `.warn(...)`, `.error(...)`

- [ ] **Step 1: Inicializar el repositorio git y proteger los secretos**

⚠️ El `.gitignore` va ANTES del primer commit. El árbol actual contiene `base-baileys-memory/.env` (API key de OpenAI) y `base-baileys-memory/bot_sessions/` (credenciales de la sesión de WhatsApp). Si entran al historial, quedan ahí para siempre.

Desde la raíz del repositorio:

```bash
git init
cat > .gitignore <<'EOF'
node_modules/
.env
.env.*
!.env.example
google.json
bot_sessions/
.DS_Store
*.log
coverage/
EOF
git add .gitignore
git commit -m "chore: gitignore antes de cualquier otro commit"
```

- [ ] **Step 2: Verificar que ningún secreto será commiteado**

```bash
git add -A
git status --short | grep -Ei '\.env$|bot_sessions|google\.json' && echo "PELIGRO: hay secretos en el stage" || echo "OK: sin secretos en el stage"
```

Expected: `OK: sin secretos en el stage`. Si aparece "PELIGRO", corregir `.gitignore` y ejecutar `git rm -r --cached <archivo>` antes de seguir.

```bash
git commit -m "chore: estado inicial del proyecto"
```

- [ ] **Step 3: Crear el proyecto Node**

```bash
mkdir -p motoescuela-whatsapp/src/{whatsapp,db/{migrations,repos},ia,core} motoescuela-whatsapp/test
cd motoescuela-whatsapp
npm init -y
npm pkg set type=module
npm pkg set engines.node=">=22"
npm pkg set scripts.start="node src/server.js"
npm pkg set scripts.dev="node --watch src/server.js"
npm pkg set scripts.test="MYSQL_DATABASE=motoescuela_test node --test --test-concurrency=1"
npm pkg set scripts.db:setup="node src/db/migrate.js"
npm pkg set "scripts.db:setup:test"="MYSQL_DATABASE=motoescuela_test node src/db/migrate.js"
npm install express mysql2 openai dotenv
npm install --save-dev supertest
```

Por qué `--test-concurrency=1`: el test runner de Node ejecuta los archivos de test **en paralelo** por defecto, y todos los archivos comparten la misma base `motoescuela_test`. Sin esta bandera, el `TRUNCATE` de un archivo borra las filas que otro archivo está usando en ese momento, y los tests fallan de forma intermitente y desconcertante (un test que pasaba empieza a fallar sin que lo hayas tocado).

Por qué el script `test` lleva el prefijo `MYSQL_DATABASE=motoescuela_test`: `config.js` carga el `.env` con `dotenv`, y **dotenv no pisa variables que ya existen en el entorno**. Por eso la variable puesta en la línea de comandos gana sobre la del `.env`, y los tests quedan aislados de la base de desarrollo sin necesidad de un segundo archivo de configuración.

- [ ] **Step 4: Crear `.env.example` y `.env`**

`.env.example` (SÍ se commitea — sin valores reales):

```
PORT=3000

# Meta / WhatsApp Cloud API
WHATSAPP_VERIFY_TOKEN=inventa_una_cadena_larga_aqui
WHATSAPP_APP_SECRET=
WHATSAPP_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
GRAPH_API_VERSION=v21.0

# OpenAI
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
OPENAI_VECTOR_STORE_ID=vs_68f103e570d481918608039028091559

# MySQL
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=
MYSQL_DATABASE=motoescuela

# App
HISTORY_LIMIT=10
LOG_LEVEL=info
```

Luego `cp .env.example .env` y completar `.env` con los valores reales. La `OPENAI_API_KEY` se puede tomar de `../base-baileys-memory/.env`. Los cuatro valores de WhatsApp se completan en la Task 11; hasta entonces se pueden poner valores de relleno (`test`) para que el servidor arranque.

- [ ] **Step 5: Escribir el test de configuración (falla)**

`test/config.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.js'

const envCompleto = {
  PORT: '3000',
  WHATSAPP_VERIFY_TOKEN: 'verifica',
  WHATSAPP_APP_SECRET: 'secreto',
  WHATSAPP_TOKEN: 'token',
  WHATSAPP_PHONE_NUMBER_ID: '123',
  OPENAI_API_KEY: 'sk-test',
  OPENAI_VECTOR_STORE_ID: 'vs_test',
  MYSQL_HOST: '127.0.0.1',
  MYSQL_USER: 'root',
  MYSQL_DATABASE: 'motoescuela_test',
}

test('loadConfig arma la configuración cuando están todas las variables', () => {
  const cfg = loadConfig(envCompleto)
  assert.equal(cfg.port, 3000)
  assert.equal(cfg.whatsapp.phoneNumberId, '123')
  assert.equal(cfg.openai.vectorStoreId, 'vs_test')
  assert.equal(cfg.mysql.database, 'motoescuela_test')
})

test('loadConfig aplica los valores por defecto', () => {
  const cfg = loadConfig(envCompleto)
  assert.equal(cfg.whatsapp.graphVersion, 'v21.0')
  assert.equal(cfg.openai.model, 'gpt-4o-mini')
  assert.equal(cfg.historyLimit, 10)
  assert.equal(cfg.mysql.port, 3306)
})

test('loadConfig lanza error nombrando TODAS las variables faltantes', () => {
  const incompleto = { ...envCompleto }
  delete incompleto.WHATSAPP_APP_SECRET
  delete incompleto.OPENAI_API_KEY
  assert.throws(
    () => loadConfig(incompleto),
    (err) =>
      err.message.includes('WHATSAPP_APP_SECRET') &&
      err.message.includes('OPENAI_API_KEY')
  )
})

test('la configuración es inmutable', () => {
  const cfg = loadConfig(envCompleto)
  assert.throws(() => { cfg.port = 9999 }, TypeError)
})
```

- [ ] **Step 6: Correr el test para verificar que falla**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/config.js'`

- [ ] **Step 7: Implementar `src/config.js`**

```js
import 'dotenv/config'

const REQUERIDAS = [
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'OPENAI_API_KEY',
  'OPENAI_VECTOR_STORE_ID',
  'MYSQL_HOST',
  'MYSQL_USER',
  'MYSQL_DATABASE',
]

export function loadConfig(env) {
  const faltantes = REQUERIDAS.filter((k) => !env[k] || String(env[k]).trim() === '')
  if (faltantes.length > 0) {
    throw new Error(
      `Faltan variables de entorno obligatorias: ${faltantes.join(', ')}. ` +
        `Copiá .env.example a .env y completalas.`
    )
  }

  const cfg = {
    port: Number(env.PORT ?? 3000),
    whatsapp: Object.freeze({
      verifyToken: env.WHATSAPP_VERIFY_TOKEN,
      appSecret: env.WHATSAPP_APP_SECRET,
      token: env.WHATSAPP_TOKEN,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      graphVersion: env.GRAPH_API_VERSION ?? 'v21.0',
    }),
    openai: Object.freeze({
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL ?? 'gpt-4o-mini',
      vectorStoreId: env.OPENAI_VECTOR_STORE_ID,
    }),
    mysql: Object.freeze({
      host: env.MYSQL_HOST,
      port: Number(env.MYSQL_PORT ?? 3306),
      user: env.MYSQL_USER,
      password: env.MYSQL_PASSWORD ?? '',
      database: env.MYSQL_DATABASE,
    }),
    historyLimit: Number(env.HISTORY_LIMIT ?? 10),
    logLevel: env.LOG_LEVEL ?? 'info',
  }

  return Object.freeze(cfg)
}

export default loadConfig(process.env)
```

Nota: `Object.freeze` es superficial, por eso cada objeto anidado se congela por separado.

- [ ] **Step 8: Implementar `src/logger.js`**

```js
const NIVELES = { debug: 10, info: 20, warn: 30, error: 40 }

function crearLogger(nivelMinimo = 'info') {
  const umbral = NIVELES[nivelMinimo] ?? NIVELES.info

  const emitir = (nivel, mensaje, meta) => {
    if (NIVELES[nivel] < umbral) return
    const linea = {
      ts: new Date().toISOString(),
      nivel,
      mensaje,
      ...(meta ? { meta } : {}),
    }
    const salida = nivel === 'error' || nivel === 'warn' ? console.error : console.log
    salida(JSON.stringify(linea))
  }

  return {
    debug: (m, meta) => emitir('debug', m, meta),
    info: (m, meta) => emitir('info', m, meta),
    warn: (m, meta) => emitir('warn', m, meta),
    error: (m, meta) => emitir('error', m, meta),
  }
}

export { crearLogger }
export default crearLogger(process.env.LOG_LEVEL ?? 'info')
```

- [ ] **Step 9: Correr los tests para verificar que pasan**

Run: `npm test`
Expected: PASS — 4 tests de `config.test.js`

- [ ] **Step 10: Commit**

```bash
git add motoescuela-whatsapp/package.json motoescuela-whatsapp/package-lock.json motoescuela-whatsapp/.env.example motoescuela-whatsapp/src/config.js motoescuela-whatsapp/src/logger.js motoescuela-whatsapp/test/config.test.js
git commit -m "feat: scaffolding del proyecto con configuracion validada y logger"
```

---

### Task 2: Validación de la firma del webhook

Meta firma cada webhook con HMAC-SHA256 sobre el cuerpo crudo, usando el App Secret. Sin esta validación, cualquiera que conozca la URL puede inyectar mensajes falsos.

**Files:**
- Create: `src/whatsapp/signature.js`
- Test: `test/whatsapp/signature.test.js`

**Interfaces:**
- Consumes: nada
- Produces: `esFirmaValida(rawBody: Buffer|string, header: string|undefined, appSecret: string) => boolean` (named export)

- [ ] **Step 1: Escribir el test que falla**

`test/whatsapp/signature.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { esFirmaValida } from '../../src/whatsapp/signature.js'

const SECRETO = 'app_secret_de_prueba'
const cuerpo = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }))

function firmar(buf, secreto = SECRETO) {
  return 'sha256=' + crypto.createHmac('sha256', secreto).update(buf).digest('hex')
}

test('acepta una firma correcta', () => {
  assert.equal(esFirmaValida(cuerpo, firmar(cuerpo), SECRETO), true)
})

test('rechaza una firma generada con otro secreto', () => {
  assert.equal(esFirmaValida(cuerpo, firmar(cuerpo, 'otro_secreto'), SECRETO), false)
})

test('rechaza cuando el cuerpo fue alterado', () => {
  const firma = firmar(cuerpo)
  const alterado = Buffer.from(JSON.stringify({ object: 'alterado' }))
  assert.equal(esFirmaValida(alterado, firma, SECRETO), false)
})

test('rechaza si el header falta', () => {
  assert.equal(esFirmaValida(cuerpo, undefined, SECRETO), false)
})

test('rechaza si el header no tiene el prefijo sha256=', () => {
  const sinPrefijo = crypto.createHmac('sha256', SECRETO).update(cuerpo).digest('hex')
  assert.equal(esFirmaValida(cuerpo, sinPrefijo, SECRETO), false)
})

test('rechaza un header de longitud distinta sin lanzar excepcion', () => {
  assert.equal(esFirmaValida(cuerpo, 'sha256=abc', SECRETO), false)
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../src/whatsapp/signature.js'`

- [ ] **Step 3: Implementar `src/whatsapp/signature.js`**

```js
import crypto from 'node:crypto'

/**
 * Valida la firma HMAC-SHA256 que Meta envía en el header X-Hub-Signature-256.
 * IMPORTANTE: rawBody debe ser el cuerpo CRUDO de la request, byte por byte.
 * Si Express ya lo parseó y se re-serializa con JSON.stringify, la firma no coincide.
 */
export function esFirmaValida(rawBody, header, appSecret) {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false

  const esperado =
    'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')

  const recibidoBuf = Buffer.from(header, 'utf8')
  const esperadoBuf = Buffer.from(esperado, 'utf8')

  // timingSafeEqual exige longitudes iguales; comparar antes evita que lance.
  if (recibidoBuf.length !== esperadoBuf.length) return false

  return crypto.timingSafeEqual(recibidoBuf, esperadoBuf)
}
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

Run: `npm test`
Expected: PASS — 6 tests nuevos

- [ ] **Step 5: Commit**

```bash
git add motoescuela-whatsapp/src/whatsapp/signature.js motoescuela-whatsapp/test/whatsapp/signature.test.js
git commit -m "feat: validacion HMAC de la firma del webhook de Meta"
```

---

### Task 3: Parseo del payload de Meta

**Files:**
- Create: `src/whatsapp/parse.js`, `test/fixtures/webhook-texto.json`, `test/fixtures/webhook-audio.json`, `test/fixtures/webhook-status.json`
- Test: `test/whatsapp/parse.test.js`

**Interfaces:**
- Consumes: nada
- Produces: `parsearWebhook(payload: object) => { mensajes: MensajeEntrante[], estados: object[] }`
  donde `MensajeEntrante = { waMessageId: string, from: string, profileName: string|null, type: string, text: string|null, timestamp: Date, raw: object }`

- [ ] **Step 1: Crear los fixtures con payloads reales de Meta**

`test/fixtures/webhook-texto.json`:

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "111111111111111",
      "changes": [
        {
          "field": "messages",
          "value": {
            "messaging_product": "whatsapp",
            "metadata": { "display_phone_number": "15550001111", "phone_number_id": "222222222222222" },
            "contacts": [{ "profile": { "name": "Maciel" }, "wa_id": "5492235042643" }],
            "messages": [
              {
                "from": "5492235042643",
                "id": "wamid.HBgNTQ5MjIzNTA0MjY0MxUCABIYIDNBMDAwMDAwMDAwMDAwMDAA",
                "timestamp": "1756400000",
                "type": "text",
                "text": { "body": "Hola, que precio tiene la clase?" }
              }
            ]
          }
        }
      ]
    }
  ]
}
```

`test/fixtures/webhook-audio.json`:

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "111111111111111",
      "changes": [
        {
          "field": "messages",
          "value": {
            "messaging_product": "whatsapp",
            "metadata": { "display_phone_number": "15550001111", "phone_number_id": "222222222222222" },
            "contacts": [{ "profile": { "name": "Maciel" }, "wa_id": "5492235042643" }],
            "messages": [
              {
                "from": "5492235042643",
                "id": "wamid.AUDIO0000000000000000000000000000",
                "timestamp": "1756400100",
                "type": "audio",
                "audio": { "id": "999888777", "mime_type": "audio/ogg; codecs=opus", "voice": true }
              }
            ]
          }
        }
      ]
    }
  ]
}
```

`test/fixtures/webhook-status.json`:

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "111111111111111",
      "changes": [
        {
          "field": "messages",
          "value": {
            "messaging_product": "whatsapp",
            "metadata": { "display_phone_number": "15550001111", "phone_number_id": "222222222222222" },
            "statuses": [
              {
                "id": "wamid.SALIENTE00000000000000000000000",
                "status": "delivered",
                "timestamp": "1756400200",
                "recipient_id": "5492235042643"
              }
            ]
          }
        }
      ]
    }
  ]
}
```

- [ ] **Step 2: Escribir el test que falla**

`test/whatsapp/parse.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parsearWebhook } from '../../src/whatsapp/parse.js'

const fixture = (n) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8'))

test('extrae un mensaje de texto con todos sus campos', () => {
  const { mensajes, estados } = parsearWebhook(fixture('webhook-texto'))
  assert.equal(mensajes.length, 1)
  assert.equal(estados.length, 0)

  const m = mensajes[0]
  assert.equal(m.waMessageId, 'wamid.HBgNTQ5MjIzNTA0MjY0MxUCABIYIDNBMDAwMDAwMDAwMDAwMDAA')
  assert.equal(m.from, '5492235042643')
  assert.equal(m.profileName, 'Maciel')
  assert.equal(m.type, 'text')
  assert.equal(m.text, 'Hola, que precio tiene la clase?')
  assert.ok(m.timestamp instanceof Date)
  assert.equal(m.timestamp.getTime(), 1756400000 * 1000)
})

test('un mensaje de audio se extrae con text nulo', () => {
  const { mensajes } = parsearWebhook(fixture('webhook-audio'))
  assert.equal(mensajes.length, 1)
  assert.equal(mensajes[0].type, 'audio')
  assert.equal(mensajes[0].text, null)
  assert.equal(mensajes[0].profileName, 'Maciel')
})

test('un webhook de estados no produce mensajes', () => {
  const { mensajes, estados } = parsearWebhook(fixture('webhook-status'))
  assert.equal(mensajes.length, 0)
  assert.equal(estados.length, 1)
  assert.equal(estados[0].status, 'delivered')
})

test('un payload vacio o malformado devuelve listas vacias sin lanzar', () => {
  for (const entrada of [{}, null, undefined, { entry: null }, { entry: [{}] }, { entry: [{ changes: [{}] }] }]) {
    const r = parsearWebhook(entrada)
    assert.deepEqual(r.mensajes, [])
    assert.deepEqual(r.estados, [])
  }
})

test('procesa multiples entries y changes en un mismo payload', () => {
  const uno = fixture('webhook-texto')
  const doble = { object: 'whatsapp_business_account', entry: [uno.entry[0], uno.entry[0]] }
  assert.equal(parsearWebhook(doble).mensajes.length, 2)
})

test('guarda el objeto original del mensaje en raw', () => {
  const { mensajes } = parsearWebhook(fixture('webhook-audio'))
  assert.equal(mensajes[0].raw.audio.id, '999888777')
})
```

- [ ] **Step 3: Correr el test para verificar que falla**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../src/whatsapp/parse.js'`

- [ ] **Step 4: Implementar `src/whatsapp/parse.js`**

```js
/**
 * Convierte el payload del webhook de Meta en objetos propios.
 * Función pura: no toca red, base ni configuración.
 * Nunca lanza — un payload inesperado devuelve listas vacías.
 */
export function parsearWebhook(payload) {
  const mensajes = []
  const estados = []

  const entries = Array.isArray(payload?.entry) ? payload.entry : []

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : []

    for (const change of changes) {
      const value = change?.value
      if (!value) continue

      // Índice wa_id → nombre de perfil, para adjuntarlo a cada mensaje.
      const nombrePorWaId = new Map()
      for (const c of value.contacts ?? []) {
        if (c?.wa_id) nombrePorWaId.set(c.wa_id, c?.profile?.name ?? null)
      }

      for (const msg of value.messages ?? []) {
        if (!msg?.id || !msg?.from) continue
        mensajes.push({
          waMessageId: msg.id,
          from: msg.from,
          profileName: nombrePorWaId.get(msg.from) ?? null,
          type: msg.type ?? 'unknown',
          text: msg.type === 'text' ? (msg.text?.body ?? null) : null,
          timestamp: new Date(Number(msg.timestamp ?? 0) * 1000),
          raw: msg,
        })
      }

      for (const st of value.statuses ?? []) {
        estados.push(st)
      }
    }
  }

  return { mensajes, estados }
}
```

- [ ] **Step 5: Correr los tests para verificar que pasan**

Run: `npm test`
Expected: PASS — 6 tests nuevos

- [ ] **Step 6: Commit**

```bash
git add motoescuela-whatsapp/src/whatsapp/parse.js motoescuela-whatsapp/test/whatsapp/parse.test.js motoescuela-whatsapp/test/fixtures/
git commit -m "feat: parseo del payload del webhook de Meta"
```

---

### Task 4: Base de datos — esquema y migraciones

**Files:**
- Create: `src/db/pool.js`, `src/db/migrations/001_init.sql`, `src/db/migrate.js`
- Test: `test/db/migrate.test.js`

**Interfaces:**
- Consumes: `config` de Task 1
- Produces:
  - `pool` (default export de `src/db/pool.js`): pool de `mysql2/promise`
  - `crearPool(opciones)` (named export de `src/db/pool.js`)
  - `migrar(opciones)` (named export de `src/db/migrate.js`): crea la base si no existe, aplica migraciones pendientes, devuelve `{ aplicadas: string[] }`

- [ ] **Step 1: Escribir la migración `src/db/migrations/001_init.sql`**

Las sentencias se separan por `;` al final de línea. El runner las ejecuta en orden.

```sql
CREATE TABLE IF NOT EXISTS contacts (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  wa_id         VARCHAR(32)  NOT NULL,
  profile_name  VARCHAR(255) NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_contacts_wa_id (wa_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conversations (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  contact_id       BIGINT UNSIGNED NOT NULL,
  status           ENUM('open','closed') NOT NULL DEFAULT 'open',
  last_message_at  TIMESTAMP NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_conversations_contact_status (contact_id, status),
  KEY ix_conversations_last_message_at (last_message_at),
  CONSTRAINT fk_conversations_contact FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS messages (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_id  BIGINT UNSIGNED NOT NULL,
  contact_id       BIGINT UNSIGNED NOT NULL,
  wa_message_id    VARCHAR(128) NULL,
  direction        ENUM('in','out') NOT NULL,
  type             VARCHAR(32)  NOT NULL DEFAULT 'text',
  text             TEXT NULL,
  raw_payload      JSON NULL,
  status           ENUM('received','processed','error') NOT NULL DEFAULT 'received',
  error_text       TEXT NULL,
  wa_timestamp     TIMESTAMP NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_messages_wa_message_id (wa_message_id),
  KEY ix_messages_conversation_created (conversation_id, created_at),
  CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT fk_messages_contact FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Notas de diseño:
- `uq_messages_wa_message_id` es el mecanismo de deduplicación. En MySQL un índice único permite múltiples `NULL`, así que los mensajes salientes que todavía no tienen ID de Meta no chocan entre sí.
- `utf8mb4` es obligatorio: los usuarios escriben emojis.

- [ ] **Step 2: Implementar `src/db/pool.js`**

```js
import mysql from 'mysql2/promise'
import config from '../config.js'

export function crearPool(opciones = {}) {
  return mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: 'Z',
    charset: 'utf8mb4_unicode_ci',
    ...opciones,
  })
}

export default crearPool()
```

- [ ] **Step 3: Escribir el test que falla**

`test/db/migrate.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import mysql from 'mysql2/promise'
import config from '../../src/config.js'
import { migrar } from '../../src/db/migrate.js'

// Protección: estos tests borran tablas. Nunca deben tocar la base de desarrollo.
test('el entorno de test apunta a la base de tests', () => {
  assert.ok(
    config.mysql.database.endsWith('_test'),
    `Los tests deben correr contra una base *_test, no contra "${config.mysql.database}". Usá: npm test`
  )
})

test('migrar crea las tres tablas y es idempotente', async () => {
  const primera = await migrar()
  assert.ok(primera.aplicadas.includes('001_init.sql'))

  const conn = await mysql.createConnection({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
  })

  const [tablas] = await conn.query('SHOW TABLES')
  const nombres = tablas.map((f) => Object.values(f)[0])
  for (const t of ['contacts', 'conversations', 'messages', 'schema_migrations']) {
    assert.ok(nombres.includes(t), `falta la tabla ${t}`)
  }

  // Correr de nuevo no debe fallar ni re-aplicar.
  const segunda = await migrar()
  assert.deepEqual(segunda.aplicadas, [])

  await conn.end()
})

test('wa_message_id tiene indice unico', async () => {
  await migrar()
  const conn = await mysql.createConnection({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
  })
  const [indices] = await conn.query('SHOW INDEX FROM messages WHERE Key_name = ?', [
    'uq_messages_wa_message_id',
  ])
  assert.equal(indices.length, 1)
  assert.equal(indices[0].Non_unique, 0)
  await conn.end()
})
```

- [ ] **Step 4: Correr el test para verificar que falla**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../src/db/migrate.js'`

- [ ] **Step 5: Implementar `src/db/migrate.js`**

```js
import mysql from 'mysql2/promise'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '../config.js'
import logger from '../logger.js'

const DIR_MIGRACIONES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

/**
 * Crea la base si no existe y aplica en orden las migraciones no aplicadas.
 * Registra cada archivo aplicado en schema_migrations para no repetirlo.
 */
export async function migrar() {
  // Conexión SIN base seleccionada, para poder crearla.
  const raiz = await mysql.createConnection({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    multipleStatements: false,
  })

  await raiz.query(
    `CREATE DATABASE IF NOT EXISTS \`${config.mysql.database}\` ` +
      `CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  )
  await raiz.end()

  const conn = await mysql.createConnection({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
  })

  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (filename)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  const [filas] = await conn.query('SELECT filename FROM schema_migrations')
  const yaAplicadas = new Set(filas.map((f) => f.filename))

  const archivos = readdirSync(DIR_MIGRACIONES).filter((f) => f.endsWith('.sql')).sort()
  const aplicadas = []

  for (const archivo of archivos) {
    if (yaAplicadas.has(archivo)) continue

    const sql = readFileSync(path.join(DIR_MIGRACIONES, archivo), 'utf8')
    const sentencias = sql
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    for (const sentencia of sentencias) {
      await conn.query(sentencia)
    }

    await conn.query('INSERT INTO schema_migrations (filename) VALUES (?)', [archivo])
    aplicadas.push(archivo)
    logger.info('migracion aplicada', { archivo })
  }

  await conn.end()
  return { aplicadas }
}

// Permite ejecutarlo como script: node src/db/migrate.js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrar()
    .then(({ aplicadas }) => {
      logger.info('migraciones completas', {
        base: config.mysql.database,
        aplicadas: aplicadas.length ? aplicadas : 'ninguna pendiente',
      })
      process.exit(0)
    })
    .catch((err) => {
      logger.error('fallo la migracion', { error: err.message })
      process.exit(1)
    })
}
```

- [ ] **Step 6: Crear ambas bases y correr los tests**

```bash
npm run db:setup        # crea la base "motoescuela"
npm run db:setup:test   # crea la base "motoescuela_test"
npm test
```

Expected: PASS — 3 tests nuevos.

Si aparece `ER_ACCESS_DENIED_ERROR`, revisar `MYSQL_USER` y `MYSQL_PASSWORD` en `.env` contra tu MySQL local.

- [ ] **Step 7: Commit**

```bash
git add motoescuela-whatsapp/src/db/ motoescuela-whatsapp/test/db/
git commit -m "feat: esquema MySQL y runner de migraciones"
```

---

### Task 5: Repositorios de contactos y conversaciones

**Files:**
- Create: `src/db/repos/contacts.js`, `src/db/repos/conversations.js`, `test/helpers/db.js`
- Test: `test/db/repos.test.js`

**Interfaces:**
- Consumes: `pool` de Task 4
- Produces:
  - `upsertContacto(waId: string, profileName: string|null, conn?) => Promise<{ id: number, wa_id: string, profile_name: string|null }>`
  - `obtenerOCrearConversacion(contactId: number, conn?) => Promise<{ id: number, contact_id: number, status: string }>`
  - `tocarConversacion(conversationId: number, conn?) => Promise<void>` — actualiza `last_message_at` a ahora
  - Helper de tests `limpiarBase()` (named export de `test/helpers/db.js`)

Todas las funciones aceptan una conexión opcional como último parámetro para poder participar de una transacción; si no se pasa, usan el pool.

- [ ] **Step 1: Escribir el helper de limpieza `test/helpers/db.js`**

```js
import pool from '../../src/db/pool.js'
import config from '../../src/config.js'
import { migrar } from '../../src/db/migrate.js'

/**
 * Vacía las tablas de datos entre tests.
 * Aborta si la base no termina en _test, para no borrar datos de desarrollo.
 */
export async function limpiarBase() {
  if (!config.mysql.database.endsWith('_test')) {
    throw new Error(`limpiarBase() se negó a correr contra "${config.mysql.database}"`)
  }
  await migrar()
  await pool.query('SET FOREIGN_KEY_CHECKS = 0')
  for (const t of ['messages', 'conversations', 'contacts']) {
    await pool.query(`TRUNCATE TABLE ${t}`)
  }
  await pool.query('SET FOREIGN_KEY_CHECKS = 1')
}

export async function cerrarBase() {
  await pool.end()
}
```

- [ ] **Step 2: Escribir el test que falla**

`test/db/repos.test.js`:

```js
import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { limpiarBase, cerrarBase } from '../helpers/db.js'
import { upsertContacto } from '../../src/db/repos/contacts.js'
import { obtenerOCrearConversacion, tocarConversacion } from '../../src/db/repos/conversations.js'
import pool from '../../src/db/pool.js'

before(async () => { await limpiarBase() })
beforeEach(async () => { await limpiarBase() })
after(async () => { await cerrarBase() })

test('upsertContacto crea el contacto la primera vez', async () => {
  const c = await upsertContacto('5492235042643', 'Maciel')
  assert.ok(c.id > 0)
  assert.equal(c.wa_id, '5492235042643')
  assert.equal(c.profile_name, 'Maciel')
})

test('upsertContacto no duplica y actualiza el nombre', async () => {
  const primero = await upsertContacto('5492235042643', 'Maciel')
  const segundo = await upsertContacto('5492235042643', 'Maciel F')

  assert.equal(primero.id, segundo.id)
  assert.equal(segundo.profile_name, 'Maciel F')

  const [filas] = await pool.query('SELECT COUNT(*) AS n FROM contacts')
  assert.equal(filas[0].n, 1)
})

test('upsertContacto con nombre null no borra el nombre existente', async () => {
  await upsertContacto('5492235042643', 'Maciel')
  const c = await upsertContacto('5492235042643', null)
  assert.equal(c.profile_name, 'Maciel')
})

test('obtenerOCrearConversacion devuelve la misma conversacion abierta', async () => {
  const c = await upsertContacto('5492235042643', 'Maciel')
  const a = await obtenerOCrearConversacion(c.id)
  const b = await obtenerOCrearConversacion(c.id)
  assert.equal(a.id, b.id)
  assert.equal(a.status, 'open')

  const [filas] = await pool.query('SELECT COUNT(*) AS n FROM conversations')
  assert.equal(filas[0].n, 1)
})

test('contactos distintos tienen conversaciones distintas', async () => {
  const c1 = await upsertContacto('5492235042643', 'Maciel')
  const c2 = await upsertContacto('5491100000000', 'Otro')
  const a = await obtenerOCrearConversacion(c1.id)
  const b = await obtenerOCrearConversacion(c2.id)
  assert.notEqual(a.id, b.id)
})

test('tocarConversacion actualiza last_message_at', async () => {
  const c = await upsertContacto('5492235042643', 'Maciel')
  const conv = await obtenerOCrearConversacion(c.id)

  const [antes] = await pool.query('SELECT last_message_at FROM conversations WHERE id = ?', [conv.id])
  assert.equal(antes[0].last_message_at, null)

  await tocarConversacion(conv.id)

  const [despues] = await pool.query('SELECT last_message_at FROM conversations WHERE id = ?', [conv.id])
  assert.ok(despues[0].last_message_at instanceof Date)
})
```

- [ ] **Step 3: Correr el test para verificar que falla**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../src/db/repos/contacts.js'`

- [ ] **Step 4: Implementar `src/db/repos/contacts.js`**

```js
import pool from '../pool.js'

/**
 * Crea el contacto o actualiza su nombre de perfil.
 * COALESCE evita que un webhook sin nombre borre uno que ya teníamos.
 */
export async function upsertContacto(waId, profileName = null, conn = pool) {
  await conn.query(
    `INSERT INTO contacts (wa_id, profile_name)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE
       profile_name = COALESCE(VALUES(profile_name), profile_name),
       updated_at = CURRENT_TIMESTAMP`,
    [waId, profileName]
  )

  const [filas] = await conn.query(
    'SELECT id, wa_id, profile_name FROM contacts WHERE wa_id = ?',
    [waId]
  )
  return filas[0]
}

export async function buscarContactoPorWaId(waId, conn = pool) {
  const [filas] = await conn.query(
    'SELECT id, wa_id, profile_name FROM contacts WHERE wa_id = ?',
    [waId]
  )
  return filas[0] ?? null
}
```

- [ ] **Step 5: Implementar `src/db/repos/conversations.js`**

```js
import pool from '../pool.js'

/** Devuelve la conversación abierta del contacto, creándola si no existe. */
export async function obtenerOCrearConversacion(contactId, conn = pool) {
  const [existentes] = await conn.query(
    `SELECT id, contact_id, status FROM conversations
     WHERE contact_id = ? AND status = 'open'
     ORDER BY id DESC LIMIT 1`,
    [contactId]
  )
  if (existentes.length > 0) return existentes[0]

  const [res] = await conn.query(
    `INSERT INTO conversations (contact_id, status) VALUES (?, 'open')`,
    [contactId]
  )
  return { id: res.insertId, contact_id: contactId, status: 'open' }
}

export async function tocarConversacion(conversationId, conn = pool) {
  await conn.query(
    'UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?',
    [conversationId]
  )
}
```

- [ ] **Step 6: Correr los tests para verificar que pasan**

Run: `npm test`
Expected: PASS — 6 tests nuevos

- [ ] **Step 7: Commit**

```bash
git add motoescuela-whatsapp/src/db/repos/ motoescuela-whatsapp/test/db/repos.test.js motoescuela-whatsapp/test/helpers/
git commit -m "feat: repositorios de contactos y conversaciones"
```

---

### Task 6: Repositorio de mensajes y deduplicación

Esta es la tarea que hace que un reintento de Meta no genere una segunda respuesta al usuario.

**Files:**
- Create: `src/db/repos/messages.js`
- Test: `test/db/messages.test.js`

**Interfaces:**
- Consumes: repos de Task 5
- Produces:
  - `insertarEntrante({ conversationId, contactId, waMessageId, type, text, raw, waTimestamp }) => Promise<{ id: number }|null>` — devuelve `null` si el `waMessageId` ya existía (duplicado)
  - `insertarSaliente({ conversationId, contactId, waMessageId, text }) => Promise<{ id: number }>`
  - `obtenerHistorial(conversationId: number, limite: number) => Promise<{ direction: 'in'|'out', text: string }[]>` — orden cronológico ascendente, solo mensajes con texto
  - `marcarProcesado(messageId: number) => Promise<void>`
  - `marcarError(messageId: number, errorText: string) => Promise<void>`

- [ ] **Step 1: Escribir el test que falla**

`test/db/messages.test.js`:

```js
import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { limpiarBase, cerrarBase } from '../helpers/db.js'
import { upsertContacto } from '../../src/db/repos/contacts.js'
import { obtenerOCrearConversacion } from '../../src/db/repos/conversations.js'
import {
  insertarEntrante,
  insertarSaliente,
  obtenerHistorial,
  marcarProcesado,
  marcarError,
} from '../../src/db/repos/messages.js'
import pool from '../../src/db/pool.js'

let contacto
let conversacion

beforeEach(async () => {
  await limpiarBase()
  contacto = await upsertContacto('5492235042643', 'Maciel')
  conversacion = await obtenerOCrearConversacion(contacto.id)
})

after(async () => { await cerrarBase() })

const entrante = (waMessageId, text = 'hola') => ({
  conversationId: conversacion.id,
  contactId: contacto.id,
  waMessageId,
  type: 'text',
  text,
  raw: { id: waMessageId, type: 'text' },
  waTimestamp: new Date('2026-08-28T12:00:00Z'),
})

test('insertarEntrante guarda el mensaje y devuelve su id', async () => {
  const r = await insertarEntrante(entrante('wamid.AAA'))
  assert.ok(r.id > 0)

  const [filas] = await pool.query('SELECT * FROM messages WHERE id = ?', [r.id])
  assert.equal(filas[0].direction, 'in')
  assert.equal(filas[0].status, 'received')
  assert.equal(filas[0].text, 'hola')
})

test('DEDUPLICACION: el mismo wa_message_id devuelve null y no crea fila', async () => {
  const primero = await insertarEntrante(entrante('wamid.REPETIDO'))
  assert.ok(primero.id > 0)

  const segundo = await insertarEntrante(entrante('wamid.REPETIDO'))
  assert.equal(segundo, null, 'un duplicado debe devolver null')

  const [filas] = await pool.query('SELECT COUNT(*) AS n FROM messages')
  assert.equal(filas[0].n, 1)
})

test('varios mensajes salientes sin wa_message_id conviven (NULL no choca con el indice unico)', async () => {
  await insertarSaliente({ conversationId: conversacion.id, contactId: contacto.id, waMessageId: null, text: 'uno' })
  await insertarSaliente({ conversationId: conversacion.id, contactId: contacto.id, waMessageId: null, text: 'dos' })

  const [filas] = await pool.query("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out'")
  assert.equal(filas[0].n, 2)
})

test('obtenerHistorial devuelve orden cronologico ascendente', async () => {
  await insertarEntrante(entrante('wamid.1', 'primera'))
  await insertarSaliente({ conversationId: conversacion.id, contactId: contacto.id, waMessageId: 'wamid.o1', text: 'respuesta' })
  await insertarEntrante(entrante('wamid.2', 'segunda'))

  const h = await obtenerHistorial(conversacion.id, 10)
  assert.deepEqual(h.map((m) => m.text), ['primera', 'respuesta', 'segunda'])
  assert.deepEqual(h.map((m) => m.direction), ['in', 'out', 'in'])
})

test('obtenerHistorial respeta el limite quedandose con los MAS RECIENTES', async () => {
  for (let i = 1; i <= 5; i++) await insertarEntrante(entrante(`wamid.${i}`, `msg${i}`))

  const h = await obtenerHistorial(conversacion.id, 3)
  assert.equal(h.length, 3)
  assert.deepEqual(h.map((m) => m.text), ['msg3', 'msg4', 'msg5'])
})

test('obtenerHistorial excluye mensajes sin texto (audio, imagenes)', async () => {
  await insertarEntrante(entrante('wamid.txt', 'con texto'))
  await insertarEntrante({ ...entrante('wamid.audio'), type: 'audio', text: null })

  const h = await obtenerHistorial(conversacion.id, 10)
  assert.equal(h.length, 1)
  assert.equal(h[0].text, 'con texto')
})

test('marcarProcesado y marcarError cambian el estado', async () => {
  const a = await insertarEntrante(entrante('wamid.ok'))
  await marcarProcesado(a.id)
  const [f1] = await pool.query('SELECT status FROM messages WHERE id = ?', [a.id])
  assert.equal(f1[0].status, 'processed')

  const b = await insertarEntrante(entrante('wamid.mal'))
  await marcarError(b.id, 'OpenAI timeout')
  const [f2] = await pool.query('SELECT status, error_text FROM messages WHERE id = ?', [b.id])
  assert.equal(f2[0].status, 'error')
  assert.equal(f2[0].error_text, 'OpenAI timeout')
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../src/db/repos/messages.js'`

- [ ] **Step 3: Implementar `src/db/repos/messages.js`**

```js
import pool from '../pool.js'

/**
 * Inserta un mensaje entrante.
 * Devuelve null si el wa_message_id ya existe: eso significa que Meta reintentó
 * el webhook y el mensaje ya fue (o está siendo) procesado. La deduplicación se
 * apoya en el índice único uq_messages_wa_message_id, no en lógica de aplicación.
 */
export async function insertarEntrante(
  { conversationId, contactId, waMessageId, type, text, raw, waTimestamp },
  conn = pool
) {
  try {
    const [res] = await conn.query(
      `INSERT INTO messages
         (conversation_id, contact_id, wa_message_id, direction, type, text, raw_payload, status, wa_timestamp)
       VALUES (?, ?, ?, 'in', ?, ?, ?, 'received', ?)`,
      [
        conversationId,
        contactId,
        waMessageId,
        type,
        text,
        raw ? JSON.stringify(raw) : null,
        waTimestamp ?? null,
      ]
    )
    return { id: res.insertId }
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return null
    throw err
  }
}

export async function insertarSaliente(
  { conversationId, contactId, waMessageId = null, text },
  conn = pool
) {
  const [res] = await conn.query(
    `INSERT INTO messages
       (conversation_id, contact_id, wa_message_id, direction, type, text, status)
     VALUES (?, ?, ?, 'out', 'text', ?, 'processed')`,
    [conversationId, contactId, waMessageId, text]
  )
  return { id: res.insertId }
}

/**
 * Últimos N mensajes con texto, devueltos en orden cronológico ascendente.
 * El ORDER BY DESC + LIMIT toma los más recientes; el reverse() los deja
 * en el orden que espera el modelo.
 */
export async function obtenerHistorial(conversationId, limite = 10, conn = pool) {
  const [filas] = await conn.query(
    `SELECT direction, text FROM messages
     WHERE conversation_id = ? AND text IS NOT NULL AND text <> ''
     ORDER BY id DESC
     LIMIT ?`,
    [conversationId, Number(limite)]
  )
  return filas.reverse()
}

export async function marcarProcesado(messageId, conn = pool) {
  await conn.query(`UPDATE messages SET status = 'processed' WHERE id = ?`, [messageId])
}

export async function marcarError(messageId, errorText, conn = pool) {
  await conn.query(`UPDATE messages SET status = 'error', error_text = ? WHERE id = ?`, [
    String(errorText).slice(0, 2000),
    messageId,
  ])
}
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

Run: `npm test`
Expected: PASS — 7 tests nuevos. El test "DEDUPLICACION" es el criterio de aceptación 4 del spec.

- [ ] **Step 5: Commit**

```bash
git add motoescuela-whatsapp/src/db/repos/messages.js motoescuela-whatsapp/test/db/messages.test.js
git commit -m "feat: repositorio de mensajes con deduplicacion por indice unico"
```

---

### Task 7: Cliente de la Graph API de WhatsApp

**Files:**
- Create: `src/whatsapp/client.js`
- Test: `test/whatsapp/client.test.js`

**Interfaces:**
- Consumes: `config` de Task 1, `logger` de Task 1
- Produces:
  - `crearClienteWhatsApp({ token, phoneNumberId, graphVersion, fetchImpl, reintentos, esperaBase }) => { enviarTexto, marcarLeido }`
  - `enviarTexto(to: string, texto: string) => Promise<{ waMessageId: string|null }>`
  - `marcarLeido(waMessageId: string) => Promise<void>` — nunca lanza; loguea y sigue
  - Default export: cliente ya construido con la configuración del entorno

`fetchImpl` existe para inyectar un doble en los tests. En producción usa el `fetch` global de Node 22.

- [ ] **Step 1: Escribir el test que falla**

`test/whatsapp/client.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { crearClienteWhatsApp } from '../../src/whatsapp/client.js'

const OPCIONES = {
  token: 'token_de_prueba',
  phoneNumberId: '222222222222222',
  graphVersion: 'v21.0',
  esperaBase: 0, // sin esperas reales en los tests
}

function fetchFalso(respuestas) {
  const llamadas = []
  const impl = async (url, opciones) => {
    llamadas.push({ url, opciones, body: JSON.parse(opciones.body) })
    const r = respuestas.shift() ?? { ok: true, status: 200, json: { messages: [{ id: 'wamid.OUT' }] } }
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.json,
      text: async () => JSON.stringify(r.json),
    }
  }
  impl.llamadas = llamadas
  return impl
}

test('enviarTexto llama al endpoint correcto con el cuerpo correcto', async () => {
  const fetchImpl = fetchFalso([])
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })

  const r = await cliente.enviarTexto('5492235042643', 'Hola!')

  assert.equal(fetchImpl.llamadas.length, 1)
  const { url, opciones, body } = fetchImpl.llamadas[0]
  assert.equal(url, 'https://graph.facebook.com/v21.0/222222222222222/messages')
  assert.equal(opciones.method, 'POST')
  assert.equal(opciones.headers.Authorization, 'Bearer token_de_prueba')
  assert.equal(body.messaging_product, 'whatsapp')
  assert.equal(body.to, '5492235042643')
  assert.equal(body.type, 'text')
  assert.equal(body.text.body, 'Hola!')
  assert.equal(r.waMessageId, 'wamid.OUT')
})

test('enviarTexto reintenta ante un error 500 y termina bien', async () => {
  const fetchImpl = fetchFalso([
    { ok: false, status: 500, json: { error: { message: 'server error' } } },
    { ok: true, status: 200, json: { messages: [{ id: 'wamid.SEGUNDO' }] } },
  ])
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })

  const r = await cliente.enviarTexto('5492235042643', 'Hola!')
  assert.equal(fetchImpl.llamadas.length, 2)
  assert.equal(r.waMessageId, 'wamid.SEGUNDO')
})

test('enviarTexto lanza tras agotar los reintentos', async () => {
  const fetchImpl = fetchFalso([
    { ok: false, status: 500, json: { error: { message: 'a' } } },
    { ok: false, status: 500, json: { error: { message: 'b' } } },
    { ok: false, status: 500, json: { error: { message: 'c' } } },
  ])
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl, reintentos: 2 })

  await assert.rejects(() => cliente.enviarTexto('549223', 'Hola'), /Graph API/)
  assert.equal(fetchImpl.llamadas.length, 3) // 1 intento + 2 reintentos
})

test('un error 400 NO se reintenta (es culpa nuestra, no transitorio)', async () => {
  const fetchImpl = fetchFalso([
    { ok: false, status: 400, json: { error: { message: 'numero invalido' } } },
  ])
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })

  await assert.rejects(() => cliente.enviarTexto('malo', 'Hola'), /numero invalido/)
  assert.equal(fetchImpl.llamadas.length, 1)
})

test('marcarLeido envia el cuerpo correcto y nunca lanza si falla', async () => {
  const fetchImpl = fetchFalso([{ ok: true, status: 200, json: {} }])
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })

  await cliente.marcarLeido('wamid.ABC')
  assert.equal(fetchImpl.llamadas[0].body.status, 'read')
  assert.equal(fetchImpl.llamadas[0].body.message_id, 'wamid.ABC')

  const fallando = fetchFalso([{ ok: false, status: 500, json: { error: { message: 'x' } } }])
  const cliente2 = crearClienteWhatsApp({ ...OPCIONES, fetchImpl: fallando, reintentos: 0 })
  await cliente2.marcarLeido('wamid.ABC') // no debe lanzar
})

test('enviarTexto corta el texto a 4096 caracteres (limite de WhatsApp)', async () => {
  const fetchImpl = fetchFalso([])
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })

  await cliente.enviarTexto('549223', 'x'.repeat(5000))
  assert.equal(fetchImpl.llamadas[0].body.text.body.length, 4096)
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../src/whatsapp/client.js'`

- [ ] **Step 3: Implementar `src/whatsapp/client.js`**

```js
import config from '../config.js'
import logger from '../logger.js'

const LIMITE_TEXTO_WHATSAPP = 4096

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

export function crearClienteWhatsApp({
  token,
  phoneNumberId,
  graphVersion = 'v21.0',
  fetchImpl = fetch,
  reintentos = 2,
  esperaBase = 500,
} = {}) {
  const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`

  async function postear(cuerpo) {
    let ultimoError

    for (let intento = 0; intento <= reintentos; intento++) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(cuerpo),
      })

      if (res.ok) return res.json()

      const datos = await res.json().catch(() => ({}))
      const detalle = datos?.error?.message ?? `HTTP ${res.status}`

      // 4xx = problema de nuestra request. Reintentar no lo arregla.
      // Excepción: 429 (rate limit) sí es transitorio.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new Error(`Graph API rechazó la request: ${detalle}`)
      }

      ultimoError = new Error(`Graph API falló: ${detalle}`)
      logger.warn('reintentando llamada a Graph API', {
        intento: intento + 1,
        status: res.status,
        detalle,
      })

      if (intento < reintentos) await dormir(esperaBase * Math.pow(2, intento))
    }

    throw ultimoError
  }

  return {
    async enviarTexto(to, texto) {
      const cuerpo = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body: String(texto).slice(0, LIMITE_TEXTO_WHATSAPP) },
      }
      const datos = await postear(cuerpo)
      return { waMessageId: datos?.messages?.[0]?.id ?? null }
    },

    /** Marca el mensaje como leído (doble tilde azul). Nunca lanza: es cosmético. */
    async marcarLeido(waMessageId) {
      try {
        await postear({ messaging_product: 'whatsapp', status: 'read', message_id: waMessageId })
      } catch (err) {
        logger.warn('no se pudo marcar como leido', { waMessageId, error: err.message })
      }
    },
  }
}

export default crearClienteWhatsApp({
  token: config.whatsapp.token,
  phoneNumberId: config.whatsapp.phoneNumberId,
  graphVersion: config.whatsapp.graphVersion,
})
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

Run: `npm test`
Expected: PASS — 6 tests nuevos

- [ ] **Step 5: Commit**

```bash
git add motoescuela-whatsapp/src/whatsapp/client.js motoescuela-whatsapp/test/whatsapp/client.test.js
git commit -m "feat: cliente de la Graph API con reintentos y backoff"
```

---

### Task 8: Módulo de IA con Responses API

**Files:**
- Create: `src/ia/prompt.js`, `src/ia/openai.js`, `src/ia/index.js`
- Test: `test/ia/prompt.test.js`, `test/ia/openai.test.js`

**Interfaces:**
- Consumes: `config` de Task 1; el formato de historial de `obtenerHistorial` (Task 6)
- Produces:
  - `INSTRUCCIONES: string` (named export de `src/ia/prompt.js`)
  - `construirInput(historial: {direction,text}[], pregunta: string) => { role: 'user'|'assistant', content: string }[]`
  - `limpiarCitas(texto: string) => string` — quita los marcadores 【4:0†source】 que inserta `file_search`
  - `crearIAOpenAI({ apiKey, model, vectorStoreId, clienteOpenAI }) => { responder }`
  - `responder(pregunta: string, historial: {direction,text}[]) => Promise<string>` (named export de `src/ia/index.js`)

`src/ia/index.js` es la interfaz estable: `handleMessage` solo conoce este archivo. Cambiar de proveedor toca `openai.js` y una línea de `index.js`.

- [ ] **Step 1: Escribir el test de prompt (falla)**

`test/ia/prompt.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { construirInput, limpiarCitas, INSTRUCCIONES } from '../../src/ia/prompt.js'

test('construirInput mapea direction a los roles del modelo', () => {
  const historial = [
    { direction: 'in', text: 'hola' },
    { direction: 'out', text: 'Hola! En que te ayudo?' },
  ]
  const input = construirInput(historial, 'cuanto sale la clase?')

  assert.deepEqual(input, [
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: 'Hola! En que te ayudo?' },
    { role: 'user', content: 'cuanto sale la clase?' },
  ])
})

test('construirInput funciona con historial vacio', () => {
  const input = construirInput([], 'primera pregunta')
  assert.deepEqual(input, [{ role: 'user', content: 'primera pregunta' }])
})

test('construirInput ignora entradas sin texto', () => {
  const input = construirInput(
    [{ direction: 'in', text: null }, { direction: 'in', text: '  ' }, { direction: 'in', text: 'valido' }],
    'pregunta'
  )
  assert.equal(input.length, 2)
  assert.equal(input[0].content, 'valido')
})

test('limpiarCitas quita los marcadores de file_search', () => {
  const sucio = 'La clase sale $10.000【4:0†source】 y dura 40 minutos【12:3†source】.'
  assert.equal(limpiarCitas(sucio), 'La clase sale $10.000 y dura 40 minutos.')
})

test('limpiarCitas tolera null y texto sin citas', () => {
  assert.equal(limpiarCitas(null), '')
  assert.equal(limpiarCitas('sin citas'), 'sin citas')
})

test('las instrucciones nombran a MotoEscuela y piden responder en espanol', () => {
  assert.match(INSTRUCCIONES, /MotoEscuela/i)
  assert.match(INSTRUCCIONES, /español/i)
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../src/ia/prompt.js'`

- [ ] **Step 3: Implementar `src/ia/prompt.js`**

Las instrucciones se adaptan del `basePrompt` de `base-baileys-memory/script/assistant.js`, quitando las menciones a "File Search" como herramienta (que eran un artefacto de la Assistants API).

```js
export const INSTRUCCIONES = `
Sos el asistente virtual de **MotoEscuela MdP**, una academia de conducción de motos en Mar del Plata.

Tu función es responder consultas sobre clases de manejo, requisitos, alquiler de motos para rendir
examen, precios, horarios, condiciones por lluvia y ubicación.

Tenés acceso a un archivo con la información oficial de la escuela. Usalo SIEMPRE como fuente
principal: buscá ahí antes de responder, incluso si la pregunta no parece directamente relacionada.

Estilo:
- Respondé siempre en español rioplatense, con tono amable y breve, como en WhatsApp.
- Nunca uses formato Markdown: WhatsApp no lo renderiza. Para negrita usá *un asterisco*.
- Si la pregunta es confusa, interpretá la intención y ayudá con lo que haya en el archivo.
- Si el usuario pregunta algo fuera de tema (autos, política, etc.), respondé:
  "Solo puedo ayudarte con consultas sobre las clases y alquileres de MotoEscuela MdP 😊"
- Si no encontrás nada relevante en el archivo, respondé:
  "Esa información no la tengo disponible, pero puedo ayudarte a consultar con los expertos de MotoEscuela MdP 😊"

No inventes precios, horarios ni condiciones que no estén en el archivo.
`.trim()

/** Convierte el historial de la base al formato de input de la Responses API. */
export function construirInput(historial, pregunta) {
  const input = []

  for (const m of historial ?? []) {
    if (!m?.text || String(m.text).trim() === '') continue
    input.push({
      role: m.direction === 'out' ? 'assistant' : 'user',
      content: m.text,
    })
  }

  input.push({ role: 'user', content: pregunta })
  return input
}

/** file_search inserta marcadores tipo 【4:0†source】 en la respuesta. Los sacamos. */
export function limpiarCitas(texto) {
  if (!texto) return ''
  return texto.replace(/【[^】]*】/g, '').replace(/[ \t]{2,}/g, ' ').trim()
}
```

⚠️ Detalle importante: si el historial ya termina con el mensaje actual del usuario (porque `handleMessage` lo persiste antes de leer el historial), la pregunta aparecería duplicada. Task 9 lo resuelve leyendo el historial **excluyendo** el mensaje actual. Ver la nota en esa tarea.

- [ ] **Step 4: Escribir el test de `openai.js` (falla)**

`test/ia/openai.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { crearIAOpenAI } from '../../src/ia/openai.js'

function clienteFalso(respuesta, capturar = {}) {
  return {
    responses: {
      create: async (params) => {
        capturar.params = params
        if (respuesta instanceof Error) throw respuesta
        return respuesta
      },
    },
  }
}

const OPCIONES = { model: 'gpt-4o-mini', vectorStoreId: 'vs_test' }

test('responder devuelve el texto limpio de citas', async () => {
  const ia = crearIAOpenAI({
    ...OPCIONES,
    clienteOpenAI: clienteFalso({ output_text: 'La clase sale $10.000【4:0†source】.' }),
  })

  const r = await ia.responder('cuanto sale?', [])
  assert.equal(r, 'La clase sale $10.000.')
})

test('responder configura file_search con el vector store', async () => {
  const capturar = {}
  const ia = crearIAOpenAI({
    ...OPCIONES,
    clienteOpenAI: clienteFalso({ output_text: 'ok' }, capturar),
  })

  await ia.responder('hola', [{ direction: 'in', text: 'previo' }])

  assert.equal(capturar.params.model, 'gpt-4o-mini')
  assert.deepEqual(capturar.params.tools, [
    { type: 'file_search', vector_store_ids: ['vs_test'] },
  ])
  assert.match(capturar.params.instructions, /MotoEscuela/)
  assert.deepEqual(capturar.params.input, [
    { role: 'user', content: 'previo' },
    { role: 'user', content: 'hola' },
  ])
})

test('responder extrae el texto de output[] si no viene output_text', async () => {
  const ia = crearIAOpenAI({
    ...OPCIONES,
    clienteOpenAI: clienteFalso({
      output: [
        { type: 'file_search_call', status: 'completed' },
        { type: 'message', content: [{ type: 'output_text', text: 'respuesta anidada' }] },
      ],
    }),
  })

  assert.equal(await ia.responder('hola', []), 'respuesta anidada')
})

test('responder propaga el error si OpenAI falla', async () => {
  const ia = crearIAOpenAI({ ...OPCIONES, clienteOpenAI: clienteFalso(new Error('rate limit')) })
  await assert.rejects(() => ia.responder('hola', []), /rate limit/)
})

test('responder lanza si la respuesta viene vacia', async () => {
  const ia = crearIAOpenAI({ ...OPCIONES, clienteOpenAI: clienteFalso({ output: [] }) })
  await assert.rejects(() => ia.responder('hola', []), /vacía/)
})
```

- [ ] **Step 5: Correr el test para verificar que falla**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../src/ia/openai.js'`

- [ ] **Step 6: Implementar `src/ia/openai.js`**

```js
import OpenAI from 'openai'
import config from '../config.js'
import { INSTRUCCIONES, construirInput, limpiarCitas } from './prompt.js'

/** Extrae el texto de una respuesta de la Responses API. */
function extraerTexto(respuesta) {
  if (typeof respuesta?.output_text === 'string' && respuesta.output_text.trim() !== '') {
    return respuesta.output_text
  }

  for (const item of respuesta?.output ?? []) {
    if (item?.type !== 'message') continue
    for (const parte of item.content ?? []) {
      if (parte?.type === 'output_text' && parte.text) return parte.text
    }
  }

  return null
}

export function crearIAOpenAI({
  apiKey,
  model = 'gpt-4o-mini',
  vectorStoreId,
  clienteOpenAI,
  timeoutMs = 30000,
} = {}) {
  const cliente = clienteOpenAI ?? new OpenAI({ apiKey, timeout: timeoutMs })

  return {
    async responder(pregunta, historial = []) {
      const respuesta = await cliente.responses.create({
        model,
        instructions: INSTRUCCIONES,
        input: construirInput(historial, pregunta),
        tools: [{ type: 'file_search', vector_store_ids: [vectorStoreId] }],
      })

      const texto = extraerTexto(respuesta)
      if (!texto) throw new Error('OpenAI devolvió una respuesta vacía')

      return limpiarCitas(texto)
    },
  }
}

export default crearIAOpenAI({
  apiKey: config.openai.apiKey,
  model: config.openai.model,
  vectorStoreId: config.openai.vectorStoreId,
})
```

- [ ] **Step 7: Implementar `src/ia/index.js`**

```js
/**
 * Interfaz estable del módulo de IA.
 * El resto de la aplicación importa SOLO desde acá; nadie más conoce a OpenAI.
 * Cambiar de proveedor (o agregar tool calling en la Fase 2) se hace acá adentro.
 */
import ia from './openai.js'

export const responder = (pregunta, historial) => ia.responder(pregunta, historial)

export default { responder }
```

- [ ] **Step 8: Correr los tests para verificar que pasan**

Run: `npm test`
Expected: PASS — 11 tests nuevos (6 de prompt + 5 de openai)

- [ ] **Step 9: Verificación manual contra OpenAI real (una vez)**

Confirma que el vector store responde desde este código, no solo desde curl.

```bash
node --input-type=module -e "
import ia from './src/ia/openai.js'
const r = await ia.responder('Que pasa si llueve el dia de mi clase?', [])
console.log('RESPUESTA:', r)
"
```

Expected: una respuesta en español sobre la suspensión por lluvia, sin marcadores 【...】.

- [ ] **Step 10: Commit**

```bash
git add motoescuela-whatsapp/src/ia/ motoescuela-whatsapp/test/ia/
git commit -m "feat: modulo de IA con Responses API y file_search"
```

---

### Task 9: Orquestador

Separa el trabajo en dos mitades: `ingest()` es rápido y ocurre antes del `200 OK`; `procesar()` es lento y ocurre después.

**Files:**
- Create: `src/core/handleMessage.js`
- Test: `test/core/handleMessage.test.js`

**Interfaces:**
- Consumes: repos (Tasks 5, 6), `responder` (Task 8), cliente de WhatsApp (Task 7), `config` (Task 1)
- Produces:
  - `ingest(mensaje: MensajeEntrante) => Promise<{ duplicado: boolean, messageId?, conversationId?, contactId?, mensaje? }>`
  - `procesar(contexto) => Promise<void>` — nunca lanza; captura todo y marca el mensaje en error
  - `crearOrquestador({ ia, clienteWhatsApp, historyLimit })` — para inyectar dobles en tests

**Regla clave:** `ingest()` persiste el mensaje entrante y **devuelve el `messageId`**; `procesar()` lee el historial **excluyendo ese id**, así la pregunta actual no aparece dos veces en el input del modelo.

- [ ] **Step 1: Extender `obtenerHistorial` para poder excluir un mensaje**

Modificar `src/db/repos/messages.js` (creado en Task 6). Reemplazar la función `obtenerHistorial` por:

```js
export async function obtenerHistorial(conversationId, limite = 10, excluirId = null, conn = pool) {
  const [filas] = await conn.query(
    `SELECT direction, text FROM messages
     WHERE conversation_id = ? AND text IS NOT NULL AND text <> ''
       AND (? IS NULL OR id <> ?)
     ORDER BY id DESC
     LIMIT ?`,
    [conversationId, excluirId, excluirId, Number(limite)]
  )
  return filas.reverse()
}
```

Los tests existentes de Task 6 la llaman con dos argumentos y siguen pasando, porque `excluirId` es `null` por defecto.

- [ ] **Step 2: Escribir el test que falla**

`test/core/handleMessage.test.js`:

```js
import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { limpiarBase, cerrarBase } from '../helpers/db.js'
import { crearOrquestador } from '../../src/core/handleMessage.js'
import pool from '../../src/db/pool.js'

const mensajeBase = (waMessageId, { type = 'text', text = 'hola' } = {}) => ({
  waMessageId,
  from: '5492235042643',
  profileName: 'Maciel',
  type,
  text,
  timestamp: new Date('2026-08-28T12:00:00Z'),
  raw: { id: waMessageId, type },
})

function dobles({ respuestaIA = 'Respuesta del bot', errorIA = null } = {}) {
  const enviados = []
  const leidos = []
  return {
    enviados,
    leidos,
    ia: {
      responder: async (pregunta, historial) => {
        if (errorIA) throw errorIA
        enviados.ultimoHistorial = historial
        enviados.ultimaPregunta = pregunta
        return respuestaIA
      },
    },
    clienteWhatsApp: {
      enviarTexto: async (to, texto) => {
        enviados.push({ to, texto })
        return { waMessageId: 'wamid.OUT' + enviados.length }
      },
      marcarLeido: async (id) => { leidos.push(id) },
    },
  }
}

beforeEach(async () => { await limpiarBase() })
after(async () => { await cerrarBase() })

test('ingest crea contacto, conversacion y mensaje', async () => {
  const d = dobles()
  const orq = crearOrquestador(d)

  const r = await orq.ingest(mensajeBase('wamid.A'))

  assert.equal(r.duplicado, false)
  assert.ok(r.messageId > 0)
  assert.ok(r.conversationId > 0)

  const [c] = await pool.query('SELECT COUNT(*) AS n FROM contacts')
  const [v] = await pool.query('SELECT COUNT(*) AS n FROM conversations')
  const [m] = await pool.query('SELECT COUNT(*) AS n FROM messages')
  assert.equal(c[0].n, 1)
  assert.equal(v[0].n, 1)
  assert.equal(m[0].n, 1)
})

test('ingest del mismo wa_message_id devuelve duplicado y no crea nada nuevo', async () => {
  const d = dobles()
  const orq = crearOrquestador(d)

  await orq.ingest(mensajeBase('wamid.REPE'))
  const segundo = await orq.ingest(mensajeBase('wamid.REPE'))

  assert.equal(segundo.duplicado, true)
  const [m] = await pool.query('SELECT COUNT(*) AS n FROM messages')
  assert.equal(m[0].n, 1)
})

test('procesar responde al usuario y guarda el saliente', async () => {
  const d = dobles({ respuestaIA: 'Las clases salen $10.000' })
  const orq = crearOrquestador(d)

  const ctx = await orq.ingest(mensajeBase('wamid.A', { text: 'cuanto sale?' }))
  await orq.procesar(ctx)

  assert.equal(d.enviados.length, 1)
  assert.equal(d.enviados[0].to, '5492235042643')
  assert.equal(d.enviados[0].texto, 'Las clases salen $10.000')
  assert.deepEqual(d.leidos, ['wamid.A'])

  const [salientes] = await pool.query("SELECT text, wa_message_id FROM messages WHERE direction = 'out'")
  assert.equal(salientes.length, 1)
  assert.equal(salientes[0].text, 'Las clases salen $10.000')
  assert.equal(salientes[0].wa_message_id, 'wamid.OUT1')

  const [entrante] = await pool.query('SELECT status FROM messages WHERE id = ?', [ctx.messageId])
  assert.equal(entrante[0].status, 'processed')
})

test('el historial que recibe la IA NO incluye la pregunta actual', async () => {
  const d = dobles()
  const orq = crearOrquestador(d)

  const c1 = await orq.ingest(mensajeBase('wamid.1', { text: 'primera' }))
  await orq.procesar(c1)

  const c2 = await orq.ingest(mensajeBase('wamid.2', { text: 'segunda' }))
  await orq.procesar(c2)

  assert.equal(d.enviados.ultimaPregunta, 'segunda')
  const textos = d.enviados.ultimoHistorial.map((m) => m.text)
  assert.deepEqual(textos, ['primera', 'Respuesta del bot'])
  assert.ok(!textos.includes('segunda'), 'la pregunta actual no debe estar en el historial')
})

test('un mensaje de audio recibe la respuesta fija de solo texto y no llama a la IA', async () => {
  const d = dobles({ errorIA: new Error('la IA no deberia haberse llamado') })
  const orq = crearOrquestador(d)

  const ctx = await orq.ingest(mensajeBase('wamid.AUD', { type: 'audio', text: null }))
  await orq.procesar(ctx)

  assert.equal(d.enviados.length, 1)
  assert.match(d.enviados[0].texto, /solo puedo leer mensajes de texto/i)

  const [f] = await pool.query('SELECT status FROM messages WHERE id = ?', [ctx.messageId])
  assert.equal(f[0].status, 'processed')
})

test('si la IA falla, el usuario recibe disculpa y el mensaje queda en error', async () => {
  const d = dobles({ errorIA: new Error('OpenAI 503') })
  const orq = crearOrquestador(d)

  const ctx = await orq.ingest(mensajeBase('wamid.ERR', { text: 'hola' }))
  await orq.procesar(ctx) // no debe lanzar

  assert.equal(d.enviados.length, 1)
  assert.match(d.enviados[0].texto, /problema/i)

  const [f] = await pool.query('SELECT status, error_text FROM messages WHERE id = ?', [ctx.messageId])
  assert.equal(f[0].status, 'error')
  assert.match(f[0].error_text, /OpenAI 503/)
})

test('procesar nunca lanza aunque falle tambien el envio', async () => {
  const d = dobles({ errorIA: new Error('OpenAI caido') })
  d.clienteWhatsApp.enviarTexto = async () => { throw new Error('Meta caido') }
  const orq = crearOrquestador(d)

  const ctx = await orq.ingest(mensajeBase('wamid.DOBLE'))
  await orq.procesar(ctx) // no debe lanzar

  const [f] = await pool.query('SELECT status FROM messages WHERE id = ?', [ctx.messageId])
  assert.equal(f[0].status, 'error')
})

test('procesar sobre un contexto duplicado no hace nada', async () => {
  const d = dobles()
  const orq = crearOrquestador(d)

  await orq.ingest(mensajeBase('wamid.X'))
  const dup = await orq.ingest(mensajeBase('wamid.X'))
  await orq.procesar(dup)

  assert.equal(d.enviados.length, 0)
})
```

- [ ] **Step 3: Correr el test para verificar que falla**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../src/core/handleMessage.js'`

- [ ] **Step 4: Implementar `src/core/handleMessage.js`**

```js
import config from '../config.js'
import logger from '../logger.js'
import iaPorDefecto from '../ia/index.js'
import clientePorDefecto from '../whatsapp/client.js'
import { upsertContacto } from '../db/repos/contacts.js'
import { obtenerOCrearConversacion, tocarConversacion } from '../db/repos/conversations.js'
import {
  insertarEntrante,
  insertarSaliente,
  obtenerHistorial,
  marcarProcesado,
  marcarError,
} from '../db/repos/messages.js'

const MSG_SOLO_TEXTO = 'Por ahora solo puedo leer mensajes de texto 🙂 ¿Me lo escribís?'
const MSG_ERROR =
  'Uy, tuve un problema para responderte 😅 Probá de nuevo en un ratito, por favor.'

export function crearOrquestador({
  ia = iaPorDefecto,
  clienteWhatsApp = clientePorDefecto,
  historyLimit = config.historyLimit,
} = {}) {
  /**
   * Parte SÍNCRONA: corre antes del 200 OK.
   * Solo escrituras locales a MySQL. Nada de red.
   */
  async function ingest(mensaje) {
    const contacto = await upsertContacto(mensaje.from, mensaje.profileName)
    const conversacion = await obtenerOCrearConversacion(contacto.id)

    const insertado = await insertarEntrante({
      conversationId: conversacion.id,
      contactId: contacto.id,
      waMessageId: mensaje.waMessageId,
      type: mensaje.type,
      text: mensaje.text,
      raw: mensaje.raw,
      waTimestamp: mensaje.timestamp,
    })

    // insertarEntrante devuelve null cuando el índice único rechazó el duplicado:
    // Meta reintentó el webhook y este mensaje ya fue recibido.
    if (insertado === null) {
      logger.info('webhook duplicado descartado', { waMessageId: mensaje.waMessageId })
      return { duplicado: true }
    }

    await tocarConversacion(conversacion.id)

    return {
      duplicado: false,
      messageId: insertado.id,
      conversationId: conversacion.id,
      contactId: contacto.id,
      mensaje,
    }
  }

  /**
   * Parte ASÍNCRONA: corre después del 200 OK. Acá viven las llamadas lentas.
   * NUNCA lanza: cualquier fallo se registra y el usuario recibe una respuesta.
   */
  async function procesar(ctx) {
    if (!ctx || ctx.duplicado) return

    const { messageId, conversationId, contactId, mensaje } = ctx

    try {
      await clienteWhatsApp.marcarLeido(mensaje.waMessageId)

      // Mensaje no textual: respuesta fija, sin gastar tokens.
      if (mensaje.type !== 'text' || !mensaje.text) {
        await responderYGuardar(MSG_SOLO_TEXTO, { conversationId, contactId, to: mensaje.from })
        await marcarProcesado(messageId)
        return
      }

      // El historial excluye este mensaje: ya está en la base, y la pregunta
      // se pasa aparte. Sin el excluirId aparecería duplicada en el input.
      const historial = await obtenerHistorial(conversationId, historyLimit, messageId)

      const respuesta = await ia.responder(mensaje.text, historial)

      await responderYGuardar(respuesta, { conversationId, contactId, to: mensaje.from })
      await marcarProcesado(messageId)

      logger.info('mensaje procesado', { messageId, waId: mensaje.from })
    } catch (err) {
      logger.error('fallo el procesamiento del mensaje', {
        messageId,
        error: err.message,
      })

      try {
        await marcarError(messageId, err.message)
      } catch (errDb) {
        logger.error('no se pudo marcar el error en la base', { messageId, error: errDb.message })
      }

      try {
        await responderYGuardar(MSG_ERROR, { conversationId, contactId, to: mensaje.from })
      } catch (errEnvio) {
        logger.error('tampoco se pudo avisar al usuario', {
          messageId,
          error: errEnvio.message,
        })
      }
    }
  }

  async function responderYGuardar(texto, { conversationId, contactId, to }) {
    const { waMessageId } = await clienteWhatsApp.enviarTexto(to, texto)
    await insertarSaliente({ conversationId, contactId, waMessageId, text: texto })
    await tocarConversacion(conversationId)
  }

  return { ingest, procesar }
}

export default crearOrquestador()
```

- [ ] **Step 5: Correr los tests para verificar que pasan**

Run: `npm test`
Expected: PASS — 8 tests nuevos. Los tests de Task 6 siguen pasando.

- [ ] **Step 6: Commit**

```bash
git add motoescuela-whatsapp/src/core/ motoescuela-whatsapp/src/db/repos/messages.js motoescuela-whatsapp/test/core/
git commit -m "feat: orquestador con ingest sincrono y procesamiento asincrono"
```

---

### Task 10: Webhook y servidor

**Files:**
- Create: `src/whatsapp/webhook.js`, `src/app.js`, `src/server.js`
- Test: `test/whatsapp/webhook.test.js`

**Interfaces:**
- Consumes: `esFirmaValida` (Task 2), `parsearWebhook` (Task 3), orquestador (Task 9), `config` (Task 1)
- Produces:
  - `crearRouterWebhook({ verifyToken, appSecret, orquestador, alProcesar }) => express.Router`
  - `crearApp(opciones) => express.Application` (named export de `src/app.js`)

`alProcesar` es el gancho que dispara el trabajo asíncrono. En producción es `(ctx) => setImmediate(() => orquestador.procesar(ctx))`; en los tests es una función que devuelve la promesa para poder esperarla.

- [ ] **Step 1: Escribir el test que falla**

`test/whatsapp/webhook.test.js`:

```js
import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import request from 'supertest'
import { limpiarBase, cerrarBase } from '../helpers/db.js'
import { crearApp } from '../../src/app.js'
import { crearOrquestador } from '../../src/core/handleMessage.js'
import pool from '../../src/db/pool.js'

const VERIFY_TOKEN = 'token_de_verificacion'
const APP_SECRET = 'app_secret_de_prueba'

const fixture = (n) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8'))

const firmar = (cuerpo) =>
  'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(cuerpo).digest('hex')

function armarApp() {
  const enviados = []
  const pendientes = []

  const orquestador = crearOrquestador({
    ia: { responder: async () => 'Respuesta del bot' },
    clienteWhatsApp: {
      enviarTexto: async (to, texto) => {
        enviados.push({ to, texto })
        return { waMessageId: 'wamid.OUT' + enviados.length }
      },
      marcarLeido: async () => {},
    },
  })

  const app = crearApp({
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
    orquestador,
    alProcesar: (ctx) => { pendientes.push(orquestador.procesar(ctx)) },
  })

  return { app, enviados, esperarProcesamiento: () => Promise.all(pendientes) }
}

beforeEach(async () => { await limpiarBase() })
after(async () => { await cerrarBase() })

test('GET /webhook devuelve el challenge con el token correcto', async () => {
  const { app } = armarApp()
  const res = await request(app).get('/webhook').query({
    'hub.mode': 'subscribe',
    'hub.verify_token': VERIFY_TOKEN,
    'hub.challenge': '1234567890',
  })
  assert.equal(res.status, 200)
  assert.equal(res.text, '1234567890')
})

test('GET /webhook rechaza un token incorrecto', async () => {
  const { app } = armarApp()
  const res = await request(app).get('/webhook').query({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'token_equivocado',
    'hub.challenge': '1234567890',
  })
  assert.equal(res.status, 403)
})

test('POST /webhook rechaza firma invalida con 403 y no persiste nada', async () => {
  const { app } = armarApp()
  const cuerpo = JSON.stringify(fixture('webhook-texto'))

  const res = await request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', 'sha256=' + 'f'.repeat(64))
    .send(cuerpo)

  assert.equal(res.status, 403)
  const [m] = await pool.query('SELECT COUNT(*) AS n FROM messages')
  assert.equal(m[0].n, 0)
})

test('POST /webhook sin header de firma devuelve 403', async () => {
  const { app } = armarApp()
  const cuerpo = JSON.stringify(fixture('webhook-texto'))
  const res = await request(app).post('/webhook').set('Content-Type', 'application/json').send(cuerpo)
  assert.equal(res.status, 403)
})

test('POST /webhook con firma valida responde 200 y procesa el mensaje', async () => {
  const { app, enviados, esperarProcesamiento } = armarApp()
  const cuerpo = JSON.stringify(fixture('webhook-texto'))

  const res = await request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', firmar(cuerpo))
    .send(cuerpo)

  assert.equal(res.status, 200)

  await esperarProcesamiento()

  assert.equal(enviados.length, 1)
  assert.equal(enviados[0].to, '5492235042643')
  assert.equal(enviados[0].texto, 'Respuesta del bot')

  const [m] = await pool.query('SELECT COUNT(*) AS n FROM messages')
  assert.equal(m[0].n, 2) // entrante + saliente
})

test('DEDUPLICACION end-to-end: el reintento de Meta no genera segunda respuesta', async () => {
  const { app, enviados, esperarProcesamiento } = armarApp()
  const cuerpo = JSON.stringify(fixture('webhook-texto'))
  const firma = firmar(cuerpo)

  const enviar = () =>
    request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', firma)
      .send(cuerpo)

  assert.equal((await enviar()).status, 200)
  assert.equal((await enviar()).status, 200) // reintento de Meta

  await esperarProcesamiento()

  assert.equal(enviados.length, 1, 'el usuario debe recibir UNA sola respuesta')

  const [m] = await pool.query("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in'")
  assert.equal(m[0].n, 1)
})

test('POST /webhook con un audio responde el mensaje de solo texto', async () => {
  const { app, enviados, esperarProcesamiento } = armarApp()
  const cuerpo = JSON.stringify(fixture('webhook-audio'))

  await request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', firmar(cuerpo))
    .send(cuerpo)

  await esperarProcesamiento()
  assert.match(enviados[0].texto, /solo puedo leer mensajes de texto/i)
})

test('POST /webhook con un status devuelve 200 sin procesar nada', async () => {
  const { app, enviados, esperarProcesamiento } = armarApp()
  const cuerpo = JSON.stringify(fixture('webhook-status'))

  const res = await request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', firmar(cuerpo))
    .send(cuerpo)

  assert.equal(res.status, 200)
  await esperarProcesamiento()
  assert.equal(enviados.length, 0)

  const [m] = await pool.query('SELECT COUNT(*) AS n FROM messages')
  assert.equal(m[0].n, 0)
})

test('GET /health responde ok', async () => {
  const { app } = armarApp()
  const res = await request(app).get('/health')
  assert.equal(res.status, 200)
  assert.equal(res.body.status, 'ok')
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../src/app.js'`

- [ ] **Step 3: Implementar `src/whatsapp/webhook.js`**

```js
import express from 'express'
import logger from '../logger.js'
import { esFirmaValida } from './signature.js'
import { parsearWebhook } from './parse.js'

export function crearRouterWebhook({ verifyToken, appSecret, orquestador, alProcesar }) {
  const router = express.Router()

  // Verificación inicial del webhook. Meta espera el challenge en texto plano.
  router.get('/webhook', (req, res) => {
    const modo = req.query['hub.mode']
    const token = req.query['hub.verify_token']
    const challenge = req.query['hub.challenge']

    if (modo === 'subscribe' && token === verifyToken) {
      logger.info('webhook verificado por Meta')
      return res.status(200).type('text/plain').send(String(challenge))
    }

    logger.warn('verificacion de webhook rechazada', { modo })
    return res.sendStatus(403)
  })

  // CRÍTICO: express.raw() y no express.json().
  // La firma se calcula sobre los bytes exactos que envió Meta; si Express
  // parsea y se re-serializa, la firma nunca coincide.
  router.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const rawBody = req.body // Buffer

    if (!esFirmaValida(rawBody, req.get('X-Hub-Signature-256'), appSecret)) {
      logger.warn('firma invalida en el webhook', { ip: req.ip })
      return res.sendStatus(403)
    }

    let payload
    try {
      payload = JSON.parse(rawBody.toString('utf8'))
    } catch {
      logger.warn('webhook con JSON invalido')
      return res.sendStatus(200) // no tiene sentido que Meta reintente
    }

    const { mensajes, estados } = parsearWebhook(payload)

    for (const e of estados) {
      logger.debug('estado de mensaje', { id: e.id, status: e.status })
    }

    try {
      // Persistir ANTES del 200: son escrituras locales rápidas, y la
      // deduplicación tiene que ocurrir antes de confirmarle a Meta.
      const contextos = []
      for (const mensaje of mensajes) {
        contextos.push(await orquestador.ingest(mensaje))
      }

      res.sendStatus(200)

      // El trabajo lento (OpenAI + envío) va después del ACK.
      for (const ctx of contextos) {
        if (!ctx.duplicado) alProcesar(ctx)
      }
    } catch (err) {
      // Base caída u otro fallo de persistencia: devolvemos 500 A PROPÓSITO
      // para que Meta reintente y el mensaje no se pierda.
      logger.error('fallo la persistencia del webhook', { error: err.message })
      if (!res.headersSent) res.sendStatus(500)
    }
  })

  return router
}
```

- [ ] **Step 4: Implementar `src/app.js`**

```js
import express from 'express'
import config from './config.js'
import orquestadorPorDefecto from './core/handleMessage.js'
import { crearRouterWebhook } from './whatsapp/webhook.js'

export function crearApp({
  verifyToken = config.whatsapp.verifyToken,
  appSecret = config.whatsapp.appSecret,
  orquestador = orquestadorPorDefecto,
  alProcesar = (ctx) => setImmediate(() => orquestador.procesar(ctx)),
} = {}) {
  const app = express()
  app.disable('x-powered-by')

  app.get('/health', (_req, res) => res.json({ status: 'ok' }))

  app.use(crearRouterWebhook({ verifyToken, appSecret, orquestador, alProcesar }))

  return app
}

export default crearApp
```

- [ ] **Step 5: Implementar `src/server.js`**

```js
import config from './config.js'
import logger from './logger.js'
import { crearApp } from './app.js'
import { migrar } from './db/migrate.js'

const app = crearApp()

async function arrancar() {
  const { aplicadas } = await migrar()
  if (aplicadas.length > 0) logger.info('migraciones aplicadas al arrancar', { aplicadas })

  app.listen(config.port, () => {
    logger.info('servidor escuchando', {
      port: config.port,
      base: config.mysql.database,
      phoneNumberId: config.whatsapp.phoneNumberId,
    })
  })
}

arrancar().catch((err) => {
  logger.error('no se pudo arrancar el servidor', { error: err.message })
  process.exit(1)
})
```

- [ ] **Step 6: Correr los tests para verificar que pasan**

Run: `npm test`
Expected: PASS — 9 tests nuevos. La suite completa debe estar verde.

- [ ] **Step 7: Commit**

```bash
git add motoescuela-whatsapp/src/whatsapp/webhook.js motoescuela-whatsapp/src/app.js motoescuela-whatsapp/src/server.js motoescuela-whatsapp/test/whatsapp/webhook.test.js
git commit -m "feat: webhook de Meta y servidor Express"
```

---

### Task 11: Conexión real con Meta y prueba de humo

Última tarea: enchufar el número de prueba y conversar de verdad con el bot.

**Files:**
- Create: `motoescuela-whatsapp/README.md`
- Modify: `motoescuela-whatsapp/.env` (valores reales de Meta)

**Interfaces:**
- Consumes: todo lo anterior
- Produces: el sistema andando end-to-end

- [ ] **Step 1: Configurar la app en Meta y obtener las credenciales**

1. En [developers.facebook.com](https://developers.facebook.com) crear una app de tipo **Business**.
2. Agregar el producto **WhatsApp**. Meta asigna automáticamente un número de prueba.
3. En **WhatsApp → API Setup**, anotar el **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`.
4. En esa misma pantalla, agregar tu WhatsApp personal como destinatario de prueba y verificarlo por código.
5. En **App Settings → Basic**, copiar el **App Secret** → `WHATSAPP_APP_SECRET`.
6. **Token permanente:** en Meta Business Suite → **System Users**, crear uno, darle control total sobre la app y la WABA, y generar un token con los permisos `whatsapp_business_messaging` y `whatsapp_business_management` → `WHATSAPP_TOKEN`.

⚠️ **No uses el token que muestra "API Setup": expira a las 24 horas** y el bot va a dejar de funcionar al día siguiente sin causa aparente.

7. Inventar una cadena larga y aleatoria para `WHATSAPP_VERIFY_TOKEN` (es nuestra, no de Meta):

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Cargar los seis valores en `.env`.

- [ ] **Step 2: Levantar el servidor y el túnel**

Terminal 1:

```bash
cd motoescuela-whatsapp
npm run db:setup
npm run dev
```

Expected: `{"nivel":"info","mensaje":"servidor escuchando",...}`

Terminal 2:

```bash
cloudflared tunnel --url http://localhost:3000
```

Expected: una URL pública tipo `https://algo-algo-algo.trycloudflare.com`. Anotarla.

Verificar que el túnel llega:

```bash
curl https://TU-URL.trycloudflare.com/health
```

Expected: `{"status":"ok"}`

- [ ] **Step 3: Registrar el webhook en Meta**

En **WhatsApp → Configuration → Webhook → Edit**:
- **Callback URL:** `https://TU-URL.trycloudflare.com/webhook`
- **Verify token:** el valor de `WHATSAPP_VERIFY_TOKEN`

Al guardar, Meta hace el `GET`. En los logs del servidor debe aparecer `webhook verificado por Meta`.

Luego, en **Webhook fields**, suscribirse a **`messages`**. Sin esta suscripción no llega ningún mensaje — es el olvido más común.

- [ ] **Step 4: Prueba de humo — criterios de aceptación del spec**

Desde tu WhatsApp personal, al número de prueba:

1. **CA-2:** enviar "¿Qué pasa si llueve?" → llega una respuesta en español basada en el PDF.
2. **CA-3 (contexto):** enviar "hola, soy Maciel", esperar respuesta, **cortar el servidor con Ctrl+C y volver a levantarlo**, luego enviar "¿cómo me llamo?" → el bot lo recuerda, porque el historial está en MySQL.
3. **CA-6:** enviar un audio → responde "Por ahora solo puedo leer mensajes de texto".
4. **CA-8:** verificar en los logs que el `200` sale rápido, antes de que aparezca `mensaje procesado`.

Inspeccionar la base:

```bash
mysql -u root motoescuela -e "SELECT id, direction, type, status, LEFT(text,50) AS texto FROM messages ORDER BY id;"
```

- [ ] **Step 5: Verificar el rechazo de firma inválida (CA-5)**

```bash
curl -i -X POST https://TU-URL.trycloudflare.com/webhook \
  -H 'Content-Type: application/json' \
  -H 'X-Hub-Signature-256: sha256=0000000000000000000000000000000000000000000000000000000000000000' \
  -d '{"object":"whatsapp_business_account","entry":[]}'
```

Expected: `HTTP/1.1 403 Forbidden`, y en los logs `firma invalida en el webhook`.

- [ ] **Step 6: Escribir el README**

`motoescuela-whatsapp/README.md`:

```markdown
# MotoEscuela MdP — Chatbot de WhatsApp (Cloud API)

Asistente de consultas sobre WhatsApp Cloud API. Responde con la Responses API
de OpenAI usando `file_search` sobre el material oficial de la escuela.

Fase 1: solo consultas. La gestión de turnos llega en la Fase 2.

## Requisitos

- Node 22+
- MySQL 8+ corriendo localmente
- `cloudflared` (solo para desarrollo)

## Puesta en marcha

    npm install
    cp .env.example .env      # completar los valores
    npm run db:setup
    npm run dev

En otra terminal:

    cloudflared tunnel --url http://localhost:3000

Registrar `https://<url-del-tunel>/webhook` en Meta → WhatsApp → Configuration,
usando el `WHATSAPP_VERIFY_TOKEN` del `.env`, y suscribirse al campo `messages`.

## Tests

    npm run db:setup:test
    npm test

Los tests corren contra la base `motoescuela_test` y no hacen llamadas reales
a OpenAI ni a Meta.

## Notas operativas

- El token de "API Setup" de Meta **expira a las 24 h**. Usar siempre un token
  de System User.
- Al pasar a producción cambian `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN`,
  la URL del webhook y las credenciales de MySQL. El código no cambia.
- El número de prueba solo puede escribirle a 5 destinatarios verificados.

## Documentación

- Diseño: `../docs/superpowers/specs/2026-08-28-migracion-whatsapp-cloud-api-design.md`
- Plan: `../docs/superpowers/plans/2026-08-28-migracion-whatsapp-cloud-api-fase1.md`
```

- [ ] **Step 7: Correr la suite completa una última vez**

Run: `npm test`
Expected: PASS — toda la suite verde (aproximadamente 60 tests).

- [ ] **Step 8: Commit**

```bash
git add motoescuela-whatsapp/README.md
git commit -m "docs: README con puesta en marcha y notas operativas"
```

---

## Verificación final contra el spec

| Criterio de aceptación del spec | Dónde se verifica |
|---|---|
| CA-1 Meta verifica el webhook | Task 10 test "GET /webhook devuelve el challenge"; Task 11 Step 3 |
| CA-2 Respuesta correcta desde el PDF | Task 8 Step 9 (manual); Task 11 Step 4.1 |
| CA-3 Contexto sobrevive al reinicio | Task 9 test del historial; Task 11 Step 4.2 |
| CA-4 Reintento no duplica respuesta | Task 6 test "DEDUPLICACION"; Task 10 test "DEDUPLICACION end-to-end" |
| CA-5 Firma inválida → 403 | Task 2 tests; Task 10 test de firma inválida; Task 11 Step 5 |
| CA-6 Audio → respuesta de solo texto | Task 9 test de audio; Task 10 test de audio; Task 11 Step 4.3 |
| CA-7 OpenAI caído → disculpa + `status='error'` | Task 9 test "si la IA falla" |
| CA-8 200 en menos de 500 ms | Task 10 (ingest antes del ACK, procesamiento después); Task 11 Step 4.4 |
| CA-9 Suite sin llamadas reales | Todos los tests usan dobles; verificado en Task 11 Step 7 |
