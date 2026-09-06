# Agenda y Google Calendar

El bot consulta horarios reales, agenda turnos y los cancela, contra el Google
Calendar del negocio.

## La decisión que ordena todo

**Google Calendar es la fuente de verdad de la disponibilidad.** No nuestra
base de datos.

El dueño también agenda cosas a mano desde su celular: un almuerzo, un
proveedor, una urgencia. Si la disponibilidad saliera de nuestra base, el bot
ofrecería horarios que en la realidad ya están ocupados, y alguien llegaría a
una puerta cerrada.

Guardamos las reservas en `Reserva`, pero solo para el panel y para que el bot
sepa qué reservó cada cliente. **Qué está libre lo decide Google, siempre.**

## Por qué cuenta de servicio y no OAuth

El scope de Calendar es "sensible" para Google, así que una app OAuth tiene que
pasar su proceso de verificación: semanas de espera, política de privacidad
publicada y revisión de seguridad. Para un producto que recién arranca, eso es
un muro.

Con una cuenta de servicio, el dueño comparte su calendario con un email y
listo. El costo es que cada negocio tiene que hacer ese paso a mano — el día
que haya cientos de clientes, ahí sí conviene migrar a OAuth.

## Configuración, una sola vez, del lado del servidor

1. **console.cloud.google.com** → tu proyecto → **APIs y servicios** →
   habilitar **Google Calendar API**
2. **IAM y administración → Cuentas de servicio → Crear**
3. En la cuenta creada: **Claves → Agregar clave → Crear nueva → JSON**
4. El JSON descargado va **entero, en una sola línea**, al `.env`:

```bash
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...","client_email":"bot@proyecto.iam.gserviceaccount.com",...}
```

```bash
pm2 restart wabot
```

> La cuenta de servicio **no necesita ningún rol de IAM**. No accede a recursos
> del proyecto: accede a los calendarios que le compartan, y eso se autoriza
> del lado de Calendar, no de IAM.

## Configuración por negocio

En el panel, pestaña **Agenda**:

1. Copiá el email de la cuenta de servicio que muestra la pantalla
2. En **Google Calendar** → engranaje → *Configuración* → elegí tu calendario →
   **Compartir con determinadas personas** → **Agregar** → pegá ese email →
   permiso **«Hacer cambios en los eventos»**

   > Con permiso de solo lectura el bot ve la disponibilidad pero **no puede
   > agendar**, y el error recién aparece cuando un cliente intenta reservar.

3. En el panel: **ID del calendario** (normalmente el email de Google del
   negocio), zona horaria, duración del turno y horario de atención
4. **Ver disponibilidad real** — si muestra horarios, la conexión está lista
5. Pestaña **Bot** → tildá **Agendar turnos**

## Cómo se arman los turnos

Se cruzan tres cosas:

| | |
|---|---|
| **Horario de atención** | Las franjas que cargaste. Un día sin franja no se atiende; se pueden poner dos franjas para el negocio que cierra al mediodía |
| **Google Calendar** | Todo lo ocupado en el rango, incluido lo que agendó el dueño a mano |
| **Anticipación mínima** | Sin esto, un cliente agenda a las 15:58 para las 16:00 y nadie llega a prepararse |

Un turno solo se ofrece si **entra completo** antes del cierre: con turnos de
60 minutos y cierre a las 18:00, el último que se ofrece es a las 17:00.

**Duración** y **paso** están separados porque no son lo mismo: una consulta de
45 minutos puede ofrecerse cada 60 para dejar aire entre una y otra.

## Al reservar se vuelve a verificar

Entre que el bot ofreció un horario y el cliente lo aceptó pasan minutos, y en
el medio el dueño pudo agendar otra cosa. Por eso `crear_reserva` **consulta
Google de nuevo** antes de escribir, y si el horario se ocupó devuelve el
motivo para que el bot ofrezca otro.

## Todo en UTC

Las reservas se guardan en UTC y se muestran en la zona del negocio. Guardar
hora local es cómo se terminan teniendo turnos con una hora de diferencia el
día que algo cambia.

La conversión usa `Intl` y no un offset fijo: un offset se rompe con el horario
de verano. Bolivia no lo tiene, pero un cliente en Chile sí.

## Límites conocidos

- **Un calendario por negocio.** Un consultorio con tres profesionales necesita
  hoy tres negocios. Soportar varios recursos es agregar un modelo `Recurso`
  con su propio calendarId.
- **Sin recordatorios automáticos.** Avisarle al cliente el día antes requiere
  escribirle fuera de la ventana de 24 h de Meta, o sea plantillas aprobadas y
  opt-in (módulo 6 del roadmap).
- **Cancela solo el cliente que reservó.** El número sale del webhook, no de lo
  que diga el modelo: si viniera de los argumentos, bastaría con convencer al
  bot de que uno es otra persona para cancelarle el turno a un tercero.
