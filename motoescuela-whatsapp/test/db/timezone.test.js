import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { limpiarBase, cerrarBase } from '../helpers/db.js'
import { upsertContacto } from '../../src/db/repos/contacts.js'
import { obtenerOCrearConversacion } from '../../src/db/repos/conversations.js'
import { insertarEntrante } from '../../src/db/repos/messages.js'
import pool from '../../src/db/pool.js'

before(async () => { await limpiarBase() })
after(async () => { await cerrarBase() })

// Estos tests fallan si la sesión de MySQL no está en UTC. mysql2 `timezone: 'Z'`
// solo controla cómo el driver serializa y parsea; NO cambia el time_zone de la
// sesión, y MySQL aplica su propio offset encima al guardar un TIMESTAMP.
// El resultado es una deriva silenciosa igual al offset del servidor.

test('la sesion de MySQL esta en UTC', async () => {
  const [f] = await pool.query('SELECT @@session.time_zone AS tz, NOW() AS ahora, UTC_TIMESTAMP() AS utc')
  assert.equal(
    f[0].ahora.getTime(),
    f[0].utc.getTime(),
    `NOW() y UTC_TIMESTAMP() deben coincidir; la sesión está en "${f[0].tz}"`
  )
})

test('un CURRENT_TIMESTAMP generado por la base vuelve a JS sin deriva', async () => {
  const contacto = await upsertContacto('5490000000001', 'TZ')
  const conv = await obtenerOCrearConversacion(contacto.id)

  const antes = Date.now()
  const r = await insertarEntrante({
    conversationId: conv.id,
    contactId: contacto.id,
    waMessageId: 'wamid.TZ.' + antes,
    type: 'text',
    text: 'prueba de zona horaria',
    raw: null,
    waTimestamp: null,
  })

  const [f] = await pool.query('SELECT created_at FROM messages WHERE id = ?', [r.id])
  const deriva = Math.abs(f[0].created_at.getTime() - antes) / 1000

  assert.ok(deriva < 5, `created_at difiere de Date.now() en ${deriva}s (esperado < 5s)`)
})

test('un instante escrito desde JS conserva su valor real en la base', async () => {
  const contacto = await upsertContacto('5490000000002', 'TZ2')
  const conv = await obtenerOCrearConversacion(contacto.id)

  const instante = new Date('2026-08-28T12:00:00Z')
  const r = await insertarEntrante({
    conversationId: conv.id,
    contactId: contacto.id,
    waMessageId: 'wamid.TZ2.' + Date.now(),
    type: 'text',
    text: 'x',
    raw: null,
    waTimestamp: instante,
  })

  // UNIX_TIMESTAMP lo evalúa la base: es el instante real guardado, sin pasar
  // por el parseo del driver, que es donde la deriva quedaba enmascarada.
  const [f] = await pool.query('SELECT UNIX_TIMESTAMP(wa_timestamp) AS real_ts FROM messages WHERE id = ?', [r.id])
  assert.equal(Number(f[0].real_ts) * 1000, instante.getTime())
})
