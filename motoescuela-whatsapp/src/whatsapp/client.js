import config from '../config.js'
import logger from '../logger.js'

const LIMITE_TEXTO_WHATSAPP = 4096

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

/** Error que no tiene sentido reintentar: la request en sí está mal. */
class ErrorPermanente extends Error {}

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

  async function postear(cuerpo) {
    let ultimoError

    for (let intento = 0; intento <= reintentos; intento++) {
      let detalle
      let status

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

        if (res.ok) return res.json()

        const datos = await res.json().catch(() => ({}))
        status = res.status
        detalle = datos?.error?.message ?? `HTTP ${res.status}`

        // 4xx = problema de nuestra request. Reintentar no lo arregla.
        // Excepción: 429 (rate limit) sí es transitorio.
        if (status >= 400 && status < 500 && status !== 429) {
          throw new ErrorPermanente(`Graph API rechazó la request: ${detalle}`)
        }
      } catch (err) {
        // Un rechazo de fetch (DNS, ECONNRESET, TLS, timeout) es el fallo
        // transitorio MÁS común, y es justo para el que existe el reintento.
        if (err instanceof ErrorPermanente) throw err
        if (detalle === undefined) detalle = err.message
      }

      ultimoError = new Error(`Graph API falló: ${detalle}`)

      if (intento < reintentos) {
        logger.warn('reintentando llamada a Graph API', {
          intento: intento + 1,
          status,
          detalle,
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
