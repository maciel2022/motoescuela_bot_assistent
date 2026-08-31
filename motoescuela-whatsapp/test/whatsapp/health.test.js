import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { crearApp } from '../../src/app.js'
import pool from '../../src/db/pool.js'

const appCon = (verificarBase) =>
  crearApp({
    verifyToken: 'v',
    appSecret: 's',
    orquestador: { ingest: async () => ({ duplicado: true }), procesar: async () => {} },
    alProcesar: () => {},
    verificarBase,
  })

after(async () => { await pool.end() })

test('/health devuelve 200 solo si la base responde', async () => {
  const res = await request(appCon(async () => true)).get('/health')
  assert.equal(res.status, 200)
  assert.equal(res.body.status, 'ok')
  assert.equal(res.body.base, 'ok')
})

test('/health devuelve 503 con la base caida', async () => {
  // Antes devolvia {"status":"ok"} cableado. Un monitor de uptime veia verde
  // mientras el bot rechazaba el 100% de los mensajes.
  const res = await request(appCon(async () => { throw new Error('ECONNREFUSED') })).get('/health')

  assert.equal(res.status, 503)
  assert.equal(res.body.status, 'degradado')
  assert.equal(res.body.base, 'error')
})

test('/health contra la base real responde 200', async () => {
  const res = await request(crearApp({
    verifyToken: 'v', appSecret: 's',
    orquestador: { ingest: async () => ({ duplicado: true }), procesar: async () => {} },
    alProcesar: () => {},
  })).get('/health')

  assert.equal(res.status, 200)
})
