// wabot — API del panel de control. Todo lo que hay acá está detrás
// de requireAuth y filtrado por req.sesion.negocioId: ningún endpoint acepta
// un negocioId que venga del cliente, porque eso sería dejar que un negocio
// lea o edite la base de conocimiento de otro.
const { Negocio, Usuario, Documento, Fragmento, Producto, Pedido, Cliente, Conversacion } = require("../db/models");
const { verificarPassword, generarToken, requireAuth } = require("../services/auth");
const { asyncRoute, ErrorHttp, obtenerOFallar } = require("../services/httpHelpers");
const { fragmentar, armarContexto } = require("../services/baseConocimiento");
const { agregarMensaje } = require("../services/conversacion");
const { actualizarResumen } = require("../services/cliente");
const { transcribir, MAX_BYTES } = require("../services/audio");
const express = require("express");
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
    const permitidos = ["nombre", "descripcion", "instrucciones", "mensajeSinInfo", "numeroEscalamiento", "activo", "transcribirAudios"];
    const cambios = {};
    for (const campo of permitidos) {
      if (req.body[campo] !== undefined) cambios[campo] = req.body[campo];
    }
    // herramientas va aparte: es un objeto anidado, y un $set directo del body
    // dejaría entrar cualquier clave inventada al documento.
    if (req.body.herramientas) {
      cambios["herramientas.catalogo"] = !!req.body.herramientas.catalogo;
      cambios["herramientas.pedidos"] = !!req.body.herramientas.pedidos;
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

  // ─── TRANSCRIBIR ─────────────────────────────────────────────────────────
  // El dueño graba explicando su negocio y eso se convierte en conocimiento.
  // Para alguien que no quiere escribir, es la forma natural de cargar
  // información — y la más rápida: dos minutos hablando son varias pantallas
  // de texto.
  //
  // express.raw y no una librería de multipart: es un solo archivo binario,
  // no un formulario. Una dependencia más para esto no se justifica.
  app.post("/api/transcribir", auth, express.raw({ type: "audio/*", limit: MAX_BYTES }),
    asyncRoute(async (req, res) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        throw new ErrorHttp(400, "No llegó ningún audio");
      }
      const negocio = await Negocio.findById(req.sesion.negocioId).lean();
      let texto;
      try {
        texto = await transcribir(req.body, req.headers["content-type"] || "audio/ogg", negocio?.nombre || "");
      } catch (e) {
        throw new ErrorHttp(502, `No se pudo transcribir: ${e.message}`);
      }
      if (!texto) throw new ErrorHttp(422, "El audio no tiene voz reconocible");
      // Se devuelve para que el dueño lo REVISE antes de guardarlo. Guardar
      // una transcripción sin leerla sería meter los errores del modelo
      // directo en la base de conocimiento del bot, y de ahí salen a hablar
      // con clientes reales.
      res.json({ texto });
    }));

  // ─── CATÁLOGO ────────────────────────────────────────────────────────────
  // Los precios entran y salen en la unidad de la moneda (12.50) pero se
  // guardan en centavos enteros. La conversión vive acá y en un solo lugar:
  // si cada endpoint la hiciera por su cuenta, tarde o temprano uno redondea
  // distinto y un precio queda mal por un centavo.
  const aCentavos = (v) => Math.round(parseFloat(String(v).replace(",", ".")) * 100) || 0;
  const conPrecio = (p) => ({ ...p, precio: (p.precioCentavos / 100).toFixed(2) });

  app.get("/api/productos", auth, asyncRoute(async (req, res) => {
    const productos = await Producto.find({ negocioId: req.sesion.negocioId }).sort({ categoria: 1, nombre: 1 }).lean();
    res.json(productos.map(conPrecio));
  }));

  app.post("/api/productos", auth, asyncRoute(async (req, res) => {
    const nombre = String(req.body?.nombre || "").trim();
    if (!nombre) throw new ErrorHttp(400, "El producto necesita un nombre");
    const p = await Producto.create({
      negocioId: req.sesion.negocioId,
      nombre,
      descripcion: String(req.body?.descripcion || "").trim(),
      categoria: String(req.body?.categoria || "").trim(),
      precioCentavos: aCentavos(req.body?.precio),
      moneda: String(req.body?.moneda || "BOB").trim().toUpperCase().slice(0, 4),
    });
    res.status(201).json(conPrecio(p.toObject()));
  }));

  app.put("/api/productos/:id", auth, asyncRoute(async (req, res) => {
    const p = await obtenerOFallar(Producto, { _id: req.params.id, negocioId: req.sesion.negocioId }, "Producto no encontrado");
    if (req.body.nombre !== undefined) p.nombre = String(req.body.nombre).trim();
    if (req.body.descripcion !== undefined) p.descripcion = String(req.body.descripcion).trim();
    if (req.body.categoria !== undefined) p.categoria = String(req.body.categoria).trim();
    if (req.body.precio !== undefined) p.precioCentavos = aCentavos(req.body.precio);
    if (req.body.disponible !== undefined) p.disponible = !!req.body.disponible;
    await p.save();
    res.json(conPrecio(p.toObject()));
  }));

  app.delete("/api/productos/:id", auth, asyncRoute(async (req, res) => {
    const p = await obtenerOFallar(Producto, { _id: req.params.id, negocioId: req.sesion.negocioId }, "Producto no encontrado");
    await p.deleteOne();
    res.json({ ok: true });
  }));

  // Carga masiva pegando desde una planilla. Es como una pyme tiene su lista
  // de precios de verdad: en un Excel, no cargándola de a un producto por vez.
  app.post("/api/productos/importar", auth, asyncRoute(async (req, res) => {
    const texto = String(req.body?.texto || "").trim();
    if (!texto) throw new ErrorHttp(400, "No hay nada que importar");

    const filas = texto.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const nuevos = [];
    const ignoradas = [];
    for (const fila of filas) {
      // Tabulación (lo que sale al copiar de Excel), punto y coma o coma.
      const campos = fila.split(/\t|;|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(c => c.trim().replace(/^"|"$/g, ""));
      const [nombre, precio, categoria, descripcion] = campos;
      if (!nombre || campos.length < 2) { ignoradas.push(fila.slice(0, 40)); continue; }
      nuevos.push({
        negocioId: req.sesion.negocioId,
        nombre, categoria: categoria || "", descripcion: descripcion || "",
        precioCentavos: aCentavos(precio),
      });
    }
    if (!nuevos.length) throw new ErrorHttp(400, "Ninguna fila tenía el formato: nombre, precio, categoría, descripción");
    await Producto.insertMany(nuevos);
    res.status(201).json({ importados: nuevos.length, ignoradas });
  }));

  // ─── PEDIDOS ─────────────────────────────────────────────────────────────
  app.get("/api/pedidos", auth, asyncRoute(async (req, res) => {
    const filtro = { negocioId: req.sesion.negocioId };
    if (req.query.estado) filtro.estado = req.query.estado;
    const pedidos = await Pedido.find(filtro).sort({ creadoEn: -1 }).limit(200).lean();
    res.json(pedidos.map(p => ({ ...p, total: (p.totalCentavos / 100).toFixed(2) })));
  }));

  app.put("/api/pedidos/:id", auth, asyncRoute(async (req, res) => {
    const pedido = await obtenerOFallar(Pedido, { _id: req.params.id, negocioId: req.sesion.negocioId }, "Pedido no encontrado");
    const estados = ["nuevo", "confirmado", "entregado", "cancelado"];
    if (req.body.estado !== undefined) {
      if (!estados.includes(req.body.estado)) throw new ErrorHttp(400, `Estado inválido. Válidos: ${estados.join(", ")}`);
      pedido.estado = req.body.estado;
    }
    if (req.body.notas !== undefined) pedido.notas = String(req.body.notas);
    await pedido.save();
    res.json(pedido);
  }));

  // ─── CLIENTES ────────────────────────────────────────────────────────────
  app.get("/api/clientes", auth, asyncRoute(async (req, res) => {
    const filtro = { negocioId: req.sesion.negocioId };
    // Búsqueda por número o nombre. El dueño busca "el que preguntó por el
    // delivery", no un ObjectId.
    if (req.query.q) {
      const q = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filtro.$or = [{ numero: q }, { nombre: q }, { nombrePerfil: q }];
    }
    res.json(await Cliente.find(filtro).sort({ ultimoContacto: -1 }).limit(200).lean());
  }));

  app.get("/api/clientes/:id", auth, asyncRoute(async (req, res) => {
    const cliente = await obtenerOFallar(Cliente, { _id: req.params.id, negocioId: req.sesion.negocioId }, "Cliente no encontrado");
    const conversacion = await Conversacion.findOne({ clienteId: cliente._id, negocioId: req.sesion.negocioId }).lean();
    res.json({ ...cliente.toObject(), conversacionId: conversacion?._id || null });
  }));

  app.put("/api/clientes/:id", auth, asyncRoute(async (req, res) => {
    const cliente = await obtenerOFallar(Cliente, { _id: req.params.id, negocioId: req.sesion.negocioId }, "Cliente no encontrado");
    // nombre, notas y etiquetas son del dueño. "resumen" NO está en la lista:
    // lo escribe el modelo y se regenera solo, así que dejarlo editable sería
    // ofrecer un campo que se pisa a sí mismo cada ocho mensajes.
    if (req.body.nombre !== undefined) cliente.nombre = String(req.body.nombre).trim();
    if (req.body.notas !== undefined) cliente.notas = String(req.body.notas);
    if (Array.isArray(req.body.etiquetas)) {
      cliente.etiquetas = req.body.etiquetas.map(e => String(e).trim()).filter(Boolean).slice(0, 10);
    }
    await cliente.save();
    res.json(cliente);
  }));

  // Regenerar la ficha a mano, sin esperar a que se junten mensajes. Sirve
  // cuando el dueño acaba de tener una conversación larga y quiere que el bot
  // ya la tenga incorporada.
  app.post("/api/clientes/:id/resumen", auth, asyncRoute(async (req, res) => {
    const cliente = await obtenerOFallar(Cliente, { _id: req.params.id, negocioId: req.sesion.negocioId }, "Cliente no encontrado");
    const conversacion = await Conversacion.findOne({ clienteId: cliente._id, negocioId: req.sesion.negocioId });
    if (!conversacion?.mensajes?.length) throw new ErrorHttp(400, "Todavía no hay conversación de la cual armar una ficha");
    await actualizarResumen(cliente, conversacion.mensajes);
    res.json(await Cliente.findById(cliente._id).lean());
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
    const conversacion = await obtenerOFallar(Conversacion, { _id: req.params.id, negocioId: req.sesion.negocioId }, "Conversación no encontrada");
    const cliente = conversacion.clienteId
      ? await Cliente.findOne({ _id: conversacion.clienteId, negocioId: req.sesion.negocioId }).lean()
      : null;
    res.json({ ...conversacion.toObject(), cliente });
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
