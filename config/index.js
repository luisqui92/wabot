// wabot — Config y logger.
//
// override:true es a proposito: un gestor de procesos (PM2, systemd) puede
// arrastrar variables viejas guardadas desde el primer arranque; sin esto
// dotenv las respeta y el .env del disco queda sin efecto aunque lo edites.
// El .env tiene que ser siempre la fuente de verdad.
require("dotenv").config({ override: true });

// "wabot", "/wabot", "wabot/" y "/wabot/" tienen que dar todos "/wabot".
// Cadena vacia se queda vacia (app en la raiz).
function normalizarBase(valor) {
  const limpio = String(valor || "").trim().replace(/^\/+|\/+$/g, "");
  return limpio ? `/${limpio}` : "";
}

const CONFIG = {
  MONGODB_URI: process.env.MONGODB_URI,
  PORT: parseInt(process.env.PORT || "3000", 10),
  APP_URL: process.env.APP_URL || "",

  // Prefijo bajo el que se sirve toda la app cuando comparte dominio con
  // otra cosa (ej. "/wabot" para api.chatgo.ia.bo/wabot). Vacio = la app
  // vive en la raiz de su propio dominio o subdominio.
  //
  // Se normaliza aca y no en cada uso: sin esto, un "wabot" o un "/wabot/"
  // en el .env producen rutas como "/wabot//api/login" que devuelven 404
  // sin ninguna pista de por que.
  BASE_PATH: normalizarBase(process.env.BASE_PATH),

  JWT_SECRET: process.env.JWT_SECRET,

  OPENAI_KEY: process.env.OPENAI_KEY,
  OPENAI_MODELO: process.env.OPENAI_MODELO || "gpt-4o-mini",
  // Configurable para poder apuntar a un endpoint compatible (o a un stub en
  // las pruebas) sin tocar código. Cambiar de proveedor sigue siendo tocar
  // asistenteIA.js, pero uno compatible con la API de OpenAI entra por acá.
  OPENAI_BASE_URL: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
  TIMEOUT_OPENAI: 45000,
  // Transcribir tarda más que responder: un audio de dos minutos puede llevar
  // 20 segundos. Con el timeout de texto se cortaría justo en los audios
  // largos, que son los que más valor tienen.
  TIMEOUT_TRANSCRIPCION: 120000,

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

  // ─── RESPALDOS ───────────────────────────────────────────────────────────
  // BACKUP_CLAVE cifra cada copia (AES-256-GCM). Sin ella el respaldo se
  // niega a correr: una copia sin cifrar no se puede sacar del servidor, y
  // un respaldo que solo vive en el mismo disco que la base no protege del
  // caso más común, que es perder el disco.
  //   openssl rand -base64 48
  // Guardala TAMBIÉN fuera del servidor: si se pierde el servidor y la clave
  // estaba solo ahí, los respaldos no se pueden abrir.
  // El JSON completo de la cuenta de servicio de Google, en una línea. Es lo
  // que permite leer y escribir en el calendario que el negocio comparta.
  GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "",

  BACKUP_CLAVE: process.env.BACKUP_CLAVE || "",
  BACKUP_DIR: process.env.BACKUP_DIR || `${process.env.HOME || "/home/rastreoplus"}/respaldos`,
  BACKUP_RETENCION_DIAS: parseInt(process.env.BACKUP_RETENCION_DIAS || "14", 10),
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
