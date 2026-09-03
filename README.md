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

### Detrás de un dominio compartido (`BASE_PATH`)

Si la app **no** vive en la raíz de su dominio sino colgada de un prefijo
—por ejemplo `https://api.chatgo.ia.bo/wabot`— hay que decírselo:

```bash
APP_URL=https://api.chatgo.ia.bo
BASE_PATH=/wabot
```

Con eso todo (panel, assets, API y webhook) se monta bajo `/wabot` y el panel
resuelve sus rutas contra ese prefijo. `BASE_PATH` acepta `wabot`, `/wabot`,
`wabot/` o `/wabot/`: se normaliza solo.

nginx, **sin** recortar el prefijo (la app ya lo espera):

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

**Un subdominio propio (`wabot.chatgo.ia.bo`) es preferible** y es lo que
recomiendo: dejás `BASE_PATH` vacío, no hay prefijos que alinear, y sobre todo
el panel deja de compartir origen con el resto de `api.chatgo.ia.bo` — mientras
lo comparta, cualquier JavaScript servido desde ese dominio puede leer el token
de sesión del panel en `sessionStorage`. El prefijo funciona; el subdominio
además aísla.

### Configurar el webhook en Meta

En el dashboard de Meta → tu app → WhatsApp → **Configuration**:

| Campo | Valor |
|---|---|
| Callback URL | `https://TU-DOMINIO/webhook/whatsapp`<br>(con `BASE_PATH`: `https://api.chatgo.ia.bo/wabot/webhook/whatsapp`) |
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
db/models.js               Negocio, Usuario, Documento, Fragmento, Conversacion
services/
  metaWhatsapp.js          envío por la Graph API + verificación de firma
  asistenteIA.js           el prompt y la llamada al modelo
  baseConocimiento.js      fragmentado y armado del contexto
  conversacion.js          orquestación de un mensaje entrante
  auth.js                  bcrypt + token firmado para el panel
  httpHelpers.js           asyncRoute, ErrorHttp, aislamiento por negocio
routes/
  webhookWhatsapp.js       webhook de Meta (verificación + mensajes)
  panel.js                 API del panel
public/                    el panel (sin framework, sin build)
scripts/crear_usuario.js   alta del negocio y del primer usuario
```

## Decisiones y límites conocidos

- **La base de conocimiento entra entera en el prompt**, no hay búsqueda
  semántica. Es más simple, no cuesta embeddings, y para una base de pocas
  páginas responde mejor que cualquier búsqueda porque la IA ve todo.
  El límite es `MAX_CHARS_CONTEXTO` (12k caracteres, ~3k tokens).
  **Cuándo deja de alcanzar:** el panel avisa en la pestaña "Bot" cuando hay
  fragmentos que no entran. Ahí toca llenar `Fragmento.embedding` y traer los
  N más parecidos en `armarContexto()`. El modelo de datos ya está partido en
  fragmentos justamente para que ese cambio sea local.
- **Solo se atienden mensajes de texto y botones.** Audio, imagen y ubicación
  se ignoran (`extraerTexto()` en `routes/webhookWhatsapp.js`). Un bot que
  responde cualquier cosa a un audio es peor que uno que no lo atiende.
- **Solo se cargan archivos de texto plano** (.txt, .md, .csv). No hay parseo
  de PDF ni de Word: se leen en el navegador con `FileReader`.
- **No hay registro público.** Los usuarios se dan de alta por script: el panel
  controla un número de WhatsApp real y una API que se paga por uso.
- **El proveedor de IA está aislado en `services/asistenteIA.js`.** Cambiarlo
  es tocar ese archivo, nada más.
