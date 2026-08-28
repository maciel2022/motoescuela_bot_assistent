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

    try {
      // Persistir ANTES del 200: son escrituras locales rápidas, y la
      // deduplicación tiene que ocurrir antes de confirmarle a Meta.
      const contextos = []
      for (const mensaje of mensajes) {
        contextos.push(await orquestador.ingest(mensaje))
      }

      res.sendStatus(200)

      // El trabajo lento (OpenAI + envío) va después del ACK.
      for (const ctx of contextos) {
        if (!ctx.duplicado) alProcesar(ctx)
      }
    } catch (err) {
      // Base caída u otro fallo de persistencia: devolvemos 500 A PROPÓSITO
      // para que Meta reintente y el mensaje no se pierda.
      logger.error('fallo la persistencia del webhook', { error: err.message })
      if (!res.headersSent) res.sendStatus(500)
    }
  })

  return router
}
