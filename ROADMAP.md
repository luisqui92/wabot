# Roadmap

Qué construir, en qué orden, y —sobre todo— qué **no** construir todavía.

El criterio de orden es uno solo: **cada módulo tiene que ser útil el día que
se termina**, sin depender de que exista el siguiente. Si un módulo solo sirve
"cuando esté el otro", va después.

---

## Dos restricciones que mandan sobre todo lo demás

Antes de diseñar nada, hay que tenerlas presentes, porque invalidan varias
ideas que suenan bien:

### 1. No le podés escribir a un cliente cuando querés

Cuando un cliente escribe, se abre una **ventana de 24 horas**. Dentro de esa
ventana el bot responde libre. **Fuera de la ventana solo se pueden mandar
plantillas pre-aprobadas por Meta**, y únicamente a gente que dio **opt-in
explícito**. ([Meta — Send messages](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages))

Esto no es un detalle de implementación, es un límite de producto:

| Idea | Como se suele imaginar | Lo que realmente se puede |
|---|---|---|
| Recuperación de ventas | "a las X horas le escribo de nuevo" | Solo con plantilla aprobada, si hay opt-in, y se paga |
| Contactar clientes inactivos | Mandarles un mensaje | Campaña de plantillas, con lista de opt-in |
| Modo autónomo | El bot sale a buscar clientes | El bot propone; el envío sigue las reglas de arriba |

El seguimiento automático **sí se puede** — pero es un módulo de plantillas y
opt-in, no un `setTimeout` que manda un texto. Diseñarlo mal no te da un bug:
te banean el número.

### 2. Desde el 1 de octubre de 2026 los mensajes cuestan

Meta empieza a cobrar los mensajes de servicio **dentro** de la ventana de 24 h,
que hasta ahora eran gratis.

Consecuencia directa: el costo por conversación deja de ser solo el de OpenAI.
Cualquier plan con "conversaciones ilimitadas" es una promesa que no se puede
sostener. Los niveles de precio hay que armarlos sobre **costo por conversación
medido**, no estimado — y para medirlo hace falta el módulo de métricas, que
por eso está temprano en esta lista.

---

## De dónde salen estas ideas

La mayoría de los módulos de abajo salieron de la visión de producto del dueño
del proyecto, no de este documento. **Wabot Actions** (módulo 2), la **memoria
del cliente** (módulo 1, ya construido), el **radar**, el **modo empleado**, el
**lead scoring**, los **huecos agrupados**, la **bandeja humana** y el
**versionado del cerebro** son suyas.

Lo que aporta este documento es el **orden** y las restricciones que lo
condicionan — no la lista. Y tres ideas propias que están más abajo, en
"Ideas para diferenciarse".

## Ideas para diferenciarse

Cuatro que no estaban en la visión original y que atacan lo que realmente hace
fracasar a estos productos:

### A. Que el negocio nunca escriba su base de conocimiento
Todos los competidores piden sentarse a cargar la información. La mayoría de
los dueños no lo hace, o lo hace mal, el bot responde mal, y se dan de baja.
**Esa es la principal causa de baja del rubro, y no es un problema técnico
sino de fricción.**

La solución: **importar sus conversaciones de WhatsApp**. Cualquier dueño tiene
años contestando lo mismo, y WhatsApp exporta el chat a `.txt` con un botón.
De ahí salen los pares pregunta-respuesta reales, con precios reales, y —de
regalo— su forma de hablar. Onboarding de diez minutos en vez de tres horas.

### B. "Preguntale al dueño", en tiempo real
Cuando el bot no sabe, hoy dice "te confirmamos" y el cliente espera. Dado
vuelta: se le manda al dueño la pregunta con tres respuestas sugeridas como
botones. Toca una desde donde esté, el cliente tiene respuesta en segundos, y
**esa respuesta queda guardada para siempre**.

Es el módulo de huecos convertido en algo que pasa solo, sin que nadie abra un
panel. Requiere una plantilla aprobada de categoría *utility* para poder
escribirle al dueño fuera de su ventana de 24 h.

### C. Audio en serio ✅ HECHO
Notas de voz de clientes transcritas, con el vocabulario sesgado por el
catálogo del negocio. Y dictado desde el panel para cargar conocimiento
hablando, con revisión humana antes de guardar.

Pendiente encima de esto: **responder** con nota de voz, que cierra el círculo
para el cliente que no quiere leer.

### D. Trazabilidad de cada respuesta
Guardar de qué fragmento salió cada respuesta, para poder preguntar "¿por qué
dijo eso?" y ver la fuente. Parece menor, pero ataca la barrera real de venta:
el miedo a que el bot le diga una barbaridad a un cliente. No se vende
explicando que la IA es buena — se vende mostrando que es auditable. Y es
barato: los fragmentos ya existen, falta guardar cuál se usó.

## Qué hace defendible a esto (y qué no)

La lista de funciones no es un diferenciador. En 2026 ya se venden, con equipos
y capital detrás:

| Ya existe, con nombre y precio | Quién |
|---|---|
| Agentes de IA sobre WhatsApp | Wati (*Astra AI Agents*), AiSensy, Interakt |
| Agente que califica leads y agenda citas | Waslo |
| Bandeja omnicanal con ruteo | Respond.io, SleekFlow, Blip |
| Plataforma pensada para LATAM, con MercadoPago y Tiendanube nativos | Chatsell, ~USD 49/mes |

Los precios de referencia van de USD 15 a 79 por mes de plataforma, más lo que
cobra Meta por conversación.

Conclusión incómoda: **cualquier función de la lista se copia en semanas**, y
más ahora que un LLM hace el trabajo pesado. Perseguir "el SaaS más completo
del mundo" contra empresas financiadas es competir donde ellas son fuertes.
Lo que sí es difícil de copiar:

### 1. Estar adentro antes que ellos
El mercado boliviano está en etapa temprana y con poca competencia digital.
Wati y Respond.io no van a construir integración con facturación electrónica
boliviana, QR Simple ni Tigo Money — el mercado no les justifica el esfuerzo.
Para nosotros es el foso.

### 2. Distribución — que hay que construir, no que ya existe
Wabot es un producto independiente. No se apoya en ningún otro sistema propio
ni comparte datos con ninguno.

Eso hay que decirlo sin maquillaje: **la distribución es la parte que todavía
no está**. Los competidores tienen equipos de ventas y presupuesto de
marketing; el producto no se vende solo por ser mejor.

Lo que sí hay es cercanía al mercado — se entiende cómo compra una pyme
boliviana, qué usa y qué le duele, y eso desde afuera no se compra. Pero es un
punto de partida, no un foso. El foso de distribución se construye vendiendo:
los primeros diez clientes de un mismo rubro valen más que diez clientes
sueltos de rubros distintos, porque hacen que el rubro entero se venda solo
después (ver punto 3).

### 3. El efecto de red del conocimiento
Este es el único foso que **crece solo**, y sale de algo que ya está construido:
los huecos. Cada negocio de un rubro revela qué preguntan sus clientes de
verdad. Agregado y anonimizado por rubro, el cliente número 50 de
"restaurantes" arranca con un cerebro que ya sabe las 200 preguntas que le van
a hacer.

Eso no se copia sin los datos, y los datos solo se consiguen operando. Cada
cliente nuevo mejora el producto para el siguiente.

### La consecuencia práctica
Profundidad en un rubro antes que amplitud en todos. Un producto que resuelve
**completo** un vertical —con las integraciones locales que nadie más va a
hacer— vale más que uno genérico con dieciséis módulos a medias.

El vertical se elige por dónde se puede vender rápido y dónde el bot resuelve
algo caro de verdad: un negocio que hoy paga a alguien para contestar WhatsApp
todo el día tiene un número concreto contra el cual comparar el precio. Sin ese
número, la venta se convierte en explicar qué es la IA.

Y de los dos fosos que sí crecen —integraciones locales y conocimiento por
rubro— **el segundo solo aparece con varios clientes del mismo rubro**. Diez
clientes de un vertical valen más que diez de diez verticales distintos.

## Lo que hay hoy

Funcionando en producción: bot sobre Cloud API, base de conocimiento por
fragmentos, conversaciones con historial, pausa para atención humana, y
"huecos" (lo que el bot no supo responder).

Ese núcleo es sólido y **no hay que tirarlo**. Todo lo de abajo se apoya encima.

---

## El orden

### Módulo 0 — Respaldos verificados ✅ HECHO
Ver [`RESPALDOS.md`](RESPALDOS.md). Falta configurar `BACKUP_CLAVE` y el cron
en el servidor.

Hoy la base vive en un solo disco. Las instantáneas de GCE recuperan el disco
de ayer, no la base de esta mañana, y nadie las probó restaurándolas.

Una copia que nunca se restauró no es una copia. Se hace primero porque es el
único módulo cuya ausencia puede borrar todo lo demás.

### Módulo 1 — Memoria del cliente ✅ HECHO
Colección `Cliente` separada de `Conversacion` —una persona puede tener varios
hilos el día que haya más canales—, con nombre y notas del dueño, etiquetas, y
una ficha que escribe el modelo cada 8 mensajes y en segundo plano, para no
pagar una llamada por cada línea ni hacer esperar al cliente.

Pendiente encima de esto: que la ficha alimente el lead scoring, y agregar por
rubro lo que revelan las fichas (ver el foso del punto 3).

### Módulo 2 — Acciones (tools) ✅ HECHO
Registro de herramientas en `services/herramientas.js`, bucle de *function
calling* acotado a 3 vueltas, y las dos primeras acciones: **consultar el
catálogo** y **anotar un pedido**. Con catálogo estructurado —los precios son
un dato editable, no texto enterrado en un documento— e importación pegando
desde una planilla.

Encima de esto ya se construyeron las de agenda —`consultar_disponibilidad`,
`crear_reserva`, `cancelar_reserva`— sin tocar el orquestador, que es la prueba
de que la costura estaba bien puesta. Siguen la misma vía `consultar_stock` y
`generar_pago`.

### Módulo 2b — Agenda con Google Calendar ✅ HECHO
Ver [`AGENDA.md`](AGENDA.md).

### Módulo 3 — Métricas y costo por conversación
Cuánto cuesta cada conversación (tokens + mensajes de Meta), cuántas se
resuelven sin humano, dónde se caen.

Va antes que los planes de precio porque **sin esto se cobra a ciegas**, y con
el cambio del 1 de octubre eso es cobrar por debajo del costo.

### Módulo 4 — Huecos agrupados
Ya existe la detección. Falta agrupar por tema ("envíos" ×32, "garantía" ×14) y
que el modelo redacte un borrador que el dueño acepta o corrige.

Delta chico sobre algo que ya funciona, valor alto: convierte el panel en un
ciclo de mejora en vez de una lista.

### Módulo 5 — Bandeja humana
Atender desde el panel sin abrir WhatsApp. El backend ya tiene lo esencial
(pausa y responder como humano); falta la interfaz y el tiempo real.

### Módulo 6 — Plantillas y opt-in
El módulo que **habilita legalmente** el seguimiento: registro de consentimiento,
gestión de plantillas aprobadas, envío fuera de la ventana de 24 h.

Sin esto, "recuperación de ventas" no es una función: es una infracción.

### Módulo 7 — Seguimiento automático
Recién ahora. Se apoya en el 6 para el envío y en el 1 para saber a quién.

### Módulo 7.5 — Modo "empleado"
Que el dueño configure un **objetivo** ("vender", "resolver dudas", "agendar"),
**reglas** ("no ofrecer más de 10% de descuento"), **productos prioritarios** y
una **estrategia** ("preguntar necesidad → recomendar → resolver objeciones").

Técnicamente es hacer configurable el prompt del sistema: cuesta poco. Pero
cambia el producto de "responde preguntas" a "trabaja para vos", que es la
diferencia que se puede vender y explicar en una frase.

Se cierra con el radar (módulo 3.5): el radar dice cuál es la objeción
principal, el modo empleado deja escribir la estrategia para responderla, y las
métricas dicen si funcionó. Ese ciclo completo no lo tiene armado ningún
competidor.

### Módulo 3.5 — Radar del negocio
Analizar todas las conversaciones y devolver lo que el dueño no puede ver
solo: qué se pregunta más, dónde se caen los clientes, a qué hora escriben,
cuál es la objeción que más aparece.

Va pegado a las métricas (módulo 3) porque comparten el trabajo de recorrer las
conversaciones, pero responde otra pregunta: métricas es "cuánto me cuesta",
radar es "qué me está pasando".

### Módulo 8 — Versionado del cerebro
Ya está a mitad de camino: el conocimiento son fragmentos con `activo`. Falta
agrupar cambios en versiones y poder volver atrás.

Barato, y necesario antes de dejar que el sistema aprenda solo.

### Módulo 9 — Multi-tenant real
Facturación, límites por plan, alta de clientes sin script. Es lo que convierte
esto en SaaS. El modelo de datos ya está aislado por negocio, que era la parte
difícil.

---

## Lo que yo dejaría para después, y por qué

No porque sean malas ideas — porque **el costo de construirlas ahora supera lo
que devuelven hoy**.

| Idea | Por qué esperar |
|---|---|
| **Ocho agentes especializados** | Con un negocio y poco volumen, un modelo bien instruido con herramientas responde mejor que un orquestador repartiendo entre ocho agentes: menos latencia, menos costo, menos formas de fallar. Los "agentes" del diagrama son, hoy, **herramientas** (módulo 2). Se parten en agentes cuando haya evidencia de que uno solo no da. |
| **Laboratorio de IA / simulación** | Simular 100 conversaciones cuesta plata y no predice bien el comportamiento real. Sin tráfico real no hay contra qué validar. Vuelve a tener sentido con volumen. |
| **Omnicanal** | Cada canal son semanas y su propio set de reglas. Antes conviene probar que el producto funciona en uno. |
| **Marketplace de agentes** | Un marketplace sin clientes es una página vacía. |
| **Modo autónomo** | Es lo más vendible y lo menos entregable. Además choca con la restricción 1: un agente que "sale a contactar" hace exactamente lo que Meta prohíbe. Tiene sentido como **recomendador** ("esto haría, ¿lo ejecuto?") una vez que existan métricas (3), plantillas (6) y seguimiento (7). |

---

## Qué significa "modular" en este código

Modular no es tener muchas carpetas: es que **agregar el módulo N+1 no obligue
a tocar los anteriores**. Las costuras que ya existen y hay que respetar:

- **`services/` es el borde del módulo.** Cada uno expone funciones, no
  objetos con estado. `routes/` traduce HTTP y no decide nada.
- **El proveedor de IA está aislado en `asistenteIA.js`.** Cambiarlo es tocar
  un archivo. Esa propiedad se pierde el día que otro módulo llame a OpenAI
  por su cuenta: si un módulo necesita el modelo, lo pide ahí.
- **Todo se filtra por `negocioId`.** `obtenerOFallar` lo exige a propósito.
  Cualquier módulo nuevo hereda el aislamiento gratis si respeta esa regla.
- **El conocimiento son fragmentos.** Búsqueda semántica, versionado y
  agrupación se construyen sobre esa tabla sin migrar nada.
- **Lo que sale a la red va en su propio servicio** (`metaWhatsapp.js`), para
  poder testear el resto sin tocar internet.

La regla práctica: **si un módulo nuevo obliga a editar `index.js` en más de
una línea, la costura está mal puesta.**
