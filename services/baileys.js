// wabot — Conexión a WhatsApp por Baileys (cliente no oficial, WhatsApp Web).
//
// LO QUE HAY QUE SABER ANTES DE TOCAR ESTE ARCHIVO:
//
// Esto NO es la API oficial de Meta. Es un cliente que habla el protocolo de
// WhatsApp Web, y los términos de WhatsApp lo prohíben. El castigo es el
// baneo del número — el número del cliente, que suele ser su negocio entero.
// Todo lo que hay acá está escrito para parecerse a una persona usando su
// teléfono, no porque quede lindo sino porque es lo único que evita eso.
//
// La diferencia de fondo con metaWhatsapp.js: Meta es sin estado —llega un
// webhook, se contesta, se olvida—. Esto es una conexión viva por negocio,
// que se cae, se reconecta, y a veces pide que alguien escanee un QR otra
// vez. Un proceso que se reinicia pierde las conexiones hasta reconectarlas.
const fs = require("fs");
const path = require("path");
const { CONFIG, log } = require("../config");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  jidNormalizedUser,
  Browsers,
} = require("@whiskeysockets/baileys");

// Baileys habla mucho. Su logger quiere una interfaz tipo pino; se le da una
// que tira todo salvo los errores, que sí van a nuestro log.
const silencio = {
  level: "silent",
  trace() {}, debug() {}, info() {}, warn() {},
  error: (...a) => log.error("[BAILEYS]", ...a),
  fatal: (...a) => log.error("[BAILEYS]", ...a),
  child: () => silencio,
};

// Una conexión por negocio. La clave es la misma que usa el resto del código
// para identificarlo (phoneNumberId), así nada más tiene que cambiar.
const sesiones = new Map();

const RAIZ_AUTH = process.env.BAILEYS_AUTH_DIR || path.join(__dirname, "..", ".baileys");

// WhatsApp usa el "jid": el número con un sufijo según de qué hable.
const aJid = (numero) => `${String(numero).replace(/\D/g, "")}@s.whatsapp.net`;
const deJid = (jid) => String(jid || "").split("@")[0].split(":")[0];
const esGrupo = (jid) => String(jid || "").endsWith("@g.us");

// El texto de un mensaje entrante puede venir en media docena de formas
// distintas según cómo lo mandaron.
function textoDe(msg) {
  const m = msg?.message;
  if (!m) return "";
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    ""
  ).trim();
}

function tipoDe(msg) {
  const m = msg?.message || {};
  if (m.imageMessage) return "image";
  if (m.videoMessage) return "video";
  if (m.audioMessage) return "audio";
  if (m.documentMessage) return "document";
  if (m.stickerMessage) return "sticker";
  if (m.locationMessage) return "location";
  return "text";
}

// Abre (o reusa) la conexión de un negocio.
//
// `alRecibir` se llama con cada mensaje entrante ya traducido a la forma que
// usa el resto del código, para que conversacion.js no sepa de dónde vino.
async function conectar(sesionId, alRecibir) {
  if (sesiones.has(sesionId)) return sesiones.get(sesionId);

  const carpeta = path.join(RAIZ_AUTH, String(sesionId).replace(/[^a-zA-Z0-9_-]/g, "_"));
  fs.mkdirSync(carpeta, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(carpeta);
  const { version } = await fetchLatestBaileysVersion();

  const sesion = { sesionId, sock: null, qr: null, estado: "conectando", alRecibir, carpeta, reintentos: 0 };
  sesiones.set(sesionId, sesion);

  const sock = makeWASocket({
    version,
    auth: state,
    logger: silencio,
    // Un navegador de escritorio común. Anunciarse como algo exótico es
    // gratis de hacer y gratis de detectar.
    browser: Browsers.ubuntu("Chrome"),
    // EL AJUSTE QUE MÁS LE IMPORTA AL DUEÑO: en false, su teléfono sigue
    // recibiendo notificaciones normalmente. En true, WhatsApp lo da por
    // "en línea desde la computadora" y le deja de avisar al celular — el
    // dueño cree que no le escribe nadie.
    markOnlineOnConnect: false,
    // El historial completo son cientos de megas y minutos de sincronización
    // por cada conexión. Lo que llega igual es lo reciente, que alcanza.
    syncFullHistory: false,
  });

  sesion.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      sesion.qr = qr;
      sesion.estado = "esperando-qr";
      log.info(`[BAILEYS ${sesionId}] QR nuevo — hay que escanearlo`);
    }

    if (connection === "open") {
      sesion.qr = null;
      sesion.estado = "conectado";
      sesion.reintentos = 0;
      sesion.numero = deJid(jidNormalizedUser(sock.user?.id));
      log.info(`[BAILEYS ${sesionId}] conectado como ${sesion.numero}`);
    }

    if (connection === "close") {
      const codigo = lastDisconnect?.error?.output?.statusCode;
      const cerroSesion = codigo === DisconnectReason.loggedOut;
      sesiones.delete(sesionId);

      if (cerroSesion) {
        // Cerraron la sesión desde el teléfono. Las credenciales guardadas ya
        // no sirven: reconectar con ellas da un bucle de errores. Se borran y
        // hace falta escanear de nuevo.
        sesion.estado = "desvinculado";
        fs.rmSync(carpeta, { recursive: true, force: true });
        log.error(`[BAILEYS ${sesionId}] sesión cerrada desde el teléfono — hay que volver a escanear el QR`);
        return;
      }

      // Espera creciente: si WhatsApp está rechazando, insistir cada segundo
      // es la forma más rápida de que el número quede marcado.
      const espera = Math.min(60000, 2000 * 2 ** Math.min(sesion.reintentos, 5));
      log.warn(`[BAILEYS ${sesionId}] conexión caída (${codigo}) — reintento en ${espera / 1000}s`);
      setTimeout(() => {
        conectar(sesionId, alRecibir).catch(e => log.error(`[BAILEYS ${sesionId}] no se pudo reconectar:`, e.message));
      }, espera);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // "append" son mensajes viejos que llegan al sincronizar. Contestarlos
    // sería responder conversaciones de hace semanas de golpe.
    if (type !== "notify") return;

    for (const msg of messages) {
      const jid = msg.key?.remoteJid;
      // Propios, estados y grupos no se contestan. Un bot que habla en un
      // grupo es la forma más rápida de que lo reporten.
      if (msg.key?.fromMe || !jid || jid === "status@broadcast" || esGrupo(jid)) continue;

      try {
        await sesion.alRecibir?.({
          sesionId,
          numero: deJid(jid),
          jid,
          texto: textoDe(msg),
          tipo: tipoDe(msg),
          nombrePerfil: msg.pushName || "",
          mensajeId: msg.key.id,
          clave: msg.key,
          crudo: msg,
        });
      } catch (e) {
        log.error(`[BAILEYS ${sesionId}] fallo procesando un mensaje:`, e.stack || e.message);
      }
    }
  });

  return sesion;
}

function sesionDe(sesionId) {
  const s = sesiones.get(sesionId);
  if (!s?.sock || s.estado !== "conectado") {
    throw new Error(`La sesión "${sesionId}" no está conectada (${s?.estado || "sin sesión"})`);
  }
  return s;
}

// ─── Lo que usa el resto del código ─────────────────────────────────────────
// Mismas firmas que metaWhatsapp.js: el primer argumento identifica al
// negocio y el segundo al cliente.

async function enviarTexto(sesionId, destino, texto) {
  const { sock } = sesionDe(sesionId);
  return sock.sendMessage(aJid(destino), { text: String(texto) });
}

async function enviarImagen(sesionId, destino, imagen, pie) {
  const { sock } = sesionDe(sesionId);
  // A diferencia de Meta, acá se suben los bytes directamente: no hace falta
  // que la imagen esté publicada en una URL accesible desde internet.
  const contenido = Buffer.isBuffer(imagen) ? { image: imagen } : { image: { url: String(imagen) } };
  if (pie) contenido.caption = String(pie).slice(0, 1024);
  return sock.sendMessage(aJid(destino), contenido);
}

// "escribiendo…" en el chat del cliente. Esto no existe en la API de Meta, y
// es lo que hace que la espera del ritmo humano se entienda en vez de parecer
// que el negocio no contesta.
async function escribiendo(sesionId, destino, prendido = true) {
  const { sock } = sesionDe(sesionId);
  const jid = aJid(destino);
  // Hay que suscribirse a la presencia del chat antes de publicar la propia.
  await sock.presenceSubscribe(jid).catch(() => {});
  return sock.sendPresenceUpdate(prendido ? "composing" : "paused", jid);
}

async function marcarLeido(sesionId, clave) {
  if (!clave) return;
  const { sock } = sesionDe(sesionId);
  return sock.readMessages([clave]);
}

function estado(sesionId) {
  const s = sesiones.get(sesionId);
  return s ? { estado: s.estado, numero: s.numero || null, qr: s.qr } : { estado: "sin sesión", numero: null, qr: null };
}

async function desconectar(sesionId) {
  const s = sesiones.get(sesionId);
  if (!s) return;
  sesiones.delete(sesionId);
  await s.sock?.logout().catch(() => {});
}

module.exports = {
  conectar, desconectar, estado, sesionDe,
  enviarTexto, enviarImagen, escribiendo, marcarLeido,
  aJid, deJid, textoDe, tipoDe, esGrupo,
};
