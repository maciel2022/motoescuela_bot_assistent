/**
 * Meta manda el timestamp como segundos en una cadena. Un valor ausente o
 * basura daría `new Date(0)` (1970), que está por debajo del mínimo de un
 * TIMESTAMP de MySQL: el INSERT fallaría, el webhook devolvería 500 y Meta
 * reintentaría ese mensaje indefinidamente. Preferimos null.
 */
const SEGUNDOS_MAX = 4102444800 // 2100-01-01, muy por encima de cualquier real

function instanteDe(valor) {
  const segundos = Number(valor)
  // La cota superior importa tanto como la inferior: un valor absurdo produce
  // una fecha que la base rechaza, el INSERT falla, el webhook devuelve 500 y
  // Meta reintenta ese mensaje indefinidamente.
  if (!Number.isFinite(segundos) || segundos <= 0 || segundos > SEGUNDOS_MAX) return null
  return new Date(segundos * 1000)
}

/**
 * Convierte el payload del webhook de Meta en objetos propios.
 * Función pura: no toca red, base ni configuración.
 * Nunca lanza — un payload inesperado devuelve listas vacías.
 */
export function parsearWebhook(payload) {
  const mensajes = []
  const estados = []

  const entries = Array.isArray(payload?.entry) ? payload.entry : []

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : []

    for (const change of changes) {
      const value = change?.value
      if (!value) continue

      // Índice wa_id → nombre de perfil, para adjuntarlo a cada mensaje.
      const nombrePorWaId = new Map()
      for (const c of value.contacts ?? []) {
        if (c?.wa_id) nombrePorWaId.set(c.wa_id, c?.profile?.name ?? null)
      }

      for (const msg of value.messages ?? []) {
        if (!msg?.id || !msg?.from) continue
        mensajes.push({
          waMessageId: msg.id,
          from: msg.from,
          profileName: nombrePorWaId.get(msg.from) ?? null,
          type: msg.type ?? 'unknown',
          text: msg.type === 'text' ? (msg.text?.body ?? null) : null,
          timestamp: instanteDe(msg.timestamp),
          raw: msg,
        })
      }

      for (const st of value.statuses ?? []) {
        estados.push(st)
      }
    }
  }

  return { mensajes, estados }
}
