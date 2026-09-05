# Desplegar wabot en una VM nueva de GCP

De cero a `https://wabot.chatgo.ia.bo` funcionando. Cada bloque termina con una
comprobación: **si falla, no sigas al siguiente** — la mitad de los problemas de
despliegue son en realidad un problema anterior que nadie verificó.

---

## 1. Crear la VM

Compute Engine → **Create instance**.

| Campo | Valor | Por qué |
|---|---|---|
| Región | la misma que tus otras VMs | Nada lo obliga, pero mantiene la latencia y la factura predecibles. |
| Tipo | **e2-small** (2 vCPU compartidas, 2 GB) | Ver abajo. |
| Disco | 20 GB, balanced (SSD) | El código pesa poco; el espacio es para Mongo y los logs. |
| SO | Debian 12 o Ubuntu 24.04 LTS | Cualquiera de los dos; los comandos de acá son para Debian/Ubuntu. |
| Firewall | ☑ Allow HTTP ☑ Allow HTTPS | Sin esto, ni el navegador ni Let's Encrypt llegan. |

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

VPC network → IP addresses → **Reserve external static IP address**, y asignásela
a la VM. Hacelo **antes** de tocar el DNS.

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

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx certbot python3-certbot-nginx git
sudo npm install -g pm2
```

✅ **Verificar:** `node -v` da v20.x (la app pide ≥18) y `nginx -v` responde.

---

## 5. MongoDB

```bash
curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc \
  | sudo gpg -o /usr/share/keyrings/mongodb.gpg --dearmor
echo "deb [signed-by=/usr/share/keyrings/mongodb.gpg] https://repo.mongodb.org/apt/debian bookworm/mongodb-org/7.0 main" \
  | sudo tee /etc/apt/sources.list.d/mongodb.list
sudo apt update && sudo apt install -y mongodb-org
sudo systemctl enable --now mongod
```

> En Ubuntu cambiá `debian bookworm` por `ubuntu noble` (24.04) o `ubuntu jammy`
> (22.04), y `apt/debian` por `apt/ubuntu`.

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
  verifican restaurándolas; wabot todavía no tiene nada equivalente. Mientras
  tanto, lo mínimo es un snapshot programado del disco desde
  Compute Engine → Snapshots.
- **No hay monitoreo.** Si `pm2` reinicia la app en loop o `mongod` muere, nadie
  te avisa. `pm2 logs` es lo que hay.
- **Actualizaciones de seguridad.** VM aparte, parches aparte: `unattended-upgrades`
  o un `apt upgrade` en la agenda.
