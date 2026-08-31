import mysql from 'mysql2/promise'
import config from '../config.js'
import logger from '../logger.js'

/**
 * `timezone: 'Z'` solo le dice al DRIVER que serialice y parsee en UTC.
 * NO cambia el time_zone de la sesión de MySQL, que por defecto hereda el del
 * sistema. Si no coinciden, MySQL aplica su propio offset al guardar un
 * TIMESTAMP y los valores quedan desplazados de forma silenciosa: lo escrito
 * desde JS se guarda corrido, y lo generado por la base (CURRENT_TIMESTAMP)
 * vuelve corrido en sentido contrario.
 * Por eso forzamos UTC en cada conexión nueva del pool.
 */
export function crearPool(opciones = {}) {
  const pool = mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: 'Z',
    charset: 'utf8mb4_unicode_ci',
    ...opciones,
  })

  pool.pool.on('connection', (conn) => {
    // El callback NO es opcional: una query sin callback que recibe un error
    // del servidor emite 'error' sobre un objeto sin listener, lo que en
    // mysql2 se convierte en uncaughtException y mata el proceso. Y si este
    // SET fallara en silencio, la conexión quedaría en la zona local y los
    // timestamps se guardarían corridos sin que nada avise.
    conn.query("SET time_zone = '+00:00'", (err) => {
      if (err) {
        logger.error('no se pudo forzar UTC en la conexion', {
          error: err?.message ?? String(err),
        })
      }
    })
  })

  return pool
}

export default crearPool()
