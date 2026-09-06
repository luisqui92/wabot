// Carga un negocio de demostración completo: catálogo, conocimiento, clientes
// con ficha, conversaciones, pedidos, reservas y pagos. Sirve para ver el
// panel con datos reales antes de tener clientes, y para mostrarlo.
//
//   node scripts/demo.js            crea o rehace la demo
//   node scripts/demo.js --borrar   la elimina por completo
//
// Usa un phoneNumberId propio ("DEMO-...") para no pisar jamás un negocio
// real: los datos de la demo viven aparte y se borran sin tocar nada tuyo.
const mongoose = require("mongoose");
const { CONFIG, log, validateConfig } = require("../config");
const { Negocio, Usuario, Documento, Fragmento, Producto, Pedido, Pago, Reserva, Cliente, Conversacion } = require("../db/models");
const { hashPassword } = require("../services/auth");

const PHONE_ID_DEMO = "DEMO-PIZZERIA";
const EMAIL_DEMO = "demo@wabot.local";

const hace = (min) => new Date(Date.now() - min * 60000);
const enDias = (d, h = 20, m = 0) => {
  // Los turnos se guardan en UTC; Bolivia es UTC-4.
  const f = new Date(Date.now() + d * 86400000);
  return new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate(), h + 4, m));
};

// Las imágenes se generan como SVG en vez de arrastrar binarios al repo. El
// panel las sirve con el Content-Type que se guarda acá, así que se ven igual
// que una captura real y la pantalla de Pagos se puede juzgar de verdad.
// Un negocio real sube el PNG que exporta su app del banco.
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const svg = (cuerpo, w, h) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Helvetica, Arial, sans-serif">${cuerpo}</svg>`, "utf-8");
const MIME_SVG = "image/svg+xml";

// Captura de transferencia como la que manda un cliente por WhatsApp.
function comprobante({ banco, monto, referencia, fecha, emisor, destino }) {
  const linea = (y, et, val, negrita) =>
    `<text x="28" y="${y}" font-size="13" fill="#6b7280">${esc(et)}</text>` +
    `<text x="28" y="${y + 20}" font-size="${negrita ? 22 : 15}" fill="#111827"` +
    `${negrita ? ' font-weight="700"' : ""}>${esc(val)}</text>`;
  return svg(
    `<rect width="360" height="560" fill="#ffffff"/>` +
    `<rect width="360" height="86" fill="#0f5132"/>` +
    `<text x="28" y="40" font-size="17" font-weight="700" fill="#ffffff">${esc(banco)}</text>` +
    `<text x="28" y="64" font-size="12" fill="#c9e4d5">Comprobante de transferencia</text>` +
    `<circle cx="180" cy="140" r="26" fill="#e7f5ec"/>` +
    `<path d="M168 140 l8 9 l16 -19" stroke="#0f5132" stroke-width="4" fill="none" stroke-linecap="round"/>` +
    `<text x="180" y="192" font-size="14" fill="#0f5132" text-anchor="middle">Transacción exitosa</text>` +
    linea(232, "Monto", `Bs ${monto}`, true) +
    linea(300, "Referencia", referencia) +
    linea(360, "Fecha", fecha) +
    linea(420, "De", emisor) +
    linea(480, "Para", destino),
    360, 560);
}

// QR de cobro del negocio. No codifica nada: es el marco visual para que la
// pantalla de Pagos no se vea vacía.
const QR_COBRO = svg(
  `<rect width="300" height="360" fill="#ffffff"/>` +
  `<rect x="30" y="26" width="240" height="240" fill="#111827"/>` +
  `<rect x="46" y="42" width="208" height="208" fill="#ffffff"/>` +
  [[62, 58], [190, 58], [62, 186]].map(([x, y]) =>
    `<rect x="${x}" y="${y}" width="48" height="48" fill="#111827"/>` +
    `<rect x="${x + 10}" y="${y + 10}" width="28" height="28" fill="#ffffff"/>` +
    `<rect x="${x + 17}" y="${y + 17}" width="14" height="14" fill="#111827"/>`).join("") +
  Array.from({ length: 88 }, (_, i) => {
    // Patrón fijo (no Math.random): si cambiara en cada corrida, el hash de
    // la imagen cambiaría y no se podría comparar entre demos.
    const x = 62 + ((i * 37) % 11) * 16, y = 58 + ((i * 53) % 11) * 16;
    return ((i * 7) % 3) ? `<rect x="${x}" y="${y}" width="12" height="12" fill="#111827"/>` : "";
  }).join("") +
  `<text x="150" y="300" font-size="14" font-weight="700" fill="#111827" text-anchor="middle">Banco Ganadero</text>` +
  `<text x="150" y="324" font-size="12" fill="#6b7280" text-anchor="middle">Pizzería Don Luis</text>` +
  `<text x="150" y="344" font-size="11" fill="#9ca3af" text-anchor="middle">Monto variable</text>`,
  300, 360);

const PRODUCTOS = [
  ["Pizza Muzzarella grande",  4500, "Pizzas", "8 porciones, muzzarella y orégano"],
  ["Pizza Muzzarella mediana", 3200, "Pizzas", "6 porciones"],
  ["Pizza Napolitana grande",  5200, "Pizzas", "Muzzarella, tomate y albahaca"],
  ["Pizza Especial grande",    5800, "Pizzas", "Jamón, morrón, aceituna y huevo"],
  ["Pizza Cuatro Quesos",      6000, "Pizzas", "Muzzarella, roquefort, parmesano y provolone"],
  ["Pizza Fugazzeta",          5000, "Pizzas", "Cebolla y mucha muzzarella"],
  ["Pizza Calabresa",          5500, "Pizzas", "Longaniza picante"],
  ["Pizza Vegetariana",        5200, "Pizzas", "Zapallito, berenjena y morrón"],
  ["Porción de pizza",          800, "Pizzas", "Muzzarella, para llevar"],
  ["Empanada de carne",         600, "Entradas", "Frita, jugosa"],
  ["Empanada de queso",         600, "Entradas", ""],
  ["Empanada de pollo",         600, "Entradas", ""],
  ["Docena de empanadas",      6500, "Entradas", "Surtidas, a elección"],
  ["Fainá",                     900, "Entradas", "Porción"],
  ["Papas fritas",             1800, "Entradas", "Porción grande para compartir"],
  ["Lasaña bolognesa",         4800, "Pastas", "Porción individual"],
  ["Ñoquis con salsa",         3800, "Pastas", "Los jueves"],
  ["Ravioles de ricota",       4200, "Pastas", "Con salsa a elección"],
  ["Coca-Cola 2L",             1500, "Bebidas", ""],
  ["Coca-Cola 500ml",           700, "Bebidas", ""],
  ["Agua sin gas 600ml",        500, "Bebidas", ""],
  ["Cerveza Paceña 620ml",     1200, "Bebidas", ""],
  ["Jugo natural 500ml",        900, "Bebidas", "Naranja o durazno"],
  ["Flan casero",              1200, "Postres", "Con dulce de leche"],
  ["Tiramisú",                 1600, "Postres", ""],
  ["Helado 1/4",               1800, "Postres", "Tres sabores a elección"],
];

const CONOCIMIENTO = [
  ["Horarios", "Abrimos todos los días de 11:00 a 15:00 y de 18:00 a 23:30. Los lunes solo abrimos de noche."],
  ["Ubicación", "Av. Blanco Galindo km 4, Cochabamba. A media cuadra de la rotonda, vereda norte. Referencia: al lado de la farmacia Bolivia."],
  ["Delivery", "Hacemos delivery propio hasta 5 km sin costo. Más lejos son 10 Bs. El tiempo estimado es de 35 a 50 minutos según la zona y el horario."],
  ["Zonas de delivery", "Llegamos a Queru Queru, Cala Cala, Sarco, Tupuraya, América y el centro. A Sacaba y Quillacollo no llegamos."],
  ["Formas de pago", "Aceptamos efectivo, QR de todos los bancos, y tarjeta solo en el local. Por delivery no llevamos posnet."],
  ["Reservas de mesa", "Se puede reservar mesa para cualquier día. Tenemos mesas para hasta 8 personas; para grupos más grandes hay que avisar con un día de anticipación."],
  ["Tiempo de espera", "En el local, una pizza sale en unos 20 minutos. Los viernes y sábados de noche puede demorar hasta 40."],
  ["Ingredientes y alergias", "Todas nuestras pizzas llevan muzzarella de vaca. La masa es de harina de trigo común, no tenemos opción sin gluten. Podemos hacer cualquier pizza sin queso a pedido."],
  ["Pizzas a pedido", "Se puede pedir cualquier pizza con ingredientes a elección. Cada ingrediente extra son 500 Bs... perdón, 5 Bs por ingrediente."],
  ["Estacionamiento", "Hay parqueo propio para 6 autos en la parte de atrás, con entrada por la calle lateral."],
  ["Eventos y cumpleaños", "Recibimos grupos y cumpleaños. Para más de 15 personas armamos un menú cerrado; hay que coordinarlo con anticipación."],
  ["Vegetarianos y veganos", "Tenemos la pizza Vegetariana y la Fugazzeta. Opciones veganas no manejamos por ahora porque toda la masa lleva la misma preparación."],
];

const CORRECCIONES = [
  ["¿Hacen envíos a Sacaba?", "Pregunta: ¿hacen envíos a Sacaba?\nRespuesta: No llegamos a Sacaba. Nuestro delivery cubre hasta 5 km del local."],
  ["¿Aceptan tarjeta en delivery?", "Pregunta: ¿puedo pagar con tarjeta en el delivery?\nRespuesta: En delivery no llevamos posnet. Se puede pagar en efectivo o por QR."],
];

const CLIENTES = [
  { numero: "59171234567", nombrePerfil: "Ana 🌻", nombre: "Ana Pérez", totalMensajes: 34, dias: 47,
    notas: "Cliente de todos los viernes. Pide siempre sin aceitunas.",
    resumen: "Pide casi todos los viernes de noche, siempre delivery a Queru Queru. Su pizza habitual es la Especial grande sin aceitunas. Suele pedir también una Coca 2L.",
    etiquetas: ["frecuente", "delivery"] },
  { numero: "59176543210", nombrePerfil: "Beto", nombre: "Roberto Camacho", totalMensajes: 12, dias: 18,
    notas: "Trabaja en la oficina de enfrente. Pide al mediodía.",
    resumen: "Pide al mediodía, casi siempre porciones o empanadas para llevar. Le importa que esté listo rápido porque tiene una hora de almuerzo.",
    etiquetas: ["mediodía"] },
  { numero: "59177778888", nombrePerfil: "Carla M.", nombre: "Carla Mendoza", totalMensajes: 21, dias: 90,
    notas: "Organiza los cumpleaños de su familia acá. Cuatro veces este año.",
    resumen: "Reserva mesas para grupos grandes, generalmente de 8 a 12 personas, para cumpleaños familiares. Pregunta siempre por el menú cerrado y si se puede llevar torta.",
    etiquetas: ["eventos", "grupos"] },
  { numero: "59169998877", nombrePerfil: "Diego", nombre: "", totalMensajes: 4, dias: 3,
    resumen: "Preguntó por opciones sin gluten. Se le explicó que no manejamos.", etiquetas: [] },
  { numero: "59172223344", nombrePerfil: "Flor", nombre: "Florencia Rojas", totalMensajes: 8, dias: 12,
    resumen: "Vegetariana. Pide la Vegetariana o la Fugazzeta. Consultó si el queso es de vaca.",
    etiquetas: ["vegetariana"] },
  { numero: "59165554433", nombrePerfil: "Marco", nombre: "", totalMensajes: 2, dias: 0, resumen: "", etiquetas: [] },
];

// Conversaciones con el tono real de un WhatsApp boliviano, incluidas las que
// el bot no supo responder — de ahí sale la pantalla de Huecos.
const CONVERSACIONES = [
  { numero: "59171234567", min: 8, pausado: false, previosMin: 1500, previos: [
    ["cliente", "hacen factura?"], ["bot", "esa no la tengo a mano — te la confirmamos en un momento.", true],
  ], mensajes: [
    ["cliente", "holaa buenas noches"], ["bot", "hola Ana! buenas 🍕 en qué te ayudo?"],
    ["cliente", "lo de siempre porfa, la especial grande sin aceitunas"],
    ["bot", "dale, especial grande sin aceitunas. te la mando a Queru Queru como siempre?"],
    ["cliente", "sip"], ["cliente", "y una coca de 2 litros"],
    ["bot", "listo, anotado: 1 especial grande sin aceitunas y 1 coca 2L. son 73 bs con envío gratis"],
    ["cliente", "perfecto, mando el qr"],
  ]},
  { numero: "59176543210", min: 95, pausado: false, previosMin: 2900, previos: [
    ["cliente", "tienen wifi en el local?"], ["bot", "esa no la tengo a mano — te la confirmamos en un momento.", true],
  ], mensajes: [
    ["cliente", "buen dia, cuanto estan las empanadas?"], ["bot", "6 bs cada una, la docena surtida 65"],
    ["cliente", "media docena de carne para llevar, en cuanto estan?"],
    ["bot", "en 15 min las tenés listas"], ["cliente", "voy en camino"],
  ]},
  { numero: "59177778888", min: 190, pausado: false, mensajes: [
    ["cliente", "hola! quiero reservar mesa para pasado mañana, somos 10"],
    ["bot", "hola Carla! para 10 personas pedimos avisar con un día de anticipación, así que pasado mañana entra bien. a qué hora?"],
    ["cliente", "8 y media de la noche"], ["bot", "listo, pasado mañana 20:30 para 10 personas. queda reservado ✅"],
    ["cliente", "se puede llevar torta?"], ["bot", "esa no la tengo a mano — te la confirmamos en un momento.", true],
  ]},
  { numero: "59169998877", min: 260, pausado: false, mensajes: [
    ["cliente", "tienen pizza sin gluten?"],
    ["bot", "no manejamos masa sin gluten, toda nuestra masa es de harina de trigo común 🙏"],
    ["cliente", "y sin lactosa?"], ["bot", "esa no la tengo a mano — te la confirmamos en un momento.", true],
  ]},
  { numero: "59172223344", min: 420, pausado: false, mensajes: [
    ["cliente", "hola, la vegetariana lleva queso de vaca?"],
    ["bot", "sí, toda nuestra muzzarella es de vaca"], ["cliente", "gracias!"],
  ]},
  { numero: "59165554433", min: 30, pausado: true, mensajes: [
    ["cliente", "hola, tengo un problema con un pedido de ayer"],
    ["humano", "hola Marco, contame qué pasó y lo vemos"],
  ]},
];

async function borrar() {
  const negocio = await Negocio.findOne({ phoneNumberId: PHONE_ID_DEMO });
  if (!negocio) { console.log("No hay ninguna demo cargada."); return; }
  const filtro = { negocioId: negocio._id };
  const [f, p, pe, pa, r, c, cv, d] = await Promise.all([
    Fragmento.deleteMany(filtro), Producto.deleteMany(filtro), Pedido.deleteMany(filtro),
    Pago.deleteMany(filtro), Reserva.deleteMany(filtro), Cliente.deleteMany(filtro),
    Conversacion.deleteMany(filtro), Documento.deleteMany(filtro),
  ]);
  await Usuario.deleteMany({ negocioId: negocio._id });
  await negocio.deleteOne();
  // Se listan todas las colecciones que se tocan, no solo algunas: si mañana
  // el borrado deja algo atrás, el número que falta lo delata acá.
  console.log(`Demo borrada: ${d.deletedCount} documentos, ${f.deletedCount} fragmentos, ${p.deletedCount} productos, ${c.deletedCount} clientes, ${cv.deletedCount} conversaciones, ${pe.deletedCount} pedidos, ${pa.deletedCount} pagos, ${r.deletedCount} reservas.`);
}

async function crear() {
  // Rehacer desde cero en vez de acumular: correrlo dos veces tiene que dar
  // el mismo resultado, no el doble de todo.
  await borrar().catch(() => {});

  const negocio = await Negocio.create({
    nombre: "Pizzería Don Luis",
    phoneNumberId: PHONE_ID_DEMO,
    descripcion: "Pizzería de barrio en Cochabamba, con delivery propio y mesas para comer en el local. Abierta desde 2011.",
    instrucciones: "Nunca prometas un tiempo de entrega menor a 30 minutos. Si preguntan por descuentos, decí que las promos salen los martes por nuestro Instagram.",
    estiloVoz: "Escribís corto y directo, casi siempre en minúsculas y sin punto final. Voseás. Usás un emoji cada tanto (🍕 🛵 ✅) pero no en cada mensaje. Saludás con 'hola' o 'buenas' según la hora, sin fórmulas. Cerrás cuando hace falta con 'listo' o 'dale'. No usás listas ni explicás de más: contestás lo que preguntaron y ya.",
    ejemplosVoz: ["siii hasta 5km sin costo 🛵", "45 bs la grande, 32 la mediana", "dale, en 20 min está lista"],
    mensajeSinInfo: "esa no la tengo a mano — te la confirmamos en un momento.",
    numeroEscalamiento: "59170000000",
    herramientas: { catalogo: true, pedidos: true, reservas: true, cobros: true },
    transcribirAudios: true,
    zonaHoraria: "America/La_Paz",
    duracionTurnoMinutos: 90, pasoTurnoMinutos: 30, anticipacionMinimaHoras: 2, diasMaximosAdelante: 30,
    googleCalendarId: "",
    horarioAtencion: [0,1,2,3,4,5,6].flatMap(d => d === 1
      ? [{ diaSemana: 1, horaInicio: "18:00", horaFin: "23:30" }]
      : [{ diaSemana: d, horaInicio: "11:00", horaFin: "15:00" },
         { diaSemana: d, horaInicio: "18:00", horaFin: "23:30" }]),
    qrToken: "demo" + Math.random().toString(36).slice(2, 10),
    qrImagen: QR_COBRO, qrMime: MIME_SVG,
    qrVence: new Date(Date.now() + 680 * 86400000),
    instruccionesPago: "Titular: Luis Alberto Quiroga — Banco Ganadero. Mandanos la captura cuando termines 🙏",
  });

  await Usuario.create({ email: EMAIL_DEMO, passwordHash: await hashPassword("demo12345"), negocioId: negocio._id, nombre: "Demo" });

  const doc = await Documento.create({ negocioId: negocio._id, nombre: "Información del local",
    textoOriginal: CONOCIMIENTO.map(([t, x]) => `## ${t}\n${x}`).join("\n\n") });
  await Fragmento.insertMany([
    ...CONOCIMIENTO.map(([titulo, texto]) => ({ negocioId: negocio._id, documentoId: doc._id, titulo, texto, origen: "documento" })),
    ...CORRECCIONES.map(([titulo, texto]) => ({ negocioId: negocio._id, titulo, texto, origen: "correccion" })),
  ]);

  const productos = await Producto.insertMany(PRODUCTOS.map(([nombre, precioCentavos, categoria, descripcion]) => ({
    negocioId: negocio._id, nombre, precioCentavos, categoria, descripcion, moneda: "BOB",
    disponible: nombre !== "Ñoquis con salsa",   // uno agotado, para ver cómo se muestra
  })));
  const buscar = (n) => productos.find(p => p.nombre === n);

  const clientes = {};
  for (const c of CLIENTES) {
    clientes[c.numero] = await Cliente.create({
      negocioId: negocio._id, numero: c.numero, nombrePerfil: c.nombrePerfil, nombre: c.nombre || "",
      notas: c.notas || "", resumen: c.resumen || "", etiquetas: c.etiquetas,
      totalMensajes: c.totalMensajes, mensajesDesdeResumen: 2,
      resumenActualizadoEn: c.resumen ? hace(c.dias * 1440 / 3) : null,
      primerContacto: hace(c.dias * 1440 + 60),
      // El último contacto sale de su conversación, no de un número fijo: si
      // no, el panel ordena a todos los clientes igual y "Sin responder hace
      // X" miente.
      ultimoContacto: hace(CONVERSACIONES.find(cv => cv.numero === c.numero).min),
    });
  }

  // Un hilo por número: la Conversacion tiene índice único (negocioId, numero)
  // y los mensajes van embebidos. Por eso lo viejo (`previos`) no es otra
  // conversación sino los primeros mensajes del mismo hilo, fechados semanas
  // atrás — que es como se ve un cliente que vuelve.
  for (const cv of CONVERSACIONES) {
    const linea = (lista, minBase) => lista.map(([rol, texto, sinRespuesta], i) => ({
      rol, texto, sinRespuesta: !!sinRespuesta,
      fecha: hace(minBase + (lista.length - i) * 2),
    }));
    const mensajes = [...linea(cv.previos || [], cv.previosMin || 0), ...linea(cv.mensajes, cv.min)];
    // Ana pidió "lo de siempre" por nota de voz: marcarlo hace que el panel
    // muestre el aviso de transcripción, que es media función del módulo.
    if (cv.numero === "59171234567") mensajes[4].esAudio = true;
    await Conversacion.create({
      negocioId: negocio._id, numero: cv.numero, clienteId: clientes[cv.numero]._id,
      nombrePerfil: CLIENTES.find(c => c.numero === cv.numero).nombrePerfil,
      pausado: cv.pausado, actualizadoEn: hace(cv.min),
      mensajes,
    });
  }

  const armar = (items) => {
    const detalle = items.map(([n, cantidad]) => {
      const p = buscar(n);
      return { productoId: p._id, nombre: p.nombre, cantidad, precioCentavos: p.precioCentavos };
    });
    return { items: detalle, totalCentavos: detalle.reduce((t, i) => t + i.precioCentavos * i.cantidad, 0) };
  };

  const pedidos = await Pedido.insertMany([
    { negocioId: negocio._id, clienteId: clientes["59171234567"]._id, numero: "59171234567",
      ...armar([["Pizza Especial grande", 1], ["Coca-Cola 2L", 1]]),
      notas: "Sin aceitunas. Queru Queru, casa de reja verde.", estado: "nuevo", pagado: false, creadoEn: hace(8) },
    { negocioId: negocio._id, clienteId: clientes["59176543210"]._id, numero: "59176543210",
      ...armar([["Empanada de carne", 6]]), notas: "Para llevar, pasa a buscar.", estado: "confirmado", pagado: true, creadoEn: hace(95) },
    { negocioId: negocio._id, clienteId: clientes["59172223344"]._id, numero: "59172223344",
      ...armar([["Pizza Vegetariana", 1], ["Agua sin gas 600ml", 2]]), estado: "entregado", pagado: true, creadoEn: hace(1500) },
    { negocioId: negocio._id, clienteId: clientes["59177778888"]._id, numero: "59177778888",
      ...armar([["Docena de empanadas", 2], ["Coca-Cola 2L", 3]]), notas: "Para el cumpleaños.",
      estado: "nuevo", pagado: false, creadoEn: hace(190) },
    { negocioId: negocio._id, clienteId: clientes["59169998877"]._id, numero: "59169998877",
      ...armar([["Pizza Muzzarella mediana", 1]]), estado: "cancelado", pagado: false, creadoEn: hace(2800) },
  ]);

  // Tres comprobantes: uno correcto, uno que pagó de menos, y el fraude más
  // común, que es reenviar la misma imagen.
  //
  // Los montos salen de los pedidos, no de constantes: si mañana cambia un
  // precio del catálogo, el comprobante sigue coincidiendo con lo que el
  // panel dice que se esperaba.
  const bs = (c) => (c / 100).toFixed(2);
  const COMPROBANTE_BETO = comprobante({
    banco: "Banco Ganadero", monto: bs(pedidos[1].totalCentavos), referencia: "QR-884120",
    fecha: "hoy 12:41", emisor: "ROBERTO CAMACHO", destino: "L. QUIROGA",
  });
  const COMPROBANTE_CARLA = comprobante({
    banco: "BNB", monto: "100.00", referencia: "TRX-77219",
    fecha: "hoy 17:52", emisor: "CARLA MENDOZA", destino: "L. QUIROGA",
  });
  await Pago.insertMany([
    { negocioId: negocio._id, clienteId: clientes["59176543210"]._id, pedidoId: pedidos[1]._id, numero: "59176543210",
      esperadoCentavos: pedidos[1].totalCentavos, detectadoCentavos: pedidos[1].totalCentavos, moneda: "BOB",
      banco: "Banco Ganadero", referencia: "QR-884120", fechaComprobante: "hoy 12:41", emisor: "ROBERTO CAMACHO",
      hashImagen: "a".repeat(64), imagen: COMPROBANTE_BETO, imagenMime: MIME_SVG, alertas: [], estado: "aceptado",
      creadoEn: hace(93), resueltoEn: hace(90) },
    { negocioId: negocio._id, clienteId: clientes["59177778888"]._id, pedidoId: pedidos[3]._id, numero: "59177778888",
      esperadoCentavos: pedidos[3].totalCentavos, detectadoCentavos: 10000, moneda: "BOB",
      banco: "BNB", referencia: "TRX-77219", fechaComprobante: "hoy 17:52", emisor: "CARLA MENDOZA",
      hashImagen: "b".repeat(64), imagen: COMPROBANTE_CARLA, imagenMime: MIME_SVG,
      alertas: [`PAGÓ DE MENOS: 100.00 contra ${bs(pedidos[3].totalCentavos)} esperados.`],
      estado: "pendiente", creadoEn: hace(185) },
    { negocioId: negocio._id, clienteId: clientes["59171234567"]._id, pedidoId: pedidos[0]._id, numero: "59171234567",
      // Ana reenvía el comprobante de Beto, así que lo leído es lo que dice ESA
      // imagen (36 bs), no lo que ella debía (73). Poner el monto correcto acá
      // haría que la captura y el panel se contradigan, que es justo el error
      // que el dueño tiene que poder ver de un vistazo.
      esperadoCentavos: pedidos[0].totalCentavos, detectadoCentavos: pedidos[1].totalCentavos, moneda: "BOB",
      banco: "Banco Ganadero", referencia: "QR-884120", fechaComprobante: "hoy 12:41", emisor: "ROBERTO CAMACHO",
      // Misma imagen y mismo hash que el pago de Beto: eso es exactamente lo
      // que detecta el módulo, y por eso acá se reusa el mismo buffer.
      hashImagen: "a".repeat(64), imagen: COMPROBANTE_BETO, imagenMime: MIME_SVG,
      alertas: ["⚠️ COMPROBANTE REPETIDO: esta misma imagen ya se envió hoy 12:41.",
                "⚠️ Ya hay un pago registrado con la misma referencia (QR-884120).",
                `PAGÓ DE MENOS: ${bs(pedidos[1].totalCentavos)} contra ${bs(pedidos[0].totalCentavos)} esperados.`,
                "⚠️ El titular del comprobante (ROBERTO CAMACHO) no es quien escribe."],
      estado: "pendiente", creadoEn: hace(6) },
  ]);

  await Reserva.insertMany([
    { negocioId: negocio._id, clienteId: clientes["59177778888"]._id, numero: "59177778888",
      inicio: enDias(2, 20, 30), fin: enDias(2, 22, 0), nombre: "Carla Mendoza",
      motivo: "Cumpleaños, 10 personas", eventoGoogleId: "demo-evt-1", estado: "confirmada", creadaEn: hace(190) },
    { negocioId: negocio._id, clienteId: clientes["59171234567"]._id, numero: "59171234567",
      inicio: enDias(1, 21, 0), fin: enDias(1, 22, 30), nombre: "Ana Pérez", motivo: "Mesa para 4",
      eventoGoogleId: "demo-evt-2", estado: "confirmada", creadaEn: hace(600) },
    { negocioId: negocio._id, clienteId: clientes["59172223344"]._id, numero: "59172223344",
      inicio: enDias(5, 19, 0), fin: enDias(5, 20, 30), nombre: "Florencia Rojas", motivo: "Cena, 2 personas",
      eventoGoogleId: "demo-evt-3", estado: "confirmada", creadaEn: hace(400) },
    { negocioId: negocio._id, clienteId: clientes["59169998877"]._id, numero: "59169998877",
      inicio: enDias(-1, 20, 0), fin: enDias(-1, 21, 30), nombre: "Diego", motivo: "",
      eventoGoogleId: "demo-evt-4", estado: "cancelada", creadaEn: hace(3000) },
  ]);

  console.log(`
✅ Demo cargada: ${negocio.nombre}

   ${PRODUCTOS.length} productos     ${CONOCIMIENTO.length + CORRECCIONES.length} fragmentos     ${CLIENTES.length} clientes
   ${CONVERSACIONES.length} conversaciones  ${pedidos.length} pedidos      3 pagos      4 reservas

   Entrá al panel con:
     usuario:    ${EMAIL_DEMO}
     contraseña: demo12345

   Para borrarla:  node scripts/demo.js --borrar
`);
}

async function main() {
  validateConfig();
  await mongoose.connect(CONFIG.MONGODB_URI);
  if (process.argv.includes("--borrar")) await borrar();
  else await crear();
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
