// wabot — Lectura y verificación de comprobantes de pago.
//
// LO QUE ESTE MÓDULO NO HACE, Y ES LO MÁS IMPORTANTE: no da un pago por
// bueno. Una captura de comprobante se falsifica en dos minutos con cualquier
// editor, y un modelo de visión se puede engañar y además a veces lee mal. Un
// bot que marca pedidos como pagados solo con una imagen es una puerta de
// entrada al fraude, no una función.
//
// Lo que sí hace: extrae, compara contra lo que se esperaba, y levanta la mano
// cuando algo no cuadra. Aceptar es siempre de una persona.
const crypto = require("crypto");
const { CONFIG, log } = require("../config");
const { Pago } = require("../db/models");

const MAX_BYTES = 5 * 1024 * 1024;

const PROMPT = `Sos un lector de comprobantes de pago bancarios de Bolivia (transferencias,
pagos por QR, depósitos). Vas a recibir la captura o foto que mandó un cliente.

Extraé SOLO lo que se lee con claridad en la imagen. Si un dato no está o no
se llega a leer, devolvé null en ese campo. NUNCA lo deduzcas ni lo completes
con lo que te parezca probable: un monto inventado acá termina en un pedido
entregado y no cobrado.

Devolvé SOLO este JSON:
{
  "es_comprobante": true|false,
  "monto": número sin separadores de miles, con punto decimal, o null,
  "moneda": "BOB"|"USD"|null,
  "banco": "nombre del banco o billetera" o null,
  "referencia": "número de transacción / comprobante" o null,
  "fecha": "lo que diga la imagen, tal cual" o null,
  "emisor": "quien pagó" o null,
  "destinatario": "quien recibió" o null,
  "observaciones": "algo raro que veas: montos tachados, imagen editada, texto que no cuadra" o null
}

"es_comprobante" es false si la imagen es cualquier otra cosa: una foto de un
producto, una captura de la conversación, un meme. En ese caso el resto va en
null.`;

async function leerComprobante(buffer, mime) {
  if (!CONFIG.OPENAI_KEY) throw new Error("Sin OPENAI_KEY no se pueden leer comprobantes");
  if (buffer.length > MAX_BYTES) throw new Error("La imagen es demasiado grande");

  const { default: axios } = { default: require("axios") };
  const res = await axios.post(
    `${CONFIG.OPENAI_BASE_URL}/chat/completions`,
    {
      model: CONFIG.OPENAI_MODELO_VISION,
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: [
          { type: "text", text: "Leé este comprobante." },
          { type: "image_url", image_url: { url: `data:${mime};base64,${buffer.toString("base64")}` } },
        ] },
      ],
      max_tokens: 500,
      temperature: 0,       // extraer datos no es tarea creativa
      response_format: { type: "json_object" },
    },
    { headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}` }, timeout: CONFIG.TIMEOUT_OPENAI }
  );

  const crudo = res.data.choices[0].message.content;
  try {
    return JSON.parse(crudo);
  } catch {
    log.error("[COMPROBANTE] Respuesta no parseable:", String(crudo).slice(0, 200));
    return { es_comprobante: false };
  }
}

// A centavos enteros. Un comprobante puede traer "1.234,56" o "1,234.56"
// según el banco, y confundirlos cambia el monto por mil.
function aCentavos(monto) {
  if (monto === null || monto === undefined) return null;
  const n = typeof monto === "number" ? monto : parseFloat(String(monto).replace(/[^\d.,-]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

// Compara lo leído contra lo que se esperaba y devuelve las alertas. Cada
// alerta está escrita para que el dueño entienda qué mirar, no para que un
// programa la interprete.
async function verificar({ negocioId, datos, esperadoCentavos, moneda, hashImagen }) {
  const alertas = [];
  const detectado = aCentavos(datos?.monto);

  if (!datos?.es_comprobante) {
    alertas.push("La imagen no parece un comprobante de pago.");
  }

  if (detectado === null) {
    alertas.push("No se pudo leer el monto en la imagen.");
  } else if (esperadoCentavos) {
    const dif = detectado - esperadoCentavos;
    if (dif < 0) {
      alertas.push(`PAGÓ DE MENOS: ${(detectado / 100).toFixed(2)} contra ${(esperadoCentavos / 100).toFixed(2)} esperados.`);
    } else if (dif > 0) {
      // De más no es un problema de cobro, pero el dueño tiene que saberlo
      // para devolver la diferencia.
      alertas.push(`Pagó de más: ${(detectado / 100).toFixed(2)} contra ${(esperadoCentavos / 100).toFixed(2)}. Habría que devolver ${(dif / 100).toFixed(2)}.`);
    }
  }

  if (datos?.moneda && moneda && datos.moneda !== moneda) {
    alertas.push(`La moneda no coincide: el comprobante dice ${datos.moneda} y el pedido está en ${moneda}.`);
  }

  // El fraude más común no es falsificar una imagen: es mandar dos veces la
  // misma. El hash lo detecta sin depender de que el modelo se dé cuenta.
  if (hashImagen) {
    const repetido = await Pago.findOne({ negocioId, hashImagen }).lean();
    if (repetido) {
      alertas.push(`⚠️ COMPROBANTE REPETIDO: esta misma imagen ya se envió el ${new Date(repetido.creadoEn).toLocaleString("es-BO")}.`);
    }
  }

  // La misma referencia con otra imagen: una captura recortada distinta del
  // mismo pago.
  if (datos?.referencia) {
    const mismaRef = await Pago.findOne({ negocioId, referencia: String(datos.referencia).trim() }).lean();
    if (mismaRef) alertas.push(`⚠️ Ya hay un pago registrado con la misma referencia (${datos.referencia}).`);
  }

  if (datos?.observaciones) alertas.push(`El lector notó: ${datos.observaciones}`);

  return { detectadoCentavos: detectado, alertas };
}

function hashDe(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

module.exports = { leerComprobante, verificar, hashDe, aCentavos, MAX_BYTES };
