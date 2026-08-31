import test from 'node:test'
import assert from 'node:assert/strict'
import { crearIAOpenAI } from '../../src/ia/openai.js'

function clienteFalso(respuesta, capturar = {}) {
  return {
    responses: {
      create: async (params) => {
        capturar.params = params
        if (respuesta instanceof Error) throw respuesta
        return respuesta
      },
    },
  }
}

const OPCIONES = { model: 'gpt-4o-mini', vectorStoreId: 'vs_test' }

test('responder devuelve el texto limpio de citas', async () => {
  const ia = crearIAOpenAI({
    ...OPCIONES,
    clienteOpenAI: clienteFalso({ output_text: 'La clase sale $10.000【4:0†source】.' }),
  })

  const r = await ia.responder('cuanto sale?', [])
  assert.equal(r, 'La clase sale $10.000.')
})

test('responder configura file_search con el vector store', async () => {
  const capturar = {}
  const ia = crearIAOpenAI({
    ...OPCIONES,
    clienteOpenAI: clienteFalso({ output_text: 'ok' }, capturar),
  })

  await ia.responder('hola', [{ direction: 'in', text: 'previo' }])

  assert.equal(capturar.params.model, 'gpt-4o-mini')
  assert.deepEqual(capturar.params.tools, [
    { type: 'file_search', vector_store_ids: ['vs_test'] },
  ])
  assert.match(capturar.params.instructions, /MotoEscuela/)
  assert.match(capturar.params.input[0].content, /previo/)
  assert.equal(capturar.params.input.at(-2).role, 'developer')
  assert.equal(capturar.params.input.at(-1).content, 'hola')
  assert.ok(capturar.params.max_output_tokens > 0, 'debe acotar la salida')
})

test('responder extrae el texto de output[] si no viene output_text', async () => {
  const ia = crearIAOpenAI({
    ...OPCIONES,
    clienteOpenAI: clienteFalso({
      output: [
        { type: 'file_search_call', status: 'completed' },
        { type: 'message', content: [{ type: 'output_text', text: 'respuesta anidada' }] },
      ],
    }),
  })

  assert.equal(await ia.responder('hola', []), 'respuesta anidada')
})

test('responder ignora un output_text vacio y cae al output[]', async () => {
  const ia = crearIAOpenAI({
    ...OPCIONES,
    clienteOpenAI: clienteFalso({
      output_text: '   ',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'la buena' }] }],
    }),
  })

  assert.equal(await ia.responder('hola', []), 'la buena')
})

test('responder propaga el error si OpenAI falla', async () => {
  const ia = crearIAOpenAI({ ...OPCIONES, clienteOpenAI: clienteFalso(new Error('rate limit')) })
  await assert.rejects(() => ia.responder('hola', []), /rate limit/)
})

test('responder lanza si la respuesta viene vacia', async () => {
  const ia = crearIAOpenAI({ ...OPCIONES, clienteOpenAI: clienteFalso({ output: [] }) })
  await assert.rejects(() => ia.responder('hola', []), /vacía/)
})

test('responder lanza si la respuesta trae solo citas y nada de texto', async () => {
  const ia = crearIAOpenAI({
    ...OPCIONES,
    clienteOpenAI: clienteFalso({ output_text: '【4:0†source】' }),
  })
  // Devolver una cadena vacia al usuario seria peor que fallar: el envio a
  // Meta seria rechazado y el mensaje quedaria sin respuesta ni error.
  await assert.rejects(() => ia.responder('hola', []), /vacía/)
})
