// Copia diaria de la base: vuelca, cifra, y la da por buena SOLO después de
// restaurarla de verdad en una base aparte y comparar los conteos.
//
//   node scripts/respaldo.js
//
// Pensado para correr desde cron. Sale con código 1 si algo falla, para que
// cron lo reporte en vez de que el error se pierda.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const mongoose = require("mongoose");
const { CONFIG, log, validateConfig } = require("../config");
const { cifrar, descifrar, volcar, verificar, limpiarViejos } = require("../services/respaldo");

async function main() {
  validateConfig();

  if (!CONFIG.BACKUP_CLAVE) {
    log.error("[RESPALDO] Falta BACKUP_CLAVE en el .env — un respaldo sin cifrar no se puede sacar del servidor.");
    log.error("           Generá una con: openssl rand -base64 48");
    process.exit(1);
  }

  fs.mkdirSync(CONFIG.BACKUP_DIR, { recursive: true, mode: 0o700 });

  await mongoose.connect(CONFIG.MONGODB_URI);
  const db = mongoose.connection.db;
  const nombreBase = db.databaseName;

  // ─── 1. VOLCAR ───────────────────────────────────────────────────────────
  const { datos, conteos } = await volcar(db);
  const total = Object.values(conteos).reduce((a, b) => a + b, 0);
  log.info(`[RESPALDO] ${Object.keys(conteos).length} colecciones, ${total} documentos`);

  if (total === 0) {
    // Respaldar una base vacía y pisar el respaldo bueno de ayer es cómo se
    // pierden los datos con el sistema de respaldos "funcionando".
    log.error("[RESPALDO] La base está vacía. Se aborta para no reemplazar copias buenas.");
    await mongoose.disconnect();
    process.exit(1);
  }

  // ─── 2. CIFRAR ───────────────────────────────────────────────────────────
  const { EJSON } = require("bson");
  const plano = Buffer.from(EJSON.stringify(datos, { relaxed: false }));
  const comprimido = zlib.gzipSync(plano, { level: 9 });
  const cifrado = cifrar(comprimido, CONFIG.BACKUP_CLAVE);

  const fecha = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const archivo = path.join(CONFIG.BACKUP_DIR, `wabot-${fecha}.json.gz.enc`);
  fs.writeFileSync(archivo, cifrado, { mode: 0o600 });

  const mb = (cifrado.length / 1024 / 1024).toFixed(2);
  log.info(`[RESPALDO] Escrito ${archivo} (${mb} MB, ${(plano.length / cifrado.length).toFixed(1)}x de compresión)`);

  // ─── 3. VERIFICAR RESTAURANDO ────────────────────────────────────────────
  // Se relee el archivo del disco a propósito, en vez de reusar el buffer en
  // memoria: así se comprueba que lo que quedó GRABADO sirve, que es lo que
  // vas a tener el día del incendio.
  log.info("[RESPALDO] Verificando: descifrando y restaurando en una base aparte...");
  const leido = fs.readFileSync(archivo);
  let problemas;
  try {
    const descomprimido = zlib.gunzipSync(descifrar(leido, CONFIG.BACKUP_CLAVE));
    problemas = await verificar(mongoose.connection.getClient(), `${nombreBase}_verificacion`, descomprimido, conteos);
  } catch (e) {
    log.error(`[RESPALDO] ❌ No se pudo restaurar: ${e.message}`);
    fs.renameSync(archivo, archivo + ".FALLIDO");
    await mongoose.disconnect();
    process.exit(1);
  }

  if (problemas.length) {
    log.error("[RESPALDO] ❌ La restauración no coincide con el original:");
    for (const p of problemas) log.error(`             ${p}`);
    fs.renameSync(archivo, archivo + ".FALLIDO");
    await mongoose.disconnect();
    process.exit(1);
  }

  log.info(`[RESPALDO] ✓ Verificado: ${total} documentos restaurados y comparados uno a uno`);

  // ─── 4. LIMPIAR VIEJOS ───────────────────────────────────────────────────
  // Recién ahora, con una copia nueva ya verificada. Al revés dejaría una
  // ventana sin ninguna copia buena.
  const borrados = limpiarViejos(CONFIG.BACKUP_DIR, CONFIG.BACKUP_RETENCION_DIAS);
  if (borrados) log.info(`[RESPALDO] ${borrados} respaldo(s) de más de ${CONFIG.BACKUP_RETENCION_DIAS} días borrados`);

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
