// Prueba de conexión con Baileys, aislada de todo lo demás.
//
//   node scripts/probar_baileys.js
//
// No toca la base de datos, no toca el negocio que está en producción y no
// usa la IA. Escaneás el QR, le escribís al número desde otro teléfono, y
// contesta con el ritmo humano. Sirve para responder la única pregunta que
// importa antes de construir nada encima: ¿la conexión se sostiene en esta
// máquina, o se cae cada veinte minutos?
//
// Dejalo corriendo un rato largo. Lo que hay que mirar no es que conecte
// —eso siempre funciona el primer minuto— sino cuántas veces se reconecta y
// si pide escanear otra vez.
const qrTerminal = require("qrcode-terminal");
const { log } = require("../config");
const baileys = require("../services/baileys");
const { responderComoHumano } = require("../services/humano");

const SESION = process.argv[2] || "prueba";

let recibidos = 0, reconexiones = 0;
const arranque = Date.now();

function tiempoEnPie() {
  const s = Math.round((Date.now() - arranque) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

async function main() {
  console.log(`\nSesión "${SESION}". Ctrl+C para salir.\n`);

  const sesion = await baileys.conectar(SESION, async (m) => {
    recibidos++;
    console.log(`\n← ${m.nombrePerfil || m.numero} (${m.tipo}): ${m.texto || "(sin texto)"}`);

    // Un eco con el ritmo de una persona: es lo que se quiere ver del otro
    // lado — el "escribiendo…", la pausa, la respuesta partida en dos.
    const canal = {
      leer: () => baileys.marcarLeido(SESION, m.clave),
      escribiendo: (on) => baileys.escribiendo(SESION, m.numero, on),
      enviar: (texto) => baileys.enviarTexto(SESION, m.numero, texto),
    };

    const respuesta = m.texto
      ? `te leí: "${m.texto}"\n\nesto es una prueba de conexión, todavía no soy el bot de verdad`
      : `me llegó un ${m.tipo}, pero por acá todavía no puedo verlo`;

    await responderComoHumano(canal, respuesta);
    console.log(`→ respondido (${recibidos} mensaje${recibidos === 1 ? "" : "s"} en ${tiempoEnPie()})`);
  });

  // El QR y el estado se miran por sondeo en vez de por evento: el módulo
  // guarda el último QR, y así este script no necesita engancharse a los
  // eventos internos de Baileys.
  let ultimoQr = null, ultimoEstado = null;
  setInterval(() => {
    const e = baileys.estado(SESION);

    if (e.qr && e.qr !== ultimoQr) {
      ultimoQr = e.qr;
      console.log("\n─── Escaneá este QR ───");
      console.log("WhatsApp → Dispositivos vinculados → Vincular un dispositivo\n");
      qrTerminal.generate(e.qr, { small: true });
    }

    if (e.estado !== ultimoEstado) {
      if (ultimoEstado === "conectado" && e.estado !== "conectado") reconexiones++;
      ultimoEstado = e.estado;
      console.log(`\n[estado] ${e.estado}${e.numero ? ` — ${e.numero}` : ""}` +
        (reconexiones ? `  (${reconexiones} caída${reconexiones === 1 ? "" : "s"} desde que arrancó)` : ""));
    }
  }, 1000);

  // Latido cada 10 minutos: es el dato que de verdad hay que mirar al día
  // siguiente, no el "conectado" del primer minuto.
  setInterval(() => {
    const e = baileys.estado(SESION);
    console.log(`[${new Date().toLocaleTimeString("es-BO")}] en pie ${tiempoEnPie()} · ${e.estado} · ${recibidos} recibidos · ${reconexiones} caídas`);
  }, 600000);

  process.on("SIGINT", () => {
    console.log(`\n\nResumen: ${tiempoEnPie()} en pie, ${recibidos} mensajes, ${reconexiones} caídas.`);
    console.log("La sesión queda guardada: la próxima vez no pide QR.\n");
    process.exit(0);
  });

  if (sesion.estado === "conectado") console.log(`Ya había sesión guardada: conectado como ${sesion.numero}`);
}

main().catch(e => { log.error("[PRUEBA]", e.stack || e.message); process.exit(1); });
