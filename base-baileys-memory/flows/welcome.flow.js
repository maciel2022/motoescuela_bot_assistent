// const { addKeyword, EVENTS } = require('@bot-whatsapp/bot');

// const welcomeFlow = addKeyword(EVENTS.ACTION)
//     .addAction(async (ctx, ctxFn) => {
//         await ctxFn.endFlow("Bienvenidos a Motoescuela mdp! \nPodes escribir 'Agendar turno' para reservar el tuyo.")
//     })

// module.exports = { welcomeFlow };

// const { addKeyword, EVENTS } = require('@bot-whatsapp/bot');
// const { chat } = require('../script/assistant'); // ← ruta donde está tu archivo del asistente

// // Flow con integración del Asistente de OpenAI
// const welcomeFlow = addKeyword(EVENTS.ACTION)
//     .addAction(async (ctx, ctxFn) => {
//         const state = await ctxFn.state.getMyState()
//         const thread = state?.thread ?? null;
//         const response = await chat(ctx.body, ctx.name, thread)
//         await ctxFn.state.update({ thread: response.thread })
//         return ctxFn.endFlow(response.response)
//     })

// module.exports = { welcomeFlow };

const { addKeyword, EVENTS } = require('@bot-whatsapp/bot');
const { chat } = require('../script/assistant');

const welcomeFlow = addKeyword(EVENTS.ACTION)
    .addAction(async (ctx, ctxFn) => {
        const userMessage = ctx.body.toLowerCase().trim();

        // 🧹 Si el usuario pide reiniciar, borramos su hilo
        if (userMessage.includes("reiniciar") || userMessage.includes("empezar de nuevo")) {
            await ctxFn.state.clear();
            await ctxFn.flowDynamic("✅ Se reinició tu conversación. Podés empezar de nuevo cuando quieras 🙂");
            return;
        }
        
        
        // Recuperar el estado del usuario
        const state = await ctxFn.state.getMyState();
        let thread = state?.thread ?? null;

        // Enviar el mensaje del usuario al asistente
        const response = await chat(ctx.body, ctx.name, thread);

        // Guardar el nuevo thread.id para mantener contexto
        await ctxFn.state.update({ thread: response.thread });

        // Responder sin cerrar el flujo (permite continuar la charla)
        await ctxFn.flowDynamic(response.response);
    });

module.exports = { welcomeFlow };
