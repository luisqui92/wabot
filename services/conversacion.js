// wabot — Orquesta un mensaje entrante de punta a punta: lo guarda,
// decide si el bot debe contestar, pide la respuesta a la IA, la guarda y la
// manda. Las rutas no saben nada de esta logica; el webhook solo traduce el
// formato de Meta.
const { CONFIG, log } = require("../config");
const { Negocio, Conversacion } = require("../db/models");
const { responder } = require("./asistenteIA");
const { enviarTexto, enviarConOpciones } = require("./metaWhatsapp");
const { obtenerOCrear, armarContexto, refrescarResumenSiCorresponde } = require("./cliente");
const { descargarMedia, transcribir, vocabularioDe } = require("./audio");
const { leerComprobante, verificar, hashDe } = require("./comprobante");
const { Pedido, Pago } = require("../db/models");

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

// Baja la nota de voz y la transcribe. Devuelve el texto, o null si no se
// pudo — en ese caso ya se le avisó al cliente, porque el peor resultado
// posible es que mande un audio y no pase absolutamente nada.
async function transcribirNotaDeVoz({ phoneNumberId, numero, mediaId }) {
  const negocio = await Negocio.findOne({ phoneNumberId });
  if (!negocio?.activo) return null;

  if (!negocio.transcribirAudios) {
    log.info(`[AUDIO] ${numero} mandó un audio — transcripción desactivada para este negocio`);
    await enviarTexto(phoneNumberId, numero,
      "Por acá no puedo escuchar audios 🙏 ¿me lo escribís?").catch(() => {});
    return null;
  }

  try {
    const inicio = Date.now();
    const { buffer, mime } = await descargarMedia(mediaId, phoneNumberId);
    const texto = await transcribir(buffer, mime, await vocabularioDe(negocio));
    log.info(`[AUDIO] ${numero} — ${(buffer.length / 1024).toFixed(0)} KB transcritos en ${((Date.now() - inicio) / 1000).toFixed(1)}s (${texto.length} chars)`);

    // Un audio de ruido o silencio transcribe a nada. Contestar a un texto
    // vacío haría que el bot invente sobre qué le preguntaron.
    if (!texto) {
      await enviarTexto(phoneNumberId, numero,
        "No llegué a entender el audio 🙏 ¿me lo repetís o me lo escribís?").catch(() => {});
      return null;
    }
    return texto;
  } catch (e) {
    log.error("[AUDIO] No se pudo transcribir:", e.message);
    // Que falle la transcripción no puede terminar en silencio: el cliente no
    // sabe si lo estamos ignorando o si se rompió algo.
    await enviarTexto(phoneNumberId, numero,
      "No pude escuchar tu audio 🙏 ¿me lo escribís? En un momento te respondo.").catch(() => {});
    return null;
  }
}

// Una imagen que mandó un cliente. Si el negocio cobra por QR, se trata como
// comprobante: se lee, se compara y se avisa al dueño. Nunca se marca nada
// como pagado — eso lo decide una persona en el panel.
async function procesarComprobante({ phoneNumberId, numero, mediaId, nombrePerfil }) {
  const negocio = await Negocio.findOne({ phoneNumberId });
  if (!negocio?.activo) return null;

  if (!negocio.herramientas?.cobros) {
    log.info(`[COBRO] ${numero} mandó una imagen pero el negocio no tiene cobros activados`);
    return null;
  }

  const cliente = await obtenerOCrear(negocio._id, numero, nombrePerfil);

  try {
    const { buffer, mime } = await descargarMedia(mediaId, phoneNumberId);
    const hashImagen = hashDe(buffer);

    // El pedido al que corresponde. Puede no haber ninguno: alguien puede
    // pagar antes de pedir, y eso también hay que registrarlo en vez de
    // perderlo.
    const pedido = await Pedido.findOne({
      negocioId: negocio._id, numero, estado: { $in: ["nuevo", "confirmado"] }, pagado: false,
    }).sort({ creadoEn: -1 });

    const datos = await leerComprobante(buffer, mime);
    const { detectadoCentavos, alertas } = await verificar({
      negocioId: negocio._id, datos, hashImagen,
      esperadoCentavos: pedido?.totalCentavos || 0,
      moneda: pedido?.moneda || "BOB",
    });

    if (!pedido) alertas.push("No hay ningún pedido pendiente de este número: el pago no está asociado a nada.");

    const pago = await Pago.create({
      negocioId: negocio._id, clienteId: cliente._id, pedidoId: pedido?._id || null, numero,
      esperadoCentavos: pedido?.totalCentavos || 0,
      detectadoCentavos, moneda: pedido?.moneda || datos?.moneda || "BOB",
      banco: datos?.banco || "", referencia: datos?.referencia ? String(datos.referencia).trim() : "",
      fechaComprobante: datos?.fecha || "", emisor: datos?.emisor || "",
      hashImagen, imagen: buffer, imagenMime: mime, alertas,
    });

    log.info(`[COBRO] ${numero} — comprobante ${detectadoCentavos !== null ? (detectadoCentavos / 100).toFixed(2) : "ilegible"}, ${alertas.length} alerta(s)`);

    // Aviso al dueño. Se manda SIEMPRE, coincida o no: es él quien decide, y
    // un pago que coincide perfecto pero del que nadie se entera es un pedido
    // que no sale.
    if (negocio.numeroEscalamiento) {
      const monto = detectadoCentavos !== null ? `${pago.moneda} ${(detectadoCentavos / 100).toFixed(2)}` : "monto ilegible";
      const esperado = pedido ? ` (esperado ${pago.moneda} ${(pedido.totalCentavos / 100).toFixed(2)})` : "";
      const cuerpo = [
        `💰 Comprobante nuevo de ${cliente.nombre || cliente.nombrePerfil || numero}`,
        `${monto}${esperado}`,
        pago.banco ? `Banco: ${pago.banco}` : "",
        pago.referencia ? `Ref: ${pago.referencia}` : "",
        alertas.length ? `\n⚠️ ${alertas.join("\n⚠️ ")}` : "\n✅ El monto coincide.",
        `\nAceptalo o rechazalo en el panel.`,
      ].filter(Boolean).join("\n");
      enviarTexto(phoneNumberId, negocio.numeroEscalamiento, cuerpo)
        .catch(e => log.error("[COBRO] No se pudo avisar:", e.message));
    }

    // Al cliente NO se le dice si el monto coincide. Confirmarle un pago que
    // todavía nadie miró es exactamente el agujero que deja pasar un
    // comprobante falso.
    await enviarTexto(phoneNumberId, numero,
      "¡Gracias! Recibimos tu comprobante 🧾 Lo estamos verificando y en un momento te confirmamos.");
    return pago;
  } catch (e) {
    log.error("[COBRO] No se pudo procesar el comprobante:", e.message);
    await enviarTexto(phoneNumberId, numero,
      "Recibimos tu imagen pero no la pudimos leer 🙏 En un momento te contacta una persona.").catch(() => {});
    return null;
  }
}

async function procesarMensajeEntrante({ phoneNumberId, numero, texto, nombrePerfil, esAudio = false }) {
  const negocio = await Negocio.findOne({ phoneNumberId });
  if (!negocio) {
    // Pasa cuando el numero esta dado de alta en Meta pero todavia no en el
    // panel. Es un error de configuracion, no del cliente: se loguea y se
    // deja pasar en silencio en vez de contestarle cualquier cosa.
    log.warn("[CONV] Llegó un mensaje de un phone_number_id sin negocio cargado:", phoneNumberId);
    return;
  }
  if (!negocio.activo) return;

  // El cliente se resuelve siempre, incluso si la conversación está pausada:
  // que atienda una persona no significa que deje de contar como contacto.
  const cliente = await obtenerOCrear(negocio._id, numero, nombrePerfil);

  let conversacion = await Conversacion.findOne({ negocioId: negocio._id, numero });
  if (!conversacion) {
    conversacion = new Conversacion({ negocioId: negocio._id, numero, nombrePerfil, clienteId: cliente._id });
  } else {
    if (nombrePerfil && conversacion.nombrePerfil !== nombrePerfil) conversacion.nombrePerfil = nombrePerfil;
    // Las conversaciones creadas antes de que existiera Cliente no tienen
    // clienteId. Se enlazan solas la próxima vez que el cliente escribe, sin
    // script de migración.
    if (!conversacion.clienteId) conversacion.clienteId = cliente._id;
  }

  await agregarMensaje(conversacion, { rol: "cliente", texto, esAudio });

  // Se loguea el largo del mensaje y NO su contenido: los logs son para
  // operar (¿llegó? ¿respondimos?), y el texto de lo que escribe un cliente
  // es dato suyo — está en el panel, que es donde corresponde leerlo, y no
  // desparramado en archivos de log que van a parar a cualquier lado.
  log.info(`[CONV] ${numero} -> ${esAudio ? "audio transcrito" : "mensaje"} (${texto.length} chars)`);

  // Una persona tomó la conversación: el bot se calla, pero el mensaje del
  // cliente igual queda guardado (arriba) para que lo vea en el panel.
  if (conversacion.pausado) {
    log.info(`[CONV] ${numero} — conversación pausada, el bot no responde`);
    return;
  }

  // El historial que ve la IA excluye el mensaje que se acaba de guardar —
  // ese va aparte como la consulta actual, y duplicarlo hace que el modelo
  // lo lea dos veces y a veces conteste dos veces.
  const historial = conversacion.mensajes
    .slice(0, -1)
    .slice(-CONFIG.MAX_MENSAJES_HISTORIAL)
    .map(m => ({ rol: m.rol, texto: m.texto }));

  let salida;
  try {
    salida = await responder(negocio, texto, historial, armarContexto(cliente),
      { numero, clienteId: cliente._id, phoneNumberId });
  } catch (e) {
    log.error("[CONV] Falló la IA:", e.response?.data?.error?.message || e.message);
    // Caer en silencio deja al cliente esperando sin saber que pasó. Se
    // contesta el mismo mensaje de "no tengo eso" y se escala, que es el
    // camino que ya existe para cuando el bot no puede responder.
    salida = { respuesta: negocio.mensajeSinInfo, noSe: true };
  }

  await agregarMensaje(conversacion, { rol: "bot", texto: salida.respuesta, sinRespuesta: salida.noSe });

  // Un mensaje con opciones para tocar, o texto plano. Lo decide
  // enviarConOpciones según cuántas opciones haya: no es una decisión que
  // deba tomar quien orquesta la conversación.
  const formato = salida.opciones?.length
    ? await enviarConOpciones(phoneNumberId, numero, salida.respuesta, salida.opciones, salida.tituloOpciones)
    : (await enviarTexto(phoneNumberId, numero, salida.respuesta), "texto");

  log.info(`[CONV] ${numero} <- respondido en ${formato}${salida.noSe ? " (SIN INFO: falta cargar esto en la base)" : ""}`);

  // Después de responder, nunca antes: la ficha es nuestra, la espera es del
  // cliente. Si esto falla o tarda, la conversación ya terminó bien.
  refrescarResumenSiCorresponde(cliente, conversacion.mensajes);

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

module.exports = { procesarMensajeEntrante, transcribirNotaDeVoz, procesarComprobante, agregarMensaje };
