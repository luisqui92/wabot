// Recuperar el acceso al panel desde el servidor.
//
//   node scripts/clave.js                          lista los usuarios que hay
//   node scripts/clave.js mail@ejemplo.com nueva   le pone otra contraseña
//
// El panel no tiene "olvidé mi contraseña" a propósito: mandar un mail de
// recuperación necesita un servidor de correo, y un enlace de reseteo es una
// puerta más que atacar en un panel que controla una línea de WhatsApp real.
// El dueño del servidor ya tiene el acceso más fuerte que existe, así que la
// recuperación vive acá, detrás de SSH.
//
// La contraseña vieja NO se puede mostrar: se guarda hasheada y el hash no se
// revierte. Lo único que se puede hacer es poner una nueva.
const mongoose = require("mongoose");
const { CONFIG, log, validateConfig } = require("../config");
const { Negocio, Usuario } = require("../db/models");
const { hashPassword } = require("../services/auth");

const MINIMO = 8;

async function listar() {
  const usuarios = await Usuario.find().sort({ creadoEn: 1 }).lean();
  if (!usuarios.length) {
    console.log("No hay ningún usuario. Creá el primero con:");
    console.log('  node scripts/crear_usuario.js "Mi Negocio" <phoneNumberId> <email> <password>');
    return;
  }
  // Se buscan todos los negocios de una y se indexan en memoria: son pocos, y
  // así no se hace una consulta por usuario.
  const negocios = await Negocio.find().select("nombre phoneNumberId").lean();
  const porId = new Map(negocios.map(n => [String(n._id), n]));

  console.log(`\n${usuarios.length} usuario${usuarios.length === 1 ? "" : "s"} en el panel:\n`);
  for (const u of usuarios) {
    const n = porId.get(String(u.negocioId));
    console.log(`  ${u.email}`);
    console.log(`      negocio: ${n ? `${n.nombre} (${n.phoneNumberId})` : "— (el negocio ya no existe)"}`);
    console.log(`      rol: ${u.rol || "admin"}`);
  }
  console.log("\nLa contraseña no se puede recuperar, solo cambiar:");
  console.log(`  node scripts/clave.js ${usuarios[0].email} <nueva-contraseña>\n`);
}

async function cambiar(email, password) {
  if (password.length < MINIMO) {
    console.error(`La contraseña tiene que ser de al menos ${MINIMO} caracteres.`);
    process.exit(1);
  }
  const usuario = await Usuario.findOne({ email: email.toLowerCase() });
  if (!usuario) {
    console.error(`No hay ningún usuario con el email "${email}".`);
    console.error("Corré el script sin argumentos para ver cuáles hay.");
    process.exit(1);
  }
  usuario.passwordHash = await hashPassword(password);
  await usuario.save();
  log.info(`[CLAVE] Contraseña cambiada para ${usuario.email}`);

  // Los tokens ya emitidos siguen siendo válidos hasta que expiren: cambiar la
  // contraseña no cierra las sesiones abiertas. Se dice en voz alta porque si
  // cambiás la clave por sospecha de que alguien entró, esto importa.
  console.log("\nOjo: las sesiones que ya estaban abiertas siguen abiertas hasta");
  console.log("que venza su token. Si cambiaste la clave porque sospechás que");
  console.log("alguien entró, cambiá también JWT_SECRET en el .env y reiniciá");
  console.log("el server — eso sí invalida todos los tokens de una.\n");
}

async function main() {
  validateConfig();
  const [email, password] = process.argv.slice(2);

  // Un solo argumento casi siempre es alguien que quiso cambiar la clave y se
  // olvidó de escribirla. Listar los usuarios ahí sería confuso.
  if (email && !password) {
    console.error("Falta la contraseña nueva.");
    console.error(`  node scripts/clave.js ${email} <nueva-contraseña>`);
    process.exit(1);
  }

  await mongoose.connect(CONFIG.MONGODB_URI);
  try {
    if (email) await cambiar(email, password);
    else await listar();
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
