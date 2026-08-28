import mysql from 'mysql2/promise'
import config from '../config.js'

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
    conn.query("SET time_zone = '+00:00'")
  })

  return pool
}

export default crearPool()
