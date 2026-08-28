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
const MSG_ERROR = 'Uy, tuve un problema para responderte 😅 Probá de nuevo en un ratito, por favor.'

export function crearOrquestador({
  ia = iaPorDefecto,
  clienteWhatsApp = clientePorDefecto,
  historyLimit = config.historyLimit,
} = {}) {
  /**
   * Parte SÍNCRONA: corre antes del 200 OK que espera Meta.
   * Solo escrituras locales a MySQL, nada de red. La deduplicación tiene que
   * ocurrir acá: si esperáramos al procesamiento asíncrono, un reintento de
   * Meta ya habría sido confirmado y podría procesarse dos veces.
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

    // null = el índice único rechazó el duplicado: Meta reintentó el webhook.
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
   * NUNCA lanza: se ejecuta desacoplada de la request, así que un throw acá
   * sería una promesa rechazada sin nadie que la observe. Cualquier fallo se
   * registra en la base y el usuario recibe igual una respuesta.
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

      // El historial excluye este mensaje: ya está en la base porque ingest lo
      // guardó, y la pregunta se pasa aparte. Sin excluirlo, el modelo vería
      // el turno del usuario duplicado.
      const historial = await obtenerHistorial(conversationId, historyLimit, messageId)

      const respuesta = await ia.responder(mensaje.text, historial)

      await responderYGuardar(respuesta, { conversationId, contactId, to: mensaje.from })
      await marcarProcesado(messageId)

      logger.info('mensaje procesado', { messageId, waId: mensaje.from })
    } catch (err) {
      logger.error('fallo el procesamiento del mensaje', { messageId, error: err.message })

      try {
        await marcarError(messageId, err.message)
      } catch (errDb) {
        logger.error('no se pudo marcar el error en la base', { messageId, error: errDb.message })
      }

      try {
        await responderYGuardar(MSG_ERROR, { conversationId, contactId, to: mensaje.from })
      } catch (errEnvio) {
        logger.error('tampoco se pudo avisar al usuario', { messageId, error: errEnvio.message })
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
