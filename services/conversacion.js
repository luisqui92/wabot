// wabot — Orquesta un mensaje entrante de punta a punta: lo guarda,
// decide si el bot debe contestar, pide la respuesta a la IA, la guarda y la
// manda. Las rutas no saben nada de esta logica; el webhook solo traduce el
// formato de Meta.
const { CONFIG, log } = require("../config");
const { Negocio, Conversacion } = require("../db/models");
const { responder } = require("./asistenteIA");
const { enviarTexto } = require("./metaWhatsapp");

// El historial embebido se recorta al guardar y no al leer: si solo se
// recortara al leer, un cliente de años haria crecer el documento hasta el
// limite de 16MB de Mongo y las escrituras empezarian a fallar.
const MAX_MENSAJES_GUARDADOS = 200;

async function agregarMensaje(conversacion, mensaje) {
  conversacion.mensajes.push(mensaje);
  if (conversacion.mensajes.length > MAX_MENSAJES_GUARDADOS) {
    conversacion.mensajes = conversacion.mensajes.slice(-MAX_MENSAJES_GUARDADOS);
  }
  conversacion.actualizadoEn = new Date();
  await conversacion.save();
}

async function procesarMensajeEntrante({ phoneNumberId, numero, texto, nombrePerfil }) {
  const negocio = await Negocio.findOne({ phoneNumberId });
  if (!negocio) {
    // Pasa cuando el numero esta dado de alta en Meta pero todavia no en el
    // panel. Es un error de configuracion, no del cliente: se loguea y se
    // deja pasar en silencio en vez de contestarle cualquier cosa.
    log.warn("[CONV] Llegó un mensaje de un phone_number_id sin negocio cargado:", phoneNumberId);
    return;
  }
  if (!negocio.activo) return;

  let conversacion = await Conversacion.findOne({ negocioId: negocio._id, numero });
  if (!conversacion) {
    conversacion = new Conversacion({ negocioId: negocio._id, numero, nombrePerfil });
  } else if (nombrePerfil && conversacion.nombrePerfil !== nombrePerfil) {
    conversacion.nombrePerfil = nombrePerfil;
  }

  await agregarMensaje(conversacion, { rol: "cliente", texto });

  // Una persona tomó la conversación: el bot se calla, pero el mensaje del
  // cliente igual queda guardado (arriba) para que lo vea en el panel.
  if (conversacion.pausado) return;

  // El historial que ve la IA excluye el mensaje que se acaba de guardar —
  // ese va aparte como la consulta actual, y duplicarlo hace que el modelo
  // lo lea dos veces y a veces conteste dos veces.
  const historial = conversacion.mensajes
    .slice(0, -1)
    .slice(-CONFIG.MAX_MENSAJES_HISTORIAL)
    .map(m => ({ rol: m.rol, texto: m.texto }));

  let salida;
  try {
    salida = await responder(negocio, texto, historial);
  } catch (e) {
    log.error("[CONV] Falló la IA:", e.response?.data?.error?.message || e.message);
    // Caer en silencio deja al cliente esperando sin saber que pasó. Se
    // contesta el mismo mensaje de "no tengo eso" y se escala, que es el
    // camino que ya existe para cuando el bot no puede responder.
    salida = { respuesta: negocio.mensajeSinInfo, noSe: true };
  }

  await agregarMensaje(conversacion, { rol: "bot", texto: salida.respuesta, sinRespuesta: salida.noSe });
  await enviarTexto(phoneNumberId, numero, salida.respuesta);

  if (salida.noSe && negocio.numeroEscalamiento) {
    // Aviso al humano de guardia. Va en su propio try: que falle el aviso
    // interno no debe romper la conversacion con el cliente, que ya recibio
    // su respuesta.
    const quien = conversacion.nombrePerfil ? `${conversacion.nombrePerfil} (${numero})` : numero;
    enviarTexto(
      phoneNumberId,
      negocio.numeroEscalamiento,
      `🔔 El bot no supo responderle a ${quien}:\n\n"${texto}"`
    ).catch(e => log.error("[CONV] No se pudo avisar al número de escalamiento:", e.message));
  }
}

module.exports = { procesarMensajeEntrante, agregarMensaje };
