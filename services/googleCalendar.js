// wabot — Google Calendar con cuenta de servicio.
//
// Sin la librería `googleapis`: son tres llamadas REST y un JWT firmado, y esa
// dependencia trae decenas de megas y cientos de módulos para eso. El proyecto
// entero tiene siete dependencias; sumar la más pesada de todas por tres
// endpoints no se justifica.
//
// POR QUÉ CUENTA DE SERVICIO Y NO OAUTH: el scope de Calendar es "sensible"
// para Google, así que una app OAuth necesita pasar su proceso de
// verificación —semanas, política de privacidad, revisión de seguridad—.
// Con cuenta de servicio, el dueño comparte su calendario con un email y
// listo. El costo es que cada negocio tiene que hacer ese paso a mano; el día
// que haya cientos de clientes, ahí sí conviene OAuth.
const crypto = require("crypto");
const axios = require("axios");
const { CONFIG, log } = require("../config");

const SCOPE = "https://www.googleapis.com/auth/calendar";
const API = "https://www.googleapis.com/calendar/v3";

function credenciales() {
  if (!CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) return null;
  try {
    return JSON.parse(CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    log.error("[CALENDAR] GOOGLE_SERVICE_ACCOUNT_JSON no es JSON válido");
    return null;
  }
}

function b64url(x) {
  return Buffer.from(x).toString("base64url");
}

// El token de Google dura una hora. Se cachea porque pedirlo en cada consulta
// de disponibilidad agregaría medio segundo a cada mensaje del cliente, y son
// varios por conversación.
let cache = { token: null, vence: 0 };

async function obtenerToken() {
  if (cache.token && Date.now() < cache.vence) return cache.token;

  const cred = credenciales();
  if (!cred?.client_email || !cred?.private_key) {
    throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_JSON o no tiene client_email/private_key");
  }

  const ahora = Math.floor(Date.now() / 1000);
  const cabecera = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const cuerpo = b64url(JSON.stringify({
    iss: cred.client_email,
    scope: SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: ahora,
    exp: ahora + 3600,
  }));
  const firma = crypto.createSign("RSA-SHA256").update(`${cabecera}.${cuerpo}`).sign(cred.private_key).toString("base64url");

  const res = await axios.post("https://oauth2.googleapis.com/token", new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${cabecera}.${cuerpo}.${firma}`,
  }), { timeout: 15000 });

  cache = {
    token: res.data.access_token,
    // 60 segundos de margen: si se usa un token que vence en el camino, la
    // llamada falla con un 401 que parece un problema de permisos.
    vence: Date.now() + (res.data.expires_in - 60) * 1000,
  };
  return cache.token;
}

async function llamar(metodo, ruta, datos) {
  const token = await obtenerToken();
  const res = await axios({
    method: metodo,
    url: `${API}${ruta}`,
    data: datos,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 20000,
  });
  return res.data;
}

// Los bloques ocupados del calendario, en el rango pedido. Esto es lo que hace
// que la agenda sea real: incluye lo que el dueño agendó a mano desde su
// celular, no solo lo que reservó el bot.
async function ocupados(calendarId, desde, hasta) {
  const datos = await llamar("post", "/freeBusy", {
    timeMin: desde.toISOString(),
    timeMax: hasta.toISOString(),
    items: [{ id: calendarId }],
  });

  const cal = datos.calendars?.[calendarId];
  if (cal?.errors?.length) {
    // El error típico es "notFound": el calendario no existe, o no fue
    // compartido con la cuenta de servicio. Se nombra explícito porque es
    // EL error de configuración de este módulo.
    throw new Error(
      `Google no deja leer el calendario "${calendarId}": ${cal.errors.map(e => e.reason).join(", ")}. ` +
      `¿Lo compartiste con la cuenta de servicio con permiso de "Hacer cambios en los eventos"?`
    );
  }
  return (cal?.busy || []).map(b => ({ inicio: new Date(b.start), fin: new Date(b.end) }));
}

async function crearEvento(calendarId, { inicio, fin, titulo, descripcion, zonaHoraria }) {
  const evento = await llamar("post", `/calendars/${encodeURIComponent(calendarId)}/events`, {
    summary: titulo,
    description: descripcion,
    start: { dateTime: inicio.toISOString(), timeZone: zonaHoraria },
    end: { dateTime: fin.toISOString(), timeZone: zonaHoraria },
  });
  return evento.id;
}

async function borrarEvento(calendarId, eventoId) {
  try {
    await llamar("delete", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventoId)}`);
  } catch (e) {
    // 404 o 410 significan que ya no está — que es exactamente lo que
    // queríamos. Fallar acá dejaría una reserva sin poder cancelarse nunca.
    if (![404, 410].includes(e.response?.status)) throw e;
  }
}

// Para que el panel pueda decirle al dueño con quién compartir el calendario.
function emailCuentaDeServicio() {
  return credenciales()?.client_email || "";
}

module.exports = { ocupados, crearEvento, borrarEvento, emailCuentaDeServicio, obtenerToken };
