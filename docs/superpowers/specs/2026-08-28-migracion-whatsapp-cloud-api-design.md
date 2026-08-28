# Migración del chatbot de MotoEscuela a WhatsApp Cloud API — Fase 1

**Fecha:** 2026-08-28
**Estado:** aprobado para planificación
**Alcance:** Fase 1 — asistente de consultas sobre la API oficial de WhatsApp. La gestión de turnos se diseña por separado en la Fase 2.

---

## 1. Contexto y motivación

El bot actual (`base-baileys-memory/`) corre sobre **BuilderBot v1 + Baileys**, una integración no oficial de WhatsApp que se autentica por QR y guarda la sesión en `bot_sessions/`. El estado de conversación usa `MockAdapter`: vive en memoria y se pierde en cada reinicio.

Dos hechos fuerzan la migración ahora:

1. **Baileys no es oficial.** El número queda expuesto a bloqueo por parte de Meta, y la sesión por QR se cae y hay que re-escanear.
2. **La Assistants API de OpenAI fue apagada el 26 de agosto de 2026.** Está listada en "Past deprecations" (`2026-08-26 | Assistants API | Responses API and Conversations API`). El `welcomeFlow` actual llama a `/v1/threads` y **hoy está roto en producción**. No es deuda técnica futura: es una falla activa.

### Verificaciones ya realizadas (2026-08-28)

| Qué | Resultado |
|---|---|
| Vector store del asistente | **VIVO** — `vs_68f103e570d481918608039028091559`, "Vector store for Asistente Motoescuela", 1 archivo `completed`, 7930 bytes |
| API key existente | Funciona |
| Responses API + `file_search` sobre ese vector store | **Funciona end-to-end.** `status: completed`, `file_search: completed`, respuesta correcta extraída del PDF. 3440 tokens in / 69 out con `gpt-4o-mini` |

Conclusión: los vector stores y los archivos **no** fueron afectados por el sunset (solo murieron los objetos `assistant` y `thread`). No hace falta el PDF original ni volver a indexar nada.

---

## 2. Decisiones tomadas

| Eje | Decisión | Motivo |
|---|---|---|
| Stack | **Node + Express, webhook crudo** (sin BuilderBot) | Control total sobre sesiones, colas y reintentos — necesario para la lógica de turnos de la Fase 2 |
| Alcance Fase 1 | **Solo consultas.** El flujo de turnos NO se porta | Portar código que se va a reescribir sobre MySQL es trabajo desperdiciado |
| Motor de IA | **Responses API + `file_search`** | La Assistants API ya no existe |
| Historial | **En MySQL propio**, no en OpenAI | Sobrevive al cambio de proveedor, da log auditable, y las reservas de la Fase 2 cuelgan de las mismas tablas |
| Procesamiento del webhook | **ACK inmediato + async en proceso** (opción B) | Evita duplicados por reintento de Meta sin infra extra. La tabla `messages` que necesita B es la misma que necesitará el worker con cola (opción C) en producción |
| Módulos | ESM, Node 20+ | Estándar actual; el código viejo no se reusa textualmente |
| Infra dev | Express local + túnel (Cloudflare Tunnel / ngrok), **MySQL nativo instalado en la máquina** (sin Docker) | Ya está instalado |
| Número | De prueba de Meta durante dev; el definitivo se compra y se enchufa cambiando `.env` | El `PHONE_NUMBER_ID` cambia, el código no |

### Fuera de alcance de la Fase 1

Turnos, Google Calendar, plantillas de mensaje, recordatorios proactivos, panel de administración, mensajes multimedia salientes.

---

## 3. Arquitectura

Proyecto nuevo, hermano del actual. `base-baileys-memory/` queda intacto como referencia hasta que el nuevo esté andando.

```
motoescuela-whatsapp/
├── src/
│   ├── server.js              arranque de Express
│   ├── config.js              lee y VALIDA env vars al arrancar
│   ├── whatsapp/
│   │   ├── webhook.js         GET verificación + POST recepción
│   │   ├── signature.js       validación HMAC de X-Hub-Signature-256
│   │   ├── parse.js           payload de Meta → objeto propio (función pura)
│   │   └── client.js          envío de mensajes a la Graph API
│   ├── ia/
│   │   ├── index.js           interfaz: responder(pregunta, historial)
│   │   ├── openai.js          implementación con Responses API + file_search
│   │   └── prompt.js          instrucciones de MotoEscuela
│   ├── db/
│   │   ├── pool.js            mysql2/promise
│   │   ├── migrations/        001_init.sql, ...
│   │   ├── migrate.js         runner de migraciones
│   │   └── repos/             contacts.js, conversations.js, messages.js
│   ├── core/
│   │   └── handleMessage.js   orquestador
│   └── logger.js
├── test/
├── .env.example
└── package.json
```

### Principio de aislamiento

Cada módulo tiene una responsabilidad y se testea de forma independiente:

- `parse.js` — función pura sobre el JSON de Meta. No toca red ni base.
- `signature.js` — función pura. Body crudo + secreto → booleano.
- `client.js` — sabe hablar con la Graph API. No sabe nada de IA ni de base.
- `ia/index.js` — **interfaz**: `responder(pregunta, historial) → texto`. Oculta por completo a OpenAI. Cambiar de proveedor toca un solo archivo.
- `repos/*` — únicos que escriben SQL.
- `handleMessage.js` — el único que conoce a todos; orquesta, no implementa.

`config.js` **falla al arrancar** si falta una variable obligatoria, en vez de romper con el primer mensaje del usuario.

---

## 4. Modelo de datos

Tres tablas. El diseño contempla la Fase 2 pero **no crea nada de turnos ahora**.

### `contacts`
| Columna | Tipo | Notas |
|---|---|---|
| `id` | BIGINT PK AI | |
| `wa_id` | VARCHAR(32) | **UNIQUE** — el número en formato de WhatsApp |
| `profile_name` | VARCHAR(255) NULL | el nombre que expone Meta |
| `created_at` / `updated_at` | TIMESTAMP | |

### `conversations`
| Columna | Tipo | Notas |
|---|---|---|
| `id` | BIGINT PK AI | |
| `contact_id` | BIGINT FK → contacts | |
| `status` | ENUM('open','closed') | default `open` |
| `last_message_at` | TIMESTAMP NULL | índice, para el corte de historial |
| `created_at` | TIMESTAMP | |

### `messages`
| Columna | Tipo | Notas |
|---|---|---|
| `id` | BIGINT PK AI | |
| `conversation_id` | BIGINT FK → conversations | |
| `contact_id` | BIGINT FK → contacts | |
| `wa_message_id` | VARCHAR(128) NULL | **UNIQUE** — ver deduplicación |
| `direction` | ENUM('in','out') | |
| `type` | VARCHAR(32) | `text`, `audio`, `image`, ... |
| `text` | TEXT NULL | |
| `raw_payload` | JSON NULL | el objeto original de Meta |
| `status` | ENUM('received','processed','error') | |
| `error_text` | TEXT NULL | |
| `wa_timestamp` | TIMESTAMP NULL | el que reporta Meta |
| `created_at` | TIMESTAMP | |

**Deduplicación:** el índice único en `wa_message_id` *es* el mecanismo. Cuando Meta reintenta un webhook, el INSERT choca contra el índice y el mensaje se descarta sin procesar. No hay lógica extra ni caché en memoria. Los mensajes salientes se insertan con el `wa_message_id` que devuelve la Graph API.

**Historial:** se arma leyendo los últimos `HISTORY_LIMIT` mensajes de la conversación (default 10), ordenados cronológicamente, mapeados a roles `user`/`assistant`.

**Migración de datos: ninguna.** El bot actual usa `MockAdapter` en memoria; no hay nada que traer.

---

## 5. Flujo de datos

### Verificación del webhook (una sola vez, al configurarlo)

`GET /webhook` — Meta envía `hub.mode`, `hub.verify_token`, `hub.challenge`. Si `hub.mode === 'subscribe'` y el token coincide con `WHATSAPP_VERIFY_TOKEN`, se devuelve el challenge en texto plano con `200`. Si no, `403`.

### Mensaje entrante

```
Meta → POST /webhook
  (síncrono — todo esto son operaciones locales de milisegundos)
  1. Validar firma HMAC-SHA256 sobre el body CRUDO    → inválida: 403, corta acá
  2. Parsear el payload
  3. Upsert de contact + get-or-create de conversation
  4. Insertar en `messages` (status='received')       → wa_message_id duplicado: descartar
  5. Responder 200 OK
  ──────────────────────────────────────────────────────────
  (async, ya respondido el 200 — acá viven las llamadas de red lentas)
  6. Marcar el mensaje como leído en WhatsApp
  7. Leer últimos N mensajes → armar historial
  8. ia.responder(pregunta, historial)
  9. client.enviarTexto(wa_id, respuesta)
 10. Insertar el saliente; marcar el entrante `processed`
```

El corte entre síncrono y asíncrono está puesto donde empiezan las llamadas de red lentas (OpenAI, Graph API). Los pasos 3 y 4 son escrituras locales a MySQL y se hacen **antes** del ACK a propósito: `messages` tiene foreign keys a `contacts` y `conversations`, así que esas filas deben existir primero, y sobre todo, **la deduplicación tiene que ocurrir antes de responder 200** para que un reintento de Meta se descarte sin llegar a procesarse.

**Trampa crítica del paso 1:** la firma se calcula sobre el **body crudo**. La ruta del webhook debe usar `express.raw({ type: 'application/json' })`; si `express.json()` parsea primero, la validación falla siempre. El parseo a objeto se hace después, a mano.

**Ventana de 24 h:** en Fase 1 el bot solo *responde*, nunca inicia conversación, así que siempre opera dentro de la ventana. **No se necesita ninguna plantilla.** Los recordatorios de turno de la Fase 2 sí las van a requerir; conviene ir aprobándolas a nivel WABA porque sirven igual al cambiar de número.

**Webhooks de `statuses`** (`sent`/`delivered`/`read`): se loguean y se ignoran en Fase 1.

---

## 6. Manejo de errores

Regla: **el usuario siempre recibe una respuesta**, y el error queda registrado en la base.

| Falla | Comportamiento |
|---|---|
| Firma inválida o ausente | `403`. No se procesa. Se loguea como posible spoofing |
| Mensaje no-texto (audio, imagen, ubicación, sticker) | Se guarda igual. Se responde: "Por ahora solo puedo leer mensajes de texto 🙂" |
| OpenAI falla o excede timeout | Mensaje de disculpa al usuario. `status='error'` + `error_text` en la base |
| El envío a la Graph API falla | 2 reintentos con backoff exponencial; si igual falla, queda logueado y marcado |
| **MySQL caído** | El webhook responde **`500` a propósito**, para que Meta reintente y el mensaje no se pierda |

La última fila es deliberada y es la contracara de la opción B: sin base no hay deduplicación ni registro, así que es preferible que Meta reintente antes que perder el mensaje.

---

## 7. Testing

Se trabaja con **TDD**: test primero en cada pieza. **Ningún test toca las APIs reales ni consume tokens.**

**Unitarios (sin red ni base):**
- `parse.js` — fixtures con payloads reales de Meta: texto, audio, `statuses`, entrada malformada
- `signature.js` — firma válida, inválida, ausente, body alterado
- `prompt.js` — armado del historial a partir de filas de `messages`

**Con MySQL de test:**
- Repos: upsert de contacto, get-or-create de conversación, inserción de mensajes
- **Caso clave:** insertar dos veces el mismo `wa_message_id` no genera fila nueva ni procesamiento

**Integración (`supertest`):**
- `GET /webhook` con token correcto e incorrecto
- `POST /webhook` end-to-end con dobles de OpenAI y Graph API: verifica que responde 200 rápido, que persiste, y que envía la respuesta
- Reintento de Meta con el mismo payload: una sola respuesta al usuario

---

## 8. Configuración y entornos

Todo por variables de entorno, validadas al arrancar.

```
PORT
WHATSAPP_VERIFY_TOKEN        # inventado por nosotros, para el GET
WHATSAPP_APP_SECRET          # de la app de Meta, para la firma
WHATSAPP_TOKEN               # token de acceso (System User en producción)
WHATSAPP_PHONE_NUMBER_ID     # cambia entre número de prueba y definitivo
GRAPH_API_VERSION            # ej. v21.0
OPENAI_API_KEY
OPENAI_MODEL                 # default: gpt-4o-mini (verificado funcionando)
OPENAI_VECTOR_STORE_ID       # vs_68f103e570d481918608039028091559
MYSQL_HOST / PORT / USER / PASSWORD / DATABASE
HISTORY_LIMIT                # default 10
LOG_LEVEL
```

| | Desarrollo | Producción |
|---|---|---|
| Número | De prueba de Meta (hasta 5 destinatarios verificados) | El número comprado |
| Webhook | Cloudflare Tunnel / ngrok → localhost | Dominio propio con HTTPS |
| MySQL | Instalación local nativa | Base del hosting (phpMyAdmin) |
| Setup de base | `npm run db:setup` (crea base + corre migraciones) | Idem, apuntando al host remoto |

El pasaje a producción es: cambiar `WHATSAPP_PHONE_NUMBER_ID`, el token, la URL del webhook y las credenciales de MySQL. **Cero cambios de código.**

### Prerequisitos de Meta para desarrollar (gratis, sin comprar número)

El desarrollo **no depende** del número definitivo. Checklist:

1. Cuenta de Meta for Developers + **app de tipo Business**.
2. Agregar el producto **WhatsApp** a la app → Meta asigna automáticamente un **número de prueba** con su `PHONE_NUMBER_ID` y WABA ID. Gratis, sin verificación.
3. Agregar el **WhatsApp personal como destinatario de prueba** y verificarlo por código. Hasta 5 destinatarios.
4. **Token permanente vía System User** (Meta Business Suite → System Users → control total sobre la app y la WABA). **Crítico:** el token que muestra el panel de "API Setup" expira a las **24 horas**; si se desarrolla con ese, el bot deja de funcionar al día siguiente sin causa aparente.
5. Copiar el **App Secret** de la app → `WHATSAPP_APP_SECRET`, necesario para validar la firma del webhook.
6. Inventar un `WHATSAPP_VERIFY_TOKEN` propio y cargarlo en la configuración del webhook en Meta, junto con la URL del túnel.

**La verificación del negocio NO es necesaria para esta etapa.** Entra en juego al pasar a producción con el número comprado y para levantar los límites de envío. Es el trámite más lento del proceso, así que conviene iniciarlo en paralelo al desarrollo.

### Nota sobre el número de prueba

El número de prueba **no es migrable**. Cuando se compre el definitivo, se agrega como teléfono nuevo a la misma WABA y cambia el `PHONE_NUMBER_ID`. Todo lo demás —código, webhook, plantillas aprobadas— se reutiliza.

---

## 9. Criterios de aceptación de la Fase 1

1. Meta verifica el webhook correctamente (`GET` con challenge).
2. Un mensaje de texto desde un número de prueba recibe respuesta correcta generada desde el PDF vía `file_search`.
3. La conversación mantiene contexto entre mensajes tras **reiniciar el proceso** (el historial está en MySQL).
4. Un webhook reenviado por Meta con el mismo `message_id` **no** genera una segunda respuesta.
5. Una firma inválida es rechazada con `403`.
6. Un mensaje de audio recibe la respuesta fija de "solo texto" y queda guardado.
7. Con OpenAI caído (simulado), el usuario recibe disculpa y el mensaje queda `status='error'`.
8. El webhook responde `200` en menos de 500 ms de forma consistente.
9. La suite de tests pasa entera sin llamadas reales a OpenAI ni a Meta.

---

## 10. Puente hacia la Fase 2 (turnos)

Este diseño no implementa turnos, pero los habilita:

- `contacts` y `conversations` son el ancla natural de una tabla `appointments`.
- El historial en MySQL permite que la lógica de turnos lea el contexto de la conversación.
- La interfaz `ia/index.js` es el punto donde se agregará *tool calling* (`consultar_disponibilidad`, `reservar_turno`, `cancelar_turno`) en lugar del ruteo por keywords del bot viejo.
- Queda pendiente de decidir en Fase 2: si MySQL reemplaza a Google Calendar como fuente de verdad o si se sincronizan; y las plantillas de mensaje para recordatorios proactivos.

### Hallazgo (2026-08-28): ya existe un sistema de turnos en MySQL

La máquina de desarrollo tiene la base **`appMotoEscuela`** con un sistema de turnos en uso y con datos reales:

| Tabla | Columnas | Filas |
|---|---|---|
| `usuarios` | `id`, `nombre`, `apellido`, `email`, `password`, `telefono`, `admin`, `confirmado`, `token` | 9 |
| `servicios` | `id`, `nombre`, `precio` | 10 |
| `turnos` | `id`, `fecha`, `hora`, `usuarioId` | 9 |
| `turnosServicios` | `id`, `turnosId`, `serviciosId` (relación N:M) | 14 |

**Implicancia para la Fase 2:** probablemente NO haya que diseñar un esquema de turnos desde cero. El bot debería integrarse contra estas tablas para que una reserva hecha por WhatsApp aparezca en el panel existente, y viceversa. Preguntas a resolver al abrir la Fase 2:

1. ¿Esa app está en producción o es un proyecto de práctica?
2. ¿`turnos` tiene la duración del turno, o se asume fija? Hoy solo guarda `fecha` + `hora`.
3. `usuarios.telefono` es `varchar(10)` — insuficiente para un número de WhatsApp con código de país (ej. `5492235042643`, 13 dígitos). Habría que ampliarlo o mapear contactos aparte.
4. ¿Google Calendar sigue teniendo un rol, o `turnos` pasa a ser la única fuente de verdad?
