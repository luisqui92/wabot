// wabot — Que el bot escriba como una persona y no como un sistema.
//
// Dos razones, y la segunda es la que importa de verdad:
//
// 1. Un cliente nota la diferencia. Un párrafo perfecto que aparece entero,
//    300ms después de su pregunta, no lo escribió nadie. Aunque el texto sea
//    bueno, el ritmo lo delata.
//
// 2. WhatsApp también la nota. Conectados por un cliente no oficial, la
//    regularidad es lo que distingue una cuenta automatizada de una persona:
//    responder siempre igual de rápido, siempre de una sola vez, siempre con
//    la misma pausa. Acá no hay un solo valor fijo — todos llevan una
//    variación aleatoria, y eso no es un detalle estético.
//
// Lo que NO hace: inventar demoras largas para "parecer ocupado". Un cliente
// que espera 40 segundos se va. La referencia es una persona atenta que está
// mirando el teléfono, no una que está con las manos ocupadas.
const { log } = require("../config");

// Una persona escribiendo en el celular hace unos 3 o 4 caracteres por
// segundo. A ese ritmo, una respuesta de 150 caracteres tardaría 45 segundos
// y el cliente se cansa. Se usa el ritmo de alguien que escribe rápido y
// conoce de memoria lo que contesta, que es justo lo que es un negocio
// respondiendo lo mismo de siempre.
const CHARS_POR_SEGUNDO = 17;

const RITMO = {
  // Antes de marcar como leído. Nadie lee en el instante en que llega.
  leer: [700, 2600],
  // Entre que leyó y que empieza a escribir.
  pensar: [600, 2200],
  // Piso y techo de la escritura, pase lo que pase con el largo.
  escribirMin: 900,
  escribirMax: 9000,
  // Entre un mensaje y el siguiente de la misma ráfaga.
  entreMensajes: [500, 1500],
};

// Un mensaje de WhatsApp escrito por una persona rara vez pasa de dos o tres
// renglones. Más que eso se parte, pero no en seis pedazos: una ráfaga de
// seis mensajes seguidos es tan artificial como un bloque de texto.
const LARGO_OBJETIVO = 160;
const MAX_PARTES = 3;

const entre = (min, max) => Math.round(min + Math.random() * (max - min));
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// Cuánto tarda en "escribir" ese texto, con variación. El techo evita que un
// mensaje largo deje al cliente diez segundos mirando "escribiendo...".
function tiempoDeEscritura(texto) {
  const base = (texto.length / CHARS_POR_SEGUNDO) * 1000;
  const conRuido = base * (0.8 + Math.random() * 0.45);
  return Math.round(Math.min(RITMO.escribirMax, Math.max(RITMO.escribirMin, conRuido)));
}

// Corta en el último separador que entre antes del límite, para no partir una
// palabra al medio ni dejar un pedazo de dos letras.
function cortar(texto, limite) {
  if (texto.length <= limite) return [texto, ""];
  const ventana = texto.slice(0, limite);
  // Primero en fin de oración, que es donde cortaría una persona; si no hay,
  // en el último espacio.
  const oracion = Math.max(ventana.lastIndexOf(". "), ventana.lastIndexOf("? "), ventana.lastIndexOf("! "));
  const corte = oracion > limite * 0.4 ? oracion + 1 : ventana.lastIndexOf(" ");
  if (corte <= 0) return [texto.slice(0, limite), texto.slice(limite)];
  return [texto.slice(0, corte), texto.slice(corte)];
}

// Divide la respuesta en los mensajes que mandaría una persona. Los saltos de
// línea que puso el modelo son la primera pista: ahí ya separó ideas.
function partir(texto, limite = LARGO_OBJETIVO, maxPartes = MAX_PARTES) {
  const limpio = String(texto || "").trim();
  if (!limpio) return [];

  let partes = limpio.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  if (partes.length === 1) partes = limpio.split(/\n/).map(p => p.trim()).filter(Boolean);

  // Lo que sigue siendo largo se parte por oraciones.
  const sueltas = [];
  for (const parte of partes) {
    let resto = parte;
    while (resto.length > limite) {
      const [cabeza, cola] = cortar(resto, limite);
      sueltas.push(cabeza.trim());
      resto = cola.trim();
    }
    if (resto) sueltas.push(resto);
  }

  // Si quedaron demasiados pedazos, los últimos se vuelven a juntar. Mejor un
  // mensaje algo largo que una ametralladora de seis.
  if (sueltas.length > maxPartes) {
    const cabeza = sueltas.slice(0, maxPartes - 1);
    cabeza.push(sueltas.slice(maxPartes - 1).join(" "));
    return cabeza;
  }
  return sueltas;
}

// Manda la respuesta con el ritmo de alguien que la está escribiendo.
//
// `canal` es lo que sabe hacer el driver. Solo `enviar` es obligatorio:
//   enviar(texto)        manda un mensaje            (obligatorio)
//   leer()               marca como leído            (opcional)
//   escribiendo(prendido) muestra "escribiendo..."   (opcional)
//
// Baileys implementa las tres. La API oficial de Meta no tiene presencia de
// escritura, así que ahí `escribiendo` no existe y el resto del ritmo —las
// pausas y la división en ráfagas— funciona igual.
async function responderComoHumano(canal, texto, opciones = {}) {
  const partes = partir(texto, opciones.limite, opciones.maxPartes);
  if (!partes.length) return 0;

  // Sin ritmo, todo sale de una: sirve para las pruebas y para un negocio que
  // prefiera velocidad sobre naturalidad.
  if (opciones.instantaneo) {
    for (const parte of partes) await canal.enviar(parte);
    return partes.length;
  }

  if (canal.leer) {
    await esperar(entre(...RITMO.leer));
    await canal.leer().catch(() => {});
  }
  await esperar(entre(...RITMO.pensar));

  for (let i = 0; i < partes.length; i++) {
    const parte = partes[i];
    if (canal.escribiendo) await canal.escribiendo(true).catch(() => {});
    await esperar(tiempoDeEscritura(parte));
    // La presencia se apaga ANTES de enviar: si se apagara después, WhatsApp
    // muestra un instante de "escribiendo..." con el mensaje ya entregado.
    if (canal.escribiendo) await canal.escribiendo(false).catch(() => {});
    await canal.enviar(parte);
    if (i < partes.length - 1) await esperar(entre(...RITMO.entreMensajes));
  }

  log.info(`[RITMO] respuesta de ${texto.length} chars enviada en ${partes.length} mensaje${partes.length === 1 ? "" : "s"}`);
  return partes.length;
}

module.exports = { partir, tiempoDeEscritura, responderComoHumano, RITMO, CHARS_POR_SEGUNDO };
