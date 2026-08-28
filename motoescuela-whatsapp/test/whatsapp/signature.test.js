import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { esFirmaValida } from '../../src/whatsapp/signature.js'

const SECRETO = 'app_secret_de_prueba'
const cuerpo = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }))

function firmar(buf, secreto = SECRETO) {
  return 'sha256=' + crypto.createHmac('sha256', secreto).update(buf).digest('hex')
}

test('acepta una firma correcta', () => {
  assert.equal(esFirmaValida(cuerpo, firmar(cuerpo), SECRETO), true)
})

test('rechaza una firma generada con otro secreto', () => {
  assert.equal(esFirmaValida(cuerpo, firmar(cuerpo, 'otro_secreto'), SECRETO), false)
})

test('rechaza cuando el cuerpo fue alterado', () => {
  const firma = firmar(cuerpo)
  const alterado = Buffer.from(JSON.stringify({ object: 'alterado' }))
  assert.equal(esFirmaValida(alterado, firma, SECRETO), false)
})

test('rechaza si el header falta', () => {
  assert.equal(esFirmaValida(cuerpo, undefined, SECRETO), false)
})

test('rechaza si el header no tiene el prefijo sha256=', () => {
  const sinPrefijo = crypto.createHmac('sha256', SECRETO).update(cuerpo).digest('hex')
  assert.equal(esFirmaValida(cuerpo, sinPrefijo, SECRETO), false)
})

test('rechaza un header de longitud distinta sin lanzar excepcion', () => {
  assert.equal(esFirmaValida(cuerpo, 'sha256=abc', SECRETO), false)
})
