// wabot — helpers compartidos de rutas, para no repetir el mismo
// try/catch y el mismo "buscalo y verifica que sea del negocio" en cada
// endpoint nuevo.
const { log } = require("../config");

class ErrorHttp extends Error {
  constructor(status, publicMessage) {
    super(publicMessage);
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

// Envuelve un handler async: si tira ErrorHttp responde con ese status y
// mensaje; cualquier otra cosa se loguea y sale como 500 generico (nunca se
// filtra el mensaje de error interno al cliente).
function asyncRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      if (e instanceof ErrorHttp) return res.status(e.status).json({ error: e.publicMessage });
      log.error(`[${req.method} ${req.path}]`, e.stack || e.message);
      res.status(500).json({ error: "Error interno" });
    }
  };
}

// Un campo Buffer leído con .lean() no vuelve como Buffer sino como el
// Binary del driver de MongoDB, y res.send() de un Binary no manda los bytes:
// lo serializa como JSON y el navegador recibe una cadena base64 entre
// comillas. El <img> queda roto sin ningún error en consola ni en el log, que
// es la peor forma de fallar. Esto normaliza cualquiera de las dos formas.
function aBuffer(valor) {
  if (!valor) return null;
  if (Buffer.isBuffer(valor)) return valor;
  if (valor.buffer) return Buffer.from(valor.buffer);          // Binary del driver
  if (Array.isArray(valor.data)) return Buffer.from(valor.data); // Buffer ya serializado
  return null;
}

// Busca un documento del negocio, o 404. El filtro SIEMPRE debe incluir
// negocioId: asi ningun endpoint nuevo se olvida de aislar por dueño y
// termina dejando que un negocio lea los datos de otro.
async function obtenerOFallar(Modelo, filtro, mensajeNoEncontrado = "No encontrado") {
  if (!filtro.negocioId) throw new Error("obtenerOFallar: el filtro debe incluir negocioId");
  const doc = await Modelo.findOne(filtro);
  if (!doc) throw new ErrorHttp(404, mensajeNoEncontrado);
  return doc;
}

module.exports = { asyncRoute, ErrorHttp, obtenerOFallar, aBuffer };
