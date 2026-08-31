import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { limpiarBase, cerrarBase } from '../helpers/db.js'
import { crearOrquestador } from '../../src/core/handleMessage.js'
import { ErrorPosibleEntrega } from '../../src/whatsapp/client.js'
import * as reposContactos from '../../src/db/repos/contacts.js'
import * as reposConversaciones from '../../src/db/repos/conversations.js'
import * as reposMensajes from '../../src/db/repos/messages.js'
import pool from '../../src/db/pool.js'

const mensaje = (waMessageId, text = 'cuanto sale?') => ({
  waMessageId, from: '5492235042643', profileName: 'Maciel',
  type: 'text', text, timestamp: new Date(), raw: null,
})

const dobles = (extra = {}) => {
  const enviados = []
  return {
    enviados,
    ia: { responder: async () => 'La clase sale $10.000' },
    clienteWhatsApp: {
      enviarTexto: async (to, texto) => { enviados.push(texto); return { waMessageId: 'wamid.OUT' + enviados.length } },
      marcarLeido: async () => {},
    },
    ...extra,
  }
}

beforeEach(async () => { await limpiarBase() })
after(async () => { await cerrarBase() })

test('si el mensaje YA se envio, un fallo posterior NO manda una disculpa encima', async () => {
  // El try abarcaba el envio Y la persistencia del saliente. Si MySQL fallaba
  // despues de que el mensaje ya habia salido, el catch mandaba MSG_ERROR:
  // el usuario veia la respuesta correcta y justo despues "tuve un problema".
  const d = dobles()
  const repos = {
    ...reposContactos, ...reposConversaciones, ...reposMensajes,
    insertarSaliente: async () => { throw new Error('MySQL cayo al guardar el saliente') },
  }
  const orq = crearOrquestador({ ...d, repos })

  const ctx = await orq.ingest(mensaje('wamid.UNA'))
  await orq.procesar(ctx)

  assert.equal(d.enviados.length, 1, 'el usuario debe recibir UN solo mensaje')
  assert.equal(d.enviados[0], 'La clase sale $10.000')
  assert.ok(!d.enviados.some((t) => /problema/i.test(t)), 'no debe llegar la disculpa')
})

test('si el envio falla de verdad, el usuario SI recibe la disculpa', async () => {
  const d = dobles()
  d.ia.responder = async () => { throw new Error('OpenAI 503') }
  const orq = crearOrquestador(d)

  const ctx = await orq.ingest(mensaje('wamid.DOS'))
  await orq.procesar(ctx)

  assert.equal(d.enviados.length, 1)
  assert.match(d.enviados[0], /problema/i)
})

test('procesar sobrevive a un rechazo que no es un Error', async () => {
  // El catch hacia err.message a ciegas. Un rechazo con undefined lanzaba un
  // TypeError DENTRO del catch, la promesa desacoplada quedaba rechazada sin
  // nadie observandola, y Node 22 mata el proceso por unhandledRejection.
  const d = dobles()
  d.ia.responder = async () => { throw undefined }
  const orq = crearOrquestador(d)

  const ctx = await orq.ingest(mensaje('wamid.TRES'))
  await orq.procesar(ctx) // no debe lanzar

  const [f] = await pool.query('SELECT status, error_text FROM messages WHERE id = ?', [ctx.messageId])
  assert.equal(f[0].status, 'error')
  assert.ok(f[0].error_text, 'debe registrar algo aunque el rechazo no sea un Error')
})

test('procesar sobrevive a un rechazo con un string', async () => {
  const d = dobles()
  d.ia.responder = async () => { throw 'algo salio mal' }
  const orq = crearOrquestador(d)

  const ctx = await orq.ingest(mensaje('wamid.CUATRO'))
  await orq.procesar(ctx)

  const [f] = await pool.query('SELECT status FROM messages WHERE id = ?', [ctx.messageId])
  assert.equal(f[0].status, 'error')
})

test('HISTORIAL: no se contamina con mensajes POSTERIORES del usuario', async () => {
  // Patron normalisimo en WhatsApp: dos mensajes seguidos. Ambos entran por
  // ingest y se procesan en paralelo. Con `id <> ?` el primero veia al segundo
  // presentado como contexto PREVIO, en orden invertido.
  const visto = {}
  const d = dobles()
  d.ia.responder = async (pregunta, historial) => {
    visto[pregunta] = historial.map((m) => m.text)
    return 'ok'
  }
  const orq = crearOrquestador(d)

  const a = await orq.ingest(mensaje('wamid.A', 'cuanto sale la clase?'))
  const b = await orq.ingest(mensaje('wamid.B', 'y a que hora abren?'))

  await orq.procesar(a)

  assert.deepEqual(
    visto['cuanto sale la clase?'],
    [],
    'el historial del primer mensaje no debe incluir el segundo, que llego despues'
  )

  await orq.procesar(b)
  assert.ok(visto['y a que hora abren?'].includes('cuanto sale la clase?'))
})

test('si el envio quedo en estado ambiguo, tampoco se manda disculpa', async () => {
  // Un timeout de la Graph API no prueba que el mensaje no haya llegado.
  // Mandar la disculpa arriesga que el usuario reciba respuesta + disculpa.
  const d = dobles()
  d.clienteWhatsApp.enviarTexto = async () => {
    throw new ErrorPosibleEntrega('Graph API no confirmo el envio: timeout')
  }
  const orq = crearOrquestador(d)

  const ctx = await orq.ingest(mensaje('wamid.AMBIGUO'))
  await orq.procesar(ctx)

  assert.equal(d.enviados.length, 0, 'no se envia nada mas')

  const [f] = await pool.query('SELECT status, error_text FROM messages WHERE id = ?', [ctx.messageId])
  assert.equal(f[0].status, 'error', 'pero queda registrado para el operador')
  assert.match(f[0].error_text, /no confirmo el envio/)
})
