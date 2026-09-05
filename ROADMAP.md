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

### 2. Distribución que ya existe
ChatGo tiene clientes y Vitalis está adentro de consultorios. Vender a quien ya
te conoce es la ventaja que la mayoría de las startups no tiene y no puede
comprar. **Un "Wabot para consultorios" enchufado a la agenda de Vitalis es
algo que literalmente ningún competidor puede hacer**, porque nadie más tiene
Vitalis.

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

Empezar por el vertical donde ya estamos adentro.

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

### Módulo 1 — Memoria del cliente
Quién es, qué preguntó antes, qué compró. Es lo que más cambia la experiencia
por lo que cuesta: son campos en `Conversacion` más un resumen que ya se puede
armar con el modelo que se está pagando igual.

Diferenciador real y barato. Va primero de las funciones.

### Módulo 2 — Acciones (tools)
Que el bot **haga** en vez de explicar cómo hacer. `consultar_precio()`,
`crear_reserva()`, `consultar_stock()`.

Es el salto de calidad más grande del roadmap: la diferencia entre "podés
reservar llamando al…" y una reserva hecha. Técnicamente es *function calling*
sobre lo que ya existe.

**Acá está el verdadero punto de modularidad**: un registro de herramientas
donde cada una se agrega sin tocar el orquestador.

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
