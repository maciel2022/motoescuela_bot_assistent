import config from './config.js'
import logger from './logger.js'
import { crearApp } from './app.js'
import { migrar } from './db/migrate.js'

const app = crearApp()

async function arrancar() {
  const { aplicadas } = await migrar()
  if (aplicadas.length > 0) logger.info('migraciones aplicadas al arrancar', { aplicadas })

  app.listen(config.port, () => {
    logger.info('servidor escuchando', {
      port: config.port,
      base: config.mysql.database,
      phoneNumberId: config.whatsapp.phoneNumberId,
    })
  })
}

arrancar().catch((err) => {
  logger.error('no se pudo arrancar el servidor', { error: err.message })
  process.exit(1)
})
