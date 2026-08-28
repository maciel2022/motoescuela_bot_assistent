import mysql from 'mysql2/promise'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '../config.js'
import logger from '../logger.js'

const DIR_MIGRACIONES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

/**
 * Crea la base si no existe y aplica en orden las migraciones no aplicadas.
 * Registra cada archivo aplicado en schema_migrations para no repetirlo.
 */
export async function migrar() {
  // El nombre de la base es lo único que se interpola en SQL en todo el
  // proyecto (CREATE DATABASE no admite placeholders). Viene de configuración,
  // no de usuarios, pero se valida igual: un backtick ahí escaparía de las
  // comillas y convertiría un error de .env en una inyección.
  if (!/^[A-Za-z0-9_]+$/.test(config.mysql.database)) {
    throw new Error(
      `Nombre de base de datos inválido: "${config.mysql.database}". ` +
        `Solo se permiten letras, números y guion bajo.`
    )
  }

  // Conexión SIN base seleccionada, para poder crearla.
  const raiz = await mysql.createConnection({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    multipleStatements: false,
    timezone: 'Z',
  })
  await raiz.query("SET time_zone = '+00:00'")

  await raiz.query(
    `CREATE DATABASE IF NOT EXISTS \`${config.mysql.database}\` ` +
      `CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  )
  await raiz.end()

  const conn = await mysql.createConnection({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    timezone: 'Z',
  })
  // Misma razón que en pool.js: el driver en UTC no alcanza, la sesión también.
  await conn.query("SET time_zone = '+00:00'")

  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (filename)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  const [filas] = await conn.query('SELECT filename FROM schema_migrations')
  const yaAplicadas = new Set(filas.map((f) => f.filename))

  const archivos = readdirSync(DIR_MIGRACIONES).filter((f) => f.endsWith('.sql')).sort()
  const aplicadas = []

  for (const archivo of archivos) {
    if (yaAplicadas.has(archivo)) continue

    const sql = readFileSync(path.join(DIR_MIGRACIONES, archivo), 'utf8')
    const sentencias = sql
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    for (const sentencia of sentencias) {
      await conn.query(sentencia)
    }

    await conn.query('INSERT INTO schema_migrations (filename) VALUES (?)', [archivo])
    aplicadas.push(archivo)
    logger.info('migracion aplicada', { archivo })
  }

  await conn.end()
  return { aplicadas }
}

// Permite ejecutarlo como script: node src/db/migrate.js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrar()
    .then(({ aplicadas }) => {
      logger.info('migraciones completas', {
        base: config.mysql.database,
        aplicadas: aplicadas.length ? aplicadas : 'ninguna pendiente',
      })
      process.exit(0)
    })
    .catch((err) => {
      logger.error('fallo la migracion', { error: err.message })
      process.exit(1)
    })
}
