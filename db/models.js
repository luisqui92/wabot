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

  // Qué herramientas puede usar el bot en este negocio. Se apagan por
  // separado porque un negocio puede querer que consulte precios pero NO que
  // tome pedidos — y encender una herramienta que el dueño no esperaba es la
  // forma más rápida de que el bot haga algo que nadie pidió.
  herramientas: {
    catalogo: { type: Boolean, default: true },
    pedidos: { type: Boolean, default: false },
    reservas: { type: Boolean, default: false },
    cobros: { type: Boolean, default: false },
  },

  // ─── AGENDA ──────────────────────────────────────────────────────────────
  // El ID del calendario de Google que el dueño compartió con la cuenta de
  // servicio. Suele ser su propio email. Vacío = sin agenda.
  googleCalendarId: { type: String, default: "" },

  // IANA, no un offset numérico: un offset se rompe con el horario de verano.
  // Bolivia no lo tiene, pero el día que haya un cliente en Chile sí.
  zonaHoraria: { type: String, default: "America/La_Paz" },

  // Cuánto dura un turno y cada cuánto arranca uno nuevo. Separados porque no
  // son lo mismo: una consulta de 45 minutos puede ofrecerse cada 60 para
  // dejar aire entre una y otra.
  duracionTurnoMinutos: { type: Number, default: 60 },
  pasoTurnoMinutos: { type: Number, default: 60 },

  // Con cuánta anticipación mínima se puede reservar. Sin esto, un cliente
  // agenda a las 15:58 para las 16:00 y nadie llega a prepararse.
  anticipacionMinimaHoras: { type: Number, default: 2 },
  // Hasta cuántos días para adelante se ofrecen turnos.
  diasMaximosAdelante: { type: Number, default: 30 },

  // Un día por fila. Sin fila para un día, ese día no se atiende. Se permiten
  // varias franjas por día para el negocio que cierra al mediodía.
  horarioAtencion: {
    type: [{
      diaSemana: { type: Number, min: 0, max: 6 },  // 0 = domingo
      horaInicio: String,                            // "09:00"
      horaFin: String,                               // "18:00"
      _id: false,
    }],
    default: [],
  },

  // ─── COBROS ──────────────────────────────────────────────────────────────
  // El QR de cobro del negocio, tal cual lo exporta su banco. Se guarda acá y
  // no en disco para que entre en los respaldos sin trabajo extra: un QR
  // perdido es un negocio que no puede cobrar.
  qrImagen: { type: Buffer, select: false },
  qrMime: { type: String, default: "" },
  // Ruta pública aleatoria desde donde WhatsApp descarga el QR para mostrarlo.
  // Aleatoria y no el id del negocio para que no se pueda enumerar.
  qrToken: { type: String, default: "", index: true },
  // Qué escribirle al cliente junto con el QR: nombre del titular, banco, o
  // lo que el negocio quiera aclarar.
  instruccionesPago: { type: String, default: "" },

  // Transcribir las notas de voz de los clientes. Se paga por minuto, así que
  // es del dueño la decisión — pero viene encendido: un audio ignorado deja al
  // cliente hablándole a una pared, y eso cuesta más que la transcripción.
  transcribirAudios: { type: Boolean, default: true },

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

// ─── PRODUCTO ───────────────────────────────────────────────────────────────
// El catálogo, estructurado. Antes los precios vivían dentro de fragmentos de
// texto: el bot los leía, pero no podía filtrar por disponibilidad, y cambiar
// un precio obligaba a reescribir el documento entero. Con esto, el precio es
// un dato — se edita en un campo y el bot lo lee al instante.
const productoSchema = new mongoose.Schema({
  negocioId: { type: mongoose.Schema.Types.ObjectId, ref: "Negocio", required: true, index: true },
  nombre: { type: String, required: true },
  descripcion: { type: String, default: "" },

  // En centavos y como entero: 0.1 + 0.2 no da 0.3 en coma flotante, y un
  // redondeo en un precio es una discusión con un cliente.
  precioCentavos: { type: Number, default: 0 },
  moneda: { type: String, default: "BOB" },

  categoria: { type: String, default: "", index: true },
  // Cuando está en false el bot deja de ofrecerlo, pero no se pierde el
  // producto ni su historial de pedidos.
  disponible: { type: Boolean, default: true },
  creadoEn: { type: Date, default: Date.now },
});
productoSchema.index({ negocioId: 1, nombre: "text", descripcion: "text", categoria: "text" });
const Producto = mongoose.model("Producto", productoSchema);

// ─── PEDIDO ─────────────────────────────────────────────────────────────────
// Lo que el bot anotó. No es un sistema de ventas: es la libreta donde queda
// lo que el cliente pidió, para que una persona lo atienda sabiendo qué
// quiere. Confirmarlo, cobrarlo y despacharlo sigue siendo trabajo humano.
const itemPedidoSchema = new mongoose.Schema({
  productoId: { type: mongoose.Schema.Types.ObjectId, ref: "Producto", default: null },
  // El nombre y el precio se copian al pedido a propósito: si mañana cambia
  // el precio del producto, este pedido tiene que seguir diciendo lo que se
  // le cotizó al cliente ese día.
  nombre: { type: String, required: true },
  cantidad: { type: Number, default: 1, min: 1 },
  precioCentavos: { type: Number, default: 0 },
}, { _id: false });

const pedidoSchema = new mongoose.Schema({
  negocioId: { type: mongoose.Schema.Types.ObjectId, ref: "Negocio", required: true, index: true },
  clienteId: { type: mongoose.Schema.Types.ObjectId, ref: "Cliente", default: null, index: true },
  numero: { type: String, required: true },
  items: { type: [itemPedidoSchema], default: [] },
  totalCentavos: { type: Number, default: 0 },
  moneda: { type: String, default: "BOB" },
  notas: { type: String, default: "" },
  estado: { type: String, enum: ["nuevo", "confirmado", "entregado", "cancelado"], default: "nuevo", index: true },
  // Se marca solo cuando una persona ACEPTA el pago, nunca por lo que diga la
  // verificación automática.
  pagado: { type: Boolean, default: false },
  creadoEn: { type: Date, default: Date.now, index: true },
});
const Pedido = mongoose.model("Pedido", pedidoSchema);

// ─── RESERVA ────────────────────────────────────────────────────────────────
// Nuestra copia del turno. La fuente de verdad de la DISPONIBILIDAD es Google
// Calendar —el dueño también agenda a mano desde su celular, y si no
// miráramos su calendario ofreceríamos horarios ya ocupados—, pero acá queda
// el turno para el panel y para que el bot sepa qué reservó cada cliente.
const reservaSchema = new mongoose.Schema({
  negocioId: { type: mongoose.Schema.Types.ObjectId, ref: "Negocio", required: true, index: true },
  clienteId: { type: mongoose.Schema.Types.ObjectId, ref: "Cliente", default: null, index: true },
  numero: { type: String, required: true, index: true },

  // En UTC, siempre. La zona horaria es del negocio y se aplica al mostrar:
  // guardar hora local es cómo se terminan teniendo turnos con una hora de
  // diferencia cuando algo cambia.
  inicio: { type: Date, required: true, index: true },
  fin: { type: Date, required: true },

  nombre: { type: String, default: "" },
  motivo: { type: String, default: "" },

  // El id del evento en Google. Sin esto no se puede cancelar allá lo que se
  // cancela acá, y quedarían turnos fantasma bloqueando el calendario.
  eventoGoogleId: { type: String, default: "", index: true },

  estado: { type: String, enum: ["confirmada", "cancelada"], default: "confirmada", index: true },
  creadaEn: { type: Date, default: Date.now },
});
const Reserva = mongoose.model("Reserva", reservaSchema);

// ─── PAGO ───────────────────────────────────────────────────────────────────
// Un comprobante que mandó un cliente. Nunca se marca como pagado solo: una
// captura de comprobante se falsifica en dos minutos, así que el bot extrae y
// compara, y quien acepta es una persona. El estado inicial es siempre
// "pendiente", pase lo que pase la verificación.
const pagoSchema = new mongoose.Schema({
  negocioId: { type: mongoose.Schema.Types.ObjectId, ref: "Negocio", required: true, index: true },
  clienteId: { type: mongoose.Schema.Types.ObjectId, ref: "Cliente", default: null },
  pedidoId: { type: mongoose.Schema.Types.ObjectId, ref: "Pedido", default: null, index: true },
  numero: { type: String, required: true, index: true },

  esperadoCentavos: { type: Number, default: 0 },
  // Lo que el modelo leyó en la imagen. null cuando no pudo leerlo — que es
  // distinto de cero, y por eso no se usa 0 como "no se sabe".
  detectadoCentavos: { type: Number, default: null },
  moneda: { type: String, default: "BOB" },

  // Todo lo que se pudo sacar del comprobante, para que el dueño lo vea sin
  // tener que abrir la imagen.
  banco: { type: String, default: "" },
  referencia: { type: String, default: "" },
  fechaComprobante: { type: String, default: "" },
  emisor: { type: String, default: "" },

  // El fraude más común no es falsificar: es mandar DOS VECES el mismo
  // comprobante. El hash del archivo lo detecta sin guardar nada raro.
  hashImagen: { type: String, default: "", index: true },
  imagen: { type: Buffer, select: false },
  imagenMime: { type: String, default: "" },

  // Lo que la verificación encontró mal. Vacío = todo coincide.
  alertas: { type: [String], default: [] },

  estado: { type: String, enum: ["pendiente", "aceptado", "rechazado"], default: "pendiente", index: true },
  creadoEn: { type: Date, default: Date.now, index: true },
  resueltoEn: { type: Date, default: null },
});
const Pago = mongoose.model("Pago", pagoSchema);

// ─── CLIENTE ────────────────────────────────────────────────────────────────
// Quién es la persona, separado de lo que dijo. Va en su propia colección y no
// como campos dentro de Conversacion porque son cosas distintas con vidas
// distintas: la conversación es un hilo, el cliente es alguien que puede tener
// varios hilos —hoy uno de WhatsApp, mañana también de Instagram—. Separarlo
// ahora cuesta un índice; separarlo después cuesta migrar todo el historial.
const clienteSchema = new mongoose.Schema({
  negocioId: { type: mongoose.Schema.Types.ObjectId, ref: "Negocio", required: true, index: true },
  numero: { type: String, required: true, index: true },

  // El de WhatsApp lo pone el propio cliente en su perfil; el dueño puede
  // corregirlo desde el panel y ahí manda el suyo, porque "Juanjo 🔥" no es
  // como quiere llamarlo su proveedor.
  nombrePerfil: { type: String, default: "" },
  nombre: { type: String, default: "" },

  // Lo que el dueño anota a mano: "paga a 30 días", "prefiere que le escriban
  // de mañana". Es memoria que ninguna IA puede deducir de una conversación.
  notas: { type: String, default: "" },

  // Lo que el modelo entendió de esta persona a partir de sus conversaciones.
  // Se regenera cada tantos mensajes, no en cada uno — ver services/cliente.js.
  resumen: { type: String, default: "" },
  resumenActualizadoEn: { type: Date, default: null },
  // Cuántos mensajes entraron desde el último resumen. Es el disparador: sin
  // este contador habría que releer la conversación entera para saber si el
  // resumen quedó viejo.
  mensajesDesdeResumen: { type: Number, default: 0 },

  etiquetas: { type: [String], default: [] },

  primerContacto: { type: Date, default: Date.now },
  ultimoContacto: { type: Date, default: Date.now, index: true },
  totalMensajes: { type: Number, default: 0 },
});
clienteSchema.index({ negocioId: 1, numero: 1 }, { unique: true });
const Cliente = mongoose.model("Cliente", clienteSchema);

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
  // El cliente lo mandó como nota de voz y esto es la transcripción. Se marca
  // para que quien lea la conversación en el panel sepa que ese texto lo
  // escribió una máquina y puede tener errores.
  esAudio: { type: Boolean, default: false },
  fecha: { type: Date, default: Date.now },
}, { _id: true });

const conversacionSchema = new mongoose.Schema({
  negocioId: { type: mongoose.Schema.Types.ObjectId, ref: "Negocio", required: true, index: true },
  numero: { type: String, required: true, index: true },
  clienteId: { type: mongoose.Schema.Types.ObjectId, ref: "Cliente", default: null, index: true },
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

module.exports = { Negocio, Usuario, Documento, Fragmento, Producto, Pedido, Pago, Reserva, Cliente, Conversacion };
