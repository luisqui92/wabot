// wabot — Turnos disponibles.
//
// Cruza tres cosas: el horario de atención del negocio, lo que ya está ocupado
// en su Google Calendar, y las reglas de anticipación. El resultado es la
// lista de horarios que se le pueden ofrecer a un cliente.
//
// TODO acá se calcula en UTC y se muestra en la zona del negocio. Guardar u
// operar en hora local es cómo se terminan teniendo turnos con una hora de
// diferencia el día que algo cambia.
const { log } = require("../config");
const { ocupados } = require("./googleCalendar");
const { Reserva } = require("../db/models");

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

// Cuánto está corrida una zona respecto de UTC en un instante dado. Se calcula
// con Intl y no con un offset fijo porque un offset fijo se rompe con el
// horario de verano — Bolivia no lo tiene, pero un cliente en Chile sí.
function offsetMinutos(instante, zona) {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zona, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(instante).map(p => [p.type, p.value])
  );
  const comoUtc = Date.UTC(
    +partes.year, +partes.month - 1, +partes.day,
    partes.hour === "24" ? 0 : +partes.hour, +partes.minute, +partes.second
  );
  return (comoUtc - instante.getTime()) / 60000;
}

// "2026-09-10" + "09:00" en la zona del negocio -> el instante UTC exacto.
function aUtc(fechaISO, hora, zona) {
  const [a, m, d] = fechaISO.split("-").map(Number);
  const [h, min] = hora.split(":").map(Number);
  const tentativo = Date.UTC(a, m - 1, d, h, min);
  // Dos pasadas: el offset se mide sobre el instante tentativo, que puede caer
  // del lado equivocado de un cambio de horario. La segunda pasada corrige.
  const primero = tentativo - offsetMinutos(new Date(tentativo), zona) * 60000;
  return new Date(tentativo - offsetMinutos(new Date(primero), zona) * 60000);
}

// Un instante UTC -> {fecha: "2026-09-10", hora: "09:00", diaSemana: 4} en la
// zona del negocio.
function enZona(instante, zona) {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zona, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short",
    }).formatToParts(instante).map(p => [p.type, p.value])
  );
  const hora = partes.hour === "24" ? "00" : partes.hour;
  return {
    fecha: `${partes.year}-${partes.month}-${partes.day}`,
    hora: `${hora}:${partes.minute}`,
    diaSemana: new Date(`${partes.year}-${partes.month}-${partes.day}T12:00:00Z`).getUTCDay(),
  };
}

function seSolapan(aInicio, aFin, bInicio, bFin) {
  // Estricto en los extremos: un turno que TERMINA justo cuando otro EMPIEZA
  // no se solapa. Con >= acá, una agenda de turnos consecutivos no ofrecería
  // ninguno.
  return aInicio < bFin && bInicio < aFin;
}

// Los turnos libres de UN día, en la zona del negocio.
async function turnosDelDia(negocio, fechaISO, bloquesOcupados) {
  const zona = negocio.zonaHoraria || "America/La_Paz";
  const duracion = negocio.duracionTurnoMinutos || 60;
  const paso = negocio.pasoTurnoMinutos || duracion;

  const [a, m, d] = fechaISO.split("-").map(Number);
  const diaSemana = new Date(Date.UTC(a, m - 1, d, 12)).getUTCDay();

  const franjas = (negocio.horarioAtencion || []).filter(h => h.diaSemana === diaSemana);
  if (!franjas.length) return [];

  const minimo = new Date(Date.now() + (negocio.anticipacionMinimaHoras ?? 2) * 3600000);
  const libres = [];

  for (const franja of franjas) {
    const abre = aUtc(fechaISO, franja.horaInicio, zona);
    const cierra = aUtc(fechaISO, franja.horaFin, zona);

    for (let t = abre.getTime(); t + duracion * 60000 <= cierra.getTime(); t += paso * 60000) {
      const inicio = new Date(t);
      const fin = new Date(t + duracion * 60000);

      if (inicio < minimo) continue; // ya pasó, o falta muy poco
      if (bloquesOcupados.some(o => seSolapan(inicio, fin, o.inicio, o.fin))) continue;

      libres.push({ inicio, fin, hora: enZona(inicio, zona).hora });
    }
  }
  return libres;
}

// Los turnos libres de los próximos N días. Una sola consulta a Google para
// todo el rango: preguntar día por día serían treinta llamadas para armar una
// respuesta que el cliente espera en segundos.
async function disponibilidad(negocio, { desdeISO = null, dias = 7 } = {}) {
  if (!negocio.googleCalendarId) throw new Error("Este negocio no tiene calendario configurado");

  const zona = negocio.zonaHoraria || "America/La_Paz";
  const hoy = enZona(new Date(), zona).fecha;
  const inicio = desdeISO && desdeISO >= hoy ? desdeISO : hoy;

  const [a, m, d] = inicio.split("-").map(Number);
  const desde = aUtc(inicio, "00:00", zona);
  const hasta = new Date(Date.UTC(a, m - 1, d + dias, 23, 59));

  const bloques = await ocupados(negocio.googleCalendarId, desde, hasta);

  const porDia = [];
  for (let i = 0; i < dias; i++) {
    const fecha = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(Date.UTC(a, m - 1, d + i)));
    const turnos = await turnosDelDia(negocio, fecha, bloques);
    if (turnos.length) {
      porDia.push({ fecha, diaNombre: DIAS[new Date(Date.UTC(a, m - 1, d + i, 12)).getUTCDay()], turnos });
    }
  }
  return porDia;
}

// Reserva un turno. Vuelve a comprobar la disponibilidad contra Google en el
// momento: entre que el bot ofreció el horario y el cliente lo aceptó pueden
// pasar minutos, y en el medio el dueño pudo agendar otra cosa a mano.
async function reservar(negocio, { fechaISO, hora, nombre, motivo, numero, clienteId }) {
  const zona = negocio.zonaHoraria || "America/La_Paz";
  const inicio = aUtc(fechaISO, hora, zona);
  const fin = new Date(inicio.getTime() + (negocio.duracionTurnoMinutos || 60) * 60000);

  if (inicio < new Date(Date.now() + (negocio.anticipacionMinimaHoras ?? 2) * 3600000)) {
    return { ok: false, motivo: "ese horario ya pasó o es demasiado pronto" };
  }

  const franjas = (negocio.horarioAtencion || []).filter(h => h.diaSemana === enZona(inicio, zona).diaSemana);
  const dentroDelHorario = franjas.some(f =>
    inicio >= aUtc(fechaISO, f.horaInicio, zona) && fin <= aUtc(fechaISO, f.horaFin, zona));
  if (!dentroDelHorario) return { ok: false, motivo: "ese horario está fuera del horario de atención" };

  const bloques = await ocupados(negocio.googleCalendarId, inicio, fin);
  if (bloques.some(o => seSolapan(inicio, fin, o.inicio, o.fin))) {
    return { ok: false, motivo: "ese horario se acaba de ocupar" };
  }

  const { crearEvento } = require("./googleCalendar");
  const eventoGoogleId = await crearEvento(negocio.googleCalendarId, {
    inicio, fin, zonaHoraria: zona,
    titulo: `${nombre || numero}${motivo ? ` — ${motivo}` : ""}`,
    descripcion: `Reservado por WhatsApp desde ${numero}.${motivo ? `\n\nMotivo: ${motivo}` : ""}`,
  });

  const reserva = await Reserva.create({
    negocioId: negocio._id, clienteId, numero, inicio, fin,
    nombre: nombre || "", motivo: motivo || "", eventoGoogleId,
  });

  log.info(`[AGENDA] ${numero} reservó ${fechaISO} ${hora} (${zona})`);
  return { ok: true, reserva, inicio, fin };
}

async function cancelar(negocio, reserva) {
  if (reserva.eventoGoogleId && negocio.googleCalendarId) {
    const { borrarEvento } = require("./googleCalendar");
    await borrarEvento(negocio.googleCalendarId, reserva.eventoGoogleId);
  }
  reserva.estado = "cancelada";
  await reserva.save();
  log.info(`[AGENDA] ${reserva.numero} canceló su turno`);
}

module.exports = { disponibilidad, turnosDelDia, reservar, cancelar, enZona, aUtc, offsetMinutos, DIAS };
