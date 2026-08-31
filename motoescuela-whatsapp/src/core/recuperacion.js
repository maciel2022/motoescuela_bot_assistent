import logger from '../logger.js'
import orquestadorPorDefecto from './handleMessage.js'
import { obtenerPendientes } from '../db/repos/messages.js'

/**
 * Reprocesa los mensajes entrantes que quedaron sin procesar.
 *
 * Red de seguridad del diseño "opción B": el trabajo lento corre desacoplado
 * de la request, así que si el proceso muere (deploy, reinicio, OOM) lo que
 * estaba en vuelo se pierde. Y como la fila ya está commiteada, el reintento
 * de Meta la descarta como duplicada: sin este barrido, ese mensaje no se
 * responde nunca.
 *
 * Nunca lanza: se invoca al arrancar y en un intervalo, y un fallo acá no debe
 * impedir que el servidor levante ni matar el temporizador.
 */
export async function barrerPendientes({
  orquestador = orquestadorPorDefecto,
  antiguedadMinutos = 5,
  limite = 50,
} = {}) {
  let recuperados = 0

  try {
    const pendientes = await obtenerPendientes(antiguedadMinutos, limite)
    if (pendientes.length === 0) return { recuperados: 0 }

    logger.warn('hay mensajes sin procesar, reprocesandolos', {
      cantidad: pendientes.length,
      antiguedadMinutos,
    })

    for (const p of pendientes) {
      const { messageId, conversationId, contactId, ...mensaje } = p
      try {
        await orquestador.procesar({
          duplicado: false,
          messageId,
          conversationId,
          contactId,
          mensaje,
        })
        recuperados++
      } catch (err) {
        // procesar() no deberia lanzar, pero si lo hace no puede tumbar el barrido.
        logger.error('fallo el reprocesamiento de un pendiente', {
          messageId,
          error: err?.message ?? String(err),
          stack: err?.stack,
        })
      }
    }

    logger.info('barrido de pendientes completo', { recuperados })
  } catch (err) {
    logger.error('fallo el barrido de pendientes', {
      error: err?.message ?? String(err),
      stack: err?.stack,
    })
  }

  return { recuperados }
}
