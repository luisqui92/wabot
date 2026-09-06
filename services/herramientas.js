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
const { Producto, Pedido, Cliente } = require("../db/models");
const { enviarTexto } = require("./metaWhatsapp");

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
