import pool from '../pool.js'

async function buscarAbierta(contactId, conn) {
  const [filas] = await conn.query(
    `SELECT id, contact_id, status FROM conversations
     WHERE contact_id = ? AND status = 'open'
     ORDER BY id DESC LIMIT 1`,
    [contactId]
  )
  return filas[0] ?? null
}

/**
 * Devuelve la conversación abierta del contacto, creándola si no existe.
 *
 * Consultar y después insertar es una carrera: dos webhooks simultáneos del
 * mismo contacto pueden ver ambos "no hay conversación". El índice único
 * uq_conversations_abierta (migración 002) hace que el segundo INSERT falle
 * en vez de duplicar, y ahí volvemos a consultar para devolver la que ganó.
 */
export async function obtenerOCrearConversacion(contactId, conn = pool) {
  const existente = await buscarAbierta(contactId, conn)
  if (existente) return existente

  try {
    const [res] = await conn.query(
      `INSERT INTO conversations (contact_id, status) VALUES (?, 'open')`,
      [contactId]
    )
    return { id: res.insertId, contact_id: contactId, status: 'open' }
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err

    // Otro proceso la creó entre nuestro SELECT y nuestro INSERT.
    const ganadora = await buscarAbierta(contactId, conn)
    if (!ganadora) throw err
    return ganadora
  }
}

export async function tocarConversacion(conversationId, conn = pool) {
  await conn.query(
    'UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?',
    [conversationId]
  )
}
