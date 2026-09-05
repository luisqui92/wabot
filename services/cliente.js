// wabot — Memoria del cliente.
//
// La idea: que el bot no arranque de cero cada vez. Sabe con quién habla,
// qué le preguntó antes y qué anotó el dueño sobre esa persona.
//
// El resumen NO se regenera en cada mensaje. Sería una llamada al modelo por
// cada línea que escribe el cliente —el doble de costo por conversación— para
// actualizar algo que casi nunca cambia entre un mensaje y el siguiente. Se
// regenera cada MENSAJES_PARA_RESUMIR mensajes, y siempre DESPUÉS de haberle
// contestado al cliente: nadie debería esperar más por su respuesta para que
// nosotros actualicemos una ficha.
const axios = require("axios");
const { CONFIG, log } = require("../config");
const { Cliente } = require("../db/models");

const MENSAJES_PARA_RESUMIR = 8;

// Cuántos mensajes del historial mira el resumen. Más que esto no mejora la
// ficha y sí encarece cada actualización.
const MENSAJES_PARA_CONTEXTO = 40;

async function obtenerOCrear(negocioId, numero, nombrePerfil) {
  // upsert y no findOne+create: dos mensajes que llegan casi juntos crearían
  // dos clientes con el mismo número y el índice unique tiraría error en uno.
  const cliente = await Cliente.findOneAndUpdate(
    { negocioId, numero },
    {
      $setOnInsert: { negocioId, numero, primerContacto: new Date() },
      $set: { ultimoContacto: new Date(), ...(nombrePerfil ? { nombrePerfil } : {}) },
      $inc: { totalMensajes: 1, mensajesDesdeResumen: 1 },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return cliente;
}

// El bloque que ve la IA. Devuelve null cuando no hay nada que decir —así el
// prompt no se llena de "sin información", que solo gasta tokens y le enseña
// al modelo a hablar de sus propias fichas.
function armarContexto(cliente) {
  if (!cliente) return null;
  const partes = [];

  const nombre = cliente.nombre || cliente.nombrePerfil;
  if (nombre) partes.push(`Se llama ${nombre}.`);

  // Solo cuenta como "ya lo conocemos" si hubo una conversación de verdad.
  // Con dos mensajes, saludarlo como a un viejo conocido suena falso.
  if (cliente.totalMensajes > 3) {
    const dias = Math.floor((Date.now() - new Date(cliente.primerContacto)) / 86400000);
    partes.push(dias > 0
      ? `Ya es cliente conocido: escribe desde hace ${dias} día${dias === 1 ? "" : "s"}.`
      : `Ya escribió varias veces hoy.`);
  }

  if (cliente.resumen) partes.push(`Lo que sabemos de esta persona:\n${cliente.resumen}`);

  // Las notas van al final y marcadas como del dueño: son la fuente más
  // confiable de las tres, porque las escribió una persona a propósito.
  if (cliente.notas?.trim()) partes.push(`Notas que dejó el negocio sobre esta persona:\n${cliente.notas.trim()}`);

  if (cliente.etiquetas?.length) partes.push(`Etiquetas: ${cliente.etiquetas.join(", ")}.`);

  return partes.length ? partes.join("\n") : null;
}

const PROMPT_RESUMEN = `Vas a leer la conversación entre un negocio y un cliente, y escribir una
ficha corta de QUIÉN es ese cliente, para que la próxima vez que escriba el
negocio ya lo conozca.

Incluí solo lo que sirva para atenderlo mejor la próxima vez:
- qué le interesa o qué compró
- qué preguntó antes
- cómo prefiere que le hablen, si se nota
- cualquier dato concreto que él mismo haya dado (zona, horarios, preferencias)

Reglas:
- Máximo 4 líneas. Es una ficha, no un acta.
- SOLO lo que el cliente dijo o mostró. No deduzcas su situación económica, su
  edad, su estado de ánimo ni nada que no haya dicho: una ficha con inventos es
  peor que no tener ficha, porque el bot la va a usar como si fuera cierta.
- Si la conversación no da para una ficha útil, respondé exactamente: SIN DATOS
- Escribí en tercera persona, seco y sin adornos. Nadie lo va a leer por placer.`;

// Regenera la ficha. Se llama en segundo plano: si falla, se pierde una
// actualización y se reintenta sola en los próximos mensajes — nunca debe
// romper la conversación con el cliente.
async function actualizarResumen(cliente, mensajes) {
  if (!CONFIG.OPENAI_KEY) return;

  const transcripcion = mensajes
    .slice(-MENSAJES_PARA_CONTEXTO)
    .map(m => `${m.rol === "cliente" ? "Cliente" : "Negocio"}: ${m.texto}`)
    .join("\n");

  const res = await axios.post(
    `${CONFIG.OPENAI_BASE_URL}/chat/completions`,
    {
      model: CONFIG.OPENAI_MODELO,
      messages: [
        { role: "system", content: PROMPT_RESUMEN },
        { role: "user", content: `${cliente.resumen ? `Ficha actual:\n${cliente.resumen}\n\n---\n\n` : ""}Conversación:\n${transcripcion}` },
      ],
      max_tokens: 250,
      temperature: 0.2,
    },
    { headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}` }, timeout: CONFIG.TIMEOUT_OPENAI }
  );

  const texto = (res.data.choices[0].message.content || "").trim();

  // "SIN DATOS" no se guarda como resumen: si la conversación todavía no da
  // para una ficha, es mejor no tener ninguna que tener una que diga que no
  // se sabe nada. Pero el contador se resetea igual, para no reintentar en
  // cada mensaje una charla que no va a dar más.
  await Cliente.updateOne(
    { _id: cliente._id },
    {
      $set: {
        ...(texto && texto !== "SIN DATOS" ? { resumen: texto, resumenActualizadoEn: new Date() } : {}),
        mensajesDesdeResumen: 0,
      },
    }
  );

  if (texto && texto !== "SIN DATOS") log.info(`[CLIENTE] ${cliente.numero} — ficha actualizada`);
}

// Lanza la actualización si toca, sin bloquear. El caller no espera.
function refrescarResumenSiCorresponde(cliente, mensajes) {
  if (cliente.mensajesDesdeResumen < MENSAJES_PARA_RESUMIR) return;
  actualizarResumen(cliente, mensajes)
    .catch(e => log.error("[CLIENTE] No se pudo actualizar la ficha:", e.response?.data?.error?.message || e.message));
}

module.exports = { obtenerOCrear, armarContexto, actualizarResumen, refrescarResumenSiCorresponde, MENSAJES_PARA_RESUMIR };
