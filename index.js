// ═══════════════════════════════════════════════════════════════════════════
// wabot — Bot de WhatsApp con IA (Meta Cloud API) + panel de control
// ═══════════════════════════════════════════════════════════════════════════
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const mongoose = require("mongoose");

const { CONFIG, log, validateConfig } = require("./config");
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
      imgSrc: ["'self'", "data:"],
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

require("./routes/webhookWhatsapp")(app);
require("./routes/panel")(app);

app.use(express.static(path.join(__dirname, "public")));

app.get("/salud", (_req, res) => res.json({
  ok: true,
  mongo: mongoose.connection.readyState === 1,
}));

mongoose.connect(CONFIG.MONGODB_URI)
  .then(() => {
    log.info("[DB] Conectado a MongoDB");
    app.listen(CONFIG.PORT, () => {
      log.info(`[HTTP] wabot escuchando en :${CONFIG.PORT}`);
      if (CONFIG.APP_URL) log.info(`[HTTP] Callback URL para Meta: ${CONFIG.APP_URL}/webhook/whatsapp`);
    });
  })
  .catch((e) => {
    // Sin base de datos no hay negocio, ni base de conocimiento, ni
    // conversaciones: arrancar igual solo lograría que el bot le conteste
    // errores a clientes reales.
    log.error("[DB] No se pudo conectar a MongoDB:", e.message);
    process.exit(1);
  });
