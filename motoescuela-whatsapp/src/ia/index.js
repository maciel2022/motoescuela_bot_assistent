/**
 * Interfaz estable del módulo de IA.
 *
 * El resto de la aplicación importa SOLO desde acá; nadie más conoce a OpenAI.
 * Cambiar de proveedor —o agregar tool calling para los turnos en la Fase 2—
 * se hace acá adentro, sin tocar el orquestador ni el webhook.
 */
import ia from './openai.js'

export const responder = (pregunta, historial) => ia.responder(pregunta, historial)

export default { responder }
