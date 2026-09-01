# Estado del proyecto

Última actualización: 2026-09-01

## Dónde estamos

**Fase 1 terminada y funcionando.** El bot recibe y responde mensajes reales de
WhatsApp por la API oficial, usando el número de prueba de Meta.

Rama de trabajo: `feat/whatsapp-cloud-api-fase1` (pusheada, sin mergear a `main`).

- 149 tests, todos en verde. Ninguno llama a OpenAI ni a Meta de verdad.
- Los 9 criterios de aceptación del spec verificados en vivo.
- Conversación real probada: consultas de precios, lluvia, requisitos, casco, y
  un audio que recibió la respuesta de "solo texto".

## Qué hay construido

```
motoescuela-whatsapp/
├── src/
│   ├── config.js          valida el entorno al arrancar
│   ├── logger.js
│   ├── app.js             Express, /health real, trust proxy
│   ├── server.js          apagado ordenado, barrido de pendientes
│   ├── whatsapp/          firma HMAC, parseo, cliente Graph, webhook
│   ├── db/                pool, migraciones 001-003, repos
│   ├── ia/                Responses API + file_search
│   └── core/              orquestador, recuperación, contador en vuelo
└── test/                  149 tests
```

El bot viejo (`base-baileys-memory/`) queda como referencia. **Está roto**: usaba
la Assistants API de OpenAI, apagada el 26 de agosto de 2026.

## Para retomar

```bash
cd motoescuela-whatsapp
npm run db:setup
npm run dev
```

En otra terminal:

```bash
cloudflared tunnel --url http://localhost:3000
```

**La URL del túnel cambia en cada reinicio.** Hay que actualizarla en
`developers.facebook.com → app → WhatsApp → Configuración → Webhook → Editar`.
El verify token no cambia (está en `.env`).

Todo lo demás del lado de Meta ya está hecho y no hay que rehacerlo: token
permanente, línea emisora registrada, campo `messages` suscrito, app vinculada
a la WABA.

Ver `CONEXION-WHATSAPP-CLOUD-API.md` para el detalle de la conexión y los
problemas no documentados.

## Datos de la instalación

| | |
|---|---|
| Número de prueba | `+1 555-670-9653` |
| `PHONE_NUMBER_ID` | `1288932077635671` |
| `WABA_ID` | `2836050873439442` |
| `APP_ID` | `2525236677943691` |
| App | `bot-motoescuela` |
| Usuario del sistema | `maciel_admin` |
| Vector store (OpenAI) | `vs_68f103e570d481918608039028091559` |

El PIN de dos pasos de la línea y los tokens están en `.env` (ignorado por git)
y deberían estar también en el gestor de contraseñas.

## Deuda conocida

**`WHATSAPP_NORMALIZAR_AR=true` es temporal.** Existe solo porque la lista de
destinatarios autorizados del número de prueba guarda los celulares argentinos
sin el 9, mientras que los webhooks traen el `wa_id` con 9. Cuando esté el
número definitivo, se quita del `.env`.

**Sin `Dockerfile` ni configuración de proceso.** No hay unit de systemd ni
`ecosystem.config.js` de pm2. Corresponde al despliegue real.

**El disco de la máquina estuvo al 95%.** Llenarse tumbó el servidor y el túnel
durante las pruebas. Conviene mirarlo antes de dejar algo corriendo.

## Fase 2: turnos

Todavía **sin diseñar**. La conversación de brainstorming no empezó.

El hallazgo que cambia el planteo: en la máquina ya existe la base
**`appMotoEscuela`** con un sistema de turnos en uso y con datos reales.

| Tabla | Columnas | Filas |
|---|---|---|
| `usuarios` | id, nombre, apellido, email, password, telefono, admin, confirmado, token | 9 |
| `servicios` | id, nombre, precio | 10 |
| `turnos` | id, fecha, hora, usuarioId | 9 |
| `turnosServicios` | id, turnosId, serviciosId | 14 |

Probablemente **no haya que diseñar un esquema nuevo**, sino integrarse con éste
para que una reserva hecha por WhatsApp aparezca en el panel que la escuela ya
usa. Preguntas a resolver antes de escribir nada:

1. ¿Esa app está en producción o es un proyecto de práctica?
2. `turnos` guarda solo `fecha` y `hora`. ¿La duración es fija?
3. `usuarios.telefono` es `varchar(10)`: no entra un número de WhatsApp con
   código de país (`5492235042643`, 13 dígitos). ¿Se amplía o se mapea aparte?
4. ¿Google Calendar sigue teniendo un rol, o `turnos` pasa a ser la única fuente
   de verdad?
5. Los recordatorios proactivos necesitan plantillas aprobadas por Meta. Conviene
   mandarlas a aprobar temprano.

El punto de entrada técnico es `src/ia/index.js`: ahí se agregaría el *tool
calling* (`consultar_disponibilidad`, `reservar_turno`, `cancelar_turno`) en
lugar del ruteo por palabras clave que usaba el bot viejo.

## Documentos

| Archivo | Qué es |
|---|---|
| `docs/superpowers/specs/2026-08-28-migracion-whatsapp-cloud-api-design.md` | Diseño de la Fase 1 |
| `docs/superpowers/plans/2026-08-28-migracion-whatsapp-cloud-api-fase1.md` | Plan de implementación, 11 tareas |
| `CONEXION-WHATSAPP-CLOUD-API.md` | Cómo conectar con Meta, incluyendo lo no documentado |
| `motoescuela-whatsapp/README.md` | Puesta en marcha del proyecto |
