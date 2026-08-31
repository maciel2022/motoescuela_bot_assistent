import config from '../config.js'
import logger from '../logger.js'
import pool from '../db/pool.js'
import iaPorDefecto from '../ia/index.js'
import clientePorDefecto from '../whatsapp/client.js'
import * as reposContactos from '../db/repos/contacts.js'
import * as reposConversaciones from '../db/repos/conversations.js'
import * as reposMensajes from '../db/repos/messages.js'

const REPOS_POR_DEFECTO = { ...reposContactos, ...reposConversaciones, ...reposMensajes }

const MSG_SOLO_TEXTO = 'Por ahora solo puedo leer mensajes de texto 🙂 ¿Me lo escribís?'
const MSG_ERROR = 'Uy, tuve un problema para responderte 😅 Probá de nuevo en un ratito, por favor.'

export function crearOrquestador({
  ia = iaPorDefecto,
  clienteWhatsApp = clientePorDefecto,
  historyLimit = config.historyLimit,
  repos = REPOS_POR_DEFECTO,
  db = pool,
} = {}) {
  const {
    upsertContacto,
    obtenerOCrearConversacion,
    tocarConversacion,
    insertarEntrante,
    insertarSaliente,
    obtenerHistorial,
    marcarProcesado,
    marcarError,
  } = repos

  /**
   * Parte SÍNCRONA: corre antes del 200 OK que espera Meta.
   * Solo escrituras locales a MySQL, nada de red. La deduplicación tiene que
   * ocurrir acá: si esperáramos al procesamiento asíncrono, un reintento de
   * Meta ya habría sido confirmado y podría procesarse dos veces.
   */
  async function ingest(mensaje) {
    // TODO EN UNA TRANSACCIÓN. La fila de `messages` ES el mecanismo de
    // deduplicación: si se commiteara y después fallara cualquier paso, el
    // webhook devolvería 500, Meta reintentaría, el índice único lo descartaría
    // como duplicado y el mensaje del usuario se perdería para siempre. El
    // rollback deja la base como estaba para que el reintento SÍ funcione.
    const conn = await db.getConnection()

    try {
      await conn.beginTransaction()

      const contacto = await upsertContacto(mensaje.from, mensaje.profileName, conn)
      const conversacion = await obtenerOCrearConversacion(contacto.id, conn)

      const insertado = await insertarEntrante(
        {
          conversationId: conversacion.id,
          contactId: contacto.id,
          waMessageId: mensaje.waMessageId,
          type: mensaje.type,
          text: mensaje.text,
          raw: mensaje.raw,
          waTimestamp: mensaje.timestamp,
        },
        conn
      )

      // null = el índice único rechazó el duplicado: Meta reintentó el webhook.
      if (insertado === null) {
        await conn.rollback()
        logger.info('webhook duplicado descartado', { waMessageId: mensaje.waMessageId })
        return { duplicado: true }
      }

      await tocarConversacion(conversacion.id, conn)
      await conn.commit()

      return {
        duplicado: false,
        messageId: insertado.id,
        conversationId: conversacion.id,
        contactId: contacto.id,
        mensaje,
      }
    } catch (err) {
      try {
        await conn.rollback()
      } catch (errRollback) {
        logger.error('fallo el rollback', { error: errRollback?.message ?? String(errRollback) })
      }
      throw err
    } finally {
      conn.release()
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
