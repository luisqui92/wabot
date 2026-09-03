// Alta inicial: crea el negocio y el primer usuario del panel. No hay
// registro público a propósito — el panel controla un número de WhatsApp
// real y una API de IA que se paga por uso; cualquiera que se dé de alta
// solo puede ser un problema.
//
//   node scripts/crear_usuario.js "Mi Negocio" 123456789012345 mail@ejemplo.com miClave
//                                  nombre        phoneNumberId    email          password
const mongoose = require("mongoose");
const { CONFIG, log, validateConfig } = require("../config");
const { Negocio, Usuario } = require("../db/models");
const { hashPassword } = require("../services/auth");

async function main() {
  validateConfig();
  const [nombre, phoneNumberId, email, password] = process.argv.slice(2);
  if (!nombre || !phoneNumberId || !email || !password) {
    console.error('Uso: node scripts/crear_usuario.js "Mi Negocio" <phoneNumberId> <email> <password>');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("La contraseña tiene que ser de al menos 8 caracteres.");
    process.exit(1);
  }

  await mongoose.connect(CONFIG.MONGODB_URI);

  // findOne + create y no upsert: si el negocio ya existe se reutiliza para
  // poder agregarle un segundo usuario, en vez de pisarle la configuración.
  let negocio = await Negocio.findOne({ phoneNumberId });
  if (negocio) {
    log.info(`[ALTA] El negocio "${negocio.nombre}" ya existía para ese phoneNumberId — se le agrega el usuario.`);
  } else {
    negocio = await Negocio.create({ nombre, phoneNumberId });
    log.info(`[ALTA] Negocio creado: ${negocio.nombre} (${negocio._id})`);
  }

  if (await Usuario.findOne({ email: email.toLowerCase() })) {
    console.error("Ya existe un usuario con ese email.");
    process.exit(1);
  }
  const usuario = await Usuario.create({
    email: email.toLowerCase(),
    passwordHash: await hashPassword(password),
    negocioId: negocio._id,
  });
  log.info(`[ALTA] Usuario creado: ${usuario.email}`);
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
