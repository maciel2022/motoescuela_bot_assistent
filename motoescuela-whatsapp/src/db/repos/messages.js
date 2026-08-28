import pool from '../pool.js'

/**
 * Inserta un mensaje entrante.
 * Devuelve null si el wa_message_id ya existe: eso significa que Meta reintentó
 * el webhook y el mensaje ya fue (o está siendo) procesado. La deduplicación se
 * apoya en el índice único uq_messages_wa_message_id, no en lógica de aplicación.
 */
export async function insertarEntrante(
  { conversationId, contactId, waMessageId, type, text, raw, waTimestamp },
  conn = pool
) {
  try {
    const [res] = await conn.query(
      `INSERT INTO messages
         (conversation_id, contact_id, wa_message_id, direction, type, text, raw_payload, status, wa_timestamp)
       VALUES (?, ?, ?, 'in', ?, ?, ?, 'received', ?)`,
      [
        conversationId,
        contactId,
        waMessageId,
        type,
        text,
        raw ? JSON.stringify(raw) : null,
        waTimestamp ?? null,
      ]
    )
    return { id: res.insertId }
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return null
    throw err
  }
}

export async function insertarSaliente(
  { conversationId, contactId, waMessageId = null, text },
  conn = pool
) {
  const [res] = await conn.query(
    `INSERT INTO messages
       (conversation_id, contact_id, wa_message_id, direction, type, text, status)
     VALUES (?, ?, ?, 'out', 'text', ?, 'processed')`,
    [conversationId, contactId, waMessageId, text]
  )
  return { id: res.insertId }
}

/**
 * Últimos N mensajes con texto, devueltos en orden cronológico ascendente.
 *
 * `excluirId` omite un mensaje puntual: el flujo persiste el mensaje entrante
 * ANTES de leer el historial, así que la pregunta que se está respondiendo ya
 * está en la base. Sin excluirla, aparecería dos veces en el input del modelo.
 *
 * Se ordena por `id` y no por `created_at` a propósito: TIMESTAMP no guarda
 * fracciones de segundo, así que dos mensajes del mismo segundo empatarían y
 * el orden del historial sería indeterminado.
 */
export async function obtenerHistorial(conversationId, limite = 10, excluirId = null, conn = pool) {
  // Un límite inválido produciría `LIMIT NaN` y rompería la consulta entera.
  const tope = Math.max(1, Math.min(100, Math.trunc(Number(limite)) || 10))

  const [filas] = await conn.query(
    `SELECT direction, text FROM messages
     WHERE conversation_id = ? AND text IS NOT NULL AND text <> ''
       AND (? IS NULL OR id <> ?)
     ORDER BY id DESC
     LIMIT ?`,
    [conversationId, excluirId, excluirId, tope]
  )
  return filas.reverse()
}

export async function marcarProcesado(messageId, conn = pool) {
  await conn.query(`UPDATE messages SET status = 'processed' WHERE id = ?`, [messageId])
}

export async function marcarError(messageId, errorText, conn = pool) {
  await conn.query(`UPDATE messages SET status = 'error', error_text = ? WHERE id = ?`, [
    String(errorText).slice(0, 2000),
    messageId,
  ])
}
