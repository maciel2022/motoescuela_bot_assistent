import OpenAI from 'openai'
import config from '../config.js'
import { INSTRUCCIONES, construirInput, limpiarCitas, aFormatoWhatsApp } from './prompt.js'

/**
 * Extrae el texto de una respuesta de la Responses API.
 * El SDK expone el atajo `output_text`, pero no siempre viene poblado, así que
 * se recorre `output[]` como respaldo.
 */
function extraerTexto(respuesta) {
  if (typeof respuesta?.output_text === 'string' && respuesta.output_text.trim() !== '') {
    return respuesta.output_text
  }

  for (const item of respuesta?.output ?? []) {
    if (item?.type !== 'message') continue
    for (const parte of item.content ?? []) {
      if (parte?.type === 'output_text' && parte.text) return parte.text
    }
  }

  return null
}

export function crearIAOpenAI({
  apiKey,
  model = 'gpt-4o-mini',
  vectorStoreId,
  clienteOpenAI,
  timeoutMs = 30000,
} = {}) {
  const cliente = clienteOpenAI ?? new OpenAI({ apiKey, timeout: timeoutMs })

  return {
    async responder(pregunta, historial = []) {
      const respuesta = await cliente.responses.create({
        model,
        instructions: INSTRUCCIONES,
        input: construirInput(historial, pregunta),
        tools: [{ type: 'file_search', vector_store_ids: [vectorStoreId] }],
      })

      // Se valida DESPUÉS de limpiar: una respuesta que trae solo marcadores
      // de cita queda vacía recién al limpiarla, y devolver una cadena vacía
      // sería peor que fallar (Meta rechaza el envío y el mensaje queda sin
      // respuesta y sin error registrado).
      const texto = aFormatoWhatsApp(limpiarCitas(extraerTexto(respuesta)))
      if (!texto) throw new Error('OpenAI devolvió una respuesta vacía')

      return texto
    },
  }
}

export default crearIAOpenAI({
  apiKey: config.openai.apiKey,
  model: config.openai.model,
  vectorStoreId: config.openai.vectorStoreId,
})
