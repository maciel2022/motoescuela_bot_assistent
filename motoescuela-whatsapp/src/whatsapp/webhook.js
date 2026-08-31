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
  // parsea y algo re-serializa, la firma nunca coincide.
  router.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('')

    if (!esFirmaValida(rawBody, req.get('X-Hub-Signature-256'), appSecret)) {
      logger.warn('firma invalida en el webhook', { ip: req.ip })
      return res.sendStatus(403)
    }

    let payload
    try {
      payload = JSON.parse(rawBody.toString('utf8'))
    } catch {
      // Un cuerpo corrupto no se arregla reintentando: devolver 500 haría que
      // Meta lo reenviara en un bucle infinito.
      logger.warn('webhook con JSON invalido')
      return res.sendStatus(200)
    }

    const { mensajes, estados } = parsearWebhook(payload)

    for (const e of estados) {
      logger.debug('estado de mensaje', { id: e.id, status: e.status })
    }

    // Persistir ANTES del 200: son escrituras locales rápidas, y la
    // deduplicación tiene que ocurrir antes de confirmarle a Meta.
    //
    // Cada mensaje se persiste por separado y con su propio try: si uno falla,
    // los demás del lote igual se procesan. Antes, un fallo abandonaba el lote
    // entero y los ya insertados quedaban huérfanos, porque el reintento de
    // Meta los descartaba como duplicados.
    const contextos = []
    let huboFallo = false

    for (const mensaje of mensajes) {
      try {
        contextos.push(await orquestador.ingest(mensaje))
      } catch (err) {
        huboFallo = true
        logger.error('fallo la persistencia de un mensaje', {
          waMessageId: mensaje.waMessageId,
          waId: mensaje.from,
          error: err?.message ?? String(err),
          stack: err?.stack,
        })
      }
    }

    // 500 a propósito si algo falló, para que Meta reintente ese mensaje.
    // Los que sí se persistieron quedan deduplicados en el reintento, por eso
    // se despachan igual acá abajo.
    res.sendStatus(huboFallo ? 500 : 200)

    // El trabajo lento (OpenAI + envío) va después de responder.
    for (const ctx of contextos) {
      if (!ctx.duplicado) alProcesar(ctx)
    }
  })

  return router
}
