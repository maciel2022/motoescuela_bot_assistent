import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { limpiarBase, cerrarBase } from '../helpers/db.js'
import { crearOrquestador } from '../../src/core/handleMessage.js'
import pool from '../../src/db/pool.js'

const mensajeBase = (waMessageId, { type = 'text', text = 'hola' } = {}) => ({
  waMessageId,
  from: '5492235042643',
  profileName: 'Maciel',
  type,
  text,
  timestamp: new Date('2026-08-28T12:00:00Z'),
  raw: { id: waMessageId, type },
})

function dobles({ respuestaIA = 'Respuesta del bot', errorIA = null } = {}) {
  const enviados = []
  const leidos = []
  const visto = {}
  return {
    enviados,
    leidos,
    visto,
    ia: {
      responder: async (pregunta, historial) => {
        if (errorIA) throw errorIA
        visto.historial = historial
        visto.pregunta = pregunta
        return respuestaIA
      },
    },
    clienteWhatsApp: {
      enviarTexto: async (to, texto) => {
        enviados.push({ to, texto })
        return { waMessageId: 'wamid.OUT' + enviados.length }
      },
      marcarLeido: async (id) => { leidos.push(id) },
    },
  }
}

beforeEach(async () => { await limpiarBase() })
after(async () => { await cerrarBase() })

test('ingest crea contacto, conversacion y mensaje', async () => {
  const orq = crearOrquestador(dobles())
  const r = await orq.ingest(mensajeBase('wamid.A'))

  assert.equal(r.duplicado, false)
  assert.ok(r.messageId > 0)
  assert.ok(r.conversationId > 0)

  for (const [tabla, esperado] of [['contacts', 1], ['conversations', 1], ['messages', 1]]) {
    const [f] = await pool.query(`SELECT COUNT(*) AS n FROM ${tabla}`)
    assert.equal(f[0].n, esperado, `${tabla} deberia tener ${esperado} fila(s)`)
  }
})

test('ingest del mismo wa_message_id devuelve duplicado y no crea nada nuevo', async () => {
  const orq = crearOrquestador(dobles())

  await orq.ingest(mensajeBase('wamid.REPE'))
  const segundo = await orq.ingest(mensajeBase('wamid.REPE'))

  assert.equal(segundo.duplicado, true)
  const [m] = await pool.query('SELECT COUNT(*) AS n FROM messages')
  assert.equal(m[0].n, 1)
})

test('procesar responde al usuario y guarda el saliente', async () => {
  const d = dobles({ respuestaIA: 'Las clases salen $10.000' })
  const orq = crearOrquestador(d)

  const ctx = await orq.ingest(mensajeBase('wamid.A', { text: 'cuanto sale?' }))
  await orq.procesar(ctx)

  assert.equal(d.enviados.length, 1)
  assert.equal(d.enviados[0].to, '5492235042643')
  assert.equal(d.enviados[0].texto, 'Las clases salen $10.000')
  assert.deepEqual(d.leidos, ['wamid.A'])

  const [salientes] = await pool.query("SELECT text, wa_message_id FROM messages WHERE direction = 'out'")
  assert.equal(salientes.length, 1)
  assert.equal(salientes[0].text, 'Las clases salen $10.000')
  assert.equal(salientes[0].wa_message_id, 'wamid.OUT1')

  const [entrante] = await pool.query('SELECT status FROM messages WHERE id = ?', [ctx.messageId])
  assert.equal(entrante[0].status, 'processed')
})

test('el historial que recibe la IA NO incluye la pregunta actual', async () => {
  const d = dobles()
  const orq = crearOrquestador(d)

  const c1 = await orq.ingest(mensajeBase('wamid.1', { text: 'primera' }))
  await orq.procesar(c1)

  const c2 = await orq.ingest(mensajeBase('wamid.2', { text: 'segunda' }))
  await orq.procesar(c2)

  assert.equal(d.visto.pregunta, 'segunda')
  const textos = d.visto.historial.map((m) => m.text)
  assert.deepEqual(textos, ['primera', 'Respuesta del bot'])
  assert.ok(!textos.includes('segunda'), 'la pregunta actual no debe estar en el historial')
})

test('un mensaje de audio recibe la respuesta fija de solo texto y no llama a la IA', async () => {
  const d = dobles({ errorIA: new Error('la IA no deberia haberse llamado') })
  const orq = crearOrquestador(d)

  const ctx = await orq.ingest(mensajeBase('wamid.AUD', { type: 'audio', text: null }))
  await orq.procesar(ctx)

  assert.equal(d.enviados.length, 1)
  assert.match(d.enviados[0].texto, /solo puedo leer mensajes de texto/i)

  const [f] = await pool.query('SELECT status FROM messages WHERE id = ?', [ctx.messageId])
  assert.equal(f[0].status, 'processed')
})

test('si la IA falla, el usuario recibe disculpa y el mensaje queda en error', async () => {
  const d = dobles({ errorIA: new Error('OpenAI 503') })
  const orq = crearOrquestador(d)

  const ctx = await orq.ingest(mensajeBase('wamid.ERR', { text: 'hola' }))
  await orq.procesar(ctx) // no debe lanzar

  assert.equal(d.enviados.length, 1)
  assert.match(d.enviados[0].texto, /problema/i)

  const [f] = await pool.query('SELECT status, error_text FROM messages WHERE id = ?', [ctx.messageId])
  assert.equal(f[0].status, 'error')
  assert.match(f[0].error_text, /OpenAI 503/)
})

test('procesar nunca lanza aunque falle tambien el envio', async () => {
  const d = dobles({ errorIA: new Error('OpenAI caido') })
  d.clienteWhatsApp.enviarTexto = async () => { throw new Error('Meta caido') }
  const orq = crearOrquestador(d)

  const ctx = await orq.ingest(mensajeBase('wamid.DOBLE'))
  await orq.procesar(ctx) // no debe lanzar

  const [f] = await pool.query('SELECT status FROM messages WHERE id = ?', [ctx.messageId])
  assert.equal(f[0].status, 'error')
})

test('procesar sobre un contexto duplicado no hace nada', async () => {
  const d = dobles()
  const orq = crearOrquestador(d)

  await orq.ingest(mensajeBase('wamid.X'))
  const dup = await orq.ingest(mensajeBase('wamid.X'))
  await orq.procesar(dup)

  assert.equal(d.enviados.length, 0)
})

test('procesar tolera un contexto nulo', async () => {
  const d = dobles()
  await crearOrquestador(d).procesar(null)
  assert.equal(d.enviados.length, 0)
})

test('la conversacion queda marcada con last_message_at', async () => {
  const d = dobles()
  const orq = crearOrquestador(d)

  const ctx = await orq.ingest(mensajeBase('wamid.TOCK'))
  await orq.procesar(ctx)

  const [f] = await pool.query('SELECT last_message_at FROM conversations WHERE id = ?', [ctx.conversationId])
  assert.ok(f[0].last_message_at instanceof Date)
})
