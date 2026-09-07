// wabot — El webhook de Meta: verificación inicial y mensajes
// entrantes. Este archivo solo traduce el formato de Meta; toda la lógica de
// qué contestar vive en services/conversacion.js.
const { CONFIG, log } = require("../config");
const { firmaValida, marcarLeido } = require("../services/metaWhatsapp");
const { procesarMensajeEntrante } = require("../services/conversacion");
const { transcribirNotaDeVoz, procesarComprobante, registrarMediaSinSoporte } = require("../services/conversacion");

module.exports = function (app) {
  // ─── VERIFICACIÓN ────────────────────────────────────────────────────────
  // Meta la llama una sola vez, al guardar esta URL como Callback URL en el
  // dashboard (WhatsApp → Configuration).
  app.get("/webhook/whatsapp", (req, res) => {
    const modo = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (modo === "subscribe" && CONFIG.WHATSAPP_VERIFY_TOKEN && token === CONFIG.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    res.sendStatus(403);
  });

  // ─── MENSAJES ENTRANTES ──────────────────────────────────────────────────
  app.post("/webhook/whatsapp", (req, res) => {
    if (!firmaValida(req.rawBody, req.headers["x-hub-signature-256"])) {
      log.warn("[WEBHOOK] Firma inválida — descartado.");
      return res.sendStatus(403);
    }

    // Meta espera un 200 rápido y NO espera a que termines de procesar: si
    // tardás, reintenta el mismo mensaje y el cliente recibe la respuesta
    // dos veces. Por eso se contesta primero y se procesa después.
    res.sendStatus(200);
    procesarWebhook(req.body).catch(e => log.error("[WEBHOOK]", e.stack || e.message));
  });
};

async function procesarWebhook(body) {
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      // Puede ser un evento de estado (delivered/read/failed), no un mensaje.
      for (const msg of value?.messages || []) {
        if (!msg.from || !phoneNumberId) continue;

        let texto = extraerTexto(msg);
        let esAudio = false;

        // Nota de voz: se baja de Meta y se transcribe. Hay que hacerlo YA —
        // la URL del medio vive 5 minutos— y por eso pasa acá y no en una cola.
        if (!texto && (msg.type === "audio" || msg.type === "voice") && msg.audio?.id) {
          marcarLeido(phoneNumberId, msg.id).catch(() => {});
          texto = await transcribirNotaDeVoz({ phoneNumberId, numero: msg.from, mediaId: msg.audio.id });
          esAudio = true;
          if (!texto) continue; // ya se le avisó al cliente adentro
        }

        // El pie de foto NO se mete en extraerTexto a propósito: si lo
        // hiciera, una captura de comprobante con "ya te pagué" escrito abajo
        // dejaría de ir al lector de comprobantes y se trataría como un
        // mensaje de texto cualquiera. Viaja aparte, hasta quien corresponda.
        const pie = (msg.image?.caption || msg.video?.caption || msg.document?.caption || "").trim();
        const nombrePerfil = value?.contacts?.[0]?.profile?.name || "";

        // Una imagen es, casi siempre, un comprobante de pago. Se procesa
        // aparte del flujo de texto: no hay nada que "responder", hay que
        // leerla, verificarla y avisarle al dueño. Si el negocio no cobra por
        // QR, adentro se trata como cualquier otra imagen que no se puede leer.
        if (!texto && msg.type === "image" && msg.image?.id) {
          marcarLeido(phoneNumberId, msg.id).catch(() => {});
          await procesarComprobante({ phoneNumberId, numero: msg.from, mediaId: msg.image.id, pie, nombrePerfil });
          continue;
        }

        // Video, documento, ubicación, sticker. Antes esto se registraba en el
        // log y se descartaba: el cliente no recibía nada y el dueño no veía
        // nada en el panel. Ahora queda en el hilo y se le contesta la verdad.
        if (!texto) {
          marcarLeido(phoneNumberId, msg.id).catch(() => {});
          await registrarMediaSinSoporte({ phoneNumberId, numero: msg.from, tipo: msg.type, pie, nombrePerfil });
          continue;
        }

        marcarLeido(phoneNumberId, msg.id).catch(() => {});

        await procesarMensajeEntrante({
          phoneNumberId,
          numero: msg.from,
          texto,
          esAudio,
          nombrePerfil,
        });
      }
    }
  }
}

// Los audios ya no pasan por acá: los atiende el bloque de arriba. Imagen,
// documento y ubicación siguen devolviendo null a propósito — describir una
// foto es otro problema, y un bot que responde cualquier cosa a una imagen es
// peor que uno que avisa que no la puede ver.
function extraerTexto(msg) {
  if (msg.type === "text") return (msg.text?.body || "").trim() || null;
  if (msg.type === "interactive") {
    const r = msg.interactive?.button_reply || msg.interactive?.list_reply;
    return (r?.title || r?.id || "").trim() || null;
  }
  return null;
}

// Se exporta además del montaje para poder probar el ruteo por tipo de mensaje
// —qué va al lector de comprobantes, qué al bot, qué se contesta como "no
// puedo leer esto"— sin levantar el servidor ni firmar un webhook a mano.
module.exports.procesarWebhook = procesarWebhook;
