import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { limpiarBase, cerrarBase } from '../helpers/db.js'
import { crearOrquestador } from '../../src/core/handleMessage.js'
import * as reposMensajes from '../../src/db/repos/messages.js'
import * as reposContactos from '../../src/db/repos/contacts.js'
import * as reposConversaciones from '../../src/db/repos/conversations.js'
import pool from '../../src/db/pool.js'

const mensaje = (waMessageId, text = 'hola') => ({
  waMessageId,
  from: '5492235042643',
  profileName: 'Maciel',
  type: 'text',
  text,
  timestamp: new Date('2026-08-28T12:00:00Z'),
  raw: { id: waMessageId, type: 'text' },
})

const dobles = () => ({
  ia: { responder: async () => 'respuesta' },
  clienteWhatsApp: {
    enviarTexto: async () => ({ waMessageId: 'wamid.OUT' }),
    marcarLeido: async () => {},
  },
})

const contar = async (tabla) => {
  const [f] = await pool.query(`SELECT COUNT(*) AS n FROM ${tabla}`)
  return f[0].n
}

beforeEach(async () => { await limpiarBase() })
after(async () => { await cerrarBase() })

test('ATOMICIDAD: si falla un paso posterior al INSERT, no queda NADA persistido', async () => {
  // Este es el bug critico. insertarEntrante commitea la fila que ES el
  // mecanismo de deduplicacion. Si un paso posterior falla, el webhook
  // devuelve 500, Meta reintenta, el indice unico descarta el mensaje como
  // duplicado, y nadie lo procesa nunca. El mensaje del usuario desaparece.
  const repos = {
    ...reposContactos,
    ...reposConversaciones,
    ...reposMensajes,
    tocarConversacion: async () => { throw new Error('fallo simulado de MySQL') },
  }
  const orq = crearOrquestador({ ...dobles(), repos })

  await assert.rejects(() => orq.ingest(mensaje('wamid.ATOMICO')), /fallo simulado/)

  assert.equal(await contar('messages'), 0, 'el mensaje NO debe quedar persistido')
  assert.equal(await contar('conversations'), 0, 'la conversacion NO debe quedar persistida')
  assert.equal(await contar('contacts'), 0, 'el contacto NO debe quedar persistido')
})

test('ATOMICIDAD: tras el rollback, el reintento de Meta funciona de verdad', async () => {
  let fallar = true
  const repos = {
    ...reposContactos,
    ...reposConversaciones,
    ...reposMensajes,
    tocarConversacion: async (...args) => {
      if (fallar) throw new Error('fallo transitorio')
      return reposConversaciones.tocarConversacion(...args)
    },
  }
  const orq = crearOrquestador({ ...dobles(), repos })

  // Primer intento: falla y deja la base como estaba.
  await assert.rejects(() => orq.ingest(mensaje('wamid.REINTENTO')))

  // Meta reintenta el mismo payload. Ahora tiene que entrar, NO ser
  // descartado como duplicado.
  fallar = false
  const ctx = await orq.ingest(mensaje('wamid.REINTENTO'))

  assert.equal(ctx.duplicado, false, 'el reintento NO debe verse como duplicado')
  assert.ok(ctx.messageId > 0)
  assert.equal(await contar('messages'), 1)
})

test('ATOMICIDAD: un fallo en insertarEntrante tampoco deja contacto huerfano', async () => {
  const orq = crearOrquestador(dobles())
  // wa_message_id de mas de 128 caracteres: el INSERT falla por longitud.
  await assert.rejects(() => orq.ingest(mensaje('w'.repeat(200))))

  assert.equal(await contar('contacts'), 0)
  assert.equal(await contar('conversations'), 0)
})

test('un duplicado real sigue detectandose y no deja basura', async () => {
  const orq = crearOrquestador(dobles())

  const primero = await orq.ingest(mensaje('wamid.DUP'))
  assert.equal(primero.duplicado, false)

  const segundo = await orq.ingest(mensaje('wamid.DUP'))
  assert.equal(segundo.duplicado, true)

  assert.equal(await contar('messages'), 1)
  assert.equal(await contar('contacts'), 1)
  assert.equal(await contar('conversations'), 1)
})

test('ingest concurrente sigue creando una sola conversacion, ahora con transacciones', async () => {
  // El re-SELECT tras ER_DUP_ENTRY tiene que ser una lectura con bloqueo:
  // en REPEATABLE READ una lectura comun no ve lo que commiteo la otra
  // transaccion despues de que la nuestra empezo.
  const orq = crearOrquestador(dobles())

  const resultados = await Promise.all(
    Array.from({ length: 6 }, (_, i) => orq.ingest(mensaje(`wamid.CONC.${i}`)))
  )

  assert.equal(resultados.filter((r) => !r.duplicado).length, 6)
  const ids = new Set(resultados.map((r) => r.conversationId))
  assert.equal(ids.size, 1, `se crearon ${ids.size} conversaciones`)
  assert.equal(await contar('conversations'), 1)
})
