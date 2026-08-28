import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import request from 'supertest'
import { limpiarBase, cerrarBase } from '../helpers/db.js'
import { crearApp } from '../../src/app.js'
import { crearOrquestador } from '../../src/core/handleMessage.js'
import pool from '../../src/db/pool.js'

const VERIFY_TOKEN = 'token_de_verificacion'
const APP_SECRET = 'app_secret_de_prueba'

const fixture = (n) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8'))

const firmar = (cuerpo) =>
  'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(cuerpo).digest('hex')

function armarApp({ respuestaIA = 'Respuesta del bot', errorIA = null } = {}) {
  const enviados = []
  const pendientes = []

  const orquestador = crearOrquestador({
    ia: {
      responder: async () => {
        if (errorIA) throw errorIA
        return respuestaIA
      },
    },
    clienteWhatsApp: {
      enviarTexto: async (to, texto) => {
        enviados.push({ to, texto })
        return { waMessageId: 'wamid.OUT' + enviados.length }
      },
      marcarLeido: async () => {},
    },
  })

  const app = crearApp({
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
    orquestador,
    // En produccion es setImmediate; aca guardamos la promesa para poder
    // esperarla y que el test sea determinista.
    alProcesar: (ctx) => { pendientes.push(orquestador.procesar(ctx)) },
  })

  return { app, enviados, esperarProcesamiento: () => Promise.all(pendientes) }
}

const postear = (app, cuerpo, firma) => {
  const req = request(app).post('/webhook').set('Content-Type', 'application/json')
  if (firma !== null) req.set('X-Hub-Signature-256', firma ?? firmar(cuerpo))
  return req.send(cuerpo)
}

beforeEach(async () => { await limpiarBase() })
after(async () => { await cerrarBase() })

test('GET /webhook devuelve el challenge con el token correcto', async () => {
  const { app } = armarApp()
  const res = await request(app).get('/webhook').query({
    'hub.mode': 'subscribe',
    'hub.verify_token': VERIFY_TOKEN,
    'hub.challenge': '1234567890',
  })
  assert.equal(res.status, 200)
  assert.equal(res.text, '1234567890')
})

test('GET /webhook rechaza un token incorrecto', async () => {
  const { app } = armarApp()
  const res = await request(app).get('/webhook').query({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'token_equivocado',
    'hub.challenge': '1234567890',
  })
  assert.equal(res.status, 403)
})

test('POST /webhook rechaza firma invalida con 403 y no persiste nada', async () => {
  const { app } = armarApp()
  const res = await postear(app, JSON.stringify(fixture('webhook-texto')), 'sha256=' + 'f'.repeat(64))

  assert.equal(res.status, 403)
  const [m] = await pool.query('SELECT COUNT(*) AS n FROM messages')
  assert.equal(m[0].n, 0)
})

test('POST /webhook sin header de firma devuelve 403', async () => {
  const { app } = armarApp()
  const res = await postear(app, JSON.stringify(fixture('webhook-texto')), null)
  assert.equal(res.status, 403)
})

test('POST /webhook con firma valida responde 200 y procesa el mensaje', async () => {
  const { app, enviados, esperarProcesamiento } = armarApp()
  const res = await postear(app, JSON.stringify(fixture('webhook-texto')))

  assert.equal(res.status, 200)
  await esperarProcesamiento()

  assert.equal(enviados.length, 1)
  assert.equal(enviados[0].to, '5492235042643')
  assert.equal(enviados[0].texto, 'Respuesta del bot')

  const [m] = await pool.query('SELECT COUNT(*) AS n FROM messages')
  assert.equal(m[0].n, 2) // entrante + saliente
})

test('DEDUPLICACION end-to-end: el reintento de Meta no genera segunda respuesta', async () => {
  const { app, enviados, esperarProcesamiento } = armarApp()
  const cuerpo = JSON.stringify(fixture('webhook-texto'))
  const firma = firmar(cuerpo)

  assert.equal((await postear(app, cuerpo, firma)).status, 200)
  assert.equal((await postear(app, cuerpo, firma)).status, 200) // reintento de Meta

  await esperarProcesamiento()

  assert.equal(enviados.length, 1, 'el usuario debe recibir UNA sola respuesta')

  const [m] = await pool.query("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in'")
  assert.equal(m[0].n, 1)
})

test('POST /webhook con un audio responde el mensaje de solo texto', async () => {
  const { app, enviados, esperarProcesamiento } = armarApp()
  await postear(app, JSON.stringify(fixture('webhook-audio')))

  await esperarProcesamiento()
  assert.match(enviados[0].texto, /solo puedo leer mensajes de texto/i)
})

test('POST /webhook con un status devuelve 200 sin procesar nada', async () => {
  const { app, enviados, esperarProcesamiento } = armarApp()
  const res = await postear(app, JSON.stringify(fixture('webhook-status')))

  assert.equal(res.status, 200)
  await esperarProcesamiento()
  assert.equal(enviados.length, 0)

  const [m] = await pool.query('SELECT COUNT(*) AS n FROM messages')
  assert.equal(m[0].n, 0)
})

test('POST /webhook con JSON invalido devuelve 200, no 500', async () => {
  // Un cuerpo corrupto no se arregla reintentando: pedirle a Meta que
  // reintente seria un bucle infinito.
  const { app } = armarApp()
  const res = await postear(app, '{esto no es json')
  assert.equal(res.status, 200)
})

test('si la IA falla, el webhook igual responde 200 y el usuario recibe disculpa', async () => {
  const { app, enviados, esperarProcesamiento } = armarApp({ errorIA: new Error('OpenAI 503') })
  const res = await postear(app, JSON.stringify(fixture('webhook-texto')))

  assert.equal(res.status, 200, 'el fallo de la IA ocurre despues del ACK')
  await esperarProcesamiento()

  assert.equal(enviados.length, 1)
  assert.match(enviados[0].texto, /problema/i)
})

test('GET /health responde ok', async () => {
  const { app } = armarApp()
  const res = await request(app).get('/health')
  assert.equal(res.status, 200)
  assert.equal(res.body.status, 'ok')
})
