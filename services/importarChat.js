// wabot — Importar el historial de WhatsApp del negocio.
//
// El problema que resuelve: nadie carga bien su base de conocimiento. Es la
// razón número uno por la que estos productos se abandonan — el dueño no se
// sienta tres horas a escribir lo que ya contestó mil veces.
//
// Pero YA lo contestó mil veces. WhatsApp exporta el chat con un botón, y ahí
// están las preguntas reales, las respuestas reales, y —lo que más importa—
// su forma de hablar. De ahí salen las dos cosas: qué sabe el negocio y CÓMO
// lo dice.
const { CONFIG, log } = require("../config");
const axios = require("axios");

// WhatsApp exporta con formatos distintos según el sistema y el idioma:
//   [06/09/26, 20:41:03] Juan: hola          (iOS)
//   06/09/26, 20:41 - Juan: hola             (Android)
//   6/9/2026, 8:41 p. m. - Juan: hola        (12 horas)
// El nombre puede tener dos puntos adentro, así que se corta en el PRIMER ": "
// después de la marca de tiempo y no en cualquiera.
const LINEA = /^‎?\[?(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?\s*m\.?)?)\]?\s*(?:-\s*)?([^:]{1,60}?):\s([\s\S]*)$/i;

// Lo que WhatsApp mete solo y no dijo nadie.
const DEL_SISTEMA = [
  /cifrad[oa]s? de extremo a extremo/i,
  /<multimedia omitido>|<archivo adjunto|imagen omitida|audio omitido|video omitido|sticker omitido|gif omitido/i,
  /se eliminó este mensaje|eliminaste este mensaje|this message was deleted/i,
  /^\s*(llamada|videollamada) (perdida|de voz|de vídeo)/i,
  /cambió (su número|el asunto|la descripción|el ícono)/i,
  /creó (este grupo|el grupo)|añadió a|salió del grupo/i,
  /^\s*null\s*$/i,
];

function esDelSistema(texto) {
  return DEL_SISTEMA.some(r => r.test(texto));
}

// Devuelve [{autor, texto}] en orden, uniendo los mensajes multilínea.
function parsear(contenido) {
  const mensajes = [];
  for (const linea of String(contenido).replace(/\r\n/g, "\n").split("\n")) {
    const m = linea.match(LINEA);
    if (m) {
      const autor = m[3].trim();
      const texto = m[4].trim();
      // Los avisos del sistema vienen sin autor y matchean raro; los que sí
      // matchean se filtran por su contenido.
      if (!esDelSistema(texto) && texto) mensajes.push({ autor, texto });
    } else if (mensajes.length && linea.trim()) {
      // Continuación de un mensaje de varias líneas.
      mensajes[mensajes.length - 1].texto += "\n" + linea.trim();
    }
  }
  return mensajes;
}

// Quiénes hablan y cuánto. El dueño elige cuál es él: adivinarlo por el
// volumen falla justo en los negocios chicos, donde el cliente escribe más.
function participantes(mensajes) {
  const cuenta = new Map();
  for (const m of mensajes) cuenta.set(m.autor, (cuenta.get(m.autor) || 0) + 1);
  return [...cuenta.entries()]
    .map(([nombre, mensajes]) => ({ nombre, mensajes }))
    .sort((a, b) => b.mensajes - a.mensajes);
}

// Arma los turnos pregunta→respuesta: lo que preguntó el cliente y lo que
// contestó el negocio. Se agrupan los mensajes seguidos del mismo autor
// porque en WhatsApp la gente escribe en ráfagas de tres líneas.
function turnos(mensajes, nombreNegocio) {
  const bloques = [];
  for (const m of mensajes) {
    const esNegocio = m.autor === nombreNegocio;
    const ultimo = bloques[bloques.length - 1];
    if (ultimo && ultimo.esNegocio === esNegocio) ultimo.texto += "\n" + m.texto;
    else bloques.push({ esNegocio, texto: m.texto });
  }

  const pares = [];
  for (let i = 0; i < bloques.length - 1; i++) {
    if (!bloques[i].esNegocio && bloques[i + 1].esNegocio) {
      pares.push({ pregunta: bloques[i].texto, respuesta: bloques[i + 1].texto });
    }
  }
  return pares;
}

const PROMPT_CONOCIMIENTO = `Te paso conversaciones reales entre un negocio y sus clientes. Tu trabajo es
sacar de ahí la INFORMACIÓN DEL NEGOCIO que sirva para responder en el futuro.

Devolvé SOLO JSON:
{"fragmentos": [{"titulo": "...", "texto": "...", "revisar": true|false}]}

Reglas:
- Un fragmento por tema (horarios, precios, ubicación, formas de pago,
  políticas, un producto). Agrupá lo que se repite en vez de duplicarlo.
- "texto" tiene que poder leerse solo, sin la conversación de la que salió.
  Escribilo como un dato del negocio, no como un diálogo.
- SOLO lo que el negocio afirmó. Nunca lo que dijo el cliente ni lo que
  parezca razonable: una conversación vieja no autoriza a inventar.
- "revisar" en true cuando el dato PUEDE HABER CAMBIADO: precios, promociones,
  stock, horarios especiales, plazos. Es lo más importante de todo: importar
  un precio viejo como si fuera actual hace que el bot le cotice mal a un
  cliente real.
- Si de estas conversaciones no sale nada aprovechable, devolvé
  {"fragmentos": []}. Es una respuesta válida.`;

const PROMPT_ESTILO = `Te paso mensajes REALES escritos por el dueño de un negocio a sus clientes por
WhatsApp. Tu trabajo es describir CÓMO ESCRIBE, para que un asistente pueda
sonar como él y no como un chatbot genérico.

Devolvé SOLO JSON:
{"estilo": "...", "ejemplos": ["...", "...", "..."]}

En "estilo", en no más de 8 líneas y en segunda persona ("Escribís..."):
- Largo típico de sus mensajes: ¿una línea o un párrafo?
- ¿Tutea, vosea, o trata de usted?
- Emojis: ¿cuáles, cuántos, o ninguno?
- Cómo saluda y cómo cierra.
- Muletillas y expresiones propias, sobre todo las locales.
- Mayúsculas y puntuación: ¿escribe formal o suelto?
- Qué NO hace nunca.

En "ejemplos", tres mensajes suyos textuales que mejor representen su forma de
escribir. Copialos tal cual, sin corregirlos: las faltas y los cortes son parte
de cómo suena una persona real.

No inventes rasgos que no estén en los mensajes.`;

async function pedirJson(prompt, contenido, maxTokens = 1500) {
  const res = await axios.post(
    `${CONFIG.OPENAI_BASE_URL}/chat/completions`,
    {
      model: CONFIG.OPENAI_MODELO,
      messages: [{ role: "system", content: prompt }, { role: "user", content: contenido }],
      max_tokens: maxTokens,
      temperature: 0.2,
      response_format: { type: "json_object" },
    },
    { headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}` }, timeout: CONFIG.TIMEOUT_OPENAI }
  );
  try {
    return JSON.parse(res.data.choices[0].message.content);
  } catch {
    log.error("[IMPORTAR] Respuesta no parseable");
    return null;
  }
}

// Cuántos pares se mandan por llamada. Un export grande no entra en una sola
// llamada, y mandarlo entero costaría una fortuna: se procesa por lotes y se
// corta en MAX_LOTES para que una importación tenga costo previsible.
const PARES_POR_LOTE = 40;
const MAX_LOTES = 6;

async function analizar(mensajes, nombreNegocio) {
  const pares = turnos(mensajes, nombreNegocio);
  if (!pares.length) return { fragmentos: [], estilo: null, ejemplos: [], paresUsados: 0, paresTotales: 0 };

  const usados = pares.slice(0, PARES_POR_LOTE * MAX_LOTES);
  const fragmentos = [];

  for (let i = 0; i < usados.length; i += PARES_POR_LOTE) {
    const lote = usados.slice(i, i + PARES_POR_LOTE)
      .map(p => `Cliente: ${p.pregunta}\nNegocio: ${p.respuesta}`).join("\n---\n");
    const r = await pedirJson(PROMPT_CONOCIMIENTO, lote);
    for (const f of r?.fragmentos || []) {
      const texto = String(f.texto || "").trim();
      if (texto) fragmentos.push({ titulo: String(f.titulo || "").trim().slice(0, 120), texto, revisar: f.revisar === true });
    }
  }

  // El estilo sale SOLO de lo que escribió el negocio. Mezclar los mensajes
  // del cliente haría que el bot copie la forma de escribir de sus clientes.
  const suyos = mensajes.filter(m => m.autor === nombreNegocio).map(m => m.texto).filter(t => t.length > 3);
  const muestra = suyos.slice(-120).join("\n");
  const est = muestra ? await pedirJson(PROMPT_ESTILO, muestra, 700) : null;

  return {
    fragmentos,
    estilo: est?.estilo?.trim() || null,
    ejemplos: Array.isArray(est?.ejemplos) ? est.ejemplos.filter(Boolean).slice(0, 3) : [],
    paresUsados: usados.length,
    paresTotales: pares.length,
  };
}

module.exports = { parsear, participantes, turnos, analizar, esDelSistema, PARES_POR_LOTE, MAX_LOTES };
