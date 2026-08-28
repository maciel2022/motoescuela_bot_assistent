const { addKeyword, EVENTS } = require('@bot-whatsapp/bot')
const { isDateAvailable, getNextAvailableSlot } = require('../script/calendar')
const { text2iso, iso2text } = require('../script/utils')
const { chat } = require('../script/chatgpt')

const { formFlow } = require('./form.flow')

const promptBase =  `
    Sos un asistente virtual diseñado para ayudar a los usuarios a agendar citas mediante una conversación.
    Tu objetivo es unicamente ayudar al usuario a elegir un horario y una fecha para sacar turno.
    Te voy a dar la fecha solicitada por el usuario y la disponibilidad de la misma. Esta fecha la tiene que confirmar el usuario.
    Si la disponibilidad es true, entonces responde algo como: La fecha solicitada esta disponible. El turno sería el jueves 30 de Octubre 2025 a las 10:00hs.
    Si la disponibilidad es false,  vas a enviar una disculpa de que esa fecha no esta disponible, y ofrecer la siguiente fecha disponible que te dejo al final del prompt.Suponiendo que la siguiente fecha disponible es el Jueves 30, responde con este formato: La fecha y horario solicitados no estan disponibles, te puedo ofrecer el jueves 30 de Octubre 2025 a las 11:00hs.
    Bajo ninguna circustancia hagas consultas.
    Nunca digas que la disponibilidad es false, nunca respondas en ingles, ni siquiera el nombre del día.
    Te dejo los estados actualizados de dichas fechas
`;

const dateFlow = addKeyword(EVENTS.ACTION)
    .addAnswer("Perfecto! Que fecha queres agendar?", { capture: true })
    .addAnswer("Genial, voy a revisar la disponibilidad...", null, 
        async (ctx,ctxFn) => {
            const currentDate = new Date().toLocaleString('sv-SE', {timeZone: 'America/Argentina/Buenos_Aires'});
            console.log(currentDate);
            const solicitedDate = await text2iso(ctx.body)
            console.log("Fecha solicitada: " + solicitedDate)
            if (solicitedDate.includes('false')) {
                return ctxFn.endFlow("No se pudo deducir una fecha. Volve a preguntar")
            }
            const startDate = new Date(solicitedDate);
            console.log("Start Date: " + startDate)
            let dateAvailable = await isDateAvailable(startDate);
            console.log("Is Date Available: " + dateAvailable);

            if (dateAvailable === false) {
                const nextdateAvalaible = await getNextAvailableSlot(startDate);
                const isoString = nextdateAvalaible.start.toISOString();
                const dateText = await iso2text(isoString);
                console.log(dateText);
                const messages = [{ role: "user", content: `${ctx.body}` }];
                const response = await chat(promptBase + "\nHoy es el día: " + currentDate + "\nLa fecha solicitada es: " + solicitedDate + "\nLa disponibilidad de esa fecha es: false. El proximo espacio o decha disponible que tenes que ofrecer es: " + dateText + "Da la fecha siempre en español.", messages);
                await ctxFn.flowDynamic(response);
                await ctxFn.state.update({ date: nextdateAvalaible.start });
                return ctxFn.gotoFlow(confirmationFlow)  
            } else {
                const messages = [{ role: "user", content: `${ctx.body}` }];
                const response = await chat(promptBase + "\nHoy es el día: " + currentDate + "\nLa fecha solicitada es: " + solicitedDate + "\nLa disponibilidad de esa fecha es: true" + "\nConfirmación del cliente: No confirmo. Da la fecha siempre en español, y el nombre del dia esta aquí: " + startDate, messages);
                await ctxFn.flowDynamic(response);
                await ctxFn.state.update({ date: startDate });
                return ctxFn.gotoFlow(confirmationFlow)
            }

        }
    )
const confirmationFlow = addKeyword(EVENTS.ACTION)
    .addAnswer("Confirmas la fecha propuesta? Responde unicamente con 'si' o 'no'", { capture: true },
        async (ctx, ctxFn) => {
            const answer = ctx.body.toLowerCase();
            if (answer.includes("si") || answer.includes("sí")) {
                return ctxFn.gotoFlow(formFlow);
            } else if (answer.includes("no")) {
                await ctxFn.flowDynamic("No hay problema, volvamos a intentarlo...");
                return ctxFn.gotoFlow(dateFlow); // Vuelve al mismo flujo
            } else {
                await ctxFn.flowDynamic("No entendí tu respuesta. Por favor escribí *sí* o *no*.");
                return ctxFn.gotoFlow(dateFlow); // Vuelve a preguntar
            }
        }
    )

module.exports = { dateFlow, confirmationFlow };