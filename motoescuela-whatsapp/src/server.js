import config from './config.js'
import logger from './logger.js'
import pool from './db/pool.js'
import { crearApp } from './app.js'
import { migrar } from './db/migrate.js'
import rastreador from './core/enVuelo.js'
import { barrerPendientes } from './core/recuperacion.js'

const TOPE_APAGADO_MS = 30000
const INTERVALO_BARRIDO_MS = 5 * 60 * 1000
const ANTIGUEDAD_PENDIENTE_MIN = 5

const app = crearApp()
let server
let temporizadorBarrido
let apagando = false

/**
 * Red de último recurso. Si algo rechaza sin que nadie lo observe, el default
 * de Node 22 es matar el proceso en silencio. Preferimos dejar el stack en el
 * log y salir con código distinto de cero para que el supervisor reinicie:
 * tragarse el error dejaría el proceso en un estado desconocido.
 */
process.on('unhandledRejection', (err) => {
  logger.error('PROMESA RECHAZADA SIN OBSERVAR', {
    error: err?.message ?? String(err),
    stack: err?.stack,
  })
  apagar('unhandledRejection', 1)
})

process.on('uncaughtException', (err) => {
  logger.error('EXCEPCION NO CAPTURADA', {
    error: err?.message ?? String(err),
    stack: err?.stack,
  })
  apagar('uncaughtException', 1)
})

/**
 * Apagado ordenado. Sin esto, un SIGTERM mata el mensaje en vuelo, y como su
 * fila ya está commiteada el reintento de Meta la descarta como duplicada: el
 * usuario nunca recibe respuesta. Ocurre en cada deploy, cada restart y cada
 * guardado bajo `node --watch`, no solo en un crash.
 */
async function apagar(motivo, codigo = 0) {
  if (apagando) return
  apagando = true

  logger.info('apagando', { motivo, enVuelo: rastreador.cantidad() })
  clearInterval(temporizadorBarrido)

  // Dejar de aceptar requests nuevas, pero terminar las que están en curso.
  if (server) await new Promise((r) => server.close(r))

  const { completo, pendientes } = await rastreador.esperar(TOPE_APAGADO_MS)
  if (!completo) {
    logger.warn('quedo trabajo sin terminar al apagar', {
      pendientes,
      nota: 'el barrido de pendientes lo recupera al arrancar',
    })
  }

  await pool.end().catch((err) =>
    logger.error('fallo al cerrar el pool', { error: err?.message ?? String(err) })
  )

  logger.info('apagado completo', { motivo, codigo })
  process.exit(codigo)
}

for (const senial of ['SIGTERM', 'SIGINT']) {
  process.on(senial, () => apagar(senial, 0))
}

async function arrancar() {
  const { aplicadas } = await migrar()
  if (aplicadas.length > 0) logger.info('migraciones aplicadas al arrancar', { aplicadas })

  // Recupera lo que quedó en vuelo si el proceso murió (deploy, reinicio, OOM).
  await barrerPendientes({ antiguedadMinutos: ANTIGUEDAD_PENDIENTE_MIN })

  temporizadorBarrido = setInterval(() => {
    barrerPendientes({ antiguedadMinutos: ANTIGUEDAD_PENDIENTE_MIN })
  }, INTERVALO_BARRIDO_MS)
  temporizadorBarrido.unref()

  server = app.listen(config.port, () => {
    logger.info('servidor escuchando', {
      port: config.port,
      base: config.mysql.database,
      phoneNumberId: config.whatsapp.phoneNumberId,
      modelo: config.openai.model,
    })
  })
}

arrancar().catch((err) => {
  logger.error('no se pudo arrancar el servidor', {
    error: err?.message ?? String(err),
    stack: err?.stack,
  })
  process.exit(1)
})
