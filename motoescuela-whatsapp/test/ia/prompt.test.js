import test from 'node:test'
import assert from 'node:assert/strict'
import { construirInput, limpiarCitas, aFormatoWhatsApp, INSTRUCCIONES, RECORDATORIO } from '../../src/ia/prompt.js'

test('construirInput mapea direction a los roles del modelo', () => {
  const historial = [
    { direction: 'in', text: 'hola' },
    { direction: 'out', text: 'Hola! En que te ayudo?' },
  ]
  const input = construirInput(historial, 'cuanto sale la clase?')

  assert.equal(input.length, 4)
  assert.equal(input[0].role, 'user')
  assert.match(input[0].content, /sin verificar/, 'los turnos previos del usuario van etiquetados')
  assert.match(input[0].content, /hola/)
  assert.deepEqual(input[1], { role: 'assistant', content: 'Hola! En que te ayudo?' })
  assert.deepEqual(input[2], { role: 'developer', content: RECORDATORIO })
  // La pregunta actual NO se etiqueta: es lo que el usuario esta preguntando ahora.
  assert.deepEqual(input[3], { role: 'user', content: 'cuanto sale la clase?' })
})

test('las respuestas propias del bot NO se etiquetan como texto del cliente', () => {
  const input = construirInput([{ direction: 'out', text: 'La clase sale $7000' }], 'gracias')
  assert.deepEqual(input[0], { role: 'assistant', content: 'La clase sale $7000' })
})

test('construirInput funciona con historial vacio', () => {
  const input = construirInput([], 'primera pregunta')
  assert.deepEqual(input, [
    { role: 'developer', content: RECORDATORIO },
    { role: 'user', content: 'primera pregunta' },
  ])
})

test('construirInput tolera historial null o undefined', () => {
  assert.equal(construirInput(null, 'p').length, 2)
  assert.equal(construirInput(undefined, 'p').length, 2)
})

test('construirInput ignora entradas sin texto', () => {
  const input = construirInput(
    [{ direction: 'in', text: null }, { direction: 'in', text: '  ' }, { direction: 'in', text: 'valido' }],
    'pregunta'
  )
  assert.equal(input.length, 3)
  assert.match(input[0].content, /valido/)
  assert.equal(input.at(-1).content, 'pregunta')
})

test('limpiarCitas quita los marcadores de file_search', () => {
  const sucio = 'La clase sale $10.000【4:0†source】 y dura 40 minutos【12:3†source】.'
  assert.equal(limpiarCitas(sucio), 'La clase sale $10.000 y dura 40 minutos.')
})

test('limpiarCitas tolera null y texto sin citas', () => {
  assert.equal(limpiarCitas(null), '')
  assert.equal(limpiarCitas('sin citas'), 'sin citas')
})

test('las instrucciones nombran a MotoEscuela y piden responder en espanol', () => {
  assert.match(INSTRUCCIONES, /MotoEscuela/i)
  assert.match(INSTRUCCIONES, /español/i)
})

test('las instrucciones prohiben Markdown, que WhatsApp no renderiza', () => {
  assert.match(INSTRUCCIONES, /Markdown/i)
})

test('las instrucciones prohiben explicitamente los enlaces con corchetes', () => {
  // Un [texto](url) se ve literal en WhatsApp y ademas no queda clickeable.
  // La prohibicion generica de Markdown no alcanzaba: verificado contra la
  // API real, el modelo devolvia [Google Maps](https://maps.google.com/...).
  assert.match(INSTRUCCIONES, /\[texto\]\(url\)/)
  assert.match(INSTRUCCIONES, /URL pelada/i)
})

// El prompt le pide al modelo que no use Markdown, pero obedece solo a veces:
// verificado contra la API real, devolvia **negrita** y [texto](url). Esta
// conversion es deterministica y no depende de que el modelo colabore.

test('aFormatoWhatsApp convierte la negrita de Markdown a la de WhatsApp', () => {
  assert.equal(aFormatoWhatsApp('El precio es **$8.000** por clase'), 'El precio es *$8.000* por clase')
  assert.equal(aFormatoWhatsApp('**uno** y **dos**'), '*uno* y *dos*')
})

test('aFormatoWhatsApp desarma los enlaces con corchetes', () => {
  assert.equal(
    aFormatoWhatsApp('Te dejo la [ubicación](https://maps.google.com/x)'),
    'Te dejo la ubicación: https://maps.google.com/x'
  )
})

test('aFormatoWhatsApp no rompe un enlace que ya viene pelado', () => {
  const pelado = 'Te dejo la ubicación: https://maps.google.com/maps?q=-38.01,-57.57&z=17'
  assert.equal(aFormatoWhatsApp(pelado), pelado)
})

test('aFormatoWhatsApp quita encabezados de Markdown', () => {
  assert.equal(aFormatoWhatsApp('## Precios\nLa clase sale $10.000'), 'Precios\nLa clase sale $10.000')
})

test('aFormatoWhatsApp deja intacto un texto que ya es valido en WhatsApp', () => {
  const bueno = 'La clase sale *$10.000* y dura 40 minutos 😊'
  assert.equal(aFormatoWhatsApp(bueno), bueno)
})

test('aFormatoWhatsApp tolera null', () => {
  assert.equal(aFormatoWhatsApp(null), '')
})

test('el recordatorio va SIEMPRE pegado a la pregunta, despues del historial', () => {
  // Las instrucciones del sistema quedan lejos cuando el historial es largo y
  // el modelo atiende a lo mas reciente. El recordatorio tiene que ir despues
  // de todo lo que el usuario pudo haber inyectado en turnos anteriores.
  const historial = Array.from({ length: 8 }, (_, i) => ({ direction: 'in', text: 'msg' + i }))
  const input = construirInput(historial, 'la pregunta')

  assert.equal(input.at(-1).role, 'user')
  assert.equal(input.at(-1).content, 'la pregunta')
  assert.equal(input.at(-2).role, 'developer')
  assert.equal(input.at(-2).content, RECORDATORIO)
})

test('las instrucciones declaran el historial como texto NO confiable', () => {
  assert.match(INSTRUCCIONES, /alias bancario/i)
  assert.match(INSTRUCCIONES, /no son\s+instrucciones/i)
  assert.match(RECORDATORIO, /archivo oficial/i)
})

test('limpiarCitas acota el texto del modelo antes de las expresiones regulares', () => {
  // Ambas regex tienen retroceso cuadratico ante una corrida del delimitador
  // de apertura sin cierre. 60k caracteres bloqueaban el event loop 8s, y el
  // event loop es unico: se frenarian todos los webhooks en vuelo.
  const inicio = Date.now()
  const r = limpiarCitas('【'.repeat(60000))
  const ms = Date.now() - inicio

  assert.ok(ms < 500, `tardo ${ms}ms; deberia estar acotado`)
  assert.ok(r.length <= 8192)
})
