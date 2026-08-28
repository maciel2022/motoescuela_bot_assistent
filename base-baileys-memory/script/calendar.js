const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

// Nuevo metodo con JWT:
const auth = new JWT({
  keyFile: './google.json',
  scopes: ['https://www.googleapis.com/auth/calendar']
});

const calendar = google.calendar({ version: 'v3' });
google.options({ auth });

// Constantes configurables
const calendarID = '819e0694137dab928591f37eb99fbe93d7f7ac9127725c5fe7377e09da457930@group.calendar.google.com';
const timeZone = 'America/Argentina/Buenos_Aires';

const rangeLimit = {
    days: [1,2,3,4,5], // Lunes a Viernes
    startHour: 8,
    endHour: 18
}

const standardDuration = 40; //Duración de 40 minutos por clase
const dateLimit = 30; // Maximo de dias a traer la lista de Next Events

/**
 * Crea un evento en el calendario.
 * @param {string} eventName - Nombre del evento.
 * @param {string} description - Descripción del evento.
 * @param {string} date - Fecha y hora de inicio del evento en formato ISO (eg, '2025-03-01T10:00"00')
 * @param {number} [duration=stardardDuration] - Duración del evento en minutos
 * @returns {string} - URL del la invitación del evento.
 */

async function createEvent(eventName, description, date, duration = standardDuration) {
    try {
        // Fecha y hora de inicio del evento
        const startDateTime = new Date(date);
        // Fecha y hora de fin del evento
        const endDateTime = new Date(startDateTime);
        endDateTime.setMinutes(startDateTime.getMinutes() + duration)

        const event = {
             summary: eventName,
             description: description,
             start: {
                dateTime: startDateTime.toISOString(),
                timeZone: timeZone,
             },
             end: {
                dateTime: endDateTime.toISOString(),
                timeZone: timeZone,
             },
             colorId: '2' // El ID del color verde en Google Calendar es '11'
        };

        const response = await calendar.events.insert({
            calendarId: calendarID,
            resource: event,
        });

        // Generar la URL de la invitación
        const eventId = response.data.id;
        console.log('Evento creado con éxito');
        return eventId;
    } catch (err) {
        console.log('Hubo un error al crear el evento en el servicio de Calendar:', err)
        throw err;
    }
} 

/**
 * Lista de los slots disponibles entre las fechas dadas.
 *@param {Date} [startDate=new Date()] - Fecha de inicio para buscar slots disponibles. Default es la
 @param {Date} [endDate] - Fecha de fin para buscar slots disponibles. Default es el máximo definido
 @param {Array} - Lista de slots disponibles.
 */ 

 async function listAvailableSlots(startDate = new Date(), endDate) {
    try {
        // Definir fecha de fin si no se proporciona
        if (!endDate) {
            endDate = new Date(startDate);
            endDate.setDate(startDate.getDate() + dateLimit);
        }

        const response = await calendar.events.list({
            calendarId: calendarID,
            timeMin: startDate.toISOString(),
            timeMax: endDate.toISOString(),
            timeZone: timeZone,
            singleEvents: true,
            orderBy: 'startTime'
        });

        const events = response.data.items;
        const slots = [];
        let currentDate = new Date(startDate);

        // Generar slots disponibles basados en rangeLimit
        while (currentDate < endDate) {
            const dayOfWeek = currentDate.getDay();
            if (rangeLimit.days.includes(dayOfWeek)) {
                // for (let hour = rangeLimit.starHour; hour < rangeLimit.endHour; hour++) {
                //     const slotStart = new Date(currentDate);
                //     slotStart.setHours(hour, 0, 0, 0);
                //     const slotEnd = new Date(slotStart);
                //     slotEnd.setMinutes(slotEnd.getMinutes() + standardDuration);

                //     const isBusy = events.some(event => {
                //         const eventStart = new Date(event.start.dateTime || event.start.date);
                //         const eventEnd = new Date(event.end.dateTime || event.end.date);
                //         return (slotStart < eventEnd && slotEnd > eventStart);
                //     });

                //     if (!isBusy) {
                //         slots.push({ start: slotStart, end: slotEnd });
                //     }
                // }
                for (let hour = rangeLimit.startHour; hour < rangeLimit.endHour; hour++) {
                    for (let minute = 0; minute < 60; minute += standardDuration) {
                        const slotStart = new Date(currentDate);
                        slotStart.setHours(hour, minute, 0, 0);
                        const slotEnd = new Date(slotStart);
                        slotEnd.setMinutes(slotEnd.getMinutes() + standardDuration);

                        const isBusy = events.some(event => {
                            const eventStart = new Date(event.start.dateTime || event.start.date);
                            const eventEnd = new Date(event.end.dateTime || event.end.date);
                            return (slotStart < eventEnd && slotEnd > eventStart);
                        });

                        if (!isBusy) {
                            slots.push({ start: slotStart, end: slotEnd });
                        }
                    }
                }
            }
            currentDate.setDate(currentDate.getDate() + 1);
        }
        return slots;
    } catch (err) {
        console.error("Hubo un error al conectar el servicio de Calendar: " + err);
        throw err;
    }
 }

/**
 *  Obtiene el proximo slot disponible a partir de la fecha dada.
 *  @param {string|Date} date - Fecha a partir de la cual buscar el proximo slot disponible, puede ser
 *  @returns {Object|null} - El proximo slot disponible o null si no hay  ninguno.
 */

async function getNextAvailableSlot(date) {
    try {
        // Verificar si 'date' es un string en formato ISO
        if (typeof date === 'string') {
            date = new Date(date);
        } else if (!(date instanceof Date) || isNaN(date)) {
            throw new Error('La fecha proporcionada no es válida.');
        }

        // Obtener el próximo slot disponible
        const availableSlots = await listAvailableSlots(date);

        // Filtrar slots disponibles que comienzan después de la fecha proporcionada
        const filteredSlots = availableSlots.filter(slot => new Date(slot.start) > date);

        // Ordenar los slots disponibles que comienzan después de la fecha proporcionada
        const sortedSlots = filteredSlots.sort((a, b) => new Date(a.start) - new Date(b.start));

        // Tomar el primer slot de la lista resultante, que séra el próximo slot disponible
        return sortedSlots.length > 0 ? sortedSlots[0] : null;
    } catch (err) {
        console.error('Hubo un error al obtener el próximo slot disponible: ' + err );
        throw err;
    }  
}

/**
 *  Verifica si ay slots disponibles para una fecha dada.
 *  @param {Date} date - Fecha a verificar.
 *  @returns {boolean} - devuelve true si hay slots disponibles dentro del rango permitido, false en
 */

async function isDateAvailable(date) {
    try {
        // Validar que la fecha esté dentro del rango permitido
        const currentDate = new Date();
        const maxDate = new Date(currentDate);
        maxDate.setDate(currentDate.getDate() + dateLimit);

        if (date < currentDate || date > maxDate) {
            return false; // Lafecha está fuera del rango permitido
        }

        // Verificar que la fecha caiga en un día permitido
        const dayOfWeek = date.getDay();
        if (!rangeLimit.days.includes(dayOfWeek)) {
            return false; // La fecha no está dentro de los días permitidos
        }

        // Verificar que la hora esté dentro del rango pemitido
        const hour = date.getHours();
        if (hour < rangeLimit.startHour || hour >= rangeLimit.endHour) {
            return false; // La hora no está dentro del rango permitido
        }

        // Obtener todos los slots disponibles desde la fecha actual hasta el límite definido
        const availableSlots = await listAvailableSlots(currentDate);

        // Filtrar slots dispnibles basados en la fecha dada
        const slotsOnGivenDate = availableSlots.filter(slot => new Date(slot.start).toDateString() === date.toDateString());

        // Verificar si hay slots disponibles en la fecha dada
        const isSlotAvailable = slotsOnGivenDate.some(slot => 
            new Date(slot.start).getTime() === date.getTime() &&
            new Date(slot.end).getTime() === date.getTime() + standardDuration * 60 * 1000
        );

        return isSlotAvailable;
    } catch (err) {
        console.error('Hubo un error al verificar disponibilidad de la fecha: ' + err);
        throw err;
    }  
}

module.exports = { createEvent, isDateAvailable, getNextAvailableSlot };