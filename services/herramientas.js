// wabot — Las herramientas que el bot puede usar.
//
// ESTE ES EL ÚNICO ARCHIVO QUE HAY QUE TOCAR PARA AGREGAR UNA HERRAMIENTA.
// El orquestador (asistenteIA.js) no sabe cuáles existen: pide la lista, se la
// pasa al modelo, y ejecuta la que el modelo pida. Agregar `crear_reserva` o
// `consultar_stock` mañana es sumar una entrada acá y nada más.
//
// Cada herramienta declara:
//   nombre        — cómo la llama el modelo
//   requiere      — qué flag de negocio.herramientas tiene que estar en true
//   definicion    — el esquema que ve el modelo (formato de function calling)
//   ejecutar      — la función real. Recibe SIEMPRE el negocio ya resuelto.
//
// Regla que no se negocia: `ejecutar` filtra por negocio._id, nunca por algo
// que venga en los argumentos del modelo. Los argumentos los inventa un LLM a
// partir de lo que escribió un desconocido por WhatsApp — tratarlos como
// confiables sería dejar que un cliente lea el catálogo de otro negocio.
const { CONFIG, log } = require("../config");
const { Producto, Pedido, Reserva, Negocio } = require("../db/models");
const { disponibilidad, reservar, cancelar, enZona, DIAS } = require("./agenda");
const { enviarTexto, enviarImagen } = require("./metaWhatsapp");

function precio(centavos, moneda) {
  return `${moneda} ${(centavos / 100).toFixed(2)}`;
}

const HERRAMIENTAS = [
  // ─── CATÁLOGO ─────────────────────────────────────────────────────────────
  {
    nombre: "buscar_productos",
    requiere: "catalogo",
    definicion: {
      type: "function",
      function: {
        name: "buscar_productos",
        description:
          "Busca productos o servicios en el catálogo del negocio y devuelve sus precios reales y actuales. " +
          "Usala SIEMPRE que pregunten por un precio, por si algo está disponible, o qué se vende. " +
          "Nunca respondas un precio de memoria ni lo estimes: consultá acá.",
        parameters: {
          type: "object",
          properties: {
            consulta: {
              type: "string",
              description: "Qué busca el cliente, en sus palabras. Ej: 'pizza grande', 'corte de pelo'. Vacío devuelve todo el catálogo.",
            },
          },
          required: [],
        },
      },
    },
    async ejecutar(negocio, args) {
      const consulta = String(args?.consulta || "").trim();
      const filtro = { negocioId: negocio._id, disponible: true };

      // Regex y no $text: el índice de texto de Mongo no hace coincidencias
      // parciales, y un cliente que escribe "pizz" o "corte pelo" tiene que
      // encontrar algo igual. El catálogo de una pyme es chico; el costo de
      // recorrerlo no importa.
      if (consulta) {
        const r = new RegExp(consulta.split(/\s+/).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
        filtro.$or = [{ nombre: r }, { descripcion: r }, { categoria: r }];
      }

      const productos = await Producto.find(filtro).limit(25).lean();
      if (!productos.length) {
        // Se devuelve un texto explícito y no una lista vacía: si el modelo
        // recibe [] tiende a rellenar con lo que le parece. Diciéndoselo con
        // palabras, contesta que no lo tiene.
        return consulta
          ? `No hay ningún producto que coincida con "${consulta}" en el catálogo. Decile al cliente que no lo tenés y ofrecé consultarlo.`
          : "El catálogo está vacío.";
      }
      return productos
        .map(p => `${p.nombre}${p.categoria ? ` (${p.categoria})` : ""}: ${precio(p.precioCentavos, p.moneda)}${p.descripcion ? ` — ${p.descripcion}` : ""}`)
        .join("\n");
    },
  },

  // ─── PEDIDOS ──────────────────────────────────────────────────────────────
  {
    nombre: "registrar_pedido",
    requiere: "pedidos",
    definicion: {
      type: "function",
      function: {
        name: "registrar_pedido",
        description:
          "Anota lo que el cliente quiere pedir, para que una persona del negocio lo prepare. " +
          "Usala solo cuando el cliente YA confirmó qué quiere y cuánto. " +
          "Antes de llamarla, confirmá con él los productos y las cantidades. " +
          "Los productos tienen que existir en el catálogo: buscalos primero con buscar_productos.",
        parameters: {
          type: "object",
          properties: {
            items: {
              type: "array",
              description: "Lo que pidió el cliente",
              items: {
                type: "object",
                properties: {
                  nombre: { type: "string", description: "Nombre del producto TAL CUAL figura en el catálogo" },
                  cantidad: { type: "integer", description: "Cuántos", minimum: 1 },
                },
                required: ["nombre", "cantidad"],
              },
            },
            notas: { type: "string", description: "Aclaraciones del cliente: dirección, sin cebolla, horario, etc." },
          },
          required: ["items"],
        },
      },
    },
    async ejecutar(negocio, args, contexto) {
      const pedidos = Array.isArray(args?.items) ? args.items : [];
      if (!pedidos.length) return "No se registró nada: el pedido llegó sin productos.";

      const items = [];
      const noEncontrados = [];
      for (const p of pedidos) {
        // Búsqueda exacta primero, insensible a mayúsculas. El modelo copia el
        // nombre del catálogo que le dimos, así que casi siempre coincide.
        const producto = await Producto.findOne({
          negocioId: negocio._id,
          disponible: true,
          nombre: new RegExp(`^${String(p.nombre).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
        }).lean();

        if (!producto) { noEncontrados.push(p.nombre); continue; }
        const cantidad = Math.max(1, parseInt(p.cantidad, 10) || 1);
        items.push({ productoId: producto._id, nombre: producto.nombre, cantidad, precioCentavos: producto.precioCentavos });
      }

      // Si algo no existe NO se registra un pedido parcial: el cliente creería
      // que pidió cinco cosas y le llegarían tres. Mejor que el bot vuelva a
      // preguntar.
      if (noEncontrados.length) {
        return `No se registró el pedido porque estos productos no están en el catálogo: ${noEncontrados.join(", ")}. Pedile al cliente que elija entre los que sí hay.`;
      }

      const totalCentavos = items.reduce((t, i) => t + i.precioCentavos * i.cantidad, 0);
      const moneda = items[0] ? (await Producto.findById(items[0].productoId).lean()).moneda : "BOB";

      const pedido = await Pedido.create({
        negocioId: negocio._id,
        clienteId: contexto?.clienteId || null,
        numero: contexto?.numero || "",
        items, totalCentavos, moneda,
        notas: String(args?.notas || "").trim(),
      });

      const detalle = items.map(i => `${i.cantidad}x ${i.nombre}`).join(", ");
      log.info(`[PEDIDO] ${contexto?.numero} — ${detalle} (${precio(totalCentavos, moneda)})`);

      // Avisar a la persona de guardia. Va en su propio try: que falle el
      // aviso interno no puede tirar abajo un pedido ya registrado.
      if (negocio.numeroEscalamiento) {
        enviarTexto(contexto.phoneNumberId, negocio.numeroEscalamiento,
          `🛒 Pedido nuevo de ${contexto?.numero}\n\n${detalle}\nTotal: ${precio(totalCentavos, moneda)}${pedido.notas ? `\n\nNotas: ${pedido.notas}` : ""}`
        ).catch(e => log.error("[PEDIDO] No se pudo avisar:", e.message));
      }

      return `Pedido registrado. Detalle: ${detalle}. Total: ${precio(totalCentavos, moneda)}. Confirmale al cliente el detalle y el total, y avisale que en breve lo contactan para coordinar.`;
    },
  },

  // ─── COBROS ───────────────────────────────────────────────────────────────
  {
    nombre: "enviar_datos_de_pago",
    requiere: "cobros",
    definicion: {
      type: "function",
      function: {
        name: "enviar_datos_de_pago",
        description:
          "Le manda al cliente el QR para pagar y el monto exacto. Usala cuando ya hay un pedido registrado " +
          "y el cliente quiere pagar o pregunta cómo pagar. Después de usarla, pedile que mande la captura del comprobante.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    async ejecutar(negocio, args, contexto) {
      const completo = await Negocio.findById(negocio._id).select("+qrImagen").lean();
      if (!completo?.qrToken) return "El negocio todavía no cargó su QR de cobro. Decile al cliente que en un momento lo contacta una persona para coordinar el pago.";

      // El último pedido sin pagar. Cobrar sin saber cuánto no sirve de nada.
      const pedido = await Pedido.findOne({
        negocioId: negocio._id, numero: contexto?.numero,
        estado: { $in: ["nuevo", "confirmado"] }, pagado: false,
      }).sort({ creadoEn: -1 }).lean();

      if (!pedido) return "Este cliente no tiene ningún pedido pendiente de pago. Primero registrá el pedido.";

      const monto = `${pedido.moneda} ${(pedido.totalCentavos / 100).toFixed(2)}`;
      const pie = [`Monto exacto: ${monto}`, completo.instruccionesPago].filter(Boolean).join("\n\n");

      try {
        await enviarImagen(contexto.phoneNumberId, contexto.numero,
          `${CONFIG.APP_URL}${CONFIG.BASE_PATH}/qr/${completo.qrToken}.png`, pie);
      } catch (e) {
        log.error("[COBRO] No se pudo enviar el QR:", e.message);
        return "No se pudo enviar el QR. Decile al cliente que en un momento lo contacta una persona.";
      }

      return `QR enviado con el monto ${monto}. Ahora pedile que mande la CAPTURA del comprobante cuando termine de pagar, y avisale que un humano lo confirma.`;
    },
  },

  // ─── RESERVAS ─────────────────────────────────────────────────────────────
  {
    nombre: "consultar_disponibilidad",
    requiere: "reservas",
    definicion: {
      type: "function",
      function: {
        name: "consultar_disponibilidad",
        description:
          "Devuelve los horarios REALES que están libres en la agenda, mirando el calendario del negocio. " +
          "Usala SIEMPRE antes de ofrecer un horario. Nunca inventes ni supongas disponibilidad.",
        parameters: {
          type: "object",
          properties: {
            desde: { type: "string", description: "Fecha desde la cual buscar, formato AAAA-MM-DD. Vacío = desde hoy." },
            dias: { type: "integer", description: "Cuántos días mirar hacia adelante. Por defecto 7." },
          },
          required: [],
        },
      },
    },
    async ejecutar(negocio, args) {
      const dias = Math.min(Math.max(parseInt(args?.dias, 10) || 7, 1), negocio.diasMaximosAdelante || 30);
      const porDia = await disponibilidad(negocio, { desdeISO: args?.desde || null, dias });

      if (!porDia.length) {
        return "No hay ningún horario libre en ese rango. Ofrecé buscar más adelante o que lo contacte una persona.";
      }
      // Se limitan los horarios por día: una lista de veinte opciones por
      // WhatsApp no la lee nadie, y encima gasta tokens en cada vuelta.
      return porDia.slice(0, 7).map(d =>
        `${d.diaNombre} ${d.fecha}: ${d.turnos.slice(0, 8).map(t => t.hora).join(", ")}${d.turnos.length > 8 ? " (y más)" : ""}`
      ).join("\n");
    },
  },

  {
    nombre: "crear_reserva",
    requiere: "reservas",
    definicion: {
      type: "function",
      function: {
        name: "crear_reserva",
        description:
          "Agenda el turno en el calendario del negocio. Usala SOLO cuando el cliente ya eligió un día y una hora " +
          "que vos consultaste con consultar_disponibilidad, y te dio su nombre. Confirmá día, hora y nombre antes de llamarla.",
        parameters: {
          type: "object",
          properties: {
            fecha: { type: "string", description: "AAAA-MM-DD" },
            hora: { type: "string", description: "HH:MM en 24 horas, exactamente uno de los horarios que devolvió consultar_disponibilidad" },
            nombre: { type: "string", description: "Nombre de la persona que reserva" },
            motivo: { type: "string", description: "Para qué es el turno, si lo dijo" },
          },
          required: ["fecha", "hora", "nombre"],
        },
      },
    },
    async ejecutar(negocio, args, contexto) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(args?.fecha || ""))) return "La fecha tiene que ser AAAA-MM-DD.";
      if (!/^\d{1,2}:\d{2}$/.test(String(args?.hora || ""))) return "La hora tiene que ser HH:MM.";

      const hora = String(args.hora).padStart(5, "0");
      const r = await reservar(negocio, {
        fechaISO: args.fecha, hora,
        nombre: String(args.nombre || "").trim(),
        motivo: String(args.motivo || "").trim(),
        numero: contexto?.numero || "",
        clienteId: contexto?.clienteId || null,
      });

      if (!r.ok) {
        // Se le devuelve el motivo en palabras para que vuelva a consultar
        // disponibilidad y ofrezca otro horario, en vez de insistir con el
        // mismo.
        return `No se pudo reservar: ${r.motivo}. Volvé a consultar disponibilidad y ofrecele otro horario.`;
      }

      const zona = negocio.zonaHoraria || "America/La_Paz";
      const { fecha, hora: h, diaSemana } = enZona(r.inicio, zona);
      const detalle = `${DIAS[diaSemana]} ${fecha} a las ${h}`;

      if (negocio.numeroEscalamiento) {
        enviarTexto(contexto.phoneNumberId, negocio.numeroEscalamiento,
          `📅 Turno nuevo: ${args.nombre} — ${detalle}${args.motivo ? `\n${args.motivo}` : ""}\n${contexto?.numero}`
        ).catch(e => log.error("[AGENDA] No se pudo avisar:", e.message));
      }

      return `Turno agendado para ${detalle}. Confirmaselo al cliente con el día y la hora.`;
    },
  },

  {
    nombre: "cancelar_reserva",
    requiere: "reservas",
    definicion: {
      type: "function",
      function: {
        name: "cancelar_reserva",
        description:
          "Cancela el próximo turno del cliente que está escribiendo. Usala solo si pide cancelar explícitamente. " +
          "Confirmá con él cuál es el turno antes de cancelarlo.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    async ejecutar(negocio, args, contexto) {
      // Solo puede cancelar SU turno: el número viene del webhook, no de los
      // argumentos del modelo. Si viniera de los argumentos, bastaría con
      // convencer al bot de que uno es otra persona.
      const reserva = await Reserva.findOne({
        negocioId: negocio._id,
        numero: contexto?.numero,
        estado: "confirmada",
        inicio: { $gte: new Date() },
      }).sort({ inicio: 1 });

      if (!reserva) return "Este cliente no tiene ningún turno próximo agendado.";

      const zona = negocio.zonaHoraria || "America/La_Paz";
      const { fecha, hora, diaSemana } = enZona(reserva.inicio, zona);
      await cancelar(negocio, reserva);

      if (negocio.numeroEscalamiento) {
        enviarTexto(contexto.phoneNumberId, negocio.numeroEscalamiento,
          `❌ Turno cancelado: ${reserva.nombre || contexto?.numero} — ${DIAS[diaSemana]} ${fecha} ${hora}`
        ).catch(() => {});
      }
      return `Turno del ${DIAS[diaSemana]} ${fecha} a las ${hora} cancelado. Confirmaselo al cliente.`;
    },
  },
];

// Las que este negocio tiene encendidas. Un negocio sin catálogo no debería
// ver siquiera la definición: cada herramienta declarada gasta tokens en cada
// mensaje, tenga o no sentido para ese negocio.
function disponiblesPara(negocio) {
  return HERRAMIENTAS.filter(h => negocio?.herramientas?.[h.requiere]);
}

function definicionesPara(negocio) {
  const lista = disponiblesPara(negocio).map(h => h.definicion);
  return lista.length ? lista : undefined; // undefined y no []: la API rechaza un array vacío
}

async function ejecutar(negocio, nombre, args, contexto) {
  const herramienta = disponiblesPara(negocio).find(h => h.nombre === nombre);
  // El modelo puede alucinar el nombre de una herramienta, o pedir una que
  // este negocio tiene apagada. Se le contesta con texto en vez de tirar: así
  // se corrige solo en la siguiente vuelta.
  if (!herramienta) return `La herramienta "${nombre}" no existe o no está habilitada para este negocio.`;
  try {
    return await herramienta.ejecutar(negocio, args || {}, contexto || {});
  } catch (e) {
    log.error(`[HERRAMIENTA ${nombre}]`, e.stack || e.message);
    return "Hubo un error al ejecutar esa acción. Decile al cliente que en un momento lo contacta una persona.";
  }
}

module.exports = { HERRAMIENTAS, disponiblesPara, definicionesPara, ejecutar };
