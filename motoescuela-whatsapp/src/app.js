import express from 'express'
import config from './config.js'
import logger from './logger.js'
import pool from './db/pool.js'
import orquestadorPorDefecto from './core/handleMessage.js'
import rastreadorPorDefecto from './core/enVuelo.js'
import { crearRouterWebhook } from './whatsapp/webhook.js'

/** Comprueba que la base responde de verdad, no que el proceso esté vivo. */
async function verificarBasePorDefecto() {
  await pool.query('SELECT 1')
  return true
}

export function crearApp({
  verifyToken = config.whatsapp.verifyToken,
  appSecret = config.whatsapp.appSecret,
  orquestador = orquestadorPorDefecto,
  rastreador = rastreadorPorDefecto,
  verificarBase = verificarBasePorDefecto,
  // El trabajo lento corre desacoplado de la request. El rastreador le adosa
  // un catch (un rechazo sin observar mata el proceso en Node 22) y permite
  // esperarlo al apagar.
  alProcesar = (ctx) =>
    setImmediate(() => {
      rastreador.rastrear(orquestador.procesar(ctx), (err) => {
        logger.error('procesar() rechazo, no deberia pasar nunca', {
          messageId: ctx?.messageId,
          error: err?.message ?? String(err),
          stack: err?.stack,
        })
      })
    }),
} = {}) {
  const app = express()
  app.disable('x-powered-by')

  // El webhook va detrás del túnel HTTPS que exige Meta, así que sin esto
  // req.ip sería siempre la dirección del túnel y el log de firma inválida
  // no tendría ninguna señal útil.
  app.set('trust proxy', 1)

  app.get('/health', async (_req, res) => {
    try {
      await verificarBase()
      res.json({ status: 'ok', base: 'ok', enVuelo: rastreador.cantidad() })
    } catch (err) {
      logger.error('healthcheck fallido', { error: err?.message ?? String(err) })
      res.status(503).json({ status: 'degradado', base: 'error' })
    }
  })

  app.use(crearRouterWebhook({ verifyToken, appSecret, orquestador, alProcesar }))

  // Manejador de errores propio: el de Express escupe un stack crudo
  // multilínea a stderr, que rompe el parseo del log JSON, y sin
  // NODE_ENV=production lo devuelve además en el cuerpo de la respuesta.
  app.use((err, _req, res, _next) => {
    logger.error('error no manejado en Express', {
      error: err?.message ?? String(err),
      stack: err?.stack,
    })
    if (!res.headersSent) res.sendStatus(err?.status ?? 500)
  })

  return app
}

export default crearApp
