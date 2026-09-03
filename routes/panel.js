// wabot — API del panel de control. Todo lo que hay acá está detrás
// de requireAuth y filtrado por req.sesion.negocioId: ningún endpoint acepta
// un negocioId que venga del cliente, porque eso sería dejar que un negocio
// lea o edite la base de conocimiento de otro.
const { Negocio, Usuario, Documento, Fragmento, Conversacion } = require("../db/models");
const { verificarPassword, generarToken, requireAuth } = require("../services/auth");
const { asyncRoute, ErrorHttp, obtenerOFallar } = require("../services/httpHelpers");
const { fragmentar, armarContexto } = require("../services/baseConocimiento");
const { agregarMensaje } = require("../services/conversacion");
const { enviarTexto } = require("../services/metaWhatsapp");

const auth = requireAuth(["admin"]);

module.exports = function (app) {
  // ─── SESIÓN ──────────────────────────────────────────────────────────────
  app.post("/api/login", asyncRoute(async (req, res) => {
    const { email, password } = req.body || {};
    const usuario = await Usuario.findOne({ email: String(email || "").toLowerCase().trim() });
    // Mismo mensaje para usuario inexistente y contraseña incorrecta: si se
    // distinguen, cualquiera puede averiguar qué emails están dados de alta.
    const ok = usuario && await verificarPassword(String(password || ""), usuario.passwordHash);
    if (!ok) throw new ErrorHttp(401, "Email o contraseña incorrectos");

    res.json({
      token: generarToken({ usuarioId: String(usuario._id), negocioId: String(usuario.negocioId), rol: usuario.rol }),
      nombre: usuario.nombre || usuario.email,
    });
  }));

  // ─── NEGOCIO (la personalidad del bot) ───────────────────────────────────
  app.get("/api/negocio", auth, asyncRoute(async (req, res) => {
    const negocio = await Negocio.findById(req.sesion.negocioId).lean();
    if (!negocio) throw new ErrorHttp(404, "Negocio no encontrado");
    const contexto = await armarContexto(negocio._id);
    res.json({
      ...negocio,
      // Se devuelve el estado real de la base para que el panel pueda avisar
      // cuando hay fragmentos cargados que el bot no está viendo.
      base: { total: contexto.totalFragmentos, usados: contexto.usados, recortados: contexto.recortados },
    });
  }));

  app.put("/api/negocio", auth, asyncRoute(async (req, res) => {
    const permitidos = ["nombre", "descripcion", "instrucciones", "mensajeSinInfo", "numeroEscalamiento", "activo"];
    const cambios = {};
    for (const campo of permitidos) {
      if (req.body[campo] !== undefined) cambios[campo] = req.body[campo];
    }
    // phoneNumberId no está en la lista a propósito: cambiarlo desde el panel
    // desconecta el bot de su número sin que nadie se entere hasta que un
    // cliente escriba y no le conteste nadie. Se cambia por script.
    const negocio = await Negocio.findByIdAndUpdate(req.sesion.negocioId, cambios, { new: true });
    res.json(negocio);
  }));

  // ─── DOCUMENTOS (lo que sube el dueño) ───────────────────────────────────
  app.get("/api/documentos", auth, asyncRoute(async (req, res) => {
    const docs = await Documento.find({ negocioId: req.sesion.negocioId })
      .select("-textoOriginal") // el texto completo puede ser enorme; se pide de a uno
      .sort({ creadoEn: -1 })
      .lean();
    const conteos = await Fragmento.aggregate([
      { $match: { documentoId: { $in: docs.map(d => d._id) } } },
      { $group: { _id: "$documentoId", n: { $sum: 1 } } },
    ]);
    const porDoc = Object.fromEntries(conteos.map(c => [String(c._id), c.n]));
    res.json(docs.map(d => ({ ...d, fragmentos: porDoc[String(d._id)] || 0 })));
  }));

  app.post("/api/documentos", auth, asyncRoute(async (req, res) => {
    const nombre = String(req.body?.nombre || "").trim();
    const texto = String(req.body?.texto || "").trim();
    if (!nombre) throw new ErrorHttp(400, "Falta el nombre del documento");
    if (!texto) throw new ErrorHttp(400, "El documento está vacío");

    const doc = await Documento.create({ negocioId: req.sesion.negocioId, nombre, textoOriginal: texto });
    const piezas = fragmentar(texto);
    await Fragmento.insertMany(piezas.map(t => ({
      negocioId: req.sesion.negocioId,
      documentoId: doc._id,
      texto: t,
      origen: "documento",
    })));
    res.status(201).json({ ...doc.toObject(), fragmentos: piezas.length });
  }));

  app.delete("/api/documentos/:id", auth, asyncRoute(async (req, res) => {
    const doc = await obtenerOFallar(Documento, { _id: req.params.id, negocioId: req.sesion.negocioId }, "Documento no encontrado");
    // Los fragmentos primero: si se borra el documento y falla esto, quedan
    // fragmentos huérfanos que el bot sigue usando y nadie puede ver ni
    // borrar desde el panel.
    await Fragmento.deleteMany({ documentoId: doc._id, negocioId: req.sesion.negocioId });
    await doc.deleteOne();
    res.json({ ok: true });
  }));

  // ─── FRAGMENTOS (lo que el bot realmente lee) ────────────────────────────
  app.get("/api/fragmentos", auth, asyncRoute(async (req, res) => {
    const filtro = { negocioId: req.sesion.negocioId };
    if (req.query.documentoId) filtro.documentoId = req.query.documentoId;
    if (req.query.origen) filtro.origen = req.query.origen;
    res.json(await Fragmento.find(filtro).sort({ creadoEn: -1 }).limit(500).lean());
  }));

  app.post("/api/fragmentos", auth, asyncRoute(async (req, res) => {
    const texto = String(req.body?.texto || "").trim();
    if (!texto) throw new ErrorHttp(400, "El fragmento está vacío");
    res.status(201).json(await Fragmento.create({
      negocioId: req.sesion.negocioId,
      titulo: String(req.body?.titulo || "").trim(),
      texto,
      // Este endpoint es el que usa el panel para corregir al bot después de
      // verlo fallar en una conversación real: por eso el origen por defecto
      // es "correccion" y no "documento".
      origen: req.body?.origen === "documento" ? "documento" : "correccion",
    }));
  }));

  app.put("/api/fragmentos/:id", auth, asyncRoute(async (req, res) => {
    const f = await obtenerOFallar(Fragmento, { _id: req.params.id, negocioId: req.sesion.negocioId }, "Fragmento no encontrado");
    if (req.body.texto !== undefined) f.texto = String(req.body.texto).trim();
    if (req.body.titulo !== undefined) f.titulo = String(req.body.titulo).trim();
    if (req.body.activo !== undefined) f.activo = !!req.body.activo;
    await f.save();
    res.json(f);
  }));

  app.delete("/api/fragmentos/:id", auth, asyncRoute(async (req, res) => {
    const f = await obtenerOFallar(Fragmento, { _id: req.params.id, negocioId: req.sesion.negocioId }, "Fragmento no encontrado");
    await f.deleteOne();
    res.json({ ok: true });
  }));

  // ─── CONVERSACIONES ──────────────────────────────────────────────────────
  app.get("/api/conversaciones", auth, asyncRoute(async (req, res) => {
    const convs = await Conversacion.find({ negocioId: req.sesion.negocioId })
      .sort({ actualizadoEn: -1 })
      .limit(100)
      .lean();
    res.json(convs.map(c => ({
      _id: c._id,
      numero: c.numero,
      nombrePerfil: c.nombrePerfil,
      pausado: c.pausado,
      actualizadoEn: c.actualizadoEn,
      ultimoMensaje: c.mensajes[c.mensajes.length - 1]?.texto || "",
      // Cuántas veces el bot no supo responder en esta charla: es el número
      // que le dice al dueño dónde le falta cargar información.
      huecos: c.mensajes.filter(m => m.sinRespuesta).length,
    })));
  }));

  app.get("/api/conversaciones/:id", auth, asyncRoute(async (req, res) => {
    res.json(await obtenerOFallar(Conversacion, { _id: req.params.id, negocioId: req.sesion.negocioId }, "Conversación no encontrada"));
  }));

  // Tomar o soltar la conversación. Con pausado=true el bot deja de
  // contestar en ese chat y responde una persona desde acá.
  app.put("/api/conversaciones/:id/pausa", auth, asyncRoute(async (req, res) => {
    const c = await obtenerOFallar(Conversacion, { _id: req.params.id, negocioId: req.sesion.negocioId }, "Conversación no encontrada");
    c.pausado = !!req.body?.pausado;
    await c.save();
    res.json({ pausado: c.pausado });
  }));

  app.post("/api/conversaciones/:id/responder", auth, asyncRoute(async (req, res) => {
    const texto = String(req.body?.texto || "").trim();
    if (!texto) throw new ErrorHttp(400, "El mensaje está vacío");
    const c = await obtenerOFallar(Conversacion, { _id: req.params.id, negocioId: req.sesion.negocioId }, "Conversación no encontrada");
    const negocio = await Negocio.findById(req.sesion.negocioId);

    // Se manda primero y se guarda después: si guardáramos primero y el
    // envío fallara, el panel mostraría un mensaje que el cliente nunca
    // recibió — el error más confuso posible para quien atiende.
    await enviarTexto(negocio.phoneNumberId, c.numero, texto);
    await agregarMensaje(c, { rol: "humano", texto });
    res.json({ ok: true });
  }));

  // ─── HUECOS DE CONOCIMIENTO ──────────────────────────────────────────────
  // Las preguntas reales que el bot no supo contestar. Es la pantalla que
  // convierte al panel en un ciclo de mejora en vez de un formulario: el
  // dueño ve qué le falta cargar, en las palabras de sus propios clientes.
  app.get("/api/huecos", auth, asyncRoute(async (req, res) => {
    const convs = await Conversacion.find({ negocioId: req.sesion.negocioId, "mensajes.sinRespuesta": true })
      .sort({ actualizadoEn: -1 })
      .limit(100)
      .lean();

    const huecos = [];
    for (const c of convs) {
      c.mensajes.forEach((m, i) => {
        if (!m.sinRespuesta) return;
        // La pregunta que lo causó es el mensaje del cliente inmediatamente
        // anterior a la respuesta fallida del bot.
        const previo = c.mensajes[i - 1];
        if (previo?.rol !== "cliente") return;
        huecos.push({
          conversacionId: c._id,
          numero: c.numero,
          pregunta: previo.texto,
          respuestaBot: m.texto,
          fecha: m.fecha,
        });
      });
    }
    huecos.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    res.json(huecos.slice(0, 200));
  }));
};
