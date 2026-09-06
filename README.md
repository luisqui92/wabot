# wabot

Bot de WhatsApp con IA sobre la **API oficial de Meta (Cloud API)**, con un panel
de control donde el dueño del negocio carga la información y corrige al bot
cuando se equivoca.

No usa Baileys ni ningún cliente no oficial: no hay QR que escanear ni sesión
que se caiga. La autenticación es un token de Meta.

## Cómo funciona

```
Cliente por WhatsApp
        │
        ▼
POST /webhook/whatsapp ──► verifica la firma HMAC de Meta
        │
        ▼
services/conversacion.js ──► guarda el mensaje, decide si el bot contesta
        │
        ▼
services/asistenteIA.js  ──► arma el prompt con la base de conocimiento
        │                     y responde, o marca "no sé"
        ▼
services/metaWhatsapp.js ──► manda la respuesta por la Graph API
```

Y el ciclo de mejora, que es el punto del panel:

```
El bot no supo responder  ─►  aparece en "Huecos"  ─►  el dueño escribe la
respuesta correcta  ─►  se guarda como fragmento  ─►  el bot ya lo sabe
```

## La regla que define al bot

**El bot responde únicamente con lo que está cargado en la base de
conocimiento.** Si la respuesta no está, dice que no la tiene y (si se
configuró) avisa a una persona.

Esto es a propósito y no es negociable: un bot de atención al cliente que
improvisa precios, horarios o políticas deja al negocio atado a lo que dijo.
Ver `services/asistenteIA.js`.

## Puesta en marcha

```bash
npm install
cp .env.example .env      # y completar
node scripts/crear_usuario.js "Mi Negocio" <phoneNumberId> mail@ejemplo.com <password>
npm start
```

El panel queda en `http://localhost:3000`.

### En producción, con su propio subdominio

> **Para levantarlo desde cero en una VM nueva, seguí
> [`DESPLIEGUE.md`](DESPLIEGUE.md)** — VM, swap, MongoDB, nginx, HTTPS y Meta,
> paso a paso y con una comprobación al final de cada uno. Lo de acá abajo es
> solo la parte de dominio y proxy.

Es la forma recomendada y la que usa el despliegue actual
(`wabot.chatgo.ia.bo`). `BASE_PATH` queda vacío: la app vive en la raíz de su
dominio y no hay ningún prefijo que alinear.

```bash
APP_URL=https://wabot.chatgo.ia.bo
BASE_PATH=
```

**DNS** — un registro `A` apuntando al servidor donde corre el proceso:

```
wabot.chatgo.ia.bo.   A   <IP del servidor>
```

**nginx** — un `server` propio, sin prefijos:

```nginx
server {
    server_name wabot.chatgo.ia.bo;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

**TLS** — Meta exige HTTPS con certificado válido en la Callback URL; un
autofirmado no le sirve:

```bash
certbot --nginx -d wabot.chatgo.ia.bo
```

> El `X-Forwarded-Proto` no es decorativo: la app corre con
> `app.set("trust proxy", 1)`, y sin esa cabecera ve todo el tráfico como si
> viniera de 127.0.0.1.

#### Por qué un subdominio y no `api.chatgo.ia.bo/wabot`

Las dos formas funcionan, pero el subdominio **aísla el origen**. Mientras el
panel comparta origen con otra API, cualquier JavaScript servido desde ese
dominio puede leer el token de sesión del panel en `sessionStorage`. Un
subdominio propio cierra eso, y de paso no hay prefijos que mantener alineados
entre nginx, el HTML y las llamadas a la API.

### Alternativa: colgado de un prefijo (`BASE_PATH`)

Si en algún momento tiene que compartir dominio —por ejemplo
`https://api.chatgo.ia.bo/wabot`— hay que decírselo:

```bash
APP_URL=https://api.chatgo.ia.bo
BASE_PATH=/wabot
```

Con eso todo (panel, assets, API y webhook) se monta bajo `/wabot` y el panel
resuelve sus rutas contra ese prefijo. Acepta `wabot`, `/wabot`, `wabot/` o
`/wabot/`: se normaliza solo.

```nginx
location /wabot/ {
    proxy_pass         http://127.0.0.1:3000;   # sin barra final: no recorta
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
}
```

> La barra final en `proxy_pass` es la diferencia entre que funcione y que no:
> con `http://127.0.0.1:3000/` nginx recorta `/wabot` y la app —que lo está
> esperando— responde 404 a todo.

### Configurar el webhook en Meta

En el dashboard de Meta → tu app → WhatsApp → **Configuration**:

| Campo | Valor |
|---|---|
| Callback URL | `https://wabot.chatgo.ia.bo/webhook/whatsapp` |
| Verify token | el mismo string que pusiste en `WHATSAPP_VERIFY_TOKEN` |
| Webhook fields | suscribir **`messages`** |

La URL tiene que ser HTTPS y pública — Meta no acepta `localhost`. Para probar
en local, un túnel (ngrok o similar) alcanza.

`META_APP_SECRET` sale de Meta → tu app → Settings → Basic → App Secret. Si no
lo ponés, el servidor arranca igual pero **no verifica los webhooks**: cualquiera
que descubra la URL puede inyectar mensajes falsos, envenenar el historial de
una conversación y quemar tu cuota de la API de IA. Ponelo.

## Variables de entorno

Están todas documentadas en [`.env.example`](.env.example). Obligatorias para
arrancar: `MONGODB_URI` y `JWT_SECRET`. Al levantar, el log imprime la Callback
URL ya armada con el prefijo — copiala de ahí en vez de escribirla a mano.

## Estructura

```
config/index.js            CONFIG, logger, validación al arrancar
db/models.js               Negocio, Usuario, Documento, Fragmento, Producto,
                           Pedido, Pago, Reserva, Cliente, Conversacion
services/
  metaWhatsapp.js          envío por la Graph API, botones/listas, firma
  asistenteIA.js           el prompt y la llamada al modelo
  baseConocimiento.js      fragmentado y armado del contexto
  conversacion.js          orquestación de un mensaje entrante
  cliente.js               memoria: quién es cada persona y su ficha
  audio.js                 notas de voz: descarga de Meta y transcripción
  comprobante.js           lee y verifica comprobantes de pago
  importarChat.js          lee un export de WhatsApp: conocimiento + voz
  googleCalendar.js        cuenta de servicio y REST de Calendar
  agenda.js                turnos: horario x calendario x anticipación
  herramientas.js          lo que el bot PUEDE HACER — el único archivo a
                           tocar para agregar una acción nueva
  auth.js                  bcrypt + token firmado para el panel
  httpHelpers.js           asyncRoute, ErrorHttp, aislamiento por negocio
routes/
  webhookWhatsapp.js       webhook de Meta (verificación + mensajes)
  panel.js                 API del panel
public/                    el panel (sin framework, sin build)
  index.html               barra lateral + una sección por pantalla
  css/panel.css            tema claro con acento verde
  js/panel.js              una función cargarX() por pantalla
scripts/crear_usuario.js   alta del negocio y del primer usuario
scripts/cambiar_numero.js  corrige el phoneNumberId de Meta de un negocio
scripts/respaldo.js        copia diaria cifrada, verificada restaurándola
scripts/restaurar.js       restaura un respaldo
```

## Botones

El bot puede ofrecer opciones para tocar en vez de escribir. Lo decide el
modelo, con una regla estricta: **solo cuando la elección es un conjunto
cerrado** —horarios libres, confirmar o cancelar— nunca como menú de "¿en qué
te ayudo?". Un bot que contesta todo con botones se siente un contestador
telefónico, que es lo contrario de lo que se busca.

El modelo solo dice qué opciones hay; si van como botones (hasta 3) o como
lista (hasta 10), y los recortes de longitud que exige Meta, los resuelve
`services/metaWhatsapp.js`. La respuesta siempre tiene sentido sin los
botones, porque muchos clientes escriben igual.

## Cobros

El bot manda el QR con el monto exacto, recibe la captura del comprobante, la
lee y la compara — ver [`PAGOS.md`](PAGOS.md). **Nunca marca un pedido como
pagado**: una captura se falsifica en dos minutos, así que el bot extrae y
avisa, y aceptar es de una persona. Detecta pagos de menos, de más, y el
fraude más común, que es reenviar el mismo comprobante.

## Agenda

El bot consulta horarios libres, agenda y cancela contra el Google Calendar del
negocio — ver [`AGENDA.md`](AGENDA.md). **Google es la fuente de verdad de la
disponibilidad**: el dueño también agenda a mano desde su celular, y si no
miráramos su calendario ofreceríamos horarios ya ocupados.

## Que no suene a ChatGPT

Dos piezas, y las dos importan:

**Las reglas.** El prompt prohíbe explícitamente lo que delata a un bot:
listas con viñetas, negritas, "¡Claro! Con gusto te ayudo", repetir la
pregunta antes de contestarla, cerrar cada mensaje ofreciendo más ayuda, y
responder de más. Se permite escribir suelto —sin mayúscula inicial, sin punto
final— porque así escribe la gente.

**La voz del negocio.** Desde *Conocimiento* se importa el export de WhatsApp
del propio negocio (un botón en la app: Exportar chat → Sin archivos). De ahí
salen dos cosas: lo que ya contestó mil veces, y **cómo lo dice**. El estilo y
tres mensajes textuales suyos entran al prompt, así el bot suena como él.

Lo importado **no se guarda solo**: se muestra para revisar, y lo que puede
haber cambiado —precios, promos, plazos— viene destildado. Importar un precio
viejo como si fuera actual hace que el bot cotice mal a un cliente real.

## Notas de voz

Buena parte de WhatsApp acá son audios. El bot los baja de Meta y los
transcribe, y de ahí siguen el mismo camino que un mensaje escrito. La
transcripción se sesga con los nombres del catálogo del negocio: sin eso,
"quiero dos salteñas" puede volver como algo que después no matchea ningún
producto.

Y para el otro lado: desde **Conocimiento** el dueño puede dictar en vez de
escribir. La transcripción se pega en el campo para que la revise — no se
guarda sola, porque los errores del modelo terminarían siendo lo que el bot le
dice a un cliente.

Se puede apagar por negocio: se paga por minuto.

## Acciones

El bot no solo responde: consulta el catálogo y anota pedidos. Las acciones se
declaran en un solo archivo (`services/herramientas.js`) y el orquestador no
sabe cuáles existen — pide la lista, se la pasa al modelo y ejecuta la que
pida. Agregar `crear_reserva` mañana es sumar una entrada ahí y nada más.

Cada negocio enciende las suyas desde la pestaña **Bot**: un negocio puede
querer que consulte precios pero no que tome pedidos.

## Respaldos

Copia diaria cifrada que **se verifica restaurándola de verdad** antes de darse
por buena — ver [`RESPALDOS.md`](RESPALDOS.md). Hay que configurarla: sin
`BACKUP_CLAVE` en el `.env`, el script se niega a correr.

## Hacia dónde va

Qué construir y en qué orden está en [`ROADMAP.md`](ROADMAP.md), junto con las
dos restricciones de Meta —la ventana de 24 h y el cobro por mensaje desde
octubre de 2026— que condicionan el diseño de cualquier función de seguimiento.

## Decisiones y límites conocidos

- **La base de conocimiento entra entera en el prompt**, no hay búsqueda
  semántica. Es más simple, no cuesta embeddings, y para una base de pocas
  páginas responde mejor que cualquier búsqueda porque la IA ve todo.
  El límite es `MAX_CHARS_CONTEXTO` (12k caracteres, ~3k tokens).
  **Cuándo deja de alcanzar:** el panel avisa en la pestaña "Bot" cuando hay
  fragmentos que no entran. Ahí toca llenar `Fragmento.embedding` y traer los
  N más parecidos en `armarContexto()`. El modelo de datos ya está partido en
  fragmentos justamente para que ese cambio sea local.
- **Las notas de voz se transcriben**; imagen, documento y ubicación se
  ignoran (`extraerTexto()` en `routes/webhookWhatsapp.js`). Describir una foto
  es otro problema, y un bot que responde cualquier cosa a una imagen es peor
  que uno que avisa que no la puede ver.
- **Solo se cargan archivos de texto plano** (.txt, .md, .csv). No hay parseo
  de PDF ni de Word: se leen en el navegador con `FileReader`.
- **No hay registro público.** Los usuarios se dan de alta por script: el panel
  controla un número de WhatsApp real y una API que se paga por uso.
- **El proveedor de IA está aislado en `services/asistenteIA.js`.** Cambiarlo
  es tocar ese archivo, nada más.
