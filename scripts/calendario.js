// Deja la cuenta de servicio de Google Calendar cargada en el .env.
//
//   node scripts/calendario.js ~/clave.json    carga la clave descargada
//   node scripts/calendario.js                 dice si ya hay una y cuál es
//
// Existe porque el paso que rompe siempre es el mismo: el JSON que descarga
// Google viene en varias líneas, y un .env es una variable por línea. Pegarlo
// tal cual deja la variable cortada en la primera llave, y el síntoma que se
// ve después no dice nada de eso — es la agenda respondiendo que no puede
// consultar disponibilidad.
//
// Se valida ANTES de escribir: se parsea, se comprueba que tenga los campos
// que hacen falta, y se firma algo de prueba con la clave privada. Si la clave
// no sirve para firmar, se sabe acá y no cuando un cliente intenta reservar.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const VARIABLE = "GOOGLE_SERVICE_ACCOUNT_JSON";
const RUTA_ENV = path.join(__dirname, "..", ".env");

function salir(mensaje) {
  console.error(mensaje);
  process.exit(1);
}

// Solo la línea de esta variable, sin tocar el resto del archivo ni su orden.
function leerEnv() {
  if (!fs.existsSync(RUTA_ENV)) salir(`No encuentro el .env en ${RUTA_ENV}`);
  return fs.readFileSync(RUTA_ENV, "utf8");
}

function valorActual(contenido) {
  const linea = contenido.split("\n").find(l => l.startsWith(`${VARIABLE}=`));
  return linea ? linea.slice(VARIABLE.length + 1) : "";
}

function mostrarEstado() {
  const valor = valorActual(leerEnv());
  if (!valor) {
    console.log(`\nTodavía no hay ninguna cuenta de servicio cargada.\n`);
    console.log(`  node scripts/calendario.js ~/clave.json\n`);
    console.log(`La clave se descarga en console.cloud.google.com →`);
    console.log(`IAM → Cuentas de servicio → Claves → Agregar clave → JSON.\n`);
    return;
  }
  let cred;
  try { cred = JSON.parse(valor); } catch {
    salir(`\nHay un ${VARIABLE} en el .env pero NO es JSON válido.\n` +
          `Suele pasar por pegar el archivo tal cual, en varias líneas.\n` +
          `Volvé a cargarlo con:  node scripts/calendario.js ~/clave.json\n`);
  }
  console.log(`\nCuenta de servicio cargada:\n`);
  console.log(`  ${cred.client_email}\n`);
  console.log(`Ese es el email que hay que compartir en Google Calendar, con`);
  console.log(`permiso «Hacer cambios en los eventos». Con solo lectura el bot`);
  console.log(`ve la disponibilidad pero no puede agendar, y eso recién se nota`);
  console.log(`cuando un cliente intenta reservar.\n`);
}

function cargar(rutaClave) {
  if (!fs.existsSync(rutaClave)) salir(`No encuentro el archivo: ${rutaClave}`);

  let cred;
  try {
    cred = JSON.parse(fs.readFileSync(rutaClave, "utf8"));
  } catch (e) {
    salir(`Ese archivo no es JSON válido: ${e.message}`);
  }

  if (cred.type !== "service_account") {
    salir(`Ese JSON no es de una cuenta de servicio (type="${cred.type}").\n` +
          `Si bajaste un "ID de cliente de OAuth", no sirve: hace falta una\n` +
          `clave de cuenta de servicio.`);
  }
  if (!cred.client_email || !cred.private_key) {
    salir("Al JSON le falta client_email o private_key.");
  }

  // La prueba que importa: que la clave sirva para firmar de verdad. Es
  // exactamente lo que hace googleCalendar.js para pedirle el token a Google.
  try {
    crypto.createSign("RSA-SHA256").update("prueba").sign(cred.private_key);
  } catch (e) {
    salir(`La clave privada del JSON no sirve para firmar: ${e.message}`);
  }

  // Minificado y en una sola línea, que es la única forma que sobrevive a un
  // .env. El JSON.stringify de lo ya parseado garantiza que no queden saltos.
  const linea = `${VARIABLE}=${JSON.stringify(cred)}`;

  const contenido = leerEnv();
  const lineas = contenido.split("\n");
  const i = lineas.findIndex(l => l.startsWith(`${VARIABLE}=`));
  if (i >= 0) lineas[i] = linea;
  else {
    // Si el archivo no termina en salto, agregar la línea sin comerse la
    // última variable que ya estaba.
    if (lineas[lineas.length - 1] !== "") lineas.push("");
    lineas.splice(lineas.length - 1, 0, linea);
  }
  fs.writeFileSync(RUTA_ENV, lineas.join("\n"));

  console.log(`\n✅ Cuenta de servicio cargada en el .env.\n`);
  console.log(`   ${cred.client_email}\n`);
  console.log(`Faltan tres cosas, en este orden:\n`);
  console.log(`  1. pm2 restart wabot`);
  console.log(`  2. En Google Calendar → engranaje → Configuración → tu calendario`);
  console.log(`     → «Compartir con determinadas personas» → Agregar → pegá ese`);
  console.log(`     email → permiso «Hacer cambios en los eventos»`);
  console.log(`  3. En el panel → Agenda: poné el ID del calendario y probá`);
  console.log(`     «Ver disponibilidad real»\n`);
  console.log(`Y borrá la clave del servidor cuando termines: ya está en el .env.`);
  console.log(`  rm ${rutaClave}\n`);
}

const ruta = process.argv[2];
if (ruta) cargar(ruta);
else mostrarEstado();
