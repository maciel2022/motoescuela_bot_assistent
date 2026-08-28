import test from 'node:test'
import assert from 'node:assert/strict'
import { construirInput, limpiarCitas, aFormatoWhatsApp, INSTRUCCIONES } from '../../src/ia/prompt.js'

test('construirInput mapea direction a los roles del modelo', () => {
  const historial = [
    { direction: 'in', text: 'hola' },
    { direction: 'out', text: 'Hola! En que te ayudo?' },
  ]
  const input = construirInput(historial, 'cuanto sale la clase?')

  assert.deepEqual(input, [
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: 'Hola! En que te ayudo?' },
    { role: 'user', content: 'cuanto sale la clase?' },
  ])
})

test('construirInput funciona con historial vacio', () => {
  const input = construirInput([], 'primera pregunta')
  assert.deepEqual(input, [{ role: 'user', content: 'primera pregunta' }])
})

test('construirInput tolera historial null o undefined', () => {
  assert.equal(construirInput(null, 'p').length, 1)
  assert.equal(construirInput(undefined, 'p').length, 1)
})

test('construirInput ignora entradas sin texto', () => {
  const input = construirInput(
    [{ direction: 'in', text: null }, { direction: 'in', text: '  ' }, { direction: 'in', text: 'valido' }],
    'pregunta'
  )
  assert.equal(input.length, 2)
  assert.equal(input[0].content, 'valido')
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
