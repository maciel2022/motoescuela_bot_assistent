import config from './config.js'

const NIVELES = { debug: 10, info: 20, warn: 30, error: 40 }

function crearLogger(nivelMinimo = 'info') {
  const umbral = NIVELES[nivelMinimo] ?? NIVELES.info

  const emitir = (nivel, mensaje, meta) => {
    if (NIVELES[nivel] < umbral) return
    const linea = {
      ts: new Date().toISOString(),
      nivel,
      mensaje,
      ...(meta ? { meta } : {}),
    }
    const salida = nivel === 'error' || nivel === 'warn' ? console.error : console.log
    salida(JSON.stringify(linea))
  }

  return {
    debug: (m, meta) => emitir('debug', m, meta),
    info: (m, meta) => emitir('info', m, meta),
    warn: (m, meta) => emitir('warn', m, meta),
    error: (m, meta) => emitir('error', m, meta),
  }
}

export { crearLogger }

// El nivel sale de config y no de process.env: dos fuentes de verdad para el
// mismo ajuste dejaban config.logLevel como codigo muerto.
export default crearLogger(config.logLevel)
