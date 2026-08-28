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
          timestamp: new Date(Number(msg.timestamp ?? 0) * 1000),
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
