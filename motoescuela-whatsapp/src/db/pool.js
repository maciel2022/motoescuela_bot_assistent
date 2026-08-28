import mysql from 'mysql2/promise'
import config from '../config.js'

export function crearPool(opciones = {}) {
  return mysql.createPool({
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
}

export default crearPool()
