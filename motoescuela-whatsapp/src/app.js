import express from 'express'
import config from './config.js'
import orquestadorPorDefecto from './core/handleMessage.js'
import { crearRouterWebhook } from './whatsapp/webhook.js'

export function crearApp({
  verifyToken = config.whatsapp.verifyToken,
  appSecret = config.whatsapp.appSecret,
  orquestador = orquestadorPorDefecto,
  alProcesar = (ctx) => setImmediate(() => orquestador.procesar(ctx)),
} = {}) {
  const app = express()
  app.disable('x-powered-by')

  app.get('/health', (_req, res) => res.json({ status: 'ok' }))

  app.use(crearRouterWebhook({ verifyToken, appSecret, orquestador, alProcesar }))

  return app
}

export default crearApp
