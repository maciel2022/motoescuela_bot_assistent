import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parsearWebhook } from '../../src/whatsapp/parse.js'

const fixture = (n) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8'))

test('extrae un mensaje de texto con todos sus campos', () => {
  const { mensajes, estados } = parsearWebhook(fixture('webhook-texto'))
  assert.equal(mensajes.length, 1)
  assert.equal(estados.length, 0)

  const m = mensajes[0]
  assert.equal(m.waMessageId, 'wamid.HBgNTQ5MjIzNTA0MjY0MxUCABIYIDNBMDAwMDAwMDAwMDAwMDAA')
  assert.equal(m.from, '5492235042643')
  assert.equal(m.profileName, 'Maciel')
  assert.equal(m.type, 'text')
  assert.equal(m.text, 'Hola, que precio tiene la clase?')
  assert.ok(m.timestamp instanceof Date)
  assert.equal(m.timestamp.getTime(), 1756400000 * 1000)
})

test('un mensaje de audio se extrae con text nulo', () => {
  const { mensajes } = parsearWebhook(fixture('webhook-audio'))
  assert.equal(mensajes.length, 1)
  assert.equal(mensajes[0].type, 'audio')
  assert.equal(mensajes[0].text, null)
  assert.equal(mensajes[0].profileName, 'Maciel')
})

test('un webhook de estados no produce mensajes', () => {
  const { mensajes, estados } = parsearWebhook(fixture('webhook-status'))
  assert.equal(mensajes.length, 0)
  assert.equal(estados.length, 1)
  assert.equal(estados[0].status, 'delivered')
})

test('un payload vacio o malformado devuelve listas vacias sin lanzar', () => {
  for (const entrada of [{}, null, undefined, { entry: null }, { entry: [{}] }, { entry: [{ changes: [{}] }] }]) {
    const r = parsearWebhook(entrada)
    assert.deepEqual(r.mensajes, [])
    assert.deepEqual(r.estados, [])
  }
})

test('procesa multiples entries y changes en un mismo payload', () => {
  const uno = fixture('webhook-texto')
  const doble = { object: 'whatsapp_business_account', entry: [uno.entry[0], uno.entry[0]] }
  assert.equal(parsearWebhook(doble).mensajes.length, 2)
})

test('guarda el objeto original del mensaje en raw', () => {
  const { mensajes } = parsearWebhook(fixture('webhook-audio'))
  assert.equal(mensajes[0].raw.audio.id, '999888777')
})

test('un timestamp ausente o invalido produce null, no una fecha imposible', () => {
  // new Date(0) es 1970-01-01T00:00:00Z, un segundo por debajo del minimo de
  // un TIMESTAMP de MySQL: en modo estricto el INSERT falla, el webhook
  // devuelve 500 y Meta reintenta ese mensaje para siempre.
  const armar = (timestamp) => ({
    entry: [{ changes: [{ value: { messages: [{ from: '549223', id: 'wamid.X', type: 'text', text: { body: 'hola' }, ...(timestamp === undefined ? {} : { timestamp }) }] } }] }],
  })

  for (const malo of [undefined, null, '', 'no-es-un-numero', '0', '-5']) {
    const { mensajes } = parsearWebhook(armar(malo))
    assert.equal(mensajes.length, 1)
    assert.equal(mensajes[0].timestamp, null, `timestamp=${JSON.stringify(malo)} deberia dar null`)
  }

  const { mensajes } = parsearWebhook(armar('1756400000'))
  assert.equal(mensajes[0].timestamp.getTime(), 1756400000 * 1000)
})
