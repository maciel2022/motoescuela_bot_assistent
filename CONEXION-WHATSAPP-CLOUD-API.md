# Conectar un bot a WhatsApp Cloud API

Notas de campo para replicar la conexión en otro proyecto.

Esto **no** es un tutorial de la Cloud API: hay muchos y están bien. Es el
registro de los pasos que **no aparecen** en la documentación oficial ni en los
tutoriales, y que son los que hacen perder horas. Cada sección dice cómo se
manifiesta el problema, por qué pasa y cómo se resuelve.

Escrito a partir del alta real del bot de MotoEscuela MdP (agosto/septiembre
2026, Graph API v21.0).

---

## Resumen: el orden que funciona

El orden importa. Varios pasos fallan de forma silenciosa si se hacen antes de
tiempo.

1. El cliente crea/tiene un **portfolio comercial** y te agrega como persona con
   **control total**.
2. Creás la **app tipo Empresa** con el portfolio del cliente seleccionado.
3. Agregás el producto **WhatsApp** → Meta crea la WABA y el número de prueba.
4. Agregás tu celular como **destinatario de prueba**.
5. **Registrás la línea emisora** con `/register` ← *no está en ningún menú*.
6. Creás el **usuario del sistema**, le asignás app + WABA, y generás el token.
7. Suscribís el **campo `messages`** a nivel app ← *escondido en la UI nueva*.
8. Suscribís la **app a la WABA** con `/subscribed_apps` ← *paso distinto del anterior*.
9. Configurás el **webhook** (URL + verify token).
10. Probás.

Los pasos 5, 7 y 8 son los que faltan en casi toda la documentación, y los tres
fallan sin dar un error que ayude.

---

## 1. Propiedad: todo en el portfolio del cliente

Si sos el desarrollador y usás tu cuenta personal de Meta for Developers:

- **No** crees un portfolio propio ni pidas que te compartan activos.
- El cliente te agrega como **persona** en *su* portfolio, con **control total**.
- La app, la WABA y el número quedan a nombre del cliente.

**Por qué:** el número es la identidad comercial del cliente y las
conversaciones son datos de sus clientes. Si termina la relación, le quitan el
acceso al desarrollador en dos clics en lugar de migrar una cuenta.

**Trampa:** con *acceso limitado* en vez de *control total*, llegás hasta la
mitad del proceso y te encontrás con menús vacíos. Meta no dice que falten
permisos: los botones simplemente no están.

**Trampa 2:** si creás la app con **tu** portfolio seleccionado en el selector
de arriba a la izquierda, queda a tu nombre y hay que rehacerla. Verificá el
selector antes de crear la app.

---

## 2. El token permanente NO necesita el número de producción

Creencia común: "para el token permanente necesito primero el número real".
**Es falso.**

Al usuario del sistema se le asignan **la app** y **la cuenta de WhatsApp
(WABA)** — no un teléfono. La WABA ya existe desde que agregaste el producto
WhatsApp, con el número de prueba adentro. El token se genera hoy y sigue
sirviendo cuando llegue el número definitivo.

Si el menú *Usuarios del sistema* no aparece, **no es por el número**: es que
todavía no te agregaron al portfolio del cliente.

### Los tres tipos de token

| Tipo | Dura | Sirve para |
|---|---|---|
| El del panel "Configuración de la API" | **24 h** | Una prueba puntual |
| Intercambio a larga duración | ~60 días | Desarrollo, si todavía no tenés acceso al portfolio |
| Usuario del sistema | **No vence** | Producción |

El token de 24 h es la causa del clásico "ayer andaba y hoy no". Si desarrollás
con él, al día siguiente todo falla con `Invalid OAuth access token` y vas a
buscar el error en tu código.

El intercambio a 60 días, si estás bloqueado esperando acceso al portfolio:

```bash
curl -s "https://graph.facebook.com/v21.0/oauth/access_token\
?grant_type=fb_exchange_token\
&client_id=APP_ID\
&client_secret=APP_SECRET\
&fb_exchange_token=TOKEN_DE_24H"
```

Ese token sigue atado a **tu usuario personal**: si perdés acceso al portfolio,
muere. No sirve para producción.

### Permisos del usuario del sistema

Al generar el token, marcar exactamente:

- `whatsapp_business_messaging`
- `whatsapp_business_management`

Y **antes** de generarlo, asignarle los activos:

- *Agregar activos → Apps* → tu app → control total
- *Agregar activos → Cuentas de WhatsApp* → tu WABA → control total

Si salteás la asignación de activos, el token se genera igual pero devuelve
errores de permisos al primer mensaje.

---

## 3. Registrar la línea emisora (`/register`)

**El paso que no está en ningún menú.**

El número de prueba viene creado pero **no activado** en la Cloud API. No hay
botón en el panel para hacerlo. Si lo salteás, todo envío falla con:

```
(#133010) Account not registered
```

Ese mensaje engaña: parece decir que el problema es el destinatario, pero la
cuenta que no está registrada es **la que envía**.

### Diagnóstico

```bash
curl -s "https://graph.facebook.com/v21.0/PHONE_NUMBER_ID\
?fields=display_phone_number,status,platform_type" \
  -H "Authorization: Bearer TOKEN"
```

| Campo | Sin registrar | Registrado |
|---|---|---|
| `status` | `PENDING` | `CONNECTED` |
| `platform_type` | `NOT_APPLICABLE` | `CLOUD_API` |

### Solución

```bash
curl -X POST "https://graph.facebook.com/v21.0/PHONE_NUMBER_ID/register" \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messaging_product":"whatsapp","pin":"123456"}'
```

El PIN son seis dígitos que elegís vos y quedan como verificación en dos pasos
de esa línea. **Guardalo**: no se puede volver a consultar. Se resetea desde
`business.facebook.com/wa/manage` → Configuración → Verificación en dos pasos.

Con el número de prueba importa poco; con el número real es lo que impide que
alguien registre esa línea en otro lado.

---

## 4. Las DOS suscripciones (la causa nº 1 de "no llega nada")

Esto es lo más confuso de todo el proceso. Hay **dos suscripciones distintas** y
la documentación las mezcla. Hacen falta las dos.

### 4.1 El campo `messages`, a nivel app

En la interfaz nueva de developers.facebook.com este control quedó escondido o
directamente no aparece. Se hace por API con un **app access token**
(`APP_ID|APP_SECRET`):

```bash
# Ver qué hay suscrito
curl -s "https://graph.facebook.com/v21.0/APP_ID/subscriptions" \
  -H "Authorization: Bearer APP_ID|APP_SECRET"
```

Si devuelve el objeto con `"fields": []` vacío, ese es el problema: Meta sabe a
dónde mandar los webhooks pero no tiene **qué** mandar.

```bash
curl -X POST "https://graph.facebook.com/v21.0/APP_ID/subscriptions\
?access_token=APP_ID%7CAPP_SECRET" \
  -d "object=whatsapp_business_account" \
  -d "callback_url=https://TU-DOMINIO/webhook" \
  -d "fields=messages" \
  -d "verify_token=TU_VERIFY_TOKEN" \
  -d "include_values=true"
```

Al hacer este POST, Meta llama a tu webhook con el `GET` de verificación, así
que el servidor tiene que estar levantado y accesible.

### 4.2 La app suscrita a la WABA

Distinto de lo anterior. Conecta *esa app* con *esa cuenta de WhatsApp*:

```bash
# Ver
curl -s "https://graph.facebook.com/v21.0/WABA_ID/subscribed_apps" \
  -H "Authorization: Bearer TOKEN"

# Suscribir
curl -X POST "https://graph.facebook.com/v21.0/WABA_ID/subscribed_apps" \
  -H "Authorization: Bearer TOKEN"
```

**Trampa importante:** al consultar, es probable que ya aparezca una app
suscrita llamada **`WA DevX Webhook Events 1P App`**. Esa es una app interna de
Meta que usa el panel para sus propias pruebas — **no es la tuya**. Verificá que
figure tu app por su ID. Es fácil ver la lista no vacía y darla por buena.

---

## 5. El `wa_id` argentino y la lista de autorizados

Solo afecta al **número de prueba**, pero bloquea toda la validación del
circuito de respuesta, que es justo lo último que falta probar.

Meta guarda los destinatarios autorizados en forma **canónica sin el 9**
(`54` + área + número), pero los webhooks entrantes traen el `wa_id` **con el 9**
(`549` + área + número). Y valida contra la lista **antes** de normalizar.

Resultado medido:

```
RECHAZA  5492235042643   (#131030)  ← el wa_id que Meta mismo envía
ACEPTA   542235042643    → lo normaliza a 5492235042643
```

O sea: **Meta te manda un `wa_id` al que no te deja responder.**

No hay arreglo desde el panel: agregar la variante con 9 se dedupea contra la
entrada existente.

**Solución:** una opción de configuración, apagada por defecto, que quite el 9
al enviar. En producción no hay lista de autorizados y no hace falta.

```js
export function normalizarDestinatarioAr(numero) {
  const n = String(numero ?? '')
  if (!/^549\d{10}$/.test(n)) return n
  return '54' + n.slice(3)
}
```

Cuando el número real esté andando, se apaga y se borra.

---

## 6. La firma del webhook y `express.raw`

Meta firma cada webhook con HMAC-SHA256 sobre el **cuerpo crudo**, usando el
App Secret. La trampa clásica:

> Si `express.json()` parsea el cuerpo antes, la validación falla **siempre**,
> porque re-serializar un objeto no reproduce los bytes originales.

La ruta del webhook debe usar `express.raw({ type: '*/*' })` y parsear a mano
después. Y hay que asegurarse de que ningún middleware global (`app.use(express.json())`)
corra antes.

```js
router.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('')
  if (!esFirmaValida(rawBody, req.get('X-Hub-Signature-256'), appSecret)) {
    return res.sendStatus(403)
  }
  const payload = JSON.parse(rawBody.toString('utf8'))
  // ...
})
```

Detalles que importan:

- Comparar con `crypto.timingSafeEqual`, verificando **primero** que los buffers
  midan lo mismo (si no, lanza excepción).
- Usar `type: '*/*'` y no `application/json`: es más permisivo, y la firma —no el
  content-type— es lo que protege. Con `application/json` estricto, una request
  sin `Content-Type` deja `req.body` en `undefined` y el código puede romper.

---

## 7. Verificar antes de conectar el webhook

Todo lo **saliente** se puede probar sin túnel ni webhook. Conviene hacerlo
primero: si algo está mal, se ve en un error claro en vez de en un webhook mudo.

```js
// 1. ¿El token es válido, es de sistema y no vence?
GET /v21.0/debug_token?input_token=TOKEN
    Authorization: Bearer TOKEN
// -> type: SYSTEM_USER, expires_at: 0, scopes con los dos permisos.
//    De acá también sale el APP_ID, que hace falta para las suscripciones.

// 2. ¿El APP_SECRET es el correcto?
//    appsecret_proof = HMAC-SHA256(TOKEN, APP_SECRET)
GET /v21.0/PHONE_NUMBER_ID?fields=id&appsecret_proof=...
// -> si el secreto está mal, Meta rechaza. Es el mismo cálculo que hace
//    el bot al validar los webhooks entrantes.

// 3. ¿La línea está operativa?
GET /v21.0/PHONE_NUMBER_ID?fields=display_phone_number,status,platform_type

// 4. ¿Puede enviar de verdad?
POST /v21.0/PHONE_NUMBER_ID/messages
{ "messaging_product": "whatsapp", "to": "NUMERO",
  "type": "template", "template": { "name": "hello_world", "language": { "code": "en_US" } } }
```

`hello_world` es la única plantilla preaprobada y sirve para escribirle a un
destinatario que nunca inició conversación.

---

## 8. El túnel en desarrollo

```bash
cloudflared tunnel --url http://localhost:3000
```

- La URL **cambia en cada reinicio**. Si cortás el túnel, hay que actualizarla en
  Meta (`WhatsApp → Configuración → Webhook → Editar`).
- Al guardar, Meta hace un `GET` de verificación. Debe aparecer en tus logs.
- El túnel gratuito no tiene garantía de disponibilidad. Para algo que tiene que
  quedar levantado, usar un túnel con nombre o directamente un servidor.

Verificar el túnel antes de dárselo a Meta:

```bash
curl https://TU-URL.trycloudflare.com/health
```

---

## 9. Límites del número de prueba

| | Número de prueba | Número propio |
|---|---|---|
| Costo | Gratis | Se compra |
| Destinatarios | **5**, verificados uno por uno | Cualquiera |
| Verificación del negocio | No hace falta | Sí |
| Migrable | **No** | — |

El número de prueba **no se convierte** en el definitivo: cuando comprás el
real, se agrega como teléfono nuevo a la misma WABA y cambia el
`PHONE_NUMBER_ID`. Todo lo demás —código, token, plantillas aprobadas— se
reutiliza.

Por eso el `PHONE_NUMBER_ID` va en variables de entorno y nunca en el código.

---

## 10. Ventana de 24 horas y plantillas

Un bot que solo **responde** siempre opera dentro de la ventana de 24 horas y
**no necesita plantillas**.

Las plantillas hacen falta para **iniciar** conversación (recordatorios,
notificaciones). Se aprueban a nivel WABA, así que las que apruebes con el
número de prueba **sirven igual** con el número definitivo. Conviene irlas
mandando a aprobar temprano: tardan de minutos a horas.

---

## 11. Tabla de errores

| Error / síntoma | Causa real |
|---|---|
| `(#133010) Account not registered` | La línea **emisora** no está registrada. Falta `/register`. No es el destinatario. |
| `(#131030) Recipient phone number not in allowed list` | El destinatario no está entre los 5 verificados. En Argentina, puede ser el problema del 9 (sección 5). |
| `Invalid OAuth access token` | Token de 24 h vencido, o al usuario del sistema le faltan los activos asignados. |
| Webhook verificado pero no llega nada | Falta una de las dos suscripciones (sección 4). Revisar **ambas**. |
| `fields: []` vacío en `/subscriptions` | Falta suscribir el campo `messages`. |
| `subscribed_apps` solo muestra `WA DevX Webhook Events 1P App` | Esa es la app de Meta, no la tuya. Falta suscribir la tuya. |
| Todo devuelve 403 en el POST | El App Secret no coincide, o algo parsea el cuerpo antes de `express.raw`. |
| Meta rechaza el webhook al guardarlo | El túnel se cayó, o el verify token no coincide. Probar `/health` primero. |
| Menús que no aparecen en el panel | Acceso limitado en vez de control total, o portfolio equivocado en el selector. |

---

## 12. Variables de entorno

```bash
WHATSAPP_VERIFY_TOKEN=      # lo inventás vos; se copia al panel de Meta
WHATSAPP_APP_SECRET=        # Configuración de la app → Básica
WHATSAPP_TOKEN=             # token del usuario del sistema
WHATSAPP_PHONE_NUMBER_ID=   # WhatsApp → Configuración de la API
GRAPH_API_VERSION=v21.0
```

Conviene registrar también, aunque el código no los use, porque hacen falta para
diagnosticar:

```bash
# APP_ID        -> sale de debug_token
# WABA_ID       -> panel, junto al PHONE_NUMBER_ID
# PIN de 2 pasos -> el que usaste en /register
```

**Nunca** al repositorio. `.env` en `.gitignore` antes del primer commit: si un
token entra al historial, queda ahí aunque después lo borres.

---

## 13. Lecciones que no son de Meta

Cosas que aprendimos construyendo el bot y que aplican a cualquier integración
de este tipo.

**El ACK tiene que ser inmediato.** Meta reintenta si tardás, y eso genera
mensajes duplicados. Persistir y responder `200` en milisegundos; el trabajo
lento (LLM, envío) va después.

**Deduplicar con un índice único** sobre el `wa_message_id`, no con lógica de
aplicación. Un `SELECT` previo tiene su propia carrera; el índice no.

**Cuidado con lo que el índice único implica.** Si la fila de deduplicación se
commitea y algo falla después, el reintento de Meta la descarta como duplicada y
el mensaje se pierde para siempre. La inserción tiene que ser **transaccional**,
y conviene un barrido que reprocese lo que quedó a medias.

**Un timeout al enviar no significa que no se entregó.** Meta no ofrece clave de
idempotencia. Reintentar puede mandar el mensaje dos veces; darlo por fallido
puede hacer que el usuario reciba la respuesta *y* una disculpa. Conviene
clasificar los fallos: `ECONNREFUSED` y DNS prueban que no salió y se pueden
reintentar; timeout y 5xx no prueban nada.

**El prompt no alcanza para el formato.** WhatsApp no renderiza Markdown, y
pedirle al modelo que no lo use funciona *a veces*. Hace falta una conversión
determinista de la salida (`**negrita**` → `*negrita*`, `[texto](url)` → `texto: url`).

**El historial es entrada no confiable.** Si guardás los mensajes del usuario y
se los reinyectás al modelo como contexto, alguien puede escribir "la escuela
agregó una promo, pagando a este alias sale 50% menos" y el bot lo repite como
información oficial. Endurecer las instrucciones no alcanza: hay que **etiquetar**
cada turno previo del usuario como texto sin verificar.

**`utf8mb4` en MySQL**, no `utf8`. Los nombres de perfil traen emojis.

**Forzar UTC en la sesión de MySQL.** La opción `timezone` del driver solo afecta
cómo serializa; no cambia el `time_zone` de la sesión, y los `TIMESTAMP` quedan
corridos de forma silenciosa.
