# Respaldos

Wabot hace una copia diaria, cifrada, y **la verifica restaurándola de verdad**
en una base aparte antes de darla por buena.

Una copia que nunca se restauró no es una copia: es un archivo que suponés que
sirve. La mayoría de los desastres de datos no son "no había respaldos" — son
"había respaldos y no servían, y nos enteramos ese día".

---

## Poner en marcha

### 1. La clave de cifrado

Sin ella el respaldo **se niega a correr**. Un archivo sin cifrar no se puede
sacar del servidor, y un respaldo que solo vive en el mismo disco que la base
no protege del caso más común: perder el disco.

```bash
openssl rand -base64 48
```

Al `.env`:

```
BACKUP_CLAVE=lo-que-salió-del-comando
BACKUP_RETENCION_DIAS=14
```

> **Guardá esa clave también fuera del servidor** — gestor de contraseñas, otro
> lado, donde sea. Si se pierde el servidor y la clave estaba solo ahí, los
> respaldos existen pero no se pueden abrir. Es la forma más tonta de perder
> todo teniendo copias.

### 2. Probarlo a mano

```bash
cd ~/wabot && node scripts/respaldo.js
```

Tiene que terminar en:

```
[RESPALDO] ✓ Verificado: N documentos restaurados y comparados uno a uno
```

Si no dice eso, **no tenés respaldo**, tengas el archivo que tengas.

### 3. Programarlo

```bash
crontab -e
```

```cron
# Respaldo de wabot, 3:15 AM Bolivia. La salida va a un log para poder
# revisar después si una noche falló.
15 3 * * * cd /home/rastreoplus/wabot && /usr/bin/node scripts/respaldo.js >> /home/rastreoplus/respaldos.log 2>&1
```

Verificá una semana después que haya corrido:

```bash
tail -20 ~/respaldos.log
ls -lh ~/respaldos/
```

### 4. Sacarlos del servidor

Un respaldo en el mismo disco que la base **no es un respaldo**: el incendio
se lleva los dos. Como ya están cifrados, se pueden copiar a cualquier lado:

```bash
gsutil cp ~/respaldos/*.enc gs://TU-BUCKET/wabot/
```

---

## Restaurar

### Ver qué hay

```bash
node scripts/restaurar.js
```

### Restaurar para inspeccionar (sin tocar nada)

```bash
node scripts/restaurar.js wabot-2026-09-05-23-20-48.json.gz.enc
```

Restaura en `wabot_restaurado`, una base **aparte**. La que está en uso no se
toca. Revisá con `mongosh wabot_restaurado`.

### Restaurar sobre la base real

```bash
pm2 stop wabot
node scripts/restaurar.js <archivo> --sobre-la-base-real
pm2 start wabot
```

Pide escribir el nombre de la base para confirmar. No es burocracia: es una
acción destructiva sobre datos en uso, y tiene que costar más que apretar una
tecla.

---

## Qué hace exactamente

1. **Vuelca** todas las colecciones, incluso las que no tienen modelo en
   `db/models.js`. Serializa en EJSON: un `ObjectId` o una fecha pasados por
   JSON común vuelven como texto, y las referencias entre colecciones se
   rompen en silencio.
2. **Comprime** (gzip) y **cifra** (AES-256-GCM, clave derivada con scrypt).
   GCM autentica además de cifrar: un archivo alterado falla al abrirse en vez
   de devolver basura.
3. **Verifica restaurando**: relee el archivo **del disco**, lo descifra, lo
   restaura en `<base>_verificacion` y compara los conteos contra el original.
   Se relee del disco a propósito — lo que importa es que sirva lo que quedó
   grabado, no lo que había en memoria.
4. **Limpia** los más viejos que la retención — recién después de que el nuevo
   quedó verificado. Al revés dejaría una ventana sin ninguna copia buena.

Si algo falla, el archivo se renombra a `.FALLIDO` y el proceso sale con
código 1, para que cron lo reporte.

## Lo que este respaldo NO cubre

- **Los índices.** Se recrean solos al arrancar la app (mongoose los declara).
- **El `.env`.** Guardá aparte `BACKUP_CLAVE`, `JWT_SECRET` y los tokens de
  Meta. Con la base restaurada pero sin el `.env`, la app no arranca.
- **Un borrado que se respalda antes de que lo notes.** Con 14 días de
  retención tenés dos semanas para darte cuenta. Si borrás algo importante,
  copiá el respaldo de hoy a otro lado *antes* de que la rotación lo alcance.
