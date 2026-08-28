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
