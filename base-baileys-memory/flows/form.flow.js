const { addKeyword, EVENTS } = require('@bot-whatsapp/bot');
const { createEvent } = require('../script/calendar');

// En este flow vamos a pedir toda la información necesaria para poder agendar el turno
const formFlow = addKeyword(EVENTS.ACTION)
    .addAnswer("Excelente! Gracias por confirmar tu turno. Te voy a hacer unas consultas para poder agendar el turno. Primero ¿Cuál es tu nombre y apellido?", { capture: true }, 
        async (ctx, ctxFn) => {
            await ctxFn.state.update({ name: ctx.body }); // Guardar el nombre del usuario en el estado
        }
    )
    .addAnswer("Perfecto, ¿Cuál es el motivo del turno?", { capture: true }, 
        async (ctx, ctxFn) => {
            await ctxFn.state.update({ motive: ctx.body }); // Guardar el motivo, o el dato que necesitemos registrar
        }
    )
    .addAnswer("Excelente! Ya tenes tu turno reservado. \nSaludos. ¡Nos vemos pronto!", { capture: true }, 
        async (ctx, ctxFn) => {
            const response = ctx.body;
            const userInfo = await ctxFn.state.getMyState();
            const eventName = userInfo.name;
            const description = userInfo.motive;
            const date = userInfo.date;
            const eventId = await createEvent(eventName, description, date);
            await ctxFn.state.clear();
            if (response) {
                await ctxFn.endFlow();
            } else {
                setTimeout(async () => {
                    await ctxFn.endFlow();
                }, 1 * 60 * 1000);
            }
        }
    )

module.exports = { formFlow };