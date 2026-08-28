require("dotenv").config();
const OpenAI = require("openai");

const openaiApiKey = process.env.OPENAI_API_KEY;
const assistant = process.env.OPENAI_ASSISTANT;

const basePrompt = `
Sos un asistente virtual de **MotoEscuela MdP**, una academia de conducción de motos.

Objetivo:
Tu función es responder consultas sobre clases de manejo, requisitos, alquiler de motos para rendir examen, precios, horarios, condiciones por lluvia y ubicación.

Tenés acceso a un archivo con toda la información oficial. 
Debés usar **SIEMPRE** ese archivo como fuente principal de tus respuestas.
Nunca digas "no entiendo", "no tengo información" ni "no encontré nada".
Buscá siempre dentro del archivo y contestá lo más relevante.

Estilo:
- Respondé siempre en español, con tono amable y breve, como en WhatsApp.
- Incluí el nombre del usuario si lo tenés.
- Si la pregunta es confusa, interpretá la intención y usá el contenido del archivo para ayudar.
- Si el usuario pregunta algo fuera del tema (por ejemplo, autos, política, etc.), respondé:
  "Solo puedo ayudarte con consultas sobre las clases y alquileres de MotoEscuela MdP 😊"

Ejemplos:
Usuario: "¿Qué pasa si llueve?"
Asistente: "Si llueve o el asfalto está mojado, la clase se suspende automáticamente y podés reprogramarla 🌧️"

Usuario: "¿Cuánto cuesta alquilar una moto para rendir?"
Asistente: "Podés alquilar una Mondial 110cc por $8.000 o una TVS RTR 160cc por $10.000, según la categoría que necesites rendir 🏍️"

Usuario: "¿Dónde se dan las clases?"
Asistente: "Las clases se hacen en el circuito de MotoEscuela MdP. Te dejo la ubicación: https://maps.google.com/maps?q=-38.0167013%2C-57.5743668&z=17&hl=es"

Usuario: "¿Puedo tomar clases si nunca manejé moto?"
Asistente: "Sí, empezamos desde cero con motos de 110cc semiautomáticas, ideales para principiantes ✅"

Si el usuario hace una pregunta, revisá SIEMPRE la información del archivo de MotoEscuela MdP antes de responder. 
Usá el contenido del archivo incluso si no parece directamente relacionado. 
Nunca respondas sin verificar el archivo.

IMPORTANTE:
- Antes de responder, buscá SIEMPRE en el archivo de MotoEscuela MdP.
- Usá File Search de OpenAI para encontrar la información exacta en el PDF.
- Solo respondé después de consultar el archivo.
- Si no encontrás nada relevante en el PDF, decí "Esa información no la tengo disponible, pero puedo ayudarte a consultar con los expertos de MotoEscuela MdP 😊".
`;

const chat = async (question, name, thread = null) => {
    try {
        const openai = new OpenAI({ apiKey: openaiApiKey });
        thread = thread || await openai.beta.threads.create();

        // Crear el mensaje del usuario
        await openai.beta.threads.messages.create(thread.id, {
            role: "user",
            content: question
        });

        // Crear y ejecutar la corrida del asistente
        const run = await openai.beta.threads.runs.createAndPoll(thread.id, {
            assistant_id: assistant,
            instructions: `${basePrompt}`,
            tool_choice: { type: "file_search" } // 👈 fuerza el uso de File Search
        });

        if (run.status === 'completed') {
            const messages = await openai.beta.threads.messages.list(run.thread_id);
            for (const message of messages.data.reverse()) {
                console.log(`Mensaje GS: ${message.role} > ${message.content[0].text.value}`);
            }

            if (run.required_action?.type === "submit_tool_outputs") {
                console.log("🗂️ El modelo usó File Search / Retrieval");
            } else {
                console.log("⚠️ El modelo NO usó File Search en esta respuesta");
            }

            const assistantResponse = messages.data
                .filter(m => m.role === 'assistant')
                .pop();

            const answer = assistantResponse ? assistantResponse.content[0].text.value : null;
            const cleanAnswer = answer?.replace(/【\d+:\d+†source】/g, '') ?? null;

            return { thread, response: cleanAnswer };
        }

        return { thread, response: null };
    } catch (err) {
        console.error("Error al conectar con OpenAI:", err);
        return { thread, response: "ERROR" };
    }
};

module.exports = { chat };
