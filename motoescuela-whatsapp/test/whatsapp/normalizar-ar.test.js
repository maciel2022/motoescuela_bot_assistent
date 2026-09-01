import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizarDestinatarioAr, crearClienteWhatsApp } from '../../src/whatsapp/client.js'

test('quita el 9 de un celular argentino', () => {
  // Meta guarda la lista de autorizados del numero de prueba sin el 9, pero
  // los webhooks entrantes traen el wa_id CON 9. Valida la lista antes de
  // normalizar, asi que rechaza el mismo numero que despues convierte.
  assert.equal(normalizarDestinatarioAr('5492235042643'), '542235042643')
  assert.equal(normalizarDestinatarioAr('5491133334444'), '541133334444')
})

test('deja intacto un numero argentino que ya viene sin el 9', () => {
  assert.equal(normalizarDestinatarioAr('542235042643'), '542235042643')
})

test('no toca numeros de otros paises', () => {
  assert.equal(normalizarDestinatarioAr('5511987654321'), '5511987654321') // Brasil
  assert.equal(normalizarDestinatarioAr('15550001111'), '15550001111')     // EEUU
  assert.equal(normalizarDestinatarioAr('34612345678'), '34612345678')     // Espania
})

test('no rompe con entradas raras', () => {
  for (const v of [null, undefined, '', '549', 'no-es-un-numero']) {
    assert.doesNotThrow(() => normalizarDestinatarioAr(v))
  }
})

test('el cliente NO normaliza por defecto', async () => {
  let enviado
  const fetchImpl = async (_u, o) => {
    enviado = JSON.parse(o.body)
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.X' }] }) }
  }
  const cliente = crearClienteWhatsApp({ token: 't', phoneNumberId: '1', fetchImpl })

  await cliente.enviarTexto('5492235042643', 'hola')
  assert.equal(enviado.to, '5492235042643', 'en produccion el numero va tal cual')
})

test('el cliente normaliza solo si se enciende la opcion', async () => {
  let enviado
  const fetchImpl = async (_u, o) => {
    enviado = JSON.parse(o.body)
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.X' }] }) }
  }
  const cliente = crearClienteWhatsApp({ token: 't', phoneNumberId: '1', fetchImpl, normalizarAr: true })

  await cliente.enviarTexto('5492235042643', 'hola')
  assert.equal(enviado.to, '542235042643')
})
