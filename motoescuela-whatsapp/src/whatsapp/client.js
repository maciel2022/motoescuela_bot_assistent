import config from '../config.js'
import logger from '../logger.js'

const LIMITE_TEXTO_WHATSAPP = 4096

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

/** La request en sí está mal: reintentar no la arregla y prueba que no se entregó. */
export class ErrorPermanente extends Error {}

/**
 * No sabemos si el mensaje llegó o no.
 *
 * Meta no ofrece clave de idempotencia, así que un timeout o un 5xx son
 * indistinguibles de "entregado pero se perdió la respuesta". Reintentar
 * arriesga mandarle al usuario el mensaje dos veces; darlo por fallido
 * arriesga mandarle una disculpa encima de una respuesta que sí recibió.
 * Elegimos no hacer ninguna de las dos y dejar constancia.
 */
export class ErrorPosibleEntrega extends Error {}

/** Códigos de red que prueban que la request NUNCA salió: reintentar es seguro. */
const CODIGOS_PREVIOS_AL_ENVIO = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ERR_INVALID_URL',
])

export function crearClienteWhatsApp({
  token,
  phoneNumberId,
  graphVersion = 'v21.0',
  fetchImpl = fetch,
  reintentos = 2,
  esperaBase = 500,
  timeoutMs = 10000,
} = {}) {
  const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`

  /**
   * @param {boolean} idempotente Si la operación se puede repetir sin efecto
   *   visible para el usuario (marcar como leído). Cuando lo es, se reintenta
   *   cualquier fallo transitorio; cuando no, solo los que prueban que la
   *   request no salió.
   */
  async function postear(cuerpo, { idempotente = false } = {}) {
    let ultimoError

    for (let intento = 0; intento <= reintentos; intento++) {
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(cuerpo),
          // Sin timeout, una conexión colgada deja una promesa pendiente para
          // siempre: el envío ocurre después del 200 a Meta, así que no hay
          // nadie esperándola que se dé cuenta.
          signal: AbortSignal.timeout(timeoutMs),
        })

        if (res.ok) {
          // El await es necesario: sin él, el rechazo de json() escapa del try
          // por completo. Y si el cuerpo no se puede leer, el mensaje YA se
          // entregó: darlo por fallido haría que el usuario reciba la
          // respuesta y encima una disculpa.
          return await res.json().catch((err) => {
            logger.warn('no se pudo leer la respuesta de Graph, se asume entregado', {
              error: err?.message ?? String(err),
            })
            return {}
          })
        }

        const datos = await res.json().catch(() => ({}))
        const detalle = datos?.error?.message ?? `HTTP ${res.status}`

        // 4xx (salvo 429) = nuestra request está mal. Prueba que no se entregó.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new ErrorPermanente(`Graph API rechazó la request: ${detalle}`)
        }

        // 429 = la API lo rechazó sin procesarlo: seguro reintentar.
        if (res.status === 429) {
          ultimoError = new Error(`Graph API limitó la tasa: ${detalle}`)
        } else {
          // 5xx: Graph ya recibió la request. Pudo haberla entregado.
          ultimoError = new ErrorPosibleEntrega(`Graph API falló: ${detalle}`)
          if (!idempotente) throw ultimoError
        }
      } catch (err) {
        if (err instanceof ErrorPermanente) throw err
        if (err instanceof ErrorPosibleEntrega && !idempotente) throw err

        if (!(err instanceof ErrorPosibleEntrega)) {
          const previoAlEnvio = CODIGOS_PREVIOS_AL_ENVIO.has(err?.code)

          if (!previoAlEnvio && !idempotente) {
            // Timeout, ECONNRESET, socket colgado: la request pudo haber
            // llegado. No reintentamos para no duplicar el mensaje.
            throw new ErrorPosibleEntrega(
              `Graph API no confirmó el envío: ${err?.message ?? String(err)}`
            )
          }

          ultimoError = err
        }
      }

      if (intento < reintentos) {
        logger.warn('reintentando llamada a Graph API', {
          intento: intento + 1,
          detalle: ultimoError?.message,
        })
        await dormir(esperaBase * Math.pow(2, intento))
      }
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
        // Array.from corta por PUNTOS DE CÓDIGO. `.slice()` cuenta unidades
        // UTF-16 y partiría un emoji al medio, dejando un surrogate suelto que
        // produce un JSON malformado.
        text: {
          preview_url: false,
          body: Array.from(String(texto)).slice(0, LIMITE_TEXTO_WHATSAPP).join(''),
        },
      }
      const datos = await postear(cuerpo)
      return { waMessageId: datos?.messages?.[0]?.id ?? null }
    },

    /** Marca el mensaje como leído (doble tilde azul). Nunca lanza: es cosmético. */
    async marcarLeido(waMessageId) {
      try {
        await postear(
          { messaging_product: 'whatsapp', status: 'read', message_id: waMessageId },
          { idempotente: true }
        )
      } catch (err) {
        logger.warn('no se pudo marcar como leido', {
          waMessageId,
          error: err?.message ?? String(err),
        })
      }
    },
  }
}

export default crearClienteWhatsApp({
  token: config.whatsapp.token,
  phoneNumberId: config.whatsapp.phoneNumberId,
  graphVersion: config.whatsapp.graphVersion,
})
