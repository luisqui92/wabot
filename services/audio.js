// wabot — Notas de voz.
//
// En Bolivia una parte enorme de WhatsApp son audios. Un bot que los ignora
// deja al cliente hablándole a una pared, y encima sin saber por qué. Acá se
// bajan de Meta y se transcriben; de ahí en adelante siguen el mismo camino
// que un mensaje escrito.
//
// También sirve para el otro lado: el dueño graba dos minutos explicando su
// negocio y eso se convierte en base de conocimiento. Para alguien que no
// quiere escribir, es la forma natural de cargar información.
const axios = require("axios");
const { CONFIG, log } = require("../config");

// Meta acepta hasta 16 MB en audio; la API de transcripción, 25 MB. Se corta
// en el menor de los dos antes de gastar la descarga.
const MAX_BYTES = 16 * 1024 * 1024;

// Bajar un medio de Meta son dos pasos: pedir la URL y después bajarla con el
// token. La URL vive SOLO 5 MINUTOS, así que esto tiene que pasar en el
// momento — no sirve guardarla para después.
async function descargarMedia(mediaId, phoneNumberId) {
  const meta = await axios.get(
    `https://graph.facebook.com/${CONFIG.GRAPH_VERSION}/${mediaId}`,
    { params: { phone_number_id: phoneNumberId },
      headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` }, timeout: 15000 }
  );

  const { url, mime_type: mime, file_size: tamano } = meta.data;
  if (!url) throw new Error("Meta no devolvió URL para ese medio");
  if (tamano && tamano > MAX_BYTES) {
    throw new Error(`El audio pesa ${(tamano / 1024 / 1024).toFixed(1)} MB, más del máximo de 16 MB`);
  }

  // El Authorization va también acá: sin él la descarga falla aunque la URL
  // parezca pública.
  const bin = await axios.get(url, {
    headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` },
    responseType: "arraybuffer",
    maxContentLength: MAX_BYTES,
    timeout: 30000,
  });

  return { buffer: Buffer.from(bin.data), mime: mime || "audio/ogg" };
}

const EXTENSIONES = {
  "audio/ogg": "ogg", "audio/oga": "ogg", "audio/mpeg": "mp3", "audio/mp3": "mp3",
  "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/aac": "aac", "audio/amr": "amr",
  "audio/wav": "wav", "audio/webm": "webm", "audio/x-wav": "wav",
};

// Transcribe. `vocabulario` sesga el reconocimiento hacia palabras que el
// modelo no puede adivinar: nombres de productos, del negocio, de barrios.
// Sin eso, "quiero dos salteñas" puede volver como "quiero dos sal teñas" —
// y el bot después no encuentra el producto en el catálogo.
async function transcribir(buffer, mime = "audio/ogg", vocabulario = "") {
  if (!CONFIG.OPENAI_KEY) throw new Error("Sin OPENAI_KEY no se pueden transcribir audios");
  if (buffer.length > MAX_BYTES) throw new Error("El audio es demasiado grande");

  // fetch nativo y no axios: el multipart de axios en Node necesita
  // dependencias extra, y FormData/Blob vienen en el runtime desde Node 18.
  const form = new FormData();
  const ext = EXTENSIONES[mime.split(";")[0].trim().toLowerCase()] || "ogg";
  form.append("file", new Blob([buffer], { type: mime }), `audio.${ext}`);
  form.append("model", "whisper-1");
  // Español fijo: sin esto el modelo adivina el idioma y con audios cortos o
  // ruidosos a veces se equivoca y devuelve la transcripción en portugués.
  form.append("language", "es");
  if (vocabulario) form.append("prompt", vocabulario.slice(0, 800));

  const res = await fetch(`${CONFIG.OPENAI_BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}` },
    body: form,
    signal: AbortSignal.timeout(CONFIG.TIMEOUT_TRANSCRIPCION),
  });

  if (!res.ok) {
    const detalle = await res.text().catch(() => "");
    throw new Error(`La transcripción falló (${res.status}): ${detalle.slice(0, 200)}`);
  }

  const { text } = await res.json();
  return (text || "").trim();
}

// Arma el vocabulario a partir del catálogo del negocio. Es lo que más mejora
// la transcripción en la práctica: los nombres propios y los productos son
// justo lo que un modelo genérico no puede adivinar.
async function vocabularioDe(negocio) {
  const { Producto } = require("../db/models");
  const productos = await Producto.find({ negocioId: negocio._id, disponible: true })
    .select("nombre").limit(60).lean();
  const nombres = productos.map(p => p.nombre).join(", ");
  return [negocio.nombre, nombres].filter(Boolean).join(". ");
}

module.exports = { descargarMedia, transcribir, vocabularioDe, MAX_BYTES };
