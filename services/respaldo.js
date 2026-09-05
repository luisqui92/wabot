// wabot — Respaldo de la base: volcado, cifrado y —lo que de verdad importa—
// verificación restaurando de verdad en una base aparte.
//
// Una copia que nunca se restauró no es una copia: es un archivo que suponés
// que sirve. Por eso acá el respaldo no se da por bueno hasta que se
// descifra, se restaura en otra base y se comparan los conteos contra el
// original. Si eso falla, el archivo se marca como fallido y el proceso sale
// con error — mejor enterarse hoy que el día que lo necesites.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { EJSON } = require("bson");
const { CONFIG, log } = require("../config");

// EJSON y no JSON.stringify: un ObjectId o una fecha pasados por JSON común
// vuelven como strings, y el respaldo restaurado deja de ser equivalente al
// original — las referencias entre colecciones se rompen en silencio.
const MAGIC = Buffer.from("WABOTBK1");
const ALGoritmo = "aes-256-gcm";

function derivarClave(clave, sal) {
  // scrypt y no un hash directo: la clave del .env la elige una persona, y
  // scrypt hace que un ataque por diccionario sobre el archivo robado sea
  // caro en vez de instantáneo.
  return crypto.scryptSync(clave, sal, 32);
}

function cifrar(buffer, clave) {
  const sal = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGoritmo, derivarClave(clave, sal), iv);
  const datos = Buffer.concat([cipher.update(buffer), cipher.final()]);
  // GCM da autenticación además de cifrado: si el archivo se corrompe o lo
  // tocan, el descifrado falla en vez de devolver basura silenciosamente.
  return Buffer.concat([MAGIC, sal, iv, cipher.getAuthTag(), datos]);
}

function descifrar(buffer, clave) {
  if (!buffer.subarray(0, 8).equals(MAGIC)) {
    throw new Error("El archivo no es un respaldo de wabot (falta la cabecera)");
  }
  const sal = buffer.subarray(8, 24);
  const iv = buffer.subarray(24, 36);
  const tag = buffer.subarray(36, 52);
  const decipher = crypto.createDecipheriv(ALGoritmo, derivarClave(clave, sal), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(buffer.subarray(52)), decipher.final()]);
  } catch {
    // El error que tira Node acá es "Unsupported state or unable to
    // authenticate data", que no le dice nada a nadie — y este mensaje se lee
    // el peor día. Las dos causas posibles dan exactamente el mismo error y no
    // se pueden distinguir: es cómo funciona el cifrado autenticado, no una
    // limitación que se pueda arreglar. Así que se nombran las dos.
    throw new Error(
      "No se pudo descifrar el respaldo. Hay dos causas posibles y dan el mismo error:\n" +
      "  1. La BACKUP_CLAVE no es la misma con la que se creó este archivo.\n" +
      "  2. El archivo está corrupto o incompleto (¿se copió entero?).\n" +
      "Si tenías la clave guardada en otro lado, probá con esa antes de dar el respaldo por perdido."
    );
  }
}

// Vuelca TODAS las colecciones que existan, no solo las que tienen modelo:
// si alguien agrega una colección desde un script y no la declara en
// db/models.js, el respaldo la lleva igual.
async function volcar(db) {
  const colecciones = await db.listCollections().toArray();
  const datos = {};
  const conteos = {};
  for (const { name } of colecciones) {
    if (name.startsWith("system.")) continue;
    const docs = await db.collection(name).find({}).toArray();
    datos[name] = docs;
    conteos[name] = docs.length;
  }
  return { datos, conteos };
}

// Restaura en una base de verificación y compara. Es el corazón del módulo:
// sin este paso el respaldo es una promesa, no una copia.
async function verificar(cliente, nombreBaseVerificacion, contenidoDescifrado, conteosOriginales) {
  const dbV = cliente.db(nombreBaseVerificacion);
  await dbV.dropDatabase(); // arrancar limpio: restos de una verificación anterior falsearían los conteos

  const datos = EJSON.parse(contenidoDescifrado.toString(), { relaxed: false });
  const problemas = [];

  for (const [coleccion, docs] of Object.entries(datos)) {
    if (docs.length) await dbV.collection(coleccion).insertMany(docs);
    const restaurados = await dbV.collection(coleccion).countDocuments();
    if (restaurados !== conteosOriginales[coleccion]) {
      problemas.push(`${coleccion}: ${conteosOriginales[coleccion]} originales vs ${restaurados} restaurados`);
    }
  }

  // Una colección que existía y no quedó en el archivo es una pérdida
  // silenciosa — el caso más peligroso, porque el respaldo "funciona".
  for (const coleccion of Object.keys(conteosOriginales)) {
    if (!(coleccion in datos)) problemas.push(`${coleccion}: no quedó en el respaldo`);
  }

  await dbV.dropDatabase(); // no dejar una copia sin cifrar dando vueltas en el servidor
  return problemas;
}

// Borra los respaldos más viejos que la retención. Se hace DESPUÉS de que el
// nuevo quedó verificado: borrar primero dejaría una ventana en la que no hay
// ninguna copia buena.
function limpiarViejos(directorio, dias) {
  const limite = Date.now() - dias * 24 * 60 * 60 * 1000;
  let borrados = 0;
  for (const archivo of fs.readdirSync(directorio)) {
    if (!archivo.startsWith("wabot-") || !archivo.endsWith(".enc")) continue;
    const completo = path.join(directorio, archivo);
    if (fs.statSync(completo).mtimeMs < limite) {
      fs.unlinkSync(completo);
      borrados++;
    }
  }
  return borrados;
}

module.exports = { cifrar, descifrar, volcar, verificar, limpiarViejos, MAGIC };
