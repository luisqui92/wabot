// ═══════════════════════════════════════════════════════════════════════════
// wabot — Bot de WhatsApp con IA (Meta Cloud API) + panel de control
// ═══════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const mongoose = require("mongoose");

const { CONFIG, log, validateConfig } = require("./config");
const { aBuffer } = require("./services/httpHelpers");
validateConfig();

const app = express();

// Última red de contención. El webhook procesa los mensajes en segundo plano
// (después de contestarle 200 a Meta), así que una promesa rechazada sin
// catch tumbaría todo el proceso y dejaría al bot mudo para TODOS los
// clientes por un solo mensaje que falló. Mejor perder ese mensaje —y que
// quede en el log— que el servidor entero.
process.on("unhandledRejection", (err) => {
  log.error("[UNHANDLED_REJECTION]", err?.stack || err?.message || err);
});

// Detrás de nginx u otro reverse proxy. Sin esto Express ve todo como si
// viniera de 127.0.0.1.
app.set("trust proxy", 1);

// El panel es todo propio, sin CDN ni scripts de terceros, así que la CSP
// puede ser estricta de entrada.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      // blob: porque las imágenes protegidas (comprobantes, QR de cobro) se
      // bajan con fetch autenticado y se muestran con URL.createObjectURL —
      // sin esto la CSP las bloquea y el dueño ve el recuadro vacío.
      imgSrc: ["'self'", "data:", "blob:"],
      // blob: para el audio que arma MediaRecorder al dictar desde el panel.
      mediaSrc: ["'self'", "blob:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
}));

// verify guarda el cuerpo CRUDO: la firma HMAC de Meta se calcula sobre los
// bytes exactos que mandó, y cualquier re-serialización del JSON parseado
// (orden de claves, escapes unicode) da una firma distinta y rechazaría
// webhooks legítimos. Ver services/metaWhatsapp.js → firmaValida().
app.use(express.json({
  limit: "2mb", // los documentos de la base de conocimiento se pegan como texto
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// Todo cuelga de un Router montado en BASE_PATH, en vez de colgar de app
// directamente. Asi la misma imagen sirve para un dominio propio
// (BASE_PATH vacio) y para compartir dominio con otra API
// (BASE_PATH="/wabot"), sin depender de que el reverse proxy recorte el
// prefijo — que es la parte que se olvida y deja 404 dificiles de leer.
const router = express.Router();

require("./routes/webhookWhatsapp")(router);
require("./routes/panel")(router);

// index:false porque el index.html se sirve mas abajo con el <base>
// inyectado; si express.static lo sirviera primero, saldria el archivo
// crudo con href="/" y el panel pediria los assets a la raiz del dominio.
router.use(express.static(path.join(__dirname, "public"), { index: false }));

// El <base> hace que TODA ruta relativa del panel (assets y llamadas a la
// API) se resuelva contra el prefijo real, con o sin barra final en la URL.
// Es una sustitucion al arrancar y no en cada request: el archivo no cambia
// mientras el proceso vive.
const htmlPanel = fs
  .readFileSync(path.join(__dirname, "public", "index.html"), "utf8")
  .replace('<base href="/">', `<base href="${CONFIG.BASE_PATH}/">`);

router.get(["/", "/index.html"], (_req, res) => res.type("html").send(htmlPanel));

// El QR de cobro, público a propósito: Meta lo descarga por URL para
// mostrárselo al cliente, así que no puede estar detrás de autenticación. No
// es un secreto —es un QR que el negocio le muestra a cualquiera que va a
// pagar— y el token aleatorio evita que se pueda enumerar.
router.get("/qr/:token.png", async (req, res) => {
  try {
    const { Negocio } = require("./db/models");
    const n = await Negocio.findOne({ qrToken: req.params.token }).select("+qrImagen").lean();
    const bytes = aBuffer(n?.qrImagen);
    if (!bytes) return res.sendStatus(404);
    res.set("Content-Type", n.qrMime || "image/png");
    res.set("Cache-Control", "public, max-age=300");
    res.send(bytes);
  } catch (e) {
    log.error("[QR]", e.message);
    res.sendStatus(500);
  }
});

router.get("/salud", (_req, res) => res.json({
  ok: true,
  mongo: mongoose.connection.readyState === 1,
}));

app.use(CONFIG.BASE_PATH || "/", router);

mongoose.connect(CONFIG.MONGODB_URI)
  .then(() => {
    log.info("[DB] Conectado a MongoDB");
    app.listen(CONFIG.PORT, () => {
      log.info(`[HTTP] wabot escuchando en :${CONFIG.PORT}`);
      if (CONFIG.BASE_PATH) log.info(`[HTTP] Montado bajo ${CONFIG.BASE_PATH}`);
      if (CONFIG.APP_URL) log.info(`[HTTP] Callback URL para Meta: ${CONFIG.APP_URL}${CONFIG.BASE_PATH}/webhook/whatsapp`);
    });
  })
  .catch((e) => {
    // Sin base de datos no hay negocio, ni base de conocimiento, ni
    // conversaciones: arrancar igual solo lograría que el bot le conteste
    // errores a clientes reales.
    log.error("[DB] No se pudo conectar a MongoDB:", e.message);
    process.exit(1);
  });
