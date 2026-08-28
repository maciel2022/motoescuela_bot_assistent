import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { limpiarBase, cerrarBase } from '../helpers/db.js'
import { upsertContacto } from '../../src/db/repos/contacts.js'
import { obtenerOCrearConversacion, tocarConversacion } from '../../src/db/repos/conversations.js'
import pool from '../../src/db/pool.js'

beforeEach(async () => { await limpiarBase() })
after(async () => { await cerrarBase() })

test('upsertContacto crea el contacto la primera vez', async () => {
  const c = await upsertContacto('5492235042643', 'Maciel')
  assert.ok(c.id > 0)
  assert.equal(c.wa_id, '5492235042643')
  assert.equal(c.profile_name, 'Maciel')
})

test('upsertContacto no duplica y actualiza el nombre', async () => {
  const primero = await upsertContacto('5492235042643', 'Maciel')
  const segundo = await upsertContacto('5492235042643', 'Maciel F')

  assert.equal(primero.id, segundo.id)
  assert.equal(segundo.profile_name, 'Maciel F')

  const [filas] = await pool.query('SELECT COUNT(*) AS n FROM contacts')
  assert.equal(filas[0].n, 1)
})

test('upsertContacto con nombre null no borra el nombre existente', async () => {
  await upsertContacto('5492235042643', 'Maciel')
  const c = await upsertContacto('5492235042643', null)
  assert.equal(c.profile_name, 'Maciel')
})

test('obtenerOCrearConversacion devuelve la misma conversacion abierta', async () => {
  const c = await upsertContacto('5492235042643', 'Maciel')
  const a = await obtenerOCrearConversacion(c.id)
  const b = await obtenerOCrearConversacion(c.id)
  assert.equal(a.id, b.id)
  assert.equal(a.status, 'open')

  const [filas] = await pool.query('SELECT COUNT(*) AS n FROM conversations')
  assert.equal(filas[0].n, 1)
})

test('contactos distintos tienen conversaciones distintas', async () => {
  const c1 = await upsertContacto('5492235042643', 'Maciel')
  const c2 = await upsertContacto('5491100000000', 'Otro')
  const a = await obtenerOCrearConversacion(c1.id)
  const b = await obtenerOCrearConversacion(c2.id)
  assert.notEqual(a.id, b.id)
})

test('tocarConversacion actualiza last_message_at', async () => {
  const c = await upsertContacto('5492235042643', 'Maciel')
  const conv = await obtenerOCrearConversacion(c.id)

  const [antes] = await pool.query('SELECT last_message_at FROM conversations WHERE id = ?', [conv.id])
  assert.equal(antes[0].last_message_at, null)

  await tocarConversacion(conv.id)

  const [despues] = await pool.query('SELECT last_message_at FROM conversations WHERE id = ?', [conv.id])
  assert.ok(despues[0].last_message_at instanceof Date)
})
