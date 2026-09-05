// Cambia el phoneNumberId de un negocio — el ID interno del número que da
// Meta, con el que se enruta cada webhook entrante.
//
// Existe como script y no como endpoint del panel a propósito: cambiarlo
// desconecta el bot de su número, y el síntoma no aparece hasta que un
// cliente escribe y no le contesta nadie. No es algo que deba estar a un
// click de distancia en una pantalla de configuración.
//
// El uso normal es este: diste de alta el negocio con un ID de relleno
// porque todavía no tenías la app de Meta creada, y ahora ya lo tenés.
//
//   node scripts/cambiar_numero.js                      -> lista los negocios
//   node scripts/cambiar_numero.js <negocioId> <nuevoId>
const mongoose = require("mongoose");
const { CONFIG, log, validateConfig } = require("../config");
const { Negocio } = require("../db/models");

async function main() {
  validateConfig();
  await mongoose.connect(CONFIG.MONGODB_URI);

  const [negocioId, nuevoPhoneNumberId] = process.argv.slice(2);

  // Sin argumentos: mostrar qué hay, para no tener que adivinar el id.
  if (!negocioId || !nuevoPhoneNumberId) {
    const negocios = await Negocio.find().select("nombre phoneNumberId").lean();
    if (!negocios.length) {
      console.log("No hay negocios cargados. Creá uno con scripts/crear_usuario.js");
    } else {
      console.log("Negocios:\n");
      for (const n of negocios) console.log(`  ${n._id}  ${n.phoneNumberId.padEnd(20)} ${n.nombre}`);
      console.log("\nUso: node scripts/cambiar_numero.js <negocioId> <nuevoPhoneNumberId>");
    }
    await mongoose.disconnect();
    return;
  }

  if (!/^[0-9]+$/.test(nuevoPhoneNumberId)) {
    console.error("El phoneNumberId de Meta es solo dígitos. Ojo: es el ID interno del número, no el número de teléfono.");
    process.exit(1);
  }

  const negocio = await Negocio.findById(negocioId).catch(() => null);
  if (!negocio) {
    console.error(`No existe un negocio con id ${negocioId}. Corré el script sin argumentos para ver la lista.`);
    process.exit(1);
  }

  // El campo es unique: si otro negocio ya tiene ese ID, el save falla con un
  // error de índice que no se entiende. Mejor avisar de qué se trata.
  const ocupado = await Negocio.findOne({ phoneNumberId: nuevoPhoneNumberId, _id: { $ne: negocio._id } });
  if (ocupado) {
    console.error(`Ese phoneNumberId ya lo usa el negocio "${ocupado.nombre}". Dos negocios no pueden compartir número.`);
    process.exit(1);
  }

  const anterior = negocio.phoneNumberId;
  negocio.phoneNumberId = nuevoPhoneNumberId;
  await negocio.save();

  log.info(`[NUMERO] "${negocio.nombre}": ${anterior} -> ${nuevoPhoneNumberId}`);
  console.log("\nListo. Acordate de que la Callback URL en Meta tiene que apuntar a este servidor,");
  console.log("y de reiniciar la app si cambiaste también el .env:  pm2 restart wabot");
  await mongoose.disconnect();
}

main().catch(e => { console.error(e.message); process.exit(1); });
