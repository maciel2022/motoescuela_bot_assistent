import pool from '../../src/db/pool.js'
import config from '../../src/config.js'
import { migrar } from '../../src/db/migrate.js'

/**
 * Vacía las tablas de datos entre tests.
 * Aborta si la base no termina en _test, para no borrar datos de desarrollo.
 */
export async function limpiarBase() {
  if (!config.mysql.database.endsWith('_test')) {
    throw new Error(`limpiarBase() se negó a correr contra "${config.mysql.database}"`)
  }
  await migrar()
  await pool.query('SET FOREIGN_KEY_CHECKS = 0')
  for (const t of ['messages', 'conversations', 'contacts']) {
    await pool.query(`TRUNCATE TABLE ${t}`)
  }
  await pool.query('SET FOREIGN_KEY_CHECKS = 1')
}

export async function cerrarBase() {
  await pool.end()
}
