import 'dotenv/config'

const REQUERIDAS = [
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'OPENAI_API_KEY',
  'OPENAI_VECTOR_STORE_ID',
  'MYSQL_HOST',
  'MYSQL_USER',
  'MYSQL_DATABASE',
]

/**
 * Convierte una variable numérica, fallando al arrancar si no lo es.
 * El sentido de este archivo es que un .env mal escrito rompa acá y no en
 * medio de una conversación con un usuario.
 */
function numero(env, clave, porDefecto) {
  const crudo = env[clave]
  if (crudo === undefined || String(crudo).trim() === '') return porDefecto

  const valor = Number(crudo)
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new Error(`La variable ${clave} debe ser un número positivo, y vale "${crudo}".`)
  }
  return valor
}

export function loadConfig(env) {
  const faltantes = REQUERIDAS.filter((k) => !env[k] || String(env[k]).trim() === '')
  if (faltantes.length > 0) {
    throw new Error(
      `Faltan variables de entorno obligatorias: ${faltantes.join(', ')}. ` +
        `Copiá .env.example a .env y completalas.`
    )
  }

  const cfg = {
    port: numero(env, 'PORT', 3000),
    whatsapp: Object.freeze({
      verifyToken: env.WHATSAPP_VERIFY_TOKEN,
      appSecret: env.WHATSAPP_APP_SECRET,
      token: env.WHATSAPP_TOKEN,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      graphVersion: env.GRAPH_API_VERSION ?? 'v21.0',
    }),
    openai: Object.freeze({
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL ?? 'gpt-4o-mini',
      vectorStoreId: env.OPENAI_VECTOR_STORE_ID,
    }),
    mysql: Object.freeze({
      host: env.MYSQL_HOST,
      port: numero(env, 'MYSQL_PORT', 3306),
      user: env.MYSQL_USER,
      password: env.MYSQL_PASSWORD ?? '',
      database: env.MYSQL_DATABASE,
    }),
    historyLimit: numero(env, 'HISTORY_LIMIT', 10),
    logLevel: env.LOG_LEVEL ?? 'info',
  }

  return Object.freeze(cfg)
}

export default loadConfig(process.env)
