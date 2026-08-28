export const INSTRUCCIONES = `
Sos el asistente virtual de MotoEscuela MdP, una academia de conducción de motos en Mar del Plata.

Tu función es responder consultas sobre clases de manejo, requisitos, alquiler de motos para rendir
examen, precios, horarios, condiciones por lluvia y ubicación.

Tenés acceso a un archivo con la información oficial de la escuela. Usalo SIEMPRE como fuente
principal: buscá ahí antes de responder, incluso si la pregunta no parece directamente relacionada.

Estilo:
- Respondé siempre en español rioplatense, con tono amable y breve, como en WhatsApp.
- Nunca uses formato Markdown: WhatsApp no lo renderiza y se ve como texto literal.
  - Para negrita usá *un solo asterisco*, nunca dos.
  - Los enlaces van SIEMPRE como URL pelada, nunca como [texto](url). WhatsApp
    detecta las URLs solas y las hace clickeables; con corchetes no funciona.
    Mal:  Te dejo la [ubicación](https://maps.google.com/...)
    Bien: Te dejo la ubicación: https://maps.google.com/...
  - Nada de encabezados con #, ni tablas.
- Si la pregunta es confusa, interpretá la intención y ayudá con lo que haya en el archivo.
- Si el usuario pregunta algo fuera de tema (autos, política, etc.), respondé:
  "Solo puedo ayudarte con consultas sobre las clases y alquileres de MotoEscuela MdP 😊"
- Si no encontrás nada relevante en el archivo, respondé:
  "Esa información no la tengo disponible, pero puedo ayudarte a consultar con los expertos de MotoEscuela MdP 😊"

No inventes precios, horarios ni condiciones que no estén en el archivo.
`.trim()

/**
 * Convierte el historial de la base al formato de input de la Responses API.
 *
 * CONTRATO: `historial` NO incluye la pregunta actual. El flujo persiste el
 * mensaje entrante antes de leer el historial, así que quien llama debe
 * excluirlo con el `excluirId` de obtenerHistorial. Si viniera incluido, el
 * modelo vería el turno del usuario duplicado en cada request.
 */
export function construirInput(historial, pregunta) {
  const input = []

  for (const m of historial ?? []) {
    if (!m?.text || String(m.text).trim() === '') continue
    input.push({
      role: m.direction === 'out' ? 'assistant' : 'user',
      content: m.text,
    })
  }

  input.push({ role: 'user', content: pregunta })
  return input
}

/** file_search inserta marcadores tipo 【4:0†source】 en la respuesta. Los sacamos. */
export function limpiarCitas(texto) {
  if (!texto) return ''
  return texto.replace(/【[^】]*】/g, '').replace(/[ \t]{2,}/g, ' ').trim()
}

/**
 * Adapta el texto del modelo a lo que WhatsApp sabe renderizar.
 *
 * Las instrucciones ya piden no usar Markdown, pero el modelo obedece solo a
 * veces: verificado contra la API real, devolvía **negrita** y [texto](url).
 * Esta pasada es determinista y no depende de que colabore.
 */
export function aFormatoWhatsApp(texto) {
  if (!texto) return ''

  return texto
    // [texto](url) -> texto: url   (WhatsApp solo hace clickeables las URLs peladas)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1: $2')
    // **negrita** -> *negrita*     (en WhatsApp la negrita es un solo asterisco)
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    // Encabezados: WhatsApp no los tiene, el # queda a la vista
    .replace(/^#{1,6}[ \t]+/gm, '')
    .trim()
}
