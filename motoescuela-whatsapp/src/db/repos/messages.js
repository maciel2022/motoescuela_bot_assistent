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

/**
 * Mensajes entrantes que quedaron en 'received' y ya son viejos: nadie los
 * procesó. Ocurre cuando el proceso muere entre el 200 OK a Meta y el
 * procesamiento asíncrono. Sin este barrido quedarían ahí para siempre y el
 * usuario nunca recibiría respuesta, sin ninguna señal para el operador.
 *
 * El corte por antigüedad evita agarrar mensajes que se están procesando ahora.
 */
export async function obtenerPendientes(antiguedadMinutos = 5, limite = 50, conn = pool) {
  const minutos = Math.max(1, Math.trunc(Number(antiguedadMinutos)) || 5)
  const tope = Math.max(1, Math.min(500, Math.trunc(Number(limite)) || 50))

  const [filas] = await conn.query(
    `SELECT m.id, m.conversation_id, m.contact_id, m.wa_message_id, m.type,
            m.text, m.raw_payload, m.wa_timestamp, c.wa_id, c.profile_name
       FROM messages m
       JOIN contacts c ON c.id = m.contact_id
      WHERE m.direction = 'in'
        AND m.status = 'received'
        AND m.created_at < NOW() - INTERVAL ? MINUTE
      ORDER BY m.id
      LIMIT ?`,
    [minutos, tope]
  )

  return filas.map((f) => ({
    messageId: f.id,
    conversationId: f.conversation_id,
    contactId: f.contact_id,
    waMessageId: f.wa_message_id,
    from: f.wa_id,
    profileName: f.profile_name,
    type: f.type,
    text: f.text,
    timestamp: f.wa_timestamp,
    raw: f.raw_payload,
  }))
}
