import pool from '../pool.js'

/**
 * `paraActualizar` agrega FOR UPDATE, que hace una lectura CON BLOQUEO.
 * Importa dentro de una transacción: MySQL corre en REPEATABLE READ, así que
 * una lectura común usa el snapshot del inicio de la transacción y NO vería la
 * fila que otra transacción commiteó después. La lectura con bloqueo sí ve la
 * última versión commiteada, que es lo que necesita la recuperación de abajo.
 */
async function buscarAbierta(contactId, conn, paraActualizar = false) {
  const [filas] = await conn.query(
    `SELECT id, contact_id, status FROM conversations
     WHERE contact_id = ? AND status = 'open'
     ORDER BY id DESC LIMIT 1${paraActualizar ? ' FOR UPDATE' : ''}`,
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

    // Otra transacción la creó entre nuestro SELECT y nuestro INSERT.
    // FOR UPDATE es obligatorio acá: sin él, en REPEATABLE READ no veríamos
    // la fila ganadora y devolveríamos null, rompiendo el ingest.
    const ganadora = await buscarAbierta(contactId, conn, true)
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
