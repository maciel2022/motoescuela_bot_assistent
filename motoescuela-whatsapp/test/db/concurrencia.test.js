import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { limpiarBase, cerrarBase } from '../helpers/db.js'
import { upsertContacto } from '../../src/db/repos/contacts.js'
import { obtenerOCrearConversacion } from '../../src/db/repos/conversations.js'
import { insertarEntrante } from '../../src/db/repos/messages.js'
import pool from '../../src/db/pool.js'

beforeEach(async () => { await limpiarBase() })
after(async () => { await cerrarBase() })

test('DEDUPLICACION concurrente: 4 webhooks identicos simultaneos crean 1 sola fila', async () => {
  // Meta puede reintentar un webhook mientras el primero sigue procesandose.
  // La garantia central del disenio es que el indice unico lo resuelva, no
  // una comprobacion previa en la aplicacion (que tendria su propia carrera).
  const contacto = await upsertContacto('5492235042643', 'Maciel')
  const conv = await obtenerOCrearConversacion(contacto.id)

  const uno = () =>
    insertarEntrante({
      conversationId: conv.id,
      contactId: contacto.id,
      waMessageId: 'wamid.CONCURRENTE',
      type: 'text',
      text: 'hola',
      raw: null,
      waTimestamp: null,
    })

  const resultados = await Promise.all([uno(), uno(), uno(), uno()])

  const insertados = resultados.filter((r) => r !== null)
  const duplicados = resultados.filter((r) => r === null)
  assert.equal(insertados.length, 1, 'exactamente uno debe insertar')
  assert.equal(duplicados.length, 3, 'los otros tres deben devolver null')

  const [filas] = await pool.query('SELECT COUNT(*) AS n FROM messages')
  assert.equal(filas[0].n, 1)
})

test('obtenerOCrearConversacion concurrente no crea conversaciones duplicadas', async () => {
  // Es un check-then-act: dos webhooks simultaneos del mismo contacto pueden
  // ver ambos "no hay conversacion" antes de que ninguno inserte.
  // Si se parte en dos, el historial del usuario se divide y el bot parece
  // perder el contexto (criterio de aceptacion 3).
  const contacto = await upsertContacto('5492235042643', 'Maciel')

  const resultados = await Promise.all(
    Array.from({ length: 6 }, () => obtenerOCrearConversacion(contacto.id))
  )

  const ids = new Set(resultados.map((c) => c.id))
  assert.equal(ids.size, 1, `se crearon ${ids.size} conversaciones distintas`)

  const [filas] = await pool.query(
    "SELECT COUNT(*) AS n FROM conversations WHERE contact_id = ? AND status = 'open'",
    [contacto.id]
  )
  assert.equal(filas[0].n, 1, 'debe haber exactamente una conversacion abierta')
})

test('upsertContacto concurrente no duplica el contacto', async () => {
  const resultados = await Promise.all(
    Array.from({ length: 6 }, () => upsertContacto('5491199999999', 'Concurrente'))
  )

  const ids = new Set(resultados.map((c) => c.id))
  assert.equal(ids.size, 1)

  const [filas] = await pool.query('SELECT COUNT(*) AS n FROM contacts WHERE wa_id = ?', ['5491199999999'])
  assert.equal(filas[0].n, 1)
})
