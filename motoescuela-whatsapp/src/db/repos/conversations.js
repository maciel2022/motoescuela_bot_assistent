import pool from '../pool.js'

/** Devuelve la conversación abierta del contacto, creándola si no existe. */
export async function obtenerOCrearConversacion(contactId, conn = pool) {
  const [existentes] = await conn.query(
    `SELECT id, contact_id, status FROM conversations
     WHERE contact_id = ? AND status = 'open'
     ORDER BY id DESC LIMIT 1`,
    [contactId]
  )
  if (existentes.length > 0) return existentes[0]

  const [res] = await conn.query(
    `INSERT INTO conversations (contact_id, status) VALUES (?, 'open')`,
    [contactId]
  )
  return { id: res.insertId, contact_id: contactId, status: 'open' }
}

export async function tocarConversacion(conversationId, conn = pool) {
  await conn.query(
    'UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?',
    [conversationId]
  )
}
