const { chat } = require('./chatgpt');
const { DateTime } = require('luxon');

/**
 *  Convierte a fecha un formato ISO a un texto legible
 * @param {string} iso - Fecha en formato ISO
 * @returns {string} - Fecha en formato legible
 */

function iso2text(iso) {
    try {
        // Convertir la fecha a DateTime de Luxon
        const dateTime = DateTime.fromISO(iso, { zone: 'America/Argentina/Buenos_Aires' });

        // Formatear la fecha
        const formattedDate = dateTime.toLocaleString({
            weekday: 'long',
            day: '2-digit',
            month: 'long',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZoneName: 'short'
        });

        return formattedDate;
    } catch (err) {
        console.error('Error al convertir la fecha: ' + err);
        return 'Formato de fecha no válido.'
    }
}

/**
 *  Convierte una fecha en texto a formato ISO utilizando ChatGPT.
 *  @param {string} text - Fecha en formato texto.
 *  @returns {Promise<string>} - Fecha en formato ISO.
 */

async function text2iso(text) {
    const currentDate = new Date().toLocaleString('sv-SE', {
        timeZone: 'America/Argentina/Buenos_Aires'
    }).replace(' ', 'T');

    const prompt = `La fecha actual (en zona horaria de Buenos Aires, Argentina) es: ` + currentDate + `
        Necesito que del siguiente texto extraigas la fecha y hora y respondas **exclusivamente** en formato ISO (YYYY-MM-DDTHH:MM:SS.000).
        Usá las siguientes reglas:
        - Si no hay hora, usa las 10:00.
        - Si dice "mañana", sumá un día exacto.
        - Si dice "pasado mañana", sumá dos días exactos.
        - Si dice "de la semana que viene", no sumamos una semana, buscamos a partir del siguiente lunes.
        - Si el texto no tiene sentido, respondé 'false'.
        Ejemplos:
        "el jueves 30 de mayo a las 12hs" → 2025-05-30T12:00:00.000
        "este viernes 31" (si hoy es mayo) → 2025-05-31T10:00:00.000
        "mañana 10am" → fecha actual +1 día a las 10:00.
        `
    // `
    //     Necesito que de este texto extraigas la fecha y la hora del texto que te voy a dar y respondas en formato ISO.
    //     Me tenes que responder EXCLUSIVAMENTE con esa fecha y horarios en formato ISO, usando el horario 10:00 en caso de que no este especificada la hora.
    //     Por ejemplo, el texto puede ser algo como "el jueves 30 de mayo a las 12hs". En ese caso tu respuesta tiene que ser 2025-05-30T12:00:00.000.
    //     Por ejemplo, el texto puede ser algo como "Este viernes 31". En ese caso tu respuesta tiene que ser (en caso de que el mes actual sea mayo) 2025-05-31T10:00:00.000.
    //     Si el texto es algo como: "Mañana a las 9" o "Mañana a las 9am" o "Mañana a las 9hs", sumarle un día a la fecha actual y dar eso como resultado.
    //     Si el texto no tiene sentido, responde 'false' `
        ;
    const messages = [{ role: "user", content: `${text}` }];

    const response = await chat(prompt, messages);

    return response.trim(); // Asegura que no haya espacios en  blanco adicionales.
}

module.exports = { text2iso, iso2text };