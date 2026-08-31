import test from 'node:test'
import assert from 'node:assert/strict'
import { crearRastreador } from '../../src/core/enVuelo.js'

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

test('cuenta el trabajo en vuelo y lo descuenta al terminar', async () => {
  const r = crearRastreador()
  assert.equal(r.cantidad(), 0)

  const tarea = r.rastrear(dormir(30))
  assert.equal(r.cantidad(), 1)

  await tarea
  assert.equal(r.cantidad(), 0)
})

test('esperar() resuelve cuando el trabajo termina', async () => {
  const r = crearRastreador()
  r.rastrear(dormir(20))
  r.rastrear(dormir(40))

  await r.esperar(1000)
  assert.equal(r.cantidad(), 0)
})

test('esperar() respeta el tope y no se cuelga para siempre', async () => {
  const r = crearRastreador()
  r.rastrear(dormir(5000))

  const inicio = Date.now()
  const { completo } = await r.esperar(100)

  assert.equal(completo, false, 'debe reportar que no llego a terminar')
  assert.ok(Date.now() - inicio < 1000, 'no debe esperar los 5 segundos')
})

test('una tarea que rechaza NO propaga ni deja el contador colgado', async () => {
  // Este rastreador envuelve trabajo desacoplado: si dejara escapar un
  // rechazo, Node 22 mataria el proceso por unhandledRejection.
  const r = crearRastreador()
  const alFallar = []

  r.rastrear(Promise.reject(new Error('fallo desacoplado')), (err) => alFallar.push(err))

  await r.esperar(1000)
  assert.equal(r.cantidad(), 0)
  assert.equal(alFallar.length, 1)
  assert.match(alFallar[0].message, /fallo desacoplado/)
})

test('esperar() con nada en vuelo resuelve de inmediato', async () => {
  const r = crearRastreador()
  const { completo } = await r.esperar(1000)
  assert.equal(completo, true)
})
