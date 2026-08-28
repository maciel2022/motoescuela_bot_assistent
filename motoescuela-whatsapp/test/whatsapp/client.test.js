import test from 'node:test'
import assert from 'node:assert/strict'
import { crearClienteWhatsApp } from '../../src/whatsapp/client.js'

const OPCIONES = {
  token: 'token_de_prueba',
  phoneNumberId: '222222222222222',
  graphVersion: 'v21.0',
  esperaBase: 0, // sin esperas reales en los tests
}

function fetchFalso(respuestas) {
  const llamadas = []
  const impl = async (url, opciones) => {
    llamadas.push({ url, opciones, body: JSON.parse(opciones.body) })
    const r = respuestas.shift() ?? { ok: true, status: 200, json: { messages: [{ id: 'wamid.OUT' }] } }
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.json,
      text: async () => JSON.stringify(r.json),
    }
  }
  impl.llamadas = llamadas
  return impl
}

test('enviarTexto llama al endpoint correcto con el cuerpo correcto', async () => {
  const fetchImpl = fetchFalso([])
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })

  const r = await cliente.enviarTexto('5492235042643', 'Hola!')

  assert.equal(fetchImpl.llamadas.length, 1)
  const { url, opciones, body } = fetchImpl.llamadas[0]
  assert.equal(url, 'https://graph.facebook.com/v21.0/222222222222222/messages')
  assert.equal(opciones.method, 'POST')
  assert.equal(opciones.headers.Authorization, 'Bearer token_de_prueba')
  assert.equal(body.messaging_product, 'whatsapp')
  assert.equal(body.to, '5492235042643')
  assert.equal(body.type, 'text')
  assert.equal(body.text.body, 'Hola!')
  assert.equal(r.waMessageId, 'wamid.OUT')
})

test('enviarTexto reintenta ante un error 500 y termina bien', async () => {
  const fetchImpl = fetchFalso([
    { ok: false, status: 500, json: { error: { message: 'server error' } } },
    { ok: true, status: 200, json: { messages: [{ id: 'wamid.SEGUNDO' }] } },
  ])
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })

  const r = await cliente.enviarTexto('5492235042643', 'Hola!')
  assert.equal(fetchImpl.llamadas.length, 2)
  assert.equal(r.waMessageId, 'wamid.SEGUNDO')
})

test('enviarTexto lanza tras agotar los reintentos', async () => {
  const fetchImpl = fetchFalso([
    { ok: false, status: 500, json: { error: { message: 'a' } } },
    { ok: false, status: 500, json: { error: { message: 'b' } } },
    { ok: false, status: 500, json: { error: { message: 'c' } } },
  ])
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl, reintentos: 2 })

  await assert.rejects(() => cliente.enviarTexto('549223', 'Hola'), /Graph API/)
  assert.equal(fetchImpl.llamadas.length, 3) // 1 intento + 2 reintentos
})

test('un error 400 NO se reintenta (es culpa nuestra, no transitorio)', async () => {
  const fetchImpl = fetchFalso([
    { ok: false, status: 400, json: { error: { message: 'numero invalido' } } },
  ])
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })

  await assert.rejects(() => cliente.enviarTexto('malo', 'Hola'), /numero invalido/)
  assert.equal(fetchImpl.llamadas.length, 1)
})

test('marcarLeido envia el cuerpo correcto y nunca lanza si falla', async () => {
  const fetchImpl = fetchFalso([{ ok: true, status: 200, json: {} }])
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })

  await cliente.marcarLeido('wamid.ABC')
  assert.equal(fetchImpl.llamadas[0].body.status, 'read')
  assert.equal(fetchImpl.llamadas[0].body.message_id, 'wamid.ABC')

  const fallando = fetchFalso([{ ok: false, status: 500, json: { error: { message: 'x' } } }])
  const cliente2 = crearClienteWhatsApp({ ...OPCIONES, fetchImpl: fallando, reintentos: 0 })
  await cliente2.marcarLeido('wamid.ABC') // no debe lanzar
})

test('enviarTexto corta el texto a 4096 caracteres (limite de WhatsApp)', async () => {
  const fetchImpl = fetchFalso([])
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })

  await cliente.enviarTexto('549223', 'x'.repeat(5000))
  assert.equal(fetchImpl.llamadas[0].body.text.body.length, 4096)
})

test('un error de RED se reintenta igual que un 5xx', async () => {
  // El fallo mas comun no es un 500 sino que fetch rechace: DNS caido,
  // ECONNRESET, TLS. Si eso escapa del bucle, el reintento nunca ocurre
  // justo en el caso para el que existe.
  let llamadas = 0
  const fetchImpl = async () => {
    llamadas++
    if (llamadas === 1) throw new TypeError('fetch failed')
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.TRAS_RED' }] }) }
  }

  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })
  const r = await cliente.enviarTexto('549223', 'Hola')

  assert.equal(llamadas, 2)
  assert.equal(r.waMessageId, 'wamid.TRAS_RED')
})

test('un error de red persistente lanza tras agotar los reintentos', async () => {
  let llamadas = 0
  const fetchImpl = async () => { llamadas++; throw new TypeError('fetch failed') }

  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl, reintentos: 2 })

  await assert.rejects(() => cliente.enviarTexto('549223', 'Hola'), /fetch failed/)
  assert.equal(llamadas, 3)
})

test('cada request lleva un AbortSignal para no colgarse indefinidamente', async () => {
  const fetchImpl = fetchFalso([])
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })

  await cliente.enviarTexto('549223', 'Hola')
  const { signal } = fetchImpl.llamadas[0].opciones
  assert.ok(signal instanceof AbortSignal, 'falta el signal de timeout')
})

test('marcarLeido tampoco lanza ante un error de red', async () => {
  const fetchImpl = async () => { throw new TypeError('fetch failed') }
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl, reintentos: 0 })
  await cliente.marcarLeido('wamid.ABC') // no debe lanzar
})
