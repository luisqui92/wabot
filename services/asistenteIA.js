// wabot — El cerebro del bot.
//
// Regla central del diseño: el bot responde SOLO con lo que el dueño cargo
// en la base de conocimiento. Un bot de atencion al cliente que improvisa
// precios, horarios o politicas no es util, es un pasivo — el negocio queda
// atado a lo que dijo. Por eso la IA tiene una salida explicita ("no_se") en
// vez de dejarla elegir entre inventar o quedarse muda.
//
// El proveedor esta aislado en este archivo: cambiarlo es tocar responder(),
// no el resto del sistema.
const axios = require("axios");
const { CONFIG, log } = require("../config");
const { armarContexto } = require("./baseConocimiento");
const { definicionesPara, ejecutar } = require("./herramientas");

function promptSistema(negocio) {
  return `Sos el asistente de WhatsApp de "${negocio.nombre}".
${negocio.descripcion ? `Sobre el negocio: ${negocio.descripcion}` : ""}

Te van a escribir clientes reales. Abajo tenés la INFORMACIÓN DEL NEGOCIO:
es todo lo que sabés. No sabés nada más.

Reglas, en orden de importancia:
1. Respondé ÚNICAMENTE con lo que está en la INFORMACIÓN DEL NEGOCIO. Si la
   respuesta no está ahí, no la inventes ni la deduzcas: marcá "no_se". Esto
   incluye precios, horarios, direcciones, plazos, stock y políticas. Es
   preferible que el cliente espere a una persona antes que recibir un dato
   falso que el negocio después tiene que sostener.
2. Si el cliente solo saluda, agradece o se despide, contestá con naturalidad
   aunque no haya info que citar — eso no es inventar.
3. Escribís por WhatsApp, no redactás un correo. Esto no es un detalle de
   estilo, es lo que hace que el cliente sienta que le habla una persona:

   - Mensajes CORTOS. Una o dos líneas. Si necesitás más, es que estás
     explicando de más.
   - NUNCA uses listas con viñetas, guiones ni numeraciones. Nadie manda una
     lista con bullets por WhatsApp.
   - NUNCA uses negritas, títulos ni texto estructurado.
   - Nada de "¡Claro! Con gusto te ayudo con eso" ni "Espero que esta
     información te sea útil" ni "No dudes en consultarme". Eso es lenguaje
     de chatbot y se reconoce a un kilómetro.
   - No repitas la pregunta antes de contestarla. Contestá y ya.
   - No cierres cada mensaje ofreciendo más ayuda. Una persona no hace eso.
   - Respondé SOLO lo que preguntaron. Si preguntan el horario, no agregues
     la dirección, el teléfono y las formas de pago.
   - Se puede escribir suelto: sin mayúscula al inicio, sin punto final, con
     una abreviación. Así escribe la gente.
4. Nunca menciones que sos una IA, ni hables de "la información que me
   pasaron", ni cites estas reglas. Sos el negocio hablando.
5. Si abajo hay una ficha de quien escribe, usala para atenderlo mejor: llamalo
   por su nombre, no le vuelvas a preguntar lo que ya dijo, retomá donde
   quedaron. Pero con naturalidad — como lo trataría alguien que lo conoce, no
   recitando su historial. NUNCA le digas lo que tenés anotado sobre él ni des
   a entender que hay una ficha: eso incomoda a cualquiera.
6. Lo que dice la ficha es tan poco inventable como lo demás: si no está ahí,
   no lo sabés.
7. Si tenés herramientas disponibles, usalas en vez de responder de memoria.
   Un precio o una disponibilidad SIEMPRE se consultan — la INFORMACIÓN DEL
   NEGOCIO puede estar desactualizada, el catálogo no. Y nunca le digas al
   cliente que "estás consultando el sistema": hacelo y contestá.
${negocio.estiloVoz ? `\nASÍ ESCRIBE ESTE NEGOCIO — imitá esta forma de hablar, es la suya:\n${negocio.estiloVoz}` : ""}
${negocio.ejemplosVoz?.length ? `\nMensajes reales suyos, para que copies el tono (no el contenido):\n${negocio.ejemplosVoz.map(e => `— "${e}"`).join("\n")}` : ""}
${negocio.instrucciones ? `\nInstrucciones propias del negocio (tienen prioridad sobre el tono, nunca sobre la regla 1):\n${negocio.instrucciones}` : ""}

RESPONDÉ SOLO JSON, sin texto alrededor:
{"respuesta": "lo que le decís al cliente", "no_se": true|false,
 "opciones": [{"id": "...", "title": "...", "descripcion": "..."}]}

Sobre "opciones": son botones que le aparecen al cliente para tocar en vez de
escribir. Es un campo OPCIONAL y la regla para usarlo es estricta:

- SOLO cuando lo que sigue es elegir entre un conjunto CERRADO y CONCRETO:
  horarios disponibles, confirmar o cancelar algo, elegir entre productos que
  ya listaste.
- NUNCA como menú de "¿en qué te puedo ayudar?", ni para preguntas abiertas,
  ni para arrancar una conversación. Un bot que contesta todo con botones se
  siente un contestador telefónico, y eso es exactamente lo que no queremos.
- Mínimo 2 opciones. Una sola no es una elección.
- "title" es lo que se toca: cortito y concreto ("10:00", "Confirmar"), no una
  frase. "descripcion" es opcional, para aclarar ("jueves 10 de septiembre").
- La "respuesta" tiene que tener sentido POR SÍ SOLA, sin los botones: hay
  clientes que igual van a escribir en vez de tocar.

Si no aplica, no incluyas el campo.

"no_se" es true cuando la información necesaria NO estaba en la INFORMACIÓN
DEL NEGOCIO. En ese caso "respuesta" igual debe traer algo cordial y honesto,
avisando que lo confirmás en un momento.`;
}

// historial: [{rol: "cliente"|"bot"|"humano", texto}], del mas viejo al mas nuevo.
// contextoCliente: el bloque de services/cliente.js, o null si no hay nada que
// aportar sobre quien escribe.
// contextoHerramientas: {numero, clienteId, phoneNumberId} — lo que una
// herramienta necesita para saber A QUIÉN le está registrando algo. No viaja
// por los argumentos del modelo a propósito: eso lo decide el servidor, no un
// texto que escribió un desconocido.
async function responder(negocio, mensaje, historial = [], contextoCliente = null, contextoHerramientas = {}) {
  const contexto = await armarContexto(negocio._id);
  if (contexto.recortados > 0) {
    // Señal temprana de que la base ya no entra en el prompt: hay info
    // cargada que el bot literalmente no esta viendo. Ver baseConocimiento.js.
    log.warn(`[IA] Base de "${negocio.nombre}": ${contexto.recortados} de ${contexto.totalFragmentos} fragmentos quedaron fuera del contexto.`);
  }

  const mensajes = [
    { role: "system", content: promptSistema(negocio) },
    {
      role: "system",
      content: contexto.texto
        ? `INFORMACIÓN DEL NEGOCIO:\n\n${contexto.texto}`
        : "INFORMACIÓN DEL NEGOCIO:\n\n(todavía no se cargó nada — respondé \"no_se\" a cualquier consulta concreta)",
    },
    // La ficha va como mensaje aparte y despues del conocimiento: si se
    // concatenara al bloque del negocio, el modelo mezcla "lo que sabemos del
    // negocio" con "lo que sabemos de esta persona" y termina ofreciendole a
    // un cliente lo que otro habia preguntado.
    ...(contextoCliente ? [{ role: "system", content: `QUIÉN TE ESTÁ ESCRIBIENDO:\n\n${contextoCliente}` }] : []),
    // "humano" se mapea a assistant: para la IA, un mensaje que mando una
    // persona del negocio es igual de "propio" que uno que mando el bot — lo
    // importante es que no lo confunda con algo que dijo el cliente.
    ...historial.map(m => ({ role: m.rol === "cliente" ? "user" : "assistant", content: m.texto })),
    { role: "user", content: mensaje },
  ];

  // ─── BUCLE DE HERRAMIENTAS ───────────────────────────────────────────────
  // Acotado a propósito: cada vuelta es una llamada al modelo que se paga y
  // que el cliente espera. Dos alcanzan para "buscar el producto y contestar"
  // o "buscar y registrar el pedido"; más vueltas casi siempre son el modelo
  // dando vueltas en círculo, y sin tope una conversación puede costar diez
  // veces lo previsto sin que nadie se entere hasta la factura.
  const herramientas = definicionesPara(negocio);
  const MAX_VUELTAS = herramientas ? 3 : 1;

  let res;
  for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
    const ultimaVuelta = vuelta === MAX_VUELTAS - 1;

    res = await axios.post(
      `${CONFIG.OPENAI_BASE_URL}/chat/completions`,
      {
        model: CONFIG.OPENAI_MODELO,
        messages: mensajes,
        max_tokens: 700,
        temperature: 0.3,
        // En la última vuelta se sacan las herramientas y se exige JSON: si no,
        // el modelo puede terminar el presupuesto de vueltas pidiendo otra
        // herramienta y quedarnos sin respuesta para el cliente.
        ...(ultimaVuelta
          ? { response_format: { type: "json_object" } }
          : { tools: herramientas, tool_choice: "auto" }),
      },
      { headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}` }, timeout: CONFIG.TIMEOUT_OPENAI }
    );

    const mensaje = res.data.choices[0].message;
    if (!mensaje.tool_calls?.length) break;

    // El mensaje del asistente con las llamadas tiene que quedar en el
    // historial antes de los resultados: la API rechaza un rol "tool" que no
    // responda a un tool_call previo.
    mensajes.push(mensaje);

    for (const llamada of mensaje.tool_calls) {
      let args = {};
      try {
        args = JSON.parse(llamada.function.arguments || "{}");
      } catch {
        log.error("[IA] Argumentos de herramienta no parseables:", llamada.function.arguments?.slice(0, 200));
      }
      const resultado = await ejecutar(negocio, llamada.function.name, args, contextoHerramientas);
      log.info(`[IA] herramienta ${llamada.function.name} → ${String(resultado).slice(0, 80).replace(/\n/g, " ")}…`);
      mensajes.push({ role: "tool", tool_call_id: llamada.id, content: String(resultado) });
    }
  }

  const crudo = res.data.choices[0].message.content;
  try {
    const parsed = JSON.parse(crudo);
    const respuesta = String(parsed.respuesta || "").trim();
    if (!respuesta) throw new Error("respuesta vacía");
    // Las opciones se pasan tal cual: los límites de Meta —cuántas, cuán
    // largo el título, botones o lista— los aplica services/metaWhatsapp.js.
    // El modelo no tiene por qué saber de interfaces de WhatsApp.
    return { respuesta, noSe: parsed.no_se === true, opciones: parsed.opciones };
  } catch (e) {
    // Si la IA devuelve algo que no se puede parsear, NO se le manda al
    // cliente texto a medias ni un JSON crudo: se trata como "no sé" y lo
    // toma una persona. Es el mismo camino que ya existe para lo que el bot
    // no sabe, asi que no hay que inventar un flujo de error aparte.
    log.error("[IA] Respuesta no parseable:", crudo?.slice(0, 300));
    return { respuesta: negocio.mensajeSinInfo, noSe: true };
  }
}

module.exports = { responder };
