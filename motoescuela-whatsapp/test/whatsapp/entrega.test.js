import test from 'node:test'
import assert from 'node:assert/strict'
import { crearClienteWhatsApp, ErrorPosibleEntrega } from '../../src/whatsapp/client.js'

const OPCIONES = { token: 't', phoneNumberId: '222', graphVersion: 'v21.0', esperaBase: 0 }

const errorCon = (code) => Object.assign(new Error('fallo de red'), { code })

function contador(impl) {
  let n = 0
  const f = async (...args) => { n++; return impl(n, ...args) }
  f.veces = () => n
  return f
}

const ok = { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.OUT' }] }) }
const httpErr = (status, message = 'x') => ({ ok: false, status, json: async () => ({ error: { message } }) })

test('un timeout NO se reintenta al enviar: el mensaje pudo haberse entregado', async () => {
  const fetchImpl = contador(async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }) })
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })

  await assert.rejects(() => cliente.enviarTexto('549', 'hola'), ErrorPosibleEntrega)
  assert.equal(fetchImpl.veces(), 1, 'un solo intento: reintentar duplicaria el mensaje')
})

test('un ECONNRESET tampoco se reintenta al enviar', async () => {
  const fetchImpl = contador(async () => { throw errorCon('ECONNRESET') })
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })

  await assert.rejects(() => cliente.enviarTexto('549', 'hola'), ErrorPosibleEntrega)
  assert.equal(fetchImpl.veces(), 1)
})

test('un 500 tampoco: Graph ya recibio la request', async () => {
  const fetchImpl = contador(async () => httpErr(500, 'server error'))
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })

  await assert.rejects(() => cliente.enviarTexto('549', 'hola'), ErrorPosibleEntrega)
  assert.equal(fetchImpl.veces(), 1)
})

test('un ECONNREFUSED SI se reintenta: prueba que nunca salio', async () => {
  const fetchImpl = contador(async (n) => {
    if (n === 1) throw errorCon('ECONNREFUSED')
    return ok
  })
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })

  const r = await cliente.enviarTexto('549', 'hola')
  assert.equal(fetchImpl.veces(), 2)
  assert.equal(r.waMessageId, 'wamid.OUT')
})

test('un fallo de DNS se reintenta', async () => {
  const fetchImpl = contador(async (n) => {
    if (n === 1) throw errorCon('ENOTFOUND')
    return ok
  })
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })
  await cliente.enviarTexto('549', 'hola')
  assert.equal(fetchImpl.veces(), 2)
})

test('un 429 se reintenta: la API lo rechazo sin entregarlo', async () => {
  const fetchImpl = contador(async (n) => (n === 1 ? httpErr(429, 'rate limited') : ok))
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })
  await cliente.enviarTexto('549', 'hola')
  assert.equal(fetchImpl.veces(), 2)
})

test('un 400 sigue sin reintentarse y no es ErrorPosibleEntrega', async () => {
  const fetchImpl = contador(async () => httpErr(400, 'numero invalido'))
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })

  await assert.rejects(() => cliente.enviarTexto('malo', 'hola'), (e) => {
    assert.ok(!(e instanceof ErrorPosibleEntrega), 'un 400 prueba que NO se entrego')
    assert.match(e.message, /numero invalido/)
    return true
  })
  assert.equal(fetchImpl.veces(), 1)
})

test('marcarLeido SI reintenta timeouts: es idempotente', async () => {
  const fetchImpl = contador(async (n) => {
    if (n < 3) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' })
    return { ok: true, status: 200, json: async () => ({}) }
  })
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })

  await cliente.marcarLeido('wamid.X')
  assert.equal(fetchImpl.veces(), 3)
})

test('si la respuesta 200 no se puede leer, el mensaje se da por enviado', async () => {
  // res.json() se devolvia sin await, asi que su rechazo escapaba del try:
  // sin reintento, pero propagando. El saliente no se guardaba y el usuario
  // recibia la respuesta correcta MAS la disculpa.
  const fetchImpl = contador(async () => ({
    ok: true, status: 200,
    json: async () => { throw new Error('socket hang up al leer el cuerpo') },
  }))
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })

  const r = await cliente.enviarTexto('549', 'hola')
  assert.equal(r.waMessageId, null, 'sin id, pero entregado')
  assert.equal(fetchImpl.veces(), 1)
})

test('el truncado a 4096 no parte un par surrogado', async () => {
  // .slice() cuenta unidades UTF-16: cortar en medio de un emoji deja un
  // surrogate suelto y el JSON sale malformado.
  let enviado
  const fetchImpl = async (_url, opciones) => { enviado = JSON.parse(opciones.body); return ok }
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })

  await cliente.enviarTexto('549', 'á'.repeat(4095) + '😊' + 'resto')

  const cuerpo = enviado.text.body
  assert.ok(cuerpo.isWellFormed(), 'el texto no debe tener surrogates sueltos')
  assert.ok([...cuerpo].length <= 4096)
})

test('el truncado cuenta puntos de codigo, no unidades UTF-16', async () => {
  let enviado
  const fetchImpl = async (_url, opciones) => { enviado = JSON.parse(opciones.body); return ok }
  const cliente = crearClienteWhatsApp({ ...OPCIONES, fetchImpl })

  await cliente.enviarTexto('549', '😊'.repeat(5000))

  assert.equal([...enviado.text.body].length, 4096)
  assert.ok(enviado.text.body.isWellFormed())
})
