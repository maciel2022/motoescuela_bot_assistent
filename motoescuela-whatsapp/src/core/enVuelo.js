/**
 * Contador del trabajo asíncrono desacoplado de las requests.
 *
 * El procesamiento de un mensaje corre después del 200 OK a Meta, así que
 * nadie lo espera. Eso trae dos problemas que este rastreador resuelve:
 *
 * 1. Un rechazo sin observar mata el proceso en Node 22. Acá se captura.
 * 2. Un SIGTERM mataría el trabajo en vuelo sin terminarlo, y como la fila ya
 *    está commiteada el reintento de Meta la descarta como duplicada: el
 *    mensaje se pierde. Esto pasa en CADA deploy, no solo en un crash.
 */
export function crearRastreador() {
  const enVuelo = new Set()

  return {
    cantidad: () => enVuelo.size,

    /** Registra una promesa y le adosa un catch para que nunca quede sin observar. */
    rastrear(promesa, alFallar) {
      const seguida = Promise.resolve(promesa)
        .catch((err) => {
          try {
            alFallar?.(err)
          } catch {
            // Ni siquiera el manejador de errores puede tumbar el proceso.
          }
        })
        .finally(() => enVuelo.delete(seguida))

      enVuelo.add(seguida)
      return seguida
    },

    /** Espera a que se vacíe, con un tope para no colgar el apagado. */
    async esperar(topeMs = 30000) {
      if (enVuelo.size === 0) return { completo: true }

      const vencimiento = new Promise((r) => setTimeout(() => r('vencido'), topeMs))
      const vaciado = (async () => {
        while (enVuelo.size > 0) await Promise.all([...enVuelo])
      })()

      const resultado = await Promise.race([vaciado.then(() => 'listo'), vencimiento])
      return { completo: resultado === 'listo', pendientes: enVuelo.size }
    },
  }
}

export default crearRastreador()
