import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import request from 'supertest'
import { limpiarBase, cerrarBase } from '../helpers/db.js'
import { crearApp } from '../../src/app.js'
import { crearOrquestador } from '../../src/core/handleMessage.js'
import { barrerPendientes } from '../../src/core/recuperacion.js'
import { obtenerPendientes } from '../../src/db/repos/messages.js'
import pool from '../../src/db/pool.js'

const APP_SECRET = 'app_secret_de_prueba'
const firmar = (c) => 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(c).digest('hex')

const payloadCon = (...mensajes) => ({
  object: 'whatsapp_business_account',
  entry: [{
    id: '1', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: '222' },
      contacts: [{ profile: { name: 'Maciel' }, wa_id: '5492235042643' }],
      messages: mensajes.map((m) => ({
        from: '5492235042643', id: m.id, timestamp: '1756400000',
        type: 'text', text: { body: m.text },
      })),
    } }],
  }],
})

const dobles = () => {
  const enviados = []
  return {
    enviados,
    ia: { responder: async (p) => 'respuesta a: ' + p },
    clienteWhatsApp: {
      enviarTexto: async (to, texto) => { enviados.push({ to, texto }); return { waMessageId: 'wamid.OUT' + enviados.length } },
      marcarLeido: async () => {},
    },
  }
}

beforeEach(async () => { await limpiarBase() })
after(async () => { await cerrarBase() })

test('LOTE: si falla un mensaje, los demas igual se procesan', async () => {
  // El webhook procesaba el lote en un bucle y abandonaba todo ante el primer
  // fallo. Los ya insertados quedaban huerfanos: el reintento de Meta los
  // descartaba como duplicados y nadie los respondia jamas.
  const d = dobles()
  const pendientes = []
  const base = crearOrquestador(d)

  const orquestador = {
    ingest: async (mensaje) => {
      if (mensaje.waMessageId === 'wamid.MALO') throw new Error('fallo simulado de MySQL')
      return base.ingest(mensaje)
    },
    procesar: base.procesar,
  }

  const app = crearApp({
    verifyToken: 'v', appSecret: APP_SECRET, orquestador,
    alProcesar: (ctx) => { pendientes.push(orquestador.procesar(ctx)) },
  })

  const cuerpo = JSON.stringify(payloadCon(
    { id: 'wamid.BUENO', text: 'primera pregunta' },
    { id: 'wamid.MALO', text: 'segunda pregunta' }
  ))

  const res = await request(app).post('/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', firmar(cuerpo))
    .send(cuerpo)

  // 500 para que Meta reintente el que fallo.
  assert.equal(res.status, 500)

  await Promise.all(pendientes)

  // Pero el bueno TIENE que haber sido respondido igual.
  assert.equal(d.enviados.length, 1, 'el mensaje que si se persistio debe responderse')
  assert.equal(d.enviados[0].texto, 'respuesta a: primera pregunta')
})

test('obtenerPendientes encuentra mensajes entrantes sin procesar y viejos', async () => {
  const d = dobles()
  const orq = crearOrquestador(d)
  const ctx = await orq.ingest({
    waMessageId: 'wamid.COLGADO', from: '5492235042643', profileName: 'Maciel',
    type: 'text', text: 'quedo colgado', timestamp: new Date(), raw: null,
  })

  // Recien insertado: todavia no es "viejo", puede estar procesandose.
  assert.equal((await obtenerPendientes(5)).length, 0)

  // Lo envejecemos artificialmente.
  await pool.query('UPDATE messages SET created_at = NOW() - INTERVAL 10 MINUTE WHERE id = ?', [ctx.messageId])

  const pendientes = await obtenerPendientes(5)
  assert.equal(pendientes.length, 1)
  assert.equal(pendientes[0].waMessageId, 'wamid.COLGADO')
  assert.equal(pendientes[0].from, '5492235042643')
  assert.equal(pendientes[0].text, 'quedo colgado')
})

test('BARRIDO: un mensaje huerfano de un reinicio termina siendo respondido', async () => {
  // Escenario real: el proceso muere entre el 200 OK y el procesamiento.
  // Sin barrido, ese mensaje queda en 'received' para siempre y el usuario
  // nunca recibe nada, sin ninguna senial para el operador.
  const d = dobles()
  const orq = crearOrquestador(d)

  const ctx = await orq.ingest({
    waMessageId: 'wamid.HUERFANO', from: '5492235042643', profileName: 'Maciel',
    type: 'text', text: 'hola, hay turno?', timestamp: new Date(), raw: null,
  })
  await pool.query('UPDATE messages SET created_at = NOW() - INTERVAL 10 MINUTE WHERE id = ?', [ctx.messageId])

  assert.equal(d.enviados.length, 0)

  const { recuperados } = await barrerPendientes({ orquestador: orq, antiguedadMinutos: 5 })

  assert.equal(recuperados, 1)
  assert.equal(d.enviados.length, 1)
  assert.equal(d.enviados[0].texto, 'respuesta a: hola, hay turno?')

  const [f] = await pool.query('SELECT status FROM messages WHERE id = ?', [ctx.messageId])
  assert.equal(f[0].status, 'processed')
})

test('BARRIDO: no toca mensajes ya procesados ni en error', async () => {
  const d = dobles()
  const orq = crearOrquestador(d)

  const a = await orq.ingest({ waMessageId: 'wamid.OK', from: '549223', profileName: null, type: 'text', text: 'uno', timestamp: new Date(), raw: null })
  await orq.procesar(a)
  d.enviados.length = 0

  await pool.query('UPDATE messages SET created_at = NOW() - INTERVAL 10 MINUTE')

  const { recuperados } = await barrerPendientes({ orquestador: orq, antiguedadMinutos: 5 })
  assert.equal(recuperados, 0)
  assert.equal(d.enviados.length, 0)
})

test('BARRIDO: no lanza si el procesamiento de un pendiente falla', async () => {
  const d = dobles()
  d.ia.responder = async () => { throw new Error('OpenAI caido') }
  const orq = crearOrquestador(d)

  const ctx = await orq.ingest({ waMessageId: 'wamid.FALLA', from: '549223', profileName: null, type: 'text', text: 'x', timestamp: new Date(), raw: null })
  await pool.query('UPDATE messages SET created_at = NOW() - INTERVAL 10 MINUTE WHERE id = ?', [ctx.messageId])

  await barrerPendientes({ orquestador: orq, antiguedadMinutos: 5 }) // no debe lanzar

  const [f] = await pool.query('SELECT status FROM messages WHERE id = ?', [ctx.messageId])
  assert.equal(f[0].status, 'error')
})
