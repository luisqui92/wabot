# Cobros por QR

El bot le manda el QR al cliente con el monto exacto, recibe la captura del
comprobante, la lee, la compara contra el pedido y te avisa. **Aceptar el pago
lo hacés vos.**

## La regla que no se negocia

**El bot nunca marca un pedido como pagado.**

Una captura de comprobante se falsifica en dos minutos con cualquier editor de
imágenes. Un modelo de visión se puede engañar, y además a veces simplemente
lee mal. Un sistema que acredita pagos con una imagen no es una función: es una
puerta de entrada al fraude.

Lo que el bot hace: extrae, compara y **levanta la mano cuando algo no cuadra**.
Lo que hace una persona: aceptar.

Por eso el cliente tampoco recibe una confirmación de pago — solo un "recibimos
tu comprobante, lo estamos verificando". Confirmarle un pago que todavía nadie
miró es exactamente el agujero que deja pasar un comprobante falso.

## Lo que se detecta solo

| Situación | Qué pasa |
|---|---|
| El monto coincide | Sin alertas, listo para aceptar |
| **Pagó de menos** | Alerta con los dos montos |
| Pagó de más | Alerta diciendo cuánto devolver |
| Moneda distinta | Alerta |
| **La misma imagen otra vez** | Alerta con la fecha del envío anterior |
| **La misma referencia** con otra captura | Alerta |
| No es un comprobante | Alerta |
| Sin pedido pendiente | Se registra igual, avisando que no está asociado a nada |

Las dos en negrita son los fraudes que de verdad pasan. Reenviar el mismo
comprobante es mucho más común que falsificar uno: se detecta con el hash del
archivo, sin depender de que el modelo se dé cuenta.

## Configurar

1. **Panel → Pagos**: subí tu QR (exportado desde la app de tu banco) y escribí
   qué aclararle al cliente — titular, banco, lo que haga falta.
2. **Panel → Bot**: tildá **Enviar QR de pago**.
3. Necesitás `APP_URL` en el `.env`: Meta **descarga el QR por URL** para
   mostrárselo al cliente, así que sin dominio configurado el envío falla. El
   panel te avisa si falta.

## Cómo se ve

```
Cliente:  ya elegí, ¿cómo pago?

Bot ──► enviar_datos_de_pago()
         ├─ busca el último pedido sin pagar de ese número
         └─ manda el QR con "Monto exacto: BOB 90.00"

Cliente:  [captura del comprobante]

Bot ──► descarga la imagen de Meta
         ├─ la lee: monto, banco, referencia, fecha, emisor
         ├─ compara contra el pedido
         ├─ busca el hash y la referencia en pagos anteriores
         └─ guarda como PENDIENTE

Vos:      💰 recibís un WhatsApp con el monto, las alertas si las hay,
             y "aceptalo o rechazalo en el panel"

Cliente:  "Recibimos tu comprobante, lo estamos verificando"
```

Recién cuando apretás **Aceptar pago**, el pedido queda marcado como pagado.

## El QR: lo que hoy se puede y lo que no

Se usa **tu QR fijo**, el que exportás del banco, y el cliente escribe el monto.

**Un QR único por pedido, con el monto ya embebido, requiere convenio y
credenciales API de tu banco** (QR Simple / ASFI). Eso es papeleo comercial, no
programación. El día que lo tengas, la pieza que cambia es una sola:
`enviar_datos_de_pago` genera el QR dinámico en vez de servir el fijo. El resto
—recepción, lectura, verificación, aprobación— no se toca.

## Dónde vive cada cosa

- **El QR** se guarda en la base, no en disco: así entra en los respaldos sin
  trabajo extra. Un QR perdido es un negocio que no puede cobrar.
- Se sirve en `/qr/<token>.png`, público porque Meta tiene que poder
  descargarlo. No es un secreto —es un QR que le mostrás a cualquiera que va a
  pagar— y el token aleatorio evita que se pueda enumerar. Al subir un QR nuevo
  se genera otro token, así el anterior deja de servir.
- **Los comprobantes** también van a la base, y su imagen se sirve solo
  autenticada: es un documento bancario de un cliente, no algo que deba andar
  circulando por URL.

## Límites conocidos

- **Un comprobante bien falsificado pasa la verificación.** Por eso aprueba una
  persona. Si el monto y la referencia son creíbles, lo único que lo delata es
  no encontrarlo en el extracto del banco.
- **No se concilia contra el banco.** Nadie comprueba que la plata entró de
  verdad; se comprueba que el comprobante dice lo que tiene que decir. La
  conciliación real necesita la API del banco.
- **Un solo QR por negocio.** Sin cuentas separadas por sucursal.
