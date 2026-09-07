// wabot — Reglas de los archivos que se mandan por WhatsApp.
//
// Existe como módulo aparte porque el que descarga la foto no es un navegador
// sino Meta, y Meta es mucho más exigente: si el formato no está en su lista
// el mensaje falla del lado del cliente, sin error visible en el panel. Todo
// lo que decide "esto se puede mandar o no" vive acá y en un solo lugar.
const { CONFIG } = require("../config");

// Meta acepta JPEG y PNG para mensajes de imagen. WEBP, GIF y SVG los muestra
// cualquier navegador, así que si no se valida en la carga el dueño sube un
// WEBP, lo ve perfecto en el panel, y el cliente no recibe nada. Se rechaza al
// subir, que es el único momento en que hay alguien mirando para corregirlo.
const MIMES_IMAGEN = ["image/jpeg", "image/png"];

// El límite de Meta para imágenes es de 5 MB.
const MAX_IMAGEN = 5 * 1024 * 1024;

const EXT = { "image/jpeg": "jpg", "image/png": "png" };

function extDe(mime) {
  return EXT[String(mime || "").toLowerCase()] || "jpg";
}

// Normaliza lo que manda el navegador: "image/jpeg; charset=binary" y
// "IMAGE/JPEG" son el mismo tipo, y compararlos crudos rechaza cargas válidas.
function mimeLimpio(cabecera) {
  return String(cabecera || "").split(";")[0].trim().toLowerCase();
}

function imagenValida(mime) {
  return MIMES_IMAGEN.includes(mimeLimpio(mime));
}

// Dentro del panel alcanza con la ruta: el navegador ya está en el dominio.
function rutaFoto(producto) {
  if (!producto?.fotoToken) return "";
  return `${CONFIG.BASE_PATH}/foto/${producto.fotoToken}.${extDe(producto.fotoMime)}`;
}

// Para Meta hace falta la URL absoluta, porque la descarga desde sus
// servidores. Sin APP_URL no hay nada que darle: devuelve "" y quien llama
// tiene que tratarlo como "no se puede mandar", no como una URL rota.
function urlFoto(producto) {
  const ruta = rutaFoto(producto);
  return ruta && CONFIG.APP_URL ? `${CONFIG.APP_URL}${ruta}` : "";
}

module.exports = { MIMES_IMAGEN, MAX_IMAGEN, extDe, mimeLimpio, imagenValida, rutaFoto, urlFoto };
