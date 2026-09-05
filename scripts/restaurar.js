// Restaura un respaldo. El comando que se corre el peor día, así que pide
// confirmación explícita y por defecto restaura en una base NUEVA en vez de
// pisar la que está en uso.
//
//   node scripts/restaurar.js                              -> lista los respaldos
//   node scripts/restaurar.js <archivo>                    -> restaura en <base>_restaurado
//   node scripts/restaurar.js <archivo> --sobre-la-base-real  -> PISA la base en uso
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const mongoose = require("mongoose");
const { EJSON } = require("bson");
const { CONFIG, log, validateConfig } = require("../config");
const { descifrar } = require("../services/respaldo");

function preguntar(texto) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(texto, x => { rl.close(); r(x); }));
}

async function main() {
  validateConfig();
  const [archivoArg, ...flags] = process.argv.slice(2);
  const sobreLaReal = flags.includes("--sobre-la-base-real");

  if (!archivoArg) {
    const archivos = fs.existsSync(CONFIG.BACKUP_DIR)
      ? fs.readdirSync(CONFIG.BACKUP_DIR).filter(a => a.endsWith(".enc")).sort().reverse()
      : [];
    if (!archivos.length) {
      console.log(`No hay respaldos en ${CONFIG.BACKUP_DIR}`);
    } else {
      console.log("Respaldos disponibles (el más nuevo primero):\n");
      for (const a of archivos) {
        const st = fs.statSync(path.join(CONFIG.BACKUP_DIR, a));
        console.log(`  ${a}   ${(st.size / 1024 / 1024).toFixed(2)} MB   ${st.mtime.toISOString().slice(0, 16).replace("T", " ")}`);
      }
      console.log(`\nUso: node scripts/restaurar.js <archivo> [--sobre-la-base-real]`);
    }
    return;
  }

  if (!CONFIG.BACKUP_CLAVE) {
    log.error("[RESTAURAR] Falta BACKUP_CLAVE — es la misma con la que se cifró. Sin ella el respaldo no se puede abrir.");
    process.exit(1);
  }

  const ruta = fs.existsSync(archivoArg) ? archivoArg : path.join(CONFIG.BACKUP_DIR, archivoArg);
  if (!fs.existsSync(ruta)) {
    log.error(`[RESTAURAR] No existe: ${ruta}`);
    process.exit(1);
  }

  const datos = EJSON.parse(zlib.gunzipSync(descifrar(fs.readFileSync(ruta), CONFIG.BACKUP_CLAVE)).toString(), { relaxed: false });
  const conteos = Object.entries(datos).map(([c, d]) => `${c}: ${d.length}`);
  console.log(`\nContenido del respaldo:\n  ${conteos.join("\n  ")}\n`);

  await mongoose.connect(CONFIG.MONGODB_URI);
  const cliente = mongoose.connection.getClient();
  const nombreOriginal = mongoose.connection.db.databaseName;
  const destino = sobreLaReal ? nombreOriginal : `${nombreOriginal}_restaurado`;

  if (sobreLaReal) {
    // Escribir el nombre a mano y no un "s/n": es una acción destructiva
    // sobre datos en uso, y tiene que costar más que apretar una tecla.
    console.log(`⚠️  Esto va a BORRAR Y REEMPLAZAR la base en uso: ${nombreOriginal}`);
    console.log("   Antes, parar la app:  pm2 stop wabot\n");
    const r = await preguntar(`Escribí el nombre de la base para confirmar (${nombreOriginal}): `);
    if (r.trim() !== nombreOriginal) {
      console.log("Cancelado.");
      await mongoose.disconnect();
      return;
    }
  }

  const db = cliente.db(destino);
  await db.dropDatabase();
  for (const [coleccion, docs] of Object.entries(datos)) {
    if (docs.length) await db.collection(coleccion).insertMany(docs);
    log.info(`[RESTAURAR] ${coleccion}: ${docs.length}`);
  }

  console.log(`\n✓ Restaurado en la base "${destino}"`);
  if (!sobreLaReal) {
    console.log(`  Para revisarlo:  mongosh ${destino}`);
    console.log(`  Si está bien, apuntá MONGODB_URI ahí, o volvé a correr con --sobre-la-base-real`);
  } else {
    console.log("  Arrancá la app:  pm2 start wabot");
  }
  await mongoose.disconnect();
}

main().catch(e => { console.error(e.message); process.exit(1); });
