import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.js'

const envCompleto = {
  PORT: '3000',
  WHATSAPP_VERIFY_TOKEN: 'verifica',
  WHATSAPP_APP_SECRET: 'secreto',
  WHATSAPP_TOKEN: 'token',
  WHATSAPP_PHONE_NUMBER_ID: '123',
  OPENAI_API_KEY: 'sk-test',
  OPENAI_VECTOR_STORE_ID: 'vs_test',
  MYSQL_HOST: '127.0.0.1',
  MYSQL_USER: 'root',
  MYSQL_DATABASE: 'motoescuela_test',
}

test('loadConfig arma la configuración cuando están todas las variables', () => {
  const cfg = loadConfig(envCompleto)
  assert.equal(cfg.port, 3000)
  assert.equal(cfg.whatsapp.phoneNumberId, '123')
  assert.equal(cfg.openai.vectorStoreId, 'vs_test')
  assert.equal(cfg.mysql.database, 'motoescuela_test')
})

test('loadConfig aplica los valores por defecto', () => {
  const cfg = loadConfig(envCompleto)
  assert.equal(cfg.whatsapp.graphVersion, 'v21.0')
  assert.equal(cfg.openai.model, 'gpt-4o-mini')
  assert.equal(cfg.historyLimit, 10)
  assert.equal(cfg.mysql.port, 3306)
})

test('loadConfig lanza error nombrando TODAS las variables faltantes', () => {
  const incompleto = { ...envCompleto }
  delete incompleto.WHATSAPP_APP_SECRET
  delete incompleto.OPENAI_API_KEY
  assert.throws(
    () => loadConfig(incompleto),
    (err) =>
      err.message.includes('WHATSAPP_APP_SECRET') &&
      err.message.includes('OPENAI_API_KEY')
  )
})

test('la configuración es inmutable', () => {
  const cfg = loadConfig(envCompleto)
  assert.throws(() => { cfg.port = 9999 }, TypeError)
})

test('loadConfig rechaza variables numericas invalidas al arrancar', () => {
  // Fallar al arrancar es el punto de config.js. Un HISTORY_LIMIT o un PORT
  // mal escritos pasaban la validacion y rompian en runtime.
  for (const [clave, valor] of [['HISTORY_LIMIT', 'diez'], ['PORT', 'abc'], ['MYSQL_PORT', '?']]) {
    assert.throws(
      () => loadConfig({ ...envCompleto, [clave]: valor }),
      new RegExp(clave),
      `${clave}=${valor} deberia rechazarse`
    )
  }
})

test('loadConfig acepta valores numericos validos como cadena', () => {
  const cfg = loadConfig({ ...envCompleto, HISTORY_LIMIT: '25', PORT: '8080' })
  assert.equal(cfg.historyLimit, 25)
  assert.equal(cfg.port, 8080)
})
