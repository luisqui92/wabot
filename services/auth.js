// wabot — Sesiones del panel: hash de contraseñas con bcrypt y token
// firmado con HMAC. No es un JWT de libreria a proposito: el unico consumidor
// es este mismo servidor, y un token opaco firmado evita arrastrar una
// dependencia mas para algo que son 20 lineas.
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { CONFIG } = require("../config");

const COSTO_BCRYPT = 12;
const DURACION_SESION_MS = 8 * 60 * 60 * 1000;

function hashPassword(pwd) {
  return bcrypt.hash(pwd, COSTO_BCRYPT);
}

function verificarPassword(pwd, hashGuardado) {
  if (!hashGuardado) return Promise.resolve(false);
  return bcrypt.compare(pwd, hashGuardado);
}

function firmar(b64) {
  return crypto.createHmac("sha256", CONFIG.JWT_SECRET).update(b64).digest("hex");
}

function generarToken({ usuarioId, negocioId, rol }, duracionMs = DURACION_SESION_MS) {
  const payload = { usuarioId, negocioId, rol, iat: Date.now(), exp: Date.now() + duracionMs };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${b64}.${firmar(b64)}`;
}

function verificarToken(token) {
  if (!token) return null;
  try {
    const [b64, sig] = token.split(".");
    if (!b64 || !sig) return null;
    const esperada = firmar(b64);
    // Comparacion en tiempo constante: con !== un atacante podria medir
    // cuantos bytes iniciales coinciden por la diferencia de tiempo de
    // respuesta y reconstruir la firma byte a byte.
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(esperada, "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString());
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// Middleware. Deja en req.sesion el payload verificado; toda ruta del panel
// filtra por req.sesion.negocioId y nunca por un id que venga del body.
function requireAuth(rolesPermitidos = ["admin"]) {
  return (req, res, next) => {
    const token = req.headers.authorization?.replace("Bearer ", "") || req.query.token;
    const payload = verificarToken(token);
    if (!payload) return res.status(401).json({ error: "No autorizado — iniciá sesión" });
    if (!rolesPermitidos.includes(payload.rol)) return res.status(403).json({ error: "Sin permiso para esta acción" });
    req.sesion = payload;
    next();
  };
}

module.exports = { hashPassword, verificarPassword, generarToken, verificarToken, requireAuth };
