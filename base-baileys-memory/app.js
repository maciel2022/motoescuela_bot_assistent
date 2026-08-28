const { createBot, createProvider, createFlow, addKeyword, EVENTS } = require('@bot-whatsapp/bot')

const QRPortalWeb = require('@bot-whatsapp/portal')
const BaileysProvider = require('@bot-whatsapp/provider/baileys')
const MockAdapter = require('@bot-whatsapp/database/mock')

const { dateFlow } = require('./flows/date.flow')
const { formFlow } = require('./flows/form.flow')
const { welcomeFlow } = require('./flows/welcome.flow')

const flowPrincipal = addKeyword(EVENTS.WELCOME)
    .addAction(async (ctx, ctxFn) => {
        const bodyText = ctx.body.toLowerCase();
        // El usuario esta saludando?
        const keywords = ['hola', 'buenas', 'ola']; // Agregar todas las posibles variantes de saludos
        const containsKeyword = keywords.some(keyword => bodyText.includes(keyword));
        if (containsKeyword && ctx.body.length < 8) {
            return await ctxFn.gotoFlow(welcomeFlow); // Si, esta saludando
        } // No, no esta saludando

        // El usuario quiere agendar una cita?
        const keywordsDate = ['agendar', 'cita', 'turno', 'reunion']; // Agregar posibilidades de pedir turno
        const containsKeywordDate = keywordsDate.some(keyword => bodyText.includes(keyword));
        if (containsKeywordDate) {
            return ctxFn.gotoFlow(dateFlow); // Si quiere agendar un turno
        } else {
            return ctxFn.endFlow('No entiendo tu consulta');
        }
 
        // const solicitedDate = await text2iso(ctx.body)
        // console.log("Fecha solicitada: " + solicitedDate)
        // if (solicitedDate.includes('false')) {
        //     return ctxFn.endFlow("No se pudo deducir una fecha. Volve a preguntar")
        // }
        
        // let startDate = new Date(solicitedDate);
        // console.log("Start Date: " + startDate)

        // let dateAvailable = await isDateAvailable(startDate);
        // console.log("Is Date Available: " + dateAvailable);

        // if (dateAvailable === false) {
        //     const nextdateAvalaible = await getNextAvailableSlot(startDate);
        //     console.log("Fecha recomendada: " + nextdateAvalaible.start);
        //     startDate = nextdateAvalaible.start;
        // }

        // const eventName = "Prueba Chatbot";
        // const description = "Prueba Descripción";
        // const date = startDate;
        // const eventId = await createEvent(eventName, description, date, 2);

        
        // const prompt = "Sos un chatbot diseñado para responder preguntas";
        // const text = ctx.body;

        // const conversations = [];

        // // Crear el contexto con las conversaciones
        // const contextMessages = conversations.flatMap(conv => [
        //     { role: "user", content: conv.question },
        //     { role: "assistant", content: conv.answer }
        // ]);

        // // Añadir la pregunta actual al contexto
        // contextMessages.push({ role: "user", content: text });

        // // Obtener las respuestas
        // const response = await chat(prompt, contextMessages);

        // // Enviar la respuesta
        // await ctxFn.flowDynamic(response);
    });

const main = async () => {
    const adapterDB = new MockAdapter()
    const adapterFlow = createFlow([flowPrincipal, dateFlow, formFlow, welcomeFlow])
    const adapterProvider = createProvider(BaileysProvider)

    createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    })

    QRPortalWeb()
}

main()
