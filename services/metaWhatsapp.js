// wabot — Salida hacia WhatsApp por la API oficial de Meta (Cloud
// API). No hay sesion que vincular ni QR que escanear: la autenticacion es
// un token de Meta y los mensajes salen por HTTPS a la Graph API.
//
// "destino" es siempre el numero tal cual lo manda WhatsApp en el campo
// "from" del webhook (formato internacional sin "+", ej "59176543210").
const crypto = require("crypto");
const axios = require("axios");
const { CONFIG, log } = require("../config");

function urlMensajes(phoneNumberId) {
  return `https://graph.facebook.com/${CONFIG.GRAPH_VERSION}/${phoneNumberId}/messages`;
}

async function mandar(phoneNumberId, body) {
  if (!CONFIG.WHATSAPP_TOKEN || !phoneNumberId) {
    log.warn("[WHATSAPP] Sin token o sin phoneNumberId — no se mandó el mensaje a", body.to);
    return null;
  }
  try {
    const res = await axios.post(
      urlMensajes(phoneNumberId),
      { messaging_product: "whatsapp", recipient_type: "individual", ...body },
      { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}`, "Content-Type": "application/json" }, timeout: 15000 }
    );
    return res.data;
  } catch (e) {
    log.error("[WHATSAPP] Falló el envío:", e.response?.data?.error?.message || e.message);
    throw e;
  }
}

// Meta corta los mensajes de texto en 4096 caracteres. Partirlo acá y no en
// el caller: si la IA se entusiasma, el cliente recibe el mensaje completo
// en dos globos en vez de un error de la Graph API.
const LIMITE_TEXTO = 4000;

async function enviarTexto(phoneNumberId, destino, texto) {
  const partes = [];
  let resto = String(texto || "").trim();
  if (!resto) return null;
  while (resto.length > LIMITE_TEXTO) {
    // Cortar en el ultimo salto de linea o espacio del bloque, para no
    // partir una palabra o una lista al medio.
    const bloque = resto.slice(0, LIMITE_TEXTO);
    const corte = Math.max(bloque.lastIndexOf("\n"), bloque.lastIndexOf(" "));
    const fin = corte > LIMITE_TEXTO / 2 ? corte : LIMITE_TEXTO;
    partes.push(resto.slice(0, fin).trim());
    resto = resto.slice(fin).trim();
  }
  partes.push(resto);

  let ultima = null;
  for (const parte of partes) {
    ultima = await mandar(phoneNumberId, { to: destino, type: "text", text: { body: parte } });
  }
  return ultima;
}

// Hasta 3 botones. Limite de Meta: titulo de 20 caracteres — se recorta acá
// para no depender de que cada caller lo respete.
async function enviarBotones(phoneNumberId, destino, textoBody, botones) {
  return mandar(phoneNumberId, {
    to: destino,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: textoBody },
      action: { buttons: botones.slice(0, 3).map(b => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) },
    },
  });
}

// Marca el mensaje entrante como leido (el cliente ve el doble check azul).
// Es cosmetico: nunca debe frenar el flujo real si falla.
async function marcarLeido(phoneNumberId, messageId) {
  if (!messageId || !CONFIG.WHATSAPP_TOKEN || !phoneNumberId) return;
  try {
    await mandar(phoneNumberId, { status: "read", message_id: messageId });
  } catch { /* ignorado a proposito */ }
}

// ─── VERIFICACION DE FIRMA ──────────────────────────────────────────────────
// Meta firma cada webhook con HMAC-SHA256 del cuerpo CRUDO usando el App
// Secret. Sin esta comprobacion, cualquiera que descubra la URL del webhook
// puede inyectar mensajes falsos: hacerle decir cosas al bot, envenenar el
// historial de una conversacion, o quemar tu cuota de la API de IA.
//
// Requiere el body sin parsear — ver el express.json({verify}) de index.js.
function firmaValida(rawBody, cabeceraFirma) {
  if (!CONFIG.META_APP_SECRET) return true; // sin secreto configurado no se puede verificar (ya se avisa al arrancar)
  if (!rawBody || !cabeceraFirma?.startsWith("sha256=")) return false;
  const esperada = crypto.createHmac("sha256", CONFIG.META_APP_SECRET).update(rawBody).digest("hex");
  const a = Buffer.from(cabeceraFirma.slice(7), "hex");
  const b = Buffer.from(esperada, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { enviarTexto, enviarBotones, marcarLeido, firmaValida };
