# Desplegar wabot en una VM nueva de GCP

De cero a `https://wabot.chatgo.ia.bo` funcionando. Cada bloque termina con una
comprobación: **si falla, no sigas al siguiente** — la mitad de los problemas de
despliegue son en realidad un problema anterior que nadie verificó.

---

## 1. Crear la VM

Compute Engine → **Create instance**. Campo por campo (Google mueve cosas de
lugar cada tanto; lo que no encuentres está bajo *Advanced options*):

| Campo | Valor | Cuidado |
|---|---|---|
| **Name** | `wabot` | No se puede renombrar después. |
| **Region** | la misma que tus otras VMs | **No se cambia después** — para moverla hay que recrear. La zona (`-a`/`-b`/`-c`) da igual. |
| **Series** | E2 | |
| **Machine type** | **e2-small** (2 vCPU, 2 GB) | Ver abajo. Esto **sí** se cambia después, apagando la VM. |
| **Provisioning model** | **Standard** | **Nunca Spot.** Google las apaga cuando necesita capacidad, con 30 s de aviso. Un bot que contesta WhatsApp no puede vivir ahí. |
| **Boot disk** → Change | Debian GNU/Linux **13 (trixie)**, Balanced persistent disk, **20 GB** | ⚠️ El default son **10 GB**: subilo. Debian 13 trae Node 20 de fábrica (el 12 trae Node 18) y MongoDB publica repo para trixie, así que no hace falta agregar ningún repo de terceros para Node. |
| **Firewall** | ☑ Allow HTTP ☑ Allow HTTPS | Sin esto no llegan ni el navegador ni Let's Encrypt. |
| **Identity and API access** | por defecto | Esta VM no necesita permisos sobre el proyecto. |
| **Deletion protection** (Advanced → Management) | activada | Un click, evita un borrado por accidente. |
| **Protección de datos** → Programaciones de instantáneas | **activala** | Es el respaldo mínimo del disco, y se configura acá en dos clicks. No reemplaza a un dump de Mongo verificado, pero es la diferencia entre perder todo y perder un día. |
| **Observabilidad** → Agente de operaciones | **dejalo apagado** | En 2 GB compartidos con MongoDB y Node, el agente se come RAM que vas a extrañar. Activalo cuando la VM tenga aire, no antes. |

El panel de la derecha estima el costo mensual de tu región. Miralo antes de
crear.

### Por qué e2-small y no e2-micro

`e2-micro` (1 GB) entra en la capa gratuita y es tentador, pero acá corren
MongoDB **y** Node en la misma máquina. Con 1 GB de RAM, el caché de WiredTiger
queda en el mínimo y `mongod` es el primer candidato del OOM killer cuando algo
pica. Se cae solo, de madrugada, y el síntoma que ves es "el bot dejó de
contestar" — no "falta memoria".

Si igual arrancás con `e2-micro`, ponele swap sí o sí (paso 3) y tené presente
que el tipo de máquina se cambia después apagando la VM: no es una decisión
irreversible.

### IP estática — esto es lo que más se olvida

Por defecto GCP asigna una IP **efímera**: cambia cada vez que apagás y prendés
la VM. Si el DNS apunta a esa IP, el día que reinicies se cae el sitio *y* deja
de renovar el certificado.

**Al crear la VM** (lo más limpio): Advanced options → Networking → Network
interfaces → `default` → **External IPv4 address** → *Create IP address*.

**Si la VM ya existe**, no la recrees: VPC network → **IP addresses**, buscá la
IP efímera de `wabot` y dale **Reserve**. Te queda la misma IP, ya reservada.

En cualquier caso, hacelo **antes** de tocar el DNS.

```bash
gcloud compute addresses create wabot-ip --region=<TU-REGION>
gcloud compute addresses list          # anotá la IP
```

---

## 2. Entrar y actualizar

```bash
gcloud compute ssh wabot          # o el botón SSH de la consola
sudo apt update && sudo apt upgrade -y
```

---

## 3. Swap (obligatorio en 1 GB, recomendable en 2 GB)

Un pico de memoria sin swap no ralentiza: mata el proceso.

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

✅ **Verificar:** `free -h` muestra una fila `Swap` con 2,0Gi.

---

## 4. Node, nginx, certbot

En Debian 13 (trixie) todo sale de los repos oficiales — Node 20 viene incluido:

```bash
sudo apt install -y nodejs npm nginx certbot python3-certbot-nginx git
sudo npm install -g pm2
```

✅ **Verificar:** `node -v` da v20.x (la app pide ≥18) y `nginx -v` responde.

> En Debian 12 el `nodejs` de los repos es la 18, que también sirve. Si
> necesitás una versión más nueva ahí, el repo de NodeSource ya no usa el nombre
> de la distro — es `nodistro` para todas:
>
> ```bash
> curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
>   | sudo gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
> echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
>   | sudo tee /etc/apt/sources.list.d/nodesource.list
> sudo apt update && sudo apt install -y nodejs
> ```

---

## 5. MongoDB

El nombre de la distro se toma solo, así el mismo bloque sirve en Debian 12 y
en 13 (MongoDB publica repo para `bookworm` y para `trixie`):

```bash
CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc \
  | sudo gpg -o /usr/share/keyrings/mongodb.gpg --dearmor
echo "deb [signed-by=/usr/share/keyrings/mongodb.gpg] https://repo.mongodb.org/apt/debian $CODENAME/mongodb-org/8.0 main" \
  | sudo tee /etc/apt/sources.list.d/mongodb.list
sudo apt update && sudo apt install -y mongodb-org
sudo systemctl enable --now mongod
```

> En Ubuntu, cambiá `apt/debian` por `apt/ubuntu` — el `$CODENAME` se resuelve
> igual (`noble`, `jammy`).

**No abras Mongo a la red.** Por defecto escucha solo en `127.0.0.1` y así tiene
que quedarse: la app corre en esta misma VM. Un `mongod` expuesto sin
autenticación se encuentra y se vacía en horas — no es una hipótesis, es rutina
de los escaneos automáticos.

✅ **Verificar:** `sudo systemctl status mongod` dice `active (running)`, y
`ss -ltn | grep 27017` muestra `127.0.0.1:27017` y **no** `0.0.0.0:27017`.

---

## 6. La aplicación

```bash
cd ~ && git clone https://github.com/luisqui92/wabot && cd wabot
npm install --omit=dev
cp .env.example .env
nano .env
```

Lo mínimo para arrancar:

```bash
MONGODB_URI=mongodb://127.0.0.1:27017/wabot
JWT_SECRET=          # openssl rand -hex 32
APP_URL=https://wabot.chatgo.ia.bo
BASE_PATH=           # vacío: la app vive en la raíz de su subdominio
PORT=3000
```

Y las de Meta e IA (`WHATSAPP_TOKEN`, `WHATSAPP_VERIFY_TOKEN`, `META_APP_SECRET`,
`OPENAI_KEY`) — se pueden completar después, el panel levanta igual.

```bash
node scripts/crear_usuario.js "Mi Negocio" <phoneNumberId> tu@mail.com <password>
pm2 start index.js --name wabot
pm2 save
pm2 startup            # ejecutá el comando que imprime, para que arranque sola
```

✅ **Verificar:** `curl -s localhost:3000/salud` devuelve
`{"ok":true,"mongo":true}`. Si `mongo` es `false`, el problema es el paso 5, no
nginx.

---

## 7. DNS

Recién ahora, con la app respondiendo:

```
wabot.chatgo.ia.bo.   A   <la IP estática del paso 1>
```

✅ **Verificar:** `dig +short wabot.chatgo.ia.bo` devuelve tu IP. Esperá a que
propague antes de seguir — certbot valida por HTTP contra ese nombre, y si
todavía no resuelve, falla.

---

## 8. nginx

`/etc/nginx/sites-available/wabot`:

```nginx
server {
    listen 80;
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

```bash
sudo ln -s /etc/nginx/sites-available/wabot /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

`X-Forwarded-Proto` no es decorativo: la app corre con
`app.set("trust proxy", 1)` y sin esa cabecera ve todo el tráfico como si
viniera de 127.0.0.1.

✅ **Verificar:** desde tu máquina, `curl http://wabot.chatgo.ia.bo/salud`
devuelve el JSON.

---

## 9. HTTPS

```bash
sudo certbot --nginx -d wabot.chatgo.ia.bo
```

Certbot edita el `server` block solo y agrega la redirección de 80 a 443.

✅ **Verificar:**
```bash
curl https://wabot.chatgo.ia.bo/salud     # el JSON, sin warnings de TLS
systemctl list-timers | grep certbot      # la renovación automática existe
sudo certbot renew --dry-run              # y funciona de verdad
```

Meta exige HTTPS con certificado válido en la Callback URL: un autofirmado no
le sirve.

---

## 10. Meta

Con todo lo anterior en verde, en el dashboard de Meta → tu app → WhatsApp →
**Configuration**:

| Campo | Valor |
|---|---|
| Callback URL | `https://wabot.chatgo.ia.bo/webhook/whatsapp` |
| Verify token | el mismo string de `WHATSAPP_VERIFY_TOKEN` |
| Webhook fields | suscribir **`messages`** |

✅ **Verificar:** Meta acepta la URL al guardar (llama al webhook con
`hub.challenge` y espera que se lo devuelvas). Si la rechaza, el problema es el
verify token o el HTTPS — no el bot.

---

## Actualizar después

```bash
cd ~/wabot && git pull && npm install --omit=dev && pm2 restart wabot
pm2 logs wabot --lines 50
```

---

## Lo que esta guía NO te deja resuelto

Sé honesto con esto antes de poner clientes reales:

- **No hay respaldos.** Una VM propia significa que las copias son tuyas: si se
  pierde el disco, se pierden la base de conocimiento y todas las
  conversaciones. Vitalis tiene un `RESPALDOS.md` con copias diarias que se
  verifican restaurándolas; wabot todavía no tiene nada equivalente. Las
  instantáneas programadas del paso 1 son el piso, no el techo: recuperan el
  disco entero de ayer, no la base de esta mañana, y nadie las probó
  restaurándolas.
- **No hay monitoreo.** Si `pm2` reinicia la app en loop o `mongod` muere, nadie
  te avisa. `pm2 logs` es lo que hay.
- **Actualizaciones de seguridad.** VM aparte, parches aparte: `unattended-upgrades`
  o un `apt upgrade` en la agenda.
