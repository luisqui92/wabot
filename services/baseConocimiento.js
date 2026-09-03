// wabot — La base de conocimiento del bot: como se parte lo que sube
// el dueño, y como se arma el contexto que ve la IA en cada mensaje.
//
// HOY: se mandan todos los fragmentos activos al prompt, hasta un techo de
// caracteres. Es simple, no cuesta embeddings, y para una base de unas pocas
// paginas responde mejor que cualquier busqueda (la IA ve TODO).
//
// CUANDO DEJE DE ALCANZAR: el sintoma es concreto — hayRecorte() empieza a
// dar true seguido, o sea que hay fragmentos activos que nunca llegan al
// prompt y el bot dice "no tengo esa info" sobre algo que SI esta cargado.
// Ahi el cambio es llenar Fragmento.embedding y que armarContexto() traiga
// los N mas parecidos a la pregunta en vez de los primeros que entren. Nada
// mas del sistema cambia.
const { CONFIG } = require("../config");
const { Fragmento } = require("../db/models");

// Un fragmento deberia ser una idea completa: un horario, una politica, una
// descripcion de producto. Cortar por parrafo respeta como escribe la gente;
// el limite de caracteres es la red de contencion para el que pega tres
// paginas sin un solo enter.
const MAX_CHARS_FRAGMENTO = 1200;

function fragmentar(texto) {
  const parrafos = String(texto || "")
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean);

  const fragmentos = [];
  let actual = "";
  for (const p of parrafos) {
    // Un parrafo que ya excede el limite se parte por oraciones; si aun asi
    // no entra (una sola oracion kilometrica), se corta duro.
    if (p.length > MAX_CHARS_FRAGMENTO) {
      if (actual) { fragmentos.push(actual); actual = ""; }
      let resto = p;
      while (resto.length > MAX_CHARS_FRAGMENTO) {
        const bloque = resto.slice(0, MAX_CHARS_FRAGMENTO);
        const corte = bloque.lastIndexOf(". ");
        const fin = corte > MAX_CHARS_FRAGMENTO / 2 ? corte + 1 : MAX_CHARS_FRAGMENTO;
        fragmentos.push(resto.slice(0, fin).trim());
        resto = resto.slice(fin).trim();
      }
      if (resto) fragmentos.push(resto);
      continue;
    }
    if ((actual + "\n\n" + p).length > MAX_CHARS_FRAGMENTO) {
      fragmentos.push(actual);
      actual = p;
    } else {
      actual = actual ? `${actual}\n\n${p}` : p;
    }
  }
  if (actual) fragmentos.push(actual);
  return fragmentos;
}

// Arma el bloque de conocimiento que va al prompt. Las correcciones van
// primero: son lo que una persona escribio DESPUES de ver al bot equivocarse,
// asi que si la base se recorta, son las ultimas que se deberian perder.
async function armarContexto(negocioId) {
  const fragmentos = await Fragmento.find({ negocioId, activo: true })
    .sort({ origen: 1, creadoEn: -1 }) // "correccion" < "documento" alfabeticamente: ascendente pone las correcciones primero
    .lean();

  const partes = [];
  let usado = 0;
  let recortados = 0;
  for (const f of fragmentos) {
    const bloque = f.titulo ? `## ${f.titulo}\n${f.texto}` : f.texto;
    if (usado + bloque.length > CONFIG.MAX_CHARS_CONTEXTO) { recortados++; continue; }
    partes.push(bloque);
    usado += bloque.length;
  }

  return {
    texto: partes.join("\n\n"),
    totalFragmentos: fragmentos.length,
    usados: partes.length,
    recortados,
  };
}

module.exports = { fragmentar, armarContexto, MAX_CHARS_FRAGMENTO };
