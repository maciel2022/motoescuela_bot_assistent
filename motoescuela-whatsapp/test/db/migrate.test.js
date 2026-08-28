import test from 'node:test'
import assert from 'node:assert/strict'
import mysql from 'mysql2/promise'
import config from '../../src/config.js'
import { migrar } from '../../src/db/migrate.js'

const conectar = () =>
  mysql.createConnection({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
  })

// Protección: estos tests borran tablas. Nunca deben tocar la base de desarrollo.
test('el entorno de test apunta a la base de tests', () => {
  assert.ok(
    config.mysql.database.endsWith('_test'),
    `Los tests deben correr contra una base *_test, no contra "${config.mysql.database}". Usá: npm test`
  )
})

test('migrar crea las tres tablas y es idempotente', async () => {
  await migrar()

  const conn = await conectar()
  const [tablas] = await conn.query('SHOW TABLES')
  const nombres = tablas.map((f) => Object.values(f)[0])
  for (const t of ['contacts', 'conversations', 'messages', 'schema_migrations']) {
    assert.ok(nombres.includes(t), `falta la tabla ${t}`)
  }
  await conn.end()

  // Correr de nuevo no debe fallar ni re-aplicar.
  const segunda = await migrar()
  assert.deepEqual(segunda.aplicadas, [])
})

test('migrar registra cada archivo aplicado en schema_migrations', async () => {
  // Sin esta asercion, SHOW TABLES pasaria con tablas que dejo una corrida
  // anterior aunque migrar() fuese un no-op. Esto verifica el contrato real
  // y, a diferencia de comprobar el valor devuelto, vale tanto en una base
  // virgen como en una ya migrada.
  await migrar()

  const conn = await conectar()
  const [filas] = await conn.query('SELECT filename FROM schema_migrations')
  const registradas = filas.map((f) => f.filename)
  await conn.end()

  assert.ok(registradas.includes('001_init.sql'))
  assert.ok(registradas.includes('002_conversacion_abierta_unica.sql'))
})

test('wa_message_id tiene indice unico', async () => {
  await migrar()
  const conn = await conectar()
  const [indices] = await conn.query('SHOW INDEX FROM messages WHERE Key_name = ?', [
    'uq_messages_wa_message_id',
  ])
  assert.equal(indices.length, 1)
  assert.equal(indices[0].Non_unique, 0)
  await conn.end()
})
