import pool from '../pool.js'

/**
 * Crea el contacto o actualiza su nombre de perfil.
 * COALESCE evita que un webhook sin nombre borre uno que ya teníamos.
 */
export async function upsertContacto(waId, profileName = null, conn = pool) {
  await conn.query(
    `INSERT INTO contacts (wa_id, profile_name)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE
       profile_name = COALESCE(VALUES(profile_name), profile_name),
       updated_at = CURRENT_TIMESTAMP`,
    [waId, profileName]
  )

  const [filas] = await conn.query(
    'SELECT id, wa_id, profile_name FROM contacts WHERE wa_id = ?',
    [waId]
  )
  return filas[0]
}

export async function buscarContactoPorWaId(waId, conn = pool) {
  const [filas] = await conn.query(
    'SELECT id, wa_id, profile_name FROM contacts WHERE wa_id = ?',
    [waId]
  )
  return filas[0] ?? null
}
