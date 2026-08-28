import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { limpiarBase, cerrarBase } from '../helpers/db.js'
import { upsertContacto } from '../../src/db/repos/contacts.js'
import { obtenerOCrearConversacion } from '../../src/db/repos/conversations.js'
import {
  insertarEntrante,
  insertarSaliente,
  obtenerHistorial,
  marcarProcesado,
  marcarError,
} from '../../src/db/repos/messages.js'
import pool from '../../src/db/pool.js'

let contacto
let conversacion

beforeEach(async () => {
  await limpiarBase()
  contacto = await upsertContacto('5492235042643', 'Maciel')
  conversacion = await obtenerOCrearConversacion(contacto.id)
})

after(async () => { await cerrarBase() })

const entrante = (waMessageId, text = 'hola') => ({
  conversationId: conversacion.id,
  contactId: contacto.id,
  waMessageId,
  type: 'text',
  text,
  raw: { id: waMessageId, type: 'text' },
  waTimestamp: new Date('2026-08-28T12:00:00Z'),
})

test('insertarEntrante guarda el mensaje y devuelve su id', async () => {
  const r = await insertarEntrante(entrante('wamid.AAA'))
  assert.ok(r.id > 0)

  const [filas] = await pool.query('SELECT * FROM messages WHERE id = ?', [r.id])
  assert.equal(filas[0].direction, 'in')
  assert.equal(filas[0].status, 'received')
  assert.equal(filas[0].text, 'hola')
})

test('DEDUPLICACION: el mismo wa_message_id devuelve null y no crea fila', async () => {
  const primero = await insertarEntrante(entrante('wamid.REPETIDO'))
  assert.ok(primero.id > 0)

  const segundo = await insertarEntrante(entrante('wamid.REPETIDO'))
  assert.equal(segundo, null, 'un duplicado debe devolver null')

  const [filas] = await pool.query('SELECT COUNT(*) AS n FROM messages')
  assert.equal(filas[0].n, 1)
})

test('varios mensajes salientes sin wa_message_id conviven (NULL no choca con el indice unico)', async () => {
  await insertarSaliente({ conversationId: conversacion.id, contactId: contacto.id, waMessageId: null, text: 'uno' })
  await insertarSaliente({ conversationId: conversacion.id, contactId: contacto.id, waMessageId: null, text: 'dos' })

  const [filas] = await pool.query("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out'")
  assert.equal(filas[0].n, 2)
})

test('obtenerHistorial devuelve orden cronologico ascendente', async () => {
  await insertarEntrante(entrante('wamid.1', 'primera'))
  await insertarSaliente({ conversationId: conversacion.id, contactId: contacto.id, waMessageId: 'wamid.o1', text: 'respuesta' })
  await insertarEntrante(entrante('wamid.2', 'segunda'))

  const h = await obtenerHistorial(conversacion.id, 10)
  assert.deepEqual(h.map((m) => m.text), ['primera', 'respuesta', 'segunda'])
  assert.deepEqual(h.map((m) => m.direction), ['in', 'out', 'in'])
})

test('obtenerHistorial respeta el limite quedandose con los MAS RECIENTES', async () => {
  for (let i = 1; i <= 5; i++) await insertarEntrante(entrante(`wamid.${i}`, `msg${i}`))

  const h = await obtenerHistorial(conversacion.id, 3)
  assert.equal(h.length, 3)
  assert.deepEqual(h.map((m) => m.text), ['msg3', 'msg4', 'msg5'])
})

test('obtenerHistorial excluye mensajes sin texto (audio, imagenes)', async () => {
  await insertarEntrante(entrante('wamid.txt', 'con texto'))
  await insertarEntrante({ ...entrante('wamid.audio'), type: 'audio', text: null })

  const h = await obtenerHistorial(conversacion.id, 10)
  assert.equal(h.length, 1)
  assert.equal(h[0].text, 'con texto')
})

test('marcarProcesado y marcarError cambian el estado', async () => {
  const a = await insertarEntrante(entrante('wamid.ok'))
  await marcarProcesado(a.id)
  const [f1] = await pool.query('SELECT status FROM messages WHERE id = ?', [a.id])
  assert.equal(f1[0].status, 'processed')

  const b = await insertarEntrante(entrante('wamid.mal'))
  await marcarError(b.id, 'OpenAI timeout')
  const [f2] = await pool.query('SELECT status, error_text FROM messages WHERE id = ?', [b.id])
  assert.equal(f2[0].status, 'error')
  assert.equal(f2[0].error_text, 'OpenAI timeout')
})
