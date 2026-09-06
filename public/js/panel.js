// wabot — Panel de control. Sin framework y sin build: son cuatro
// pantallas contra una API REST, y una toolchain acá costaría más
// mantenimiento del que ahorra.
"use strict";

// sessionStorage y no localStorage: el token vive 8 horas y esto se abre en
// computadoras compartidas. Al cerrar la pestaña, la sesión se va.
const TOKEN_KEY = "wabot_token";
let token = sessionStorage.getItem(TOKEN_KEY) || "";

const $ = (sel) => document.querySelector(sel);
// Todo lo que viene de la API es texto que escribió un cliente por WhatsApp:
// se inserta siempre con textContent, nunca con innerHTML.
const el = (tag, clase, texto) => {
  const n = document.createElement(tag);
  if (clase) n.className = clase;
  if (texto !== undefined) n.textContent = texto;
  return n;
};

async function api(ruta, opciones = {}) {
  // Sin barra inicial a proposito: se resuelve contra el <base> que inyecta
  // el servidor, asi el panel funciona igual en la raiz de un dominio propio
  // que colgado de un prefijo (ej. api.chatgo.ia.bo/wabot/).
  const res = await fetch(`api${ruta}`, {
    ...opciones,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opciones.headers,
    },
  });
  if (res.status === 401) { cerrarSesion(); throw new Error("Sesión vencida"); }
  const datos = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(datos.error || `Error ${res.status}`);
  return datos;
}

function cerrarSesion() {
  token = "";
  sessionStorage.removeItem(TOKEN_KEY);
  $("#vista-panel").classList.add("oculto");
  $("#vista-login").classList.remove("oculto");
}

// ─── LOGIN ──────────────────────────────────────────────────────────────────
$("#form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  try {
    const r = await api("/login", {
      method: "POST",
      body: JSON.stringify({ email: $("#login-email").value, password: $("#login-password").value }),
    });
    token = r.token;
    sessionStorage.setItem(TOKEN_KEY, token);
    entrar();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});

$("#btn-salir").addEventListener("click", cerrarSesion);

function entrar() {
  $("#vista-login").classList.add("oculto");
  $("#vista-panel").classList.remove("oculto");
  cargarResumen().catch(mostrarError);
}

// ─── PESTAÑAS ───────────────────────────────────────────────────────────────
const CARGADORES = {
  resumen: cargarResumen,
  bot: cargarNegocio,
  conocimiento: cargarConocimiento,
  catalogo: cargarCatalogo,
  pedidos: cargarPedidos,
  agenda: cargarAgenda,
  pagos: cargarPagos,
  clientes: cargarClientes,
  conversaciones: cargarConversaciones,
  huecos: cargarHuecos,
};

document.querySelectorAll(".tab").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("activa"));
    b.classList.add("activa");
    document.querySelectorAll(".panel").forEach(p => p.classList.add("oculto"));
    $(`#tab-${b.dataset.tab}`).classList.remove("oculto");
    // Se recarga en cada cambio de pestaña a propósito: las conversaciones
    // llegan por WhatsApp mientras el panel está abierto, así que una vista
    // cacheada muestra datos viejos justo cuando más importan.
    CARGADORES[b.dataset.tab]().catch(mostrarError);
  });
});

function mostrarError(err) {
  console.error(err);
  alert(err.message);
}

// ─── RESUMEN ────────────────────────────────────────────────────────────────
function haceCuanto(fecha) {
  const min = Math.round((Date.now() - new Date(fecha)) / 60000);
  if (min < 1) return "recién";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? "ayer" : `hace ${d} días`;
}

function tarjetaKpi(etiqueta, valor, pie, sinDatos = false) {
  const k = el("div", "kpi");
  k.append(el("div", "et", etiqueta));
  k.append(el("div", "num", valor));
  k.append(el("div", `pie${sinDatos ? " sin" : ""}`, pie));
  return k;
}

const ICONO = { pedido: "▧ Pedido", turno: "▩ Turno", conversacion: "◑ Conversación" };

async function cargarResumen() {
  const r = await api("/resumen");
  const m = r.metricas;

  $("#ws-nombre").textContent = r.negocio.nombre;
  $("#resumen-sub").textContent = r.negocio.activo
    ? "Lo que pasó mientras no mirabas."
    : "⚠ El bot está apagado: no le está respondiendo a nadie.";

  // ─── Avisos ───
  const avisos = $("#avisos");
  avisos.replaceChildren();
  for (const a of r.avisos) {
    const caja = el("div", `aviso ${a.nivel}`);
    caja.append(el("span", null, a.texto));
    const ir = el("button", "sutil", "Ir");
    ir.addEventListener("click", () => document.querySelector(`[data-tab="${a.ir}"]`).click());
    caja.append(ir);
    avisos.append(caja);
  }

  // ─── KPIs. Cada número dice de qué período es: un número sin período no
  // significa nada, y es exactamente donde los tableros mienten sin querer.
  const k = $("#kpis");
  k.replaceChildren();
  k.append(tarjetaKpi("◑ Conversaciones", String(m.conversaciones30),
    m.conversaciones7 ? `${m.conversaciones7} en los últimos 7 días` : "ninguna esta semana", !m.conversaciones7));

  // El porcentaje solo aparece si hay con qué calcularlo. Un "0%" cuando
  // nadie escribió todavía haría pensar que el bot funciona mal.
  k.append(m.resueltasPorcentaje === null
    ? tarjetaKpi("✦ Resueltas por el bot", "—", "todavía no respondió nada", true)
    : tarjetaKpi("✦ Resueltas por el bot", `${m.resueltasPorcentaje}%`,
        m.sinRespuesta ? `${m.sinRespuesta} sin respuesta` : "sin huecos"));

  k.append(tarjetaKpi("▧ Pedidos nuevos", String(m.pedidosNuevos),
    r.negocio.herramientas?.pedidos ? "esperando confirmación" : "tomar pedidos está apagado", !m.pedidosNuevos));
  k.append(tarjetaKpi("▩ Turnos próximos", String(m.turnosProximos),
    r.negocio.herramientas?.reservas ? "agendados de acá en adelante" : "agendar turnos está apagado", !m.turnosProximos));
  k.append(tarjetaKpi("◉ Clientes", String(m.clientes), m.clientes ? "personas que escribieron" : "nadie todavía", !m.clientes));

  // ─── Destacado ───
  const d = $("#destacado");
  d.replaceChildren();
  d.append(el("span", "cinta", "ESTADO DEL BOT"));
  if (!m.fragmentos) {
    d.append(el("h2", null, "Al bot le falta lo principal"));
    d.append(el("p", null, "No tiene información cargada, así que no puede responder nada concreto. Andá a Conocimiento y cargá horarios, precios o lo que más te pregunten."));
  } else if (m.resueltasPorcentaje === null) {
    d.append(el("h2", null, `${m.fragmentos} fragmentos cargados`));
    d.append(el("p", null, "Todo listo. Falta que alguien le escriba: probá desde tu celular."));
  } else if (m.sinRespuesta) {
    d.append(el("h2", null, `Resolvió ${m.resueltasPorcentaje}% solo`));
    const una = m.sinRespuesta === 1;
    d.append(el("p", null, `${una ? "Quedó 1 pregunta" : `Quedaron ${m.sinRespuesta} preguntas`} sin responder. ${una ? "Contestala" : "Contestalas"} una vez en Huecos y no ${una ? "vuelve" : "vuelven"} a fallar.`));
  } else {
    d.append(el("h2", null, `Resolvió ${m.resueltasPorcentaje}% solo`));
    d.append(el("p", null, `Con ${m.fragmentos} fragmentos cargados no quedó ninguna pregunta sin responder.`));
  }

  // ─── Capacidades ───
  const cap = $("#capacidades");
  cap.replaceChildren();
  const filas = [
    ["Responder preguntas", m.fragmentos > 0, m.fragmentos ? `${m.fragmentos} fragmentos` : "sin información"],
    ["Consultar precios", !!r.negocio.herramientas?.catalogo, m.productos ? `${m.productos} productos` : "catálogo vacío"],
    ["Tomar pedidos", !!r.negocio.herramientas?.pedidos, r.negocio.herramientas?.pedidos ? "activo" : "apagado"],
    ["Agendar turnos", !!r.negocio.herramientas?.reservas, r.negocio.herramientas?.reservas ? "activo" : "apagado"],
    ["Escuchar audios", !!r.negocio.transcribirAudios, r.negocio.transcribirAudios ? "activo" : "apagado"],
  ];
  for (const [nombre, on, det] of filas) {
    const f = el("div", "capacidad");
    f.append(el("span", `punto ${on ? "on" : "off"}`));
    f.append(el("span", null, nombre));
    f.append(el("span", "det", det));
    cap.append(f);
  }

  // ─── Actividad ───
  const tbody = $("#tabla-actividad").querySelector("tbody");
  tbody.replaceChildren();
  if (!r.actividad.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5; td.append(el("span", "nota", "Todavía no pasó nada. Escribile al bot desde tu celular para ver la primera fila acá."));
    tr.append(td); tbody.append(tr);
  }
  for (const a of r.actividad) {
    const tr = document.createElement("tr");
    const celda = (contenido) => { const td = document.createElement("td"); td.append(contenido); return td; };
    tr.append(celda(el("span", null, ICONO[a.tipo] || a.tipo)));
    tr.append(celda(el("span", null, a.quien)));
    tr.append(celda(el("span", "nota", a.detalle)));
    const clase = a.resultado === "sin respuesta" ? "chip avisa" : a.estado === "cancelada" ? "chip gris" : "chip ok";
    tr.append(celda(el("span", clase, a.resultado)));
    tr.append(celda(el("span", "cuando", haceCuanto(a.cuando))));
    if (a.tipo === "conversacion" && a.id) {
      tr.style.cursor = "pointer";
      tr.addEventListener("click", () => {
        document.querySelector('[data-tab="conversaciones"]').click();
        setTimeout(() => abrirConversacion(a.id).catch(mostrarError), 100);
      });
    }
    tbody.append(tr);
  }

  // El contador del menú: que se vea desde cualquier pantalla que hay trabajo.
  const badge = $("#badge-huecos");
  if (m.sinRespuesta) { badge.textContent = m.sinRespuesta; badge.classList.remove("oculto"); }
  else badge.classList.add("oculto");
}

// ─── BOT ────────────────────────────────────────────────────────────────────
async function cargarNegocio() {
  const n = await api("/negocio");
  $("#n-nombre").value = n.nombre || "";
  $("#n-descripcion").value = n.descripcion || "";
  $("#n-instrucciones").value = n.instrucciones || "";
  $("#n-mensajeSinInfo").value = n.mensajeSinInfo || "";
  $("#n-numeroEscalamiento").value = n.numeroEscalamiento || "";
  $("#n-activo").checked = !!n.activo;
  $("#h-catalogo").checked = !!n.herramientas?.catalogo;
  $("#h-pedidos").checked = !!n.herramientas?.pedidos;
  $("#h-reservas").checked = !!n.herramientas?.reservas;
  $("#h-cobros").checked = !!n.herramientas?.cobros;
  $("#n-audios").checked = !!n.transcribirAudios;

  // El aviso importa: significa que hay información cargada que el bot NO
  // está leyendo, y el síntoma visible sería que diga "no sé" sobre algo que
  // el dueño juraría que cargó.
  const aviso = $("#aviso-base");
  if (n.base?.recortados > 0) {
    aviso.textContent = `⚠ ${n.base.recortados} de ${n.base.total} fragmentos no entran en el contexto y el bot no los está leyendo. Desactivá los que ya no sirvan, o achicá la base.`;
    aviso.classList.remove("oculto");
  } else {
    aviso.classList.add("oculto");
  }
}

$("#form-negocio").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/negocio", {
      method: "PUT",
      body: JSON.stringify({
        nombre: $("#n-nombre").value,
        descripcion: $("#n-descripcion").value,
        instrucciones: $("#n-instrucciones").value,
        mensajeSinInfo: $("#n-mensajeSinInfo").value,
        numeroEscalamiento: $("#n-numeroEscalamiento").value.replace(/[^0-9]/g, ""),
        activo: $("#n-activo").checked,
        herramientas: { catalogo: $("#h-catalogo").checked, pedidos: $("#h-pedidos").checked, reservas: $("#h-reservas").checked, cobros: $("#h-cobros").checked },
        transcribirAudios: $("#n-audios").checked,
      }),
    });
    $("#negocio-estado").textContent = "Guardado ✓";
    setTimeout(() => { $("#negocio-estado").textContent = ""; }, 2500);
  } catch (err) { mostrarError(err); }
});

// ─── CONOCIMIENTO ───────────────────────────────────────────────────────────
$("#d-archivo").addEventListener("change", (e) => {
  const archivo = e.target.files[0];
  if (!archivo) return;
  // Se lee en el navegador y se manda como texto: así el servidor no necesita
  // multer ni manejar archivos, y queda claro que solo se soporta texto plano
  // (un PDF llegaría como bytes ilegibles, y es mejor que no se pueda a que
  // se cargue basura en la base de conocimiento).
  const lector = new FileReader();
  lector.onload = () => {
    $("#d-texto").value = lector.result;
    if (!$("#d-nombre").value) $("#d-nombre").value = archivo.name.replace(/\.[^.]+$/, "");
  };
  lector.readAsText(archivo);
});

$("#form-documento").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const r = await api("/documentos", {
      method: "POST",
      body: JSON.stringify({ nombre: $("#d-nombre").value, texto: $("#d-texto").value }),
    });
    $("#documento-estado").textContent = `Cargado ✓ (${r.fragmentos} fragmentos)`;
    $("#form-documento").reset();
    await cargarConocimiento();
    setTimeout(() => { $("#documento-estado").textContent = ""; }, 3000);
  } catch (err) { mostrarError(err); }
});

async function cargarConocimiento() {
  const [docs, correcciones] = await Promise.all([
    api("/documentos"),
    api("/fragmentos?origen=correccion"),
  ]);

  const cont = $("#lista-documentos");
  cont.replaceChildren();
  if (!docs.length) cont.append(el("p", "nota", "Todavía no cargaste nada. El bot no va a poder responder consultas concretas."));
  for (const d of docs) {
    const item = el("div", "item");
    const fila = el("div", "fila");
    fila.append(el("h3", null, d.nombre), el("span", "badge", `${d.fragmentos} fragmentos`));
    const borrar = el("button", "peligro", "Borrar");
    borrar.addEventListener("click", async () => {
      if (!confirm(`¿Borrar "${d.nombre}" y sus ${d.fragmentos} fragmentos? El bot deja de saber todo eso.`)) return;
      try { await api(`/documentos/${d._id}`, { method: "DELETE" }); await cargarConocimiento(); }
      catch (err) { mostrarError(err); }
    });
    fila.append(borrar);
    item.append(fila);
    cont.append(item);
  }

  const cc = $("#lista-correcciones");
  cc.replaceChildren();
  if (!correcciones.length) cc.append(el("p", "nota", "Ninguna todavía."));
  for (const f of correcciones) {
    const item = el("div", "item");
    const fila = el("div", "fila");
    fila.append(el("h3", null, f.titulo || "(sin título)"));
    const toggle = el("button", "sutil", f.activo ? "Desactivar" : "Activar");
    toggle.addEventListener("click", async () => {
      try { await api(`/fragmentos/${f._id}`, { method: "PUT", body: JSON.stringify({ activo: !f.activo }) }); await cargarConocimiento(); }
      catch (err) { mostrarError(err); }
    });
    fila.append(toggle);
    item.append(fila, el("p", null, f.texto));
    cc.append(item);
  }
}

// ─── AGENDA ─────────────────────────────────────────────────────────────────
const NOMBRES_DIA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

function filaFranja({ diaSemana = 1, horaInicio = "09:00", horaFin = "18:00" } = {}) {
  const fila = el("div", "franja");
  const dia = document.createElement("select");
  NOMBRES_DIA.forEach((n, i) => {
    const o = document.createElement("option");
    o.value = i; o.textContent = n; if (i === diaSemana) o.selected = true;
    dia.append(o);
  });
  const desde = el("input"); desde.type = "time"; desde.value = horaInicio;
  const hasta = el("input"); hasta.type = "time"; hasta.value = horaFin;
  const quitar = el("button", "peligro", "Quitar");
  quitar.type = "button";
  quitar.addEventListener("click", () => fila.remove());
  fila.append(dia, el("span", "nota", "de"), desde, el("span", "nota", "a"), hasta, quitar);
  fila.leer = () => ({ diaSemana: +dia.value, horaInicio: desde.value, horaFin: hasta.value });
  return fila;
}

$("#btn-franja").addEventListener("click", () => $("#horario").append(filaFranja()));

async function cargarAgenda() {
  const c = await api("/agenda/config");
  $("#a-calendario").value = c.googleCalendarId;
  $("#a-zona").value = c.zonaHoraria || "America/La_Paz";
  $("#a-duracion").value = c.duracionTurnoMinutos;
  $("#a-paso").value = c.pasoTurnoMinutos;
  $("#a-anticipacion").value = c.anticipacionMinimaHoras;
  $("#a-dias").value = c.diasMaximosAdelante;

  const instr = $("#agenda-instrucciones");
  instr.replaceChildren();
  if (c.emailParaCompartir) {
    instr.append(document.createTextNode("En Google Calendar: Configuración del calendario → Compartir con determinadas personas → Agregar → "));
    const email = el("code", null, c.emailParaCompartir);
    instr.append(email);
    instr.append(document.createTextNode(" → permiso «Hacer cambios en los eventos». Sin ese permiso el bot puede leer pero no agendar."));
  } else {
    instr.textContent = "⚠ Falta GOOGLE_SERVICE_ACCOUNT_JSON en el .env del servidor. Sin eso la agenda no puede funcionar.";
  }

  const cont = $("#horario");
  cont.replaceChildren();
  (c.horarioAtencion.length ? c.horarioAtencion : [{}]).forEach(f => cont.append(filaFranja(f)));

  await cargarReservas();
}

$("#form-agenda").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/agenda/config", { method: "PUT", body: JSON.stringify({
      googleCalendarId: $("#a-calendario").value,
      zonaHoraria: $("#a-zona").value,
      duracionTurnoMinutos: $("#a-duracion").value,
      pasoTurnoMinutos: $("#a-paso").value,
      anticipacionMinimaHoras: $("#a-anticipacion").value,
      diasMaximosAdelante: $("#a-dias").value,
      horarioAtencion: [...$("#horario").children].map(f => f.leer()),
    }) });
    $("#agenda-estado").textContent = "Guardado ✓";
    setTimeout(() => { $("#agenda-estado").textContent = ""; }, 2500);
  } catch (err) { mostrarError(err); }
});

$("#btn-probar-agenda").addEventListener("click", async () => {
  const cont = $("#disponibilidad");
  cont.replaceChildren(el("p", "nota", "Consultando Google Calendar…"));
  try {
    const dias = await api("/agenda/disponibilidad");
    cont.replaceChildren();
    if (!dias.length) {
      cont.append(el("p", "nota", "Sin horarios libres. Revisá el horario de atención, o el calendario está lleno."));
      return;
    }
    for (const d of dias) {
      const caja = el("div", "dia-libre");
      caja.append(el("h4", null, `${d.diaNombre} ${d.fecha}`));
      const horas = el("div", "horas");
      d.turnos.forEach(t => horas.append(el("span", "hora-libre", t.hora)));
      caja.append(horas);
      cont.append(caja);
    }
  } catch (err) {
    cont.replaceChildren(el("p", "error", err.message));
  }
});

async function cargarReservas() {
  const reservas = await api("/reservas");
  const cont = $("#lista-reservas");
  cont.replaceChildren();
  if (!reservas.length) { cont.append(el("p", "nota", "Ningún turno próximo.")); return; }
  for (const r of reservas) {
    const item = el("div", "item");
    const fila = el("div", "fila");
    fila.append(el("h3", null, `${r.diaNombre} ${r.fechaLocal} — ${r.horaLocal}`));
    if (r.estado === "cancelada") fila.append(el("span", "badge", "cancelada"));
    item.append(fila);
    item.append(el("p", null, r.nombre || r.numero));
    if (r.motivo) item.append(el("p", "meta", r.motivo));
    item.append(el("p", "meta", r.numero));
    if (r.estado === "confirmada") {
      const cancelar = el("button", "peligro", "Cancelar turno");
      cancelar.addEventListener("click", async () => {
        if (!confirm("¿Cancelar este turno? También se borra del Google Calendar.")) return;
        try { await api(`/reservas/${r._id}`, { method: "DELETE" }); await cargarReservas(); }
        catch (err) { mostrarError(err); }
      });
      item.append(cancelar);
    }
    cont.append(item);
  }
}

// ─── DICTADO ────────────────────────────────────────────────────────────────
// Grabar desde el navegador y mandar el audio crudo a transcribir. El texto se
// PEGA en el textarea, no se guarda solo: la transcripción puede equivocarse
// con nombres y precios, y eso terminaría siendo lo que el bot le dice a un
// cliente. Que lo lea una persona antes.
let grabadora, trozos = [];

$("#btn-grabar").addEventListener("click", async () => {
  const boton = $("#btn-grabar");
  const estado = $("#grabar-estado");

  if (grabadora?.state === "recording") {
    grabadora.stop();
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    return mostrarError(new Error("Este navegador no permite grabar. Probá con Chrome, o escribí el texto."));
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    trozos = [];
    grabadora = new MediaRecorder(stream);
    grabadora.ondataavailable = (e) => { if (e.data.size) trozos.push(e.data); };

    grabadora.onstop = async () => {
      // Soltar el micrófono enseguida: si no, el navegador deja el indicador
      // de "grabando" prendido y eso asusta con razón.
      stream.getTracks().forEach(t => t.stop());
      boton.classList.remove("grabando");
      boton.textContent = "🎙 Dictar en vez de escribir";

      const blob = new Blob(trozos, { type: grabadora.mimeType || "audio/webm" });
      if (blob.size < 1000) { estado.textContent = "Muy corto, no se grabó nada."; return; }

      estado.textContent = "Transcribiendo…";
      try {
        const res = await fetch("api/transcribir", {
          method: "POST",
          headers: { "Content-Type": blob.type, Authorization: `Bearer ${token}` },
          body: blob,
        });
        const datos = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(datos.error || `Error ${res.status}`);

        // Se agrega al final en vez de reemplazar: si ya había texto escrito,
        // pisarlo sería perder trabajo de quien lo tipeó.
        const area = $("#d-texto");
        area.value = area.value ? `${area.value.trim()}\n\n${datos.texto}` : datos.texto;
        if (!$("#d-nombre").value) $("#d-nombre").value = "Dictado " + new Date().toLocaleDateString("es-BO");
        estado.textContent = "Listo ✓ — revisalo antes de cargarlo";
        area.focus();
      } catch (err) {
        estado.textContent = "";
        mostrarError(err);
      }
    };

    grabadora.start();
    boton.classList.add("grabando");
    boton.textContent = "⏹ Detener y transcribir";
    estado.textContent = "Grabando… hablá tranquilo, después lo podés corregir.";
  } catch (err) {
    mostrarError(new Error("No se pudo usar el micrófono. Revisá el permiso del navegador."));
  }
});

// ─── CATÁLOGO ───────────────────────────────────────────────────────────────
$("#form-producto").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/productos", { method: "POST", body: JSON.stringify({
      nombre: $("#p-nombre").value, precio: $("#p-precio").value,
      categoria: $("#p-categoria").value, descripcion: $("#p-descripcion").value,
    }) });
    $("#form-producto").reset();
    $("#producto-estado").textContent = "Agregado ✓";
    setTimeout(() => { $("#producto-estado").textContent = ""; }, 2000);
    await cargarCatalogo();
  } catch (err) { mostrarError(err); }
});

$("#btn-importar").addEventListener("click", async () => {
  try {
    const r = await api("/productos/importar", { method: "POST", body: JSON.stringify({ texto: $("#p-importar").value }) });
    $("#importar-estado").textContent = `${r.importados} importados${r.ignoradas.length ? `, ${r.ignoradas.length} filas ignoradas` : ""} ✓`;
    $("#p-importar").value = "";
    await cargarCatalogo();
  } catch (err) { mostrarError(err); }
});

async function cargarCatalogo() {
  const productos = await api("/productos");
  const cont = $("#lista-productos");
  cont.replaceChildren();
  if (!productos.length) {
    cont.append(el("p", "nota", "Catálogo vacío. Sin productos, el bot no puede consultar precios ni tomar pedidos."));
    return;
  }
  for (const p of productos) {
    const item = el("div", `item${p.disponible ? "" : " agotado"}`);
    const fila = el("div", "fila");
    const izq = el("div");
    izq.append(el("h3", null, p.nombre));
    if (p.categoria || p.descripcion) izq.append(el("p", "meta", [p.categoria, p.descripcion].filter(Boolean).join(" · ")));
    fila.append(izq);
    fila.append(el("span", "precio", `${p.moneda} ${p.precio}`));

    const toggle = el("button", "sutil", p.disponible ? "Marcar agotado" : "Marcar disponible");
    toggle.addEventListener("click", async () => {
      try { await api(`/productos/${p._id}`, { method: "PUT", body: JSON.stringify({ disponible: !p.disponible }) }); await cargarCatalogo(); }
      catch (err) { mostrarError(err); }
    });
    const borrar = el("button", "peligro", "Borrar");
    borrar.addEventListener("click", async () => {
      if (!confirm(`¿Borrar "${p.nombre}"?`)) return;
      try { await api(`/productos/${p._id}`, { method: "DELETE" }); await cargarCatalogo(); }
      catch (err) { mostrarError(err); }
    });
    fila.append(toggle, borrar);
    item.append(fila);
    cont.append(item);
  }
}

// ─── PEDIDOS ────────────────────────────────────────────────────────────────
const ETIQUETA_ESTADO = { nuevo: "🆕 Nuevo", confirmado: "✅ Confirmado", entregado: "📦 Entregado", cancelado: "✖ Cancelado" };

async function cargarPedidos() {
  const pedidos = await api("/pedidos");
  const cont = $("#lista-pedidos");
  cont.replaceChildren();
  if (!pedidos.length) { cont.append(el("p", "nota", "Ningún pedido todavía.")); return; }

  for (const p of pedidos) {
    const item = el("div", "item");
    const fila = el("div", "fila");
    fila.append(el("h3", null, `${p.moneda} ${p.total}`));
    fila.append(el("span", "badge", ETIQUETA_ESTADO[p.estado] || p.estado));
    item.append(fila);
    item.append(el("p", null, p.items.map(i => `${i.cantidad}x ${i.nombre}`).join(", ")));
    item.append(el("p", "meta", `${p.numero} · ${new Date(p.creadoEn).toLocaleString("es-BO", { dateStyle: "short", timeStyle: "short" })}`));
    if (p.notas) item.append(el("p", "meta", `Notas: ${p.notas}`));

    const estados = el("div", "estados");
    for (const e of ["confirmado", "entregado", "cancelado"]) {
      if (e === p.estado) continue;
      const b = el("button", e === "cancelado" ? "peligro" : "sutil", ETIQUETA_ESTADO[e]);
      b.addEventListener("click", async () => {
        try { await api(`/pedidos/${p._id}`, { method: "PUT", body: JSON.stringify({ estado: e }) }); await cargarPedidos(); }
        catch (err) { mostrarError(err); }
      });
      estados.append(b);
    }
    item.append(estados);
    cont.append(item);
  }
}

// ─── PAGOS ──────────────────────────────────────────────────────────────────
$("#qr-archivo").addEventListener("change", async (e) => {
  const archivo = e.target.files[0];
  if (!archivo) return;
  $("#qr-estado").textContent = "Subiendo…";
  try {
    const res = await fetch("api/cobros/qr", { method: "POST",
      headers: { "Content-Type": archivo.type, Authorization: `Bearer ${token}` }, body: archivo });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `Error ${res.status}`);
    $("#qr-estado").textContent = "QR cargado ✓";
    await cargarPagos();
  } catch (err) { $("#qr-estado").textContent = ""; mostrarError(err); }
});

$("#btn-guardar-cobros").addEventListener("click", async () => {
  try {
    await api("/cobros/config", { method: "PUT", body: JSON.stringify({
      instruccionesPago: $("#qr-instrucciones").value, qrVence: $("#qr-vence").value }) });
    $("#qr-estado").textContent = "Guardado ✓";
    setTimeout(() => { $("#qr-estado").textContent = ""; }, 2500);
  } catch (err) { mostrarError(err); }
});

const ETIQUETA_PAGO = { pendiente: "Pendiente", aceptado: "✅ Aceptado", rechazado: "✖ Rechazado" };

async function cargarPagos() {
  const [cfg, pagos] = await Promise.all([api("/cobros/config"), api("/pagos")]);

  $("#qr-instrucciones").value = cfg.instruccionesPago;
  $("#qr-vence").value = cfg.qrVence || "";
  const img = $("#qr-actual");
  if (cfg.tieneQr) { img.src = cfg.qrUrl + "?" + Date.now(); img.classList.remove("oculto"); }
  else img.classList.add("oculto");

  // Sin APP_URL el QR no se puede mandar, y el síntoma sería que el bot dice
  // que lo envió y al cliente no le llega nada.
  // El vencimiento manda sobre el resto de los avisos: un QR vencido corta los
  // cobros y es lo primero que hay que ver al entrar acá.
  const aviso = $("#qr-aviso");
  aviso.classList.remove("error");
  if (cfg.diasParaVencer !== null && cfg.diasParaVencer < 0) {
    aviso.textContent = `⚠ Tu QR venció hace ${Math.abs(cfg.diasParaVencer)} días. El bot dejó de cobrar con él: renovalo en tu banco y subí el nuevo.`;
    aviso.classList.add("error");
  } else if (cfg.diasParaVencer !== null && cfg.diasParaVencer <= 30) {
    aviso.textContent = `⚠ Tu QR vence en ${cfg.diasParaVencer} día${cfg.diasParaVencer === 1 ? "" : "s"}. Renovalo antes de que se corte el cobro.`;
  } else if (cfg.faltaAppUrl) {
    aviso.textContent = "⚠ Falta APP_URL en el .env del servidor. Sin eso Meta no puede descargar el QR y el envío falla.";
  } else if (cfg.tieneQr) {
    aviso.textContent = cfg.diasParaVencer !== null
      ? `Este es el QR que el bot le manda a los clientes. Vence en ${cfg.diasParaVencer} días.`
      : "Este es el QR que el bot le manda a los clientes. Cargá su fecha de caducidad para que te avise antes de que venza.";
  } else {
    aviso.textContent = "Todavía no cargaste tu QR.";
  }

  const cont = $("#lista-pagos");
  cont.replaceChildren();
  if (!pagos.length) { cont.append(el("p", "nota", "Ningún comprobante todavía.")); return; }

  for (const p of pagos) {
    const item = el("div", "item");
    const fila = el("div", "fila");
    fila.append(el("h3", null, p.emisor || p.numero));
    fila.append(el("span", `badge${p.estado === "pendiente" ? " alerta" : ""}`, ETIQUETA_PAGO[p.estado]));
    item.append(fila);

    const caja = el("div", "comprobante");
    const foto = document.createElement("img");
    // La imagen va autenticada: es un documento bancario de un cliente.
    fetch(`api/pagos/${p._id}/imagen`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.blob() : null)
      .then(b => { if (b) foto.src = URL.createObjectURL(b); })
      .catch(() => {});
    foto.addEventListener("click", () => window.open(foto.src, "_blank"));
    caja.append(foto);

    const datos = el("div");
    const montos = el("div", "montos");
    montos.append(el("span", "grande", p.detectado !== null ? `${p.moneda} ${p.detectado}` : "ilegible"));
    if (p.esperadoCentavos) montos.append(el("span", "nota", `esperado ${p.moneda} ${p.esperado}`));
    datos.append(montos);
    for (const [et, val] of [["Banco", p.banco], ["Referencia", p.referencia], ["Fecha", p.fechaComprobante]]) {
      if (val) datos.append(el("p", "meta", `${et}: ${val}`));
    }
    datos.append(el("p", "meta", `${p.numero} · ${haceCuanto(p.creadoEn)}`));

    if (p.alertas?.length) {
      for (const a of p.alertas) datos.append(el("div", "alerta-pago", a));
    } else if (p.detectado !== null && p.esperadoCentavos) {
      datos.append(el("div", "coincide", "El monto coincide con el pedido."));
    }

    if (p.estado === "pendiente") {
      const acciones = el("div", "estados");
      const aceptar = el("button", null, "Aceptar pago");
      aceptar.addEventListener("click", async () => {
        if (!confirm("¿Aceptar este pago? El pedido queda marcado como pagado.")) return;
        try { await api(`/pagos/${p._id}`, { method: "PUT", body: JSON.stringify({ estado: "aceptado" }) }); await cargarPagos(); }
        catch (err) { mostrarError(err); }
      });
      const rechazar = el("button", "peligro", "Rechazar");
      rechazar.addEventListener("click", async () => {
        try { await api(`/pagos/${p._id}`, { method: "PUT", body: JSON.stringify({ estado: "rechazado" }) }); await cargarPagos(); }
        catch (err) { mostrarError(err); }
      });
      acciones.append(aceptar, rechazar);
      datos.append(acciones);
    }
    caja.append(datos);
    item.append(caja);
    cont.append(item);
  }

  const pend = pagos.filter(p => p.estado === "pendiente").length;
  const badge = $("#badge-pagos");
  if (pend) { badge.textContent = pend; badge.classList.remove("oculto"); }
  else badge.classList.add("oculto");
}

// ─── CLIENTES ───────────────────────────────────────────────────────────────
let temporizadorBusqueda;
$("#buscar-clientes").addEventListener("input", () => {
  // Se espera a que deje de tipear: sin esto es una consulta por tecla.
  clearTimeout(temporizadorBusqueda);
  temporizadorBusqueda = setTimeout(() => cargarClientes().catch(mostrarError), 300);
});

function fecha(d) {
  return d ? new Date(d).toLocaleDateString("es-BO", { day: "numeric", month: "short", year: "numeric" }) : "—";
}

async function cargarClientes() {
  const q = $("#buscar-clientes").value.trim();
  const clientes = await api(`/clientes${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  const cont = $("#lista-clientes");
  cont.replaceChildren();
  if (!clientes.length) {
    cont.append(el("p", "nota", q ? "Ningún cliente coincide." : "Todavía no escribió nadie."));
    return;
  }
  for (const c of clientes) {
    const item = el("div", "item");
    const fila = el("div", "fila");
    fila.append(el("h3", null, c.nombre || c.nombrePerfil || c.numero));
    if (c.resumen) fila.append(el("span", "badge", "con ficha"));
    item.append(fila);
    item.append(el("p", "meta", `${c.numero} · ${c.totalMensajes} mensaje${c.totalMensajes === 1 ? "" : "s"} · último ${fecha(c.ultimoContacto)}`));
    item.style.cursor = "pointer";
    item.addEventListener("click", () => abrirCliente(c._id).catch(mostrarError));
    cont.append(item);
  }
}

async function abrirCliente(id) {
  const c = await api(`/clientes/${id}`);
  const d = $("#detalle-cliente");
  d.replaceChildren();

  d.append(el("h3", null, c.nombre || c.nombrePerfil || c.numero));
  d.append(el("p", "meta", `${c.numero} · cliente desde ${fecha(c.primerContacto)} · ${c.totalMensajes} mensajes`));

  // La ficha primero: es lo que el bot está usando ahora mismo, y es lo que el
  // dueño quiere ver cuando abre a un cliente.
  const ficha = el("div", "ficha");
  ficha.append(el("h4", null, c.resumenActualizadoEn ? `Ficha de la IA — ${fecha(c.resumenActualizadoEn)}` : "Ficha de la IA"));
  ficha.append(el("div", null, c.resumen || "Todavía no hay suficiente conversación para armar una ficha."));
  d.append(ficha);

  const regenerar = el("button", "sutil", "Regenerar ficha");
  regenerar.addEventListener("click", async () => {
    regenerar.disabled = true; regenerar.textContent = "Leyendo la conversación…";
    try { await api(`/clientes/${id}/resumen`, { method: "POST" }); await abrirCliente(id); }
    catch (err) { mostrarError(err); regenerar.disabled = false; regenerar.textContent = "Regenerar ficha"; }
  });
  d.append(regenerar);

  const campos = el("div", "campos");
  const lNombre = el("label", null, "Nombre (el que uses vos, no el de su perfil)");
  const iNombre = el("input"); iNombre.value = c.nombre || ""; iNombre.placeholder = c.nombrePerfil || "";
  lNombre.append(iNombre);

  const lNotas = el("label", null, "Notas — lo que la IA no puede deducir: cómo paga, qué prefiere, qué pasó la última vez");
  const iNotas = el("textarea"); iNotas.rows = 4; iNotas.value = c.notas || "";
  lNotas.append(iNotas);

  const lEtiq = el("label", null, "Etiquetas, separadas por coma");
  const iEtiq = el("input"); iEtiq.value = (c.etiquetas || []).join(", ");
  lEtiq.append(iEtiq);

  const guardar = el("button", null, "Guardar");
  const estado = el("span", "estado");
  guardar.addEventListener("click", async () => {
    try {
      await api(`/clientes/${id}`, { method: "PUT", body: JSON.stringify({
        nombre: iNombre.value,
        notas: iNotas.value,
        etiquetas: iEtiq.value.split(",").map(e => e.trim()).filter(Boolean),
      }) });
      estado.textContent = "Guardado ✓";
      setTimeout(() => { estado.textContent = ""; }, 2500);
      await cargarClientes();
    } catch (err) { mostrarError(err); }
  });

  campos.append(lNombre, lNotas, lEtiq, guardar, estado);
  d.append(campos);

  if (c.conversacionId) {
    const verConv = el("button", "sutil", "Ver la conversación");
    verConv.addEventListener("click", () => {
      document.querySelector('[data-tab="conversaciones"]').click();
      setTimeout(() => abrirConversacion(c.conversacionId).catch(mostrarError), 100);
    });
    d.append(verConv);
  }
}

// ─── CONVERSACIONES ─────────────────────────────────────────────────────────
async function cargarConversaciones() {
  const convs = await api("/conversaciones");
  const cont = $("#lista-conversaciones");
  cont.replaceChildren();
  if (!convs.length) cont.append(el("p", "nota", "Sin conversaciones todavía."));
  for (const c of convs) {
    const item = el("div", "item");
    const fila = el("div", "fila");
    fila.append(el("h3", null, c.nombrePerfil || c.numero));
    if (c.huecos > 0) fila.append(el("span", "badge alerta", `${c.huecos} sin respuesta`));
    if (c.pausado) fila.append(el("span", "badge", "bot pausado"));
    item.append(fila, el("p", null, (c.ultimoMensaje || "").slice(0, 120)));
    item.addEventListener("click", () => abrirConversacion(c._id).catch(mostrarError));
    item.style.cursor = "pointer";
    cont.append(item);
  }
}

async function abrirConversacion(id) {
  const c = await api(`/conversaciones/${id}`);
  const d = $("#detalle-conversacion");
  d.replaceChildren();

  const cabecera = el("div", "fila");
  cabecera.append(el("h3", null, c.nombrePerfil ? `${c.nombrePerfil} — ${c.numero}` : c.numero));
  const btnPausa = el("button", "sutil", c.pausado ? "Devolver al bot" : "Atender yo");
  btnPausa.addEventListener("click", async () => {
    try { await api(`/conversaciones/${id}/pausa`, { method: "PUT", body: JSON.stringify({ pausado: !c.pausado }) }); await abrirConversacion(id); }
    catch (err) { mostrarError(err); }
  });
  cabecera.append(btnPausa);
  d.append(cabecera);

  // La ficha, junto al hilo: quien atiende necesita saber con quién habla sin
  // tener que cambiar de pestaña.
  if (c.cliente?.resumen || c.cliente?.notas) {
    const ficha = el("div", "ficha");
    ficha.append(el("h4", null, "Quién es"));
    ficha.append(el("div", null, [c.cliente.resumen, c.cliente.notas].filter(Boolean).join("\n\n")));
    d.append(ficha);
  }

  for (const m of c.mensajes) {
    const b = el("div", `burbuja ${m.rol}${m.sinRespuesta ? " sin-respuesta" : ""}${m.esAudio ? " audio" : ""}`, m.texto);
    if (m.esAudio) b.title = "Transcripción de una nota de voz — puede tener errores";
    d.append(b);
  }

  const caja = el("div", "responder");
  const input = el("input");
  input.placeholder = c.pausado ? "Escribí tu respuesta…" : "Pausá el bot para responder vos";
  input.disabled = !c.pausado;
  const enviar = el("button", null, "Enviar");
  enviar.disabled = !c.pausado;
  enviar.addEventListener("click", async () => {
    if (!input.value.trim()) return;
    try { await api(`/conversaciones/${id}/responder`, { method: "POST", body: JSON.stringify({ texto: input.value }) }); await abrirConversacion(id); }
    catch (err) { mostrarError(err); }
  });
  caja.append(input, enviar);
  d.append(caja);
}

// ─── HUECOS ─────────────────────────────────────────────────────────────────
async function cargarHuecos() {
  const huecos = await api("/huecos");
  const cont = $("#lista-huecos");
  cont.replaceChildren();
  if (!huecos.length) { cont.append(el("p", "nota", "Ninguno. El bot supo responder todo lo que le preguntaron.")); return; }

  for (const h of huecos) {
    const item = el("div", "item");
    item.append(el("h3", null, h.pregunta));
    item.append(el("p", null, `El bot respondió: ${h.respuestaBot}`));

    const caja = el("div", "responder");
    const input = el("input");
    input.placeholder = "La respuesta correcta — se guarda como conocimiento del bot";
    const guardar = el("button", null, "Enseñar");
    guardar.addEventListener("click", async () => {
      if (!input.value.trim()) return;
      try {
        // Se guarda la pregunta junto con la respuesta: sin la pregunta, un
        // dato suelto ("$150") no le dice nada a la IA la próxima vez.
        await api("/fragmentos", {
          method: "POST",
          body: JSON.stringify({ titulo: h.pregunta.slice(0, 80), texto: `Pregunta: ${h.pregunta}\nRespuesta: ${input.value.trim()}` }),
        });
        item.replaceChildren(el("p", "estado", "Guardado ✓ — el bot ya sabe esto."));
      } catch (err) { mostrarError(err); }
    });
    caja.append(input, guardar);
    item.append(caja);
    cont.append(item);
  }
}

// ─── ARRANQUE ───────────────────────────────────────────────────────────────
if (token) entrar();
