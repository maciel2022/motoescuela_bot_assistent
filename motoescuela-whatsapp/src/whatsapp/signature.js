import crypto from 'node:crypto'

/**
 * Valida la firma HMAC-SHA256 que Meta envía en el header X-Hub-Signature-256.
 * IMPORTANTE: rawBody debe ser el cuerpo CRUDO de la request, byte por byte.
 * Si Express ya lo parseó y se re-serializa con JSON.stringify, la firma no coincide.
 */
export function esFirmaValida(rawBody, header, appSecret) {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false

  const esperado =
    'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')

  const recibidoBuf = Buffer.from(header, 'utf8')
  const esperadoBuf = Buffer.from(esperado, 'utf8')

  // timingSafeEqual exige longitudes iguales; comparar antes evita que lance.
  if (recibidoBuf.length !== esperadoBuf.length) return false

  return crypto.timingSafeEqual(recibidoBuf, esperadoBuf)
}
