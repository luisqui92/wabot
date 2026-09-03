// wabot — Modelos de datos.
//
// El diseño es multi-negocio desde el principio: un mismo despliegue puede
// atender varios numeros de WhatsApp. No es sobre-ingenieria — el webhook de
// Meta ya viene con "phone_number_id" adentro, asi que separar por negocio
// cuesta un campo y un indice, mientras que agregarlo despues obliga a
// migrar todas las colecciones.
const mongoose = require("mongoose");

// ─── NEGOCIO ────────────────────────────────────────────────────────────────
// Un negocio = un numero de WhatsApp = un bot con su propia personalidad y
// su propia base de conocimiento.
const negocioSchema = new mongoose.Schema({
  nombre: { type: String, required: true },

  // El ID INTERNO del numero que da Meta (no el numero telefonico). Es la
  // llave con la que se enruta cada webhook entrante al negocio correcto.
  phoneNumberId: { type: String, required: true, unique: true, index: true },

  // Que es el negocio, en una o dos frases. Va al prompt del sistema.
  descripcion: { type: String, default: "" },

  // Instrucciones libres que el dueño escribe desde el panel ("tuteá",
  // "nunca des precios por WhatsApp", "cerrá siempre invitando a visitarnos").
  // Es lo que hace que dos bots con el mismo codigo suenen distinto.
  instrucciones: { type: String, default: "" },

  // Que responde el bot cuando la pregunta NO esta en la base de
  // conocimiento. Configurable porque es la respuesta mas importante del
  // bot: es el momento exacto en el que, si no esta bien puesta, la IA
  // inventa. Ver services/asistenteIA.js.
  mensajeSinInfo: {
    type: String,
    default: "Esa no la tengo a mano — te la confirmamos en un momento.",
  },

  // Si se define, cuando el bot no sabe responder se avisa a este numero
  // (formato internacional sin "+", ej "59176543210") para que conteste una
  // persona. Vacio = no se escala a nadie.
  numeroEscalamiento: { type: String, default: "" },

  activo: { type: Boolean, default: true },
  creadoEn: { type: Date, default: Date.now },
});
const Negocio = mongoose.model("Negocio", negocioSchema);

// ─── USUARIO DEL PANEL ──────────────────────────────────────────────────────
const usuarioSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  nombre: { type: String, default: "" },
  negocioId: { type: mongoose.Schema.Types.ObjectId, ref: "Negocio", required: true, index: true },
  rol: { type: String, enum: ["admin"], default: "admin" },
  creadoEn: { type: Date, default: Date.now },
});
const Usuario = mongoose.model("Usuario", usuarioSchema);

// ─── DOCUMENTO ──────────────────────────────────────────────────────────────
// Lo que el dueño sube o pega desde el panel, tal cual lo entrego. Se guarda
// entero aparte de sus fragmentos para poder re-fragmentarlo despues (si
// cambia el tamaño de corte) sin pedirle que lo vuelva a subir.
const documentoSchema = new mongoose.Schema({
  negocioId: { type: mongoose.Schema.Types.ObjectId, ref: "Negocio", required: true, index: true },
  nombre: { type: String, required: true },
  textoOriginal: { type: String, default: "" },
  creadoEn: { type: Date, default: Date.now },
});
const Documento = mongoose.model("Documento", documentoSchema);

// ─── FRAGMENTO ──────────────────────────────────────────────────────────────
// La unidad real con la que se alimenta al bot. Hoy se arman por corte de
// texto y se mandan todos los activos al prompt (ver baseConocimiento.js);
// el dia que la base no entre en el contexto, el cambio es llenar
// "embedding" y buscar por similitud — el resto del sistema no se entera.
const fragmentoSchema = new mongoose.Schema({
  negocioId: { type: mongoose.Schema.Types.ObjectId, ref: "Negocio", required: true, index: true },

  // Null cuando el fragmento no vino de un documento (ej. una correccion
  // cargada a mano desde una conversacion real).
  documentoId: { type: mongoose.Schema.Types.ObjectId, ref: "Documento", default: null, index: true },

  titulo: { type: String, default: "" },
  texto: { type: String, required: true },

  // "documento" = vino de algo que se subio. "correccion" = lo agrego una
  // persona despues de ver al bot contestar mal. Se distinguen para poder
  // priorizar las correcciones y para medir cuanto se esta corrigiendo.
  origen: { type: String, enum: ["documento", "correccion"], default: "documento" },

  // Apagar un fragmento sin borrarlo: informacion de temporada (promos,
  // horario de feriados) que vuelve a servir mas adelante.
  activo: { type: Boolean, default: true },

  // Reservado para busqueda semantica. Vacio mientras la base entre entera
  // en el contexto — no se calcula todavia para no pagar embeddings de algo
  // que no se usa.
  embedding: { type: [Number], default: undefined, select: false },

  creadoEn: { type: Date, default: Date.now },
});
const Fragmento = mongoose.model("Fragmento", fragmentoSchema);

// ─── CONVERSACION ───────────────────────────────────────────────────────────
// Una por (negocio, numero). Los mensajes van embebidos y recortados: el
// historial completo de un cliente frecuente puede ser de miles de mensajes,
// y al bot solo le sirven los ultimos.
const mensajeSchema = new mongoose.Schema({
  rol: { type: String, enum: ["cliente", "bot", "humano"], required: true },
  texto: { type: String, default: "" },
  // true cuando el bot contesto "no tengo esa info" — es la señal de que
  // ahi falta un fragmento, y lo que alimenta la lista de "huecos" del panel.
  sinRespuesta: { type: Boolean, default: false },
  fecha: { type: Date, default: Date.now },
}, { _id: true });

const conversacionSchema = new mongoose.Schema({
  negocioId: { type: mongoose.Schema.Types.ObjectId, ref: "Negocio", required: true, index: true },
  numero: { type: String, required: true, index: true },
  nombrePerfil: { type: String, default: "" },
  mensajes: { type: [mensajeSchema], default: [] },

  // Cuando una persona toma la conversacion, el bot se calla. Sin esto el
  // bot le contesta encima al humano y el cliente recibe dos respuestas
  // distintas al mismo mensaje.
  pausado: { type: Boolean, default: false },

  actualizadoEn: { type: Date, default: Date.now, index: true },
});
conversacionSchema.index({ negocioId: 1, numero: 1 }, { unique: true });
const Conversacion = mongoose.model("Conversacion", conversacionSchema);

module.exports = { Negocio, Usuario, Documento, Fragmento, Conversacion };
