// wabot — Config y logger.
//
// override:true es a proposito: un gestor de procesos (PM2, systemd) puede
// arrastrar variables viejas guardadas desde el primer arranque; sin esto
// dotenv las respeta y el .env del disco queda sin efecto aunque lo edites.
// El .env tiene que ser siempre la fuente de verdad.
require("dotenv").config({ override: true });

const CONFIG = {
  MONGODB_URI: process.env.MONGODB_URI,
  PORT: parseInt(process.env.PORT || "3000", 10),
  APP_URL: process.env.APP_URL || "",

  JWT_SECRET: process.env.JWT_SECRET,

  OPENAI_KEY: process.env.OPENAI_KEY,
  OPENAI_MODELO: process.env.OPENAI_MODELO || "gpt-4o-mini",
  TIMEOUT_OPENAI: 45000,

  // WHATSAPP_TOKEN: token de acceso (Meta -> tu app -> WhatsApp -> API Setup).
  // WHATSAPP_VERIFY_TOKEN: string que definis vos, y se configura IGUAL del
  //   lado de Meta al guardar la Callback URL — confirma que la verificacion
  //   del webhook la esta pidiendo realmente Meta.
  // META_APP_SECRET: firma HMAC de cada webhook entrante (X-Hub-Signature-256).
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN || "",
  WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || "",
  META_APP_SECRET: process.env.META_APP_SECRET || "",

  // Version de la Graph API. Meta deprecia versiones ~2 años despues de
  // publicarlas, asi que esta atado a una constante visible y no enterrado
  // en una URL a mitad de un archivo.
  GRAPH_VERSION: "v21.0",

  // Cuanto texto de la base de conocimiento entra como contexto en cada
  // mensaje. Es el techo de costo por respuesta: con gpt-4o-mini, ~12k
  // caracteres son ~3k tokens de entrada. Si lo subis mucho, cada mensaje
  // del bot cuesta mas y la IA se pierde entre informacion irrelevante.
  MAX_CHARS_CONTEXTO: 12000,

  // Cuantos mensajes previos de la misma conversacion se le pasan a la IA.
  // Sin esto el bot no recuerda nada dentro de la misma charla; con
  // demasiados, cada respuesta cuesta mas y arrastra malentendidos viejos.
  MAX_MENSAJES_HISTORIAL: 12,
};

// ─── LOGGER ────────────────────────────────────────────────────────────────
const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  warn: (...a) => console.warn(new Date().toISOString(), "⚠️", ...a),
  error: (...a) => console.error(new Date().toISOString(), "❌", ...a),
};

// Falla al arrancar, no en el primer request. Un servidor que levanta sin
// JWT_SECRET acepta logins y emite tokens que cualquiera puede falsificar —
// es peor que no levantar.
function validateConfig() {
  const faltan = [];
  if (!CONFIG.MONGODB_URI) faltan.push("MONGODB_URI");
  if (!CONFIG.JWT_SECRET) faltan.push("JWT_SECRET (generalo con: openssl rand -hex 32)");
  if (faltan.length) {
    log.error("Faltan variables de entorno obligatorias:\n  - " + faltan.join("\n  - "));
    process.exit(1);
  }

  // Estas no frenan el arranque a proposito: podes levantar el panel y
  // cargar la base de conocimiento antes de tener el numero de Meta listo.
  if (!CONFIG.OPENAI_KEY) log.warn("[CONFIG] Sin OPENAI_KEY — el bot no va a poder responder.");
  if (!CONFIG.WHATSAPP_TOKEN) log.warn("[CONFIG] Sin WHATSAPP_TOKEN — no se van a poder enviar mensajes.");
  if (!CONFIG.META_APP_SECRET) log.warn("[CONFIG] Sin META_APP_SECRET — los webhooks entrantes NO se verifican (cualquiera que sepa la URL puede inyectar mensajes falsos).");
}

module.exports = { CONFIG, log, validateConfig };
