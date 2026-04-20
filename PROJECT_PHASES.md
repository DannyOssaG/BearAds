# BearAds - Evaluacion y Cierre de Fases

Fecha de evaluacion: 2026-04-11

## Finalidad del proyecto

BearAds debe ser un SaaS para PyMEs LATAM que conecta el sitio web y los datos de Google del negocio para:

1. diagnosticar problemas y oportunidades reales de marketing,
2. priorizar que hacer primero,
3. convertir ese diagnostico en estrategia,
4. transformar la estrategia en campañas y entregables accionables.

En una frase:

BearAds convierte datos reales del negocio en diagnostico, estrategia y activacion de marketing.

## Evaluacion del estado actual

### Decision operativa de acceso

- El acceso actual por Google OAuth es temporal y controlado.
- Se usa como barrera de proteccion mientras la app sigue en modo desarrollador y solo el equipo interno debe entrar.
- La finalidad de este esquema es poder subir al servidor y hacer pruebas reales antes de abrir acceso general.
- La opcion de login o registro con correo debe permanecer visible en producto, pero desactivada temporalmente hasta completar ese flujo.

### Lo que ya esta fuerte

- Login con Google OAuth y sesiones persistidas en archivo.
- Workspace, membresias, roles, trial y panel admin inicial.
- Onboarding e Integraciones con estructura ya modelada.
- Analisis del sitio con scraping + GSC + GA4 + agentes de SEO, SEM, Contenido, CRO y Trafico.
- Generacion de plan estrategico de 30-90 dias.
- Generacion de creativos y estructuras de campana para Meta y Google.
- Landing, app principal y flujo de producto navegable.

### Lo que hoy dispersa el proyecto

- Branding mezclado entre `BearAds`, `MIRTHOS` y `nexusai`.
- Alcance demasiado amplio para el estado real del producto.
- `server.js` concentra demasiada responsabilidad.
- Persistencia en JSON local, util para MVP pero no para una fase comercial seria.
- Features secundarias o futuras dentro del core visible: TikTok, billing real, monitor CLI, etc.

### Riesgos principales

- Prometer mas de lo que el producto sostiene hoy.
- Hacer crecer modulos secundarios antes de cerrar el flujo principal.
- Seguir agregando features sin una definicion de "fase cerrada".

## Fases propuestas

Las fases de aqui en adelante se deben cerrar con criterio verificable.

### Fase 1 - Base del SaaS

Objetivo:
tener una base estable para autenticacion, sesion, workspace y estructura del producto.

Criterio de cierre:

- Login con Google funcional.
- Acceso interno controlado durante etapa de pruebas.
- Sesion persistente.
- Workspace creado automaticamente.
- Roles y membresias basicas disponibles.
- Landing y app principal separadas segun autenticacion.

Estado:
cerrada.

Evidencia en codigo:

- `server.js` auth/session/workspace/admin.
- `public/landing.html`
- `public/index.html`

### Fase 2 - Diagnostico con datos reales

Objetivo:
hacer que BearAds entregue valor inmediato conectando sitio + Google y devolviendo un diagnostico confiable.

Criterio de cierre:

- Analisis de sitio funcional.
- Integracion con GSC y GA4 util para el flujo principal.
- Respuesta consolidada con SEO, contenido, CRO y trafico.
- Dashboard mostrando valor del analisis sin pasos rotos.
- Mensajeria del producto enfocada en "diagnostico con datos reales".

Pendientes para cerrar:

- eliminar o ocultar modulos que distraen del flujo principal,
- corregir branding legado en backend, tests y UI,
- validar flujo completo URL -> analisis -> dashboard,
- mantener login con correo visible pero desactivado de forma intencional,
- documentar claramente la propuesta de valor de esta fase.

Estado:
en progreso.

### Fase 3 - Estrategia accionable

Objetivo:
convertir el diagnostico en un plan concreto de 30-90 dias.

Criterio de cierre:

- Plan estrategico consistente y util para un negocio real.
- Uso de contexto del analisis y datos conectados.
- Entregable claro, legible y accionable.
- Flujo visible desde dashboard o analisis hacia estrategia.

Estado:
parcialmente implementada, no cerrada.

### Fase 4 - Activacion de campanas

Objetivo:
pasar del plan a ejecucion con activos y campanas listas para lanzar.

Criterio de cierre:

- Generador de campanas Meta y Google funcionando.
- Creativos y copies alineados con el objetivo del negocio.
- Flujo claro desde estrategia hacia campanas.
- Solo canales realmente soportados visibles al usuario.

Estado:
parcialmente implementada, no cerrada.

### Fase 5 - Operacion del workspace

Objetivo:
dar control operativo minimo a owners/admins sin ampliar de mas el producto.

Criterio de cierre:

- Onboarding completo y guardado en servidor.
- Integraciones base visibles y reutilizables.
- Admin overview, users y billing basico sin mensajes placeholder en el core.
- Roles alineados con permisos reales.

Estado:
parcialmente implementada, no cerrada.

### Fase 6 - Pulido comercial

Objetivo:
dejar el producto listo para demo comercial consistente.

Criterio de cierre:

- Sin rastros de branding mixto.
- Sin promesas visibles de features no soportadas.
- Landing y app cuentan la misma historia del producto.
- README y pruebas alineados con BearAds.
- Salud tecnica minima validada.

Estado:
no iniciada formalmente.

### Fase 7 - Escalabilidad y siguiente version

Objetivo:
preparar el sistema para crecer sin romper el core.

Criterio de cierre:

- Modularizacion del backend.
- Sustitucion de almacenamiento JSON por base de datos.
- Hardening de seguridad y observabilidad.
- Priorizacion clara de features avanzadas.

Estado:
futura.

## Ubicacion actual estimada

BearAds hoy esta entre Fase 2 y Fase 4:

- Fase 1: cerrada.
- Fase 2: avanzada pero no cerrada.
- Fase 3: implementada a nivel funcional, no cerrada.
- Fase 4: implementada de forma parcial.
- Fase 5 en adelante: abiertas.

La conclusion practica es:

no debemos abrir nuevas lineas de producto.
Debemos cerrar primero el flujo principal:

URL + Google -> analisis -> estrategia -> campanas.

## Orden recomendado de cierre

1. Cerrar Fase 2.
2. Cerrar Fase 3.
3. Cerrar Fase 4.
4. Cerrar Fase 5.
5. Hacer pulido comercial de Fase 6.

## Primera lista de trabajo para cerrar Fase 2

- Unificar branding legado (`MIRTHOS`, `nexusai`) a `BearAds`.
- Revisar mensajes de UI que prometen futuras fases dentro del core.
- Reducir visibilidad de modulos no esenciales para el flujo principal.
- Validar coherencia entre landing, dashboard y analisis.
- Alinear README y test suite con el producto actual.

## Regla para no desviar el roadmap

Toda nueva tarea debe responder una de estas preguntas:

- mejora el diagnostico,
- mejora la estrategia,
- mejora la activacion,
- o mejora la operacion minima del workspace.

Si no responde a una de esas cuatro, no entra al core actual.

## Tesis competitiva del producto

BearAds no debe competir solo como:

- otra app de reportes,
- otro generador de contenido con IA,
- o otro dashboard de marketing.

BearAds debe competir como:

- plataforma que conecta datos reales,
- los convierte en decisiones,
- y permite ejecutar campañas y escalar operacion desde el mismo workspace.

La propuesta competitiva correcta hoy es:

- diagnostico con datos reales de Google,
- plan estrategico accionable,
- activacion con campañas y creativos,
- y una capa de 12 agentes especializados que acelera la ejecucion.

Lo que nos puede volver realmente competitivos:

- que el contexto del negocio viva en el workspace y se reutilice en todos los modulos,
- que las conexiones no solo muestren datos sino que habiliten ejecucion real,
- que pasar de analisis a campaña requiera el menor numero de pasos posible,
- y que BearAds se sienta como sistema operativo de crecimiento, no como coleccion de herramientas sueltas.

## Propuesta: Modo Arranque

Objetivo:

que BearAds funcione tambien para clientes que llegan sin datos, sin tracking o sin presupuesto para pauta.

Flujo propuesto:

1. detectar si el cliente no tiene GSC, GA4, Meta Pixel o cuentas conectadas.
2. activar automaticamente `Modo Arranque`.
3. mostrar un checklist guiado con instalacion minima.
4. permitir avanzar igual con diagnostico base, estrategia organica y plan de crecimiento.

Checklist minimo del Modo Arranque:

- conectar Google Search Console,
- conectar Google Analytics 4,
- instalar Meta Pixel si el negocio quiere paid social,
- validar eventos clave,
- verificar que el sitio ya puede medirse.

BearAds debe decir claramente:

- si no tienes datos, empieza por esto,
- si no tienes presupuesto, empieza por organico,
- si ya tienes base, entonces escala con pago.

## Nuevos campos de onboarding

Faltantes prioritarios para que la estrategia sea mas precisa:

- mercado principal,
- pais o region prioritaria,
- idioma principal,
- alcance deseado: local, nacional, regional o global,
- presupuesto actual para paid media,
- si hoy el negocio depende mas de trafico organico, referidos, social o pauta.

Impacto:

estos campos cambian directamente:

- keywords,
- copies,
- competencia,
- canales recomendados,
- presupuesto sugerido,
- y tipo de campaña o estrategia organica.

## BearAds Tracking

Objetivo:

dar una capa minima de medicion propia cuando el cliente todavia no tiene nada instalado.

No reemplaza completamente GA4, pero si evita que BearAds quede ciego.

Primera version recomendada:

- script ligero de tracking propio,
- pageviews basicos,
- origen de trafico basico,
- clics en CTAs,
- formularios enviados,
- eventos clave como WhatsApp, contacto o checkout,
- resumen por pagina y por fuente dentro del workspace.

Rol dentro del producto:

- GA4 + GSC siguen siendo la base ideal,
- BearAds Tracking funciona como red de seguridad para empezar a medir desde el dia 1.

## Criterio de evaluacion

Si hacemos bien estos 3 puntos, BearAds deja de depender de que el cliente llegue maduro y se vuelve mas competitivo porque puede acompañarlo desde:

- sin datos,
- sin tracking,
- sin presupuesto,

hasta:

- trafico medible,
- estrategia organica,
- campañas escalables.

## Regla de actualizacion al cerrar conversacion

Cada vez que cerremos una conversacion de trabajo, este archivo debe actualizarse para dejar trazado:

- en que fase estamos,
- que se avanzo en la conversacion,
- que quedo pendiente,
- y cual es el siguiente paso recomendado.

Objetivo:

usar este archivo como memoria operativa del proyecto para no depender solo del contexto del chat.

## Ultima actualizacion de trabajo

Fecha:
2026-04-11

Fase actual:
Fase 2 - Diagnostico con datos reales

Avances realizados en esta conversacion:

- Se documento formalmente la finalidad del proyecto y el esquema de fases.
- Se dejo registrado que Google OAuth es acceso temporal controlado para pruebas internas.
- Se dejo visible pero desactivada la opcion de registro con correo como decision operativa temporal.
- Se hizo limpieza de branding legado en backend, tests y documentacion base.
- Se corrigieron mensajes de UI que prometian fases futuras dentro del core.
- Se alineo mejor la landing con el nucleo real del producto: diagnostico, estrategia y activacion.
- Se agrego deteccion automatica de Google Search Console, GA4 y Google Ads despues del login con Google.
- Se conecto esa deteccion al frontend en Integraciones.
- Se permitio guardar en el workspace la seleccion de:
  - sitio de Search Console,
  - propiedad GA4,
  - cuenta de Google Ads.
- Se configuro el sistema para reutilizar por defecto esos valores guardados en:
  - Integraciones,
  - dashboard live de Google,
  - flujo de analisis.
- Se corrigio el flujo de "Analisis recientes" para que los nuevos reportes se guarden completos y puedan volver a abrirse desde el historial sin quedar vacios.
- Se agregaron menus desplegables para elegir desde la cuenta conectada el sitio de Search Console, la propiedad de GA4 y la cuenta de Google Ads que se quiere usar.
- Se estabilizo el deploy de pruebas corrigiendo dependencias conflictivas para Render:
  - nodemailer -> 6.9.16
  - node-cron -> 3.0.3
  - googleapis -> 144.0.0
  - gaxios -> 6.0.3
- El servidor de pruebas ya logra arrancar correctamente despues de esos ajustes.
- Se termino de validar el flujo de Google dentro del analisis:
  - GA4 ya detecta propiedades y muestra metricas reales.
  - Search Console ya quedo validado como parte del flujo de datos reales.
- El backend del Plan Estrategico ya puede recibir resumen estructurado del analisis para enriquecer el plan.
- El frontend del Plan Estrategico ahora:
  - reutiliza negocio, URL y contexto guardado,
  - muestra mejor las fuentes conectadas,
  - y envia el resumen del analisis al endpoint del plan.
- El flujo principal dentro de la app ya quedo mas conectado:
  - dashboard -> estrategia usa el ultimo analisis valido,
  - analisis -> estrategia muestra un CTA directo al terminar,
  - estrategia -> activacion ahora sugiere el siguiente modulo segun el objetivo.
- Se hizo una simplificacion visible del producto para bajar ruido no core:
  - la navegacion principal ahora prioriza dashboard, analisis, plan, campañas, creativos e integraciones,
  - agentes, score semanal y aprendizaje quedaron como soporte y extras,
  - el dashboard ya empuja mas fuerte a plan y campañas en vez de dispersar hacia modulos secundarios.
- Se ajusto la narrativa para mantener visible que BearAds tiene 12 agentes, pero como capacidad de apoyo y no como promesa principal.
- Se mejoro el contraste visual en bloques con fondos oscuros o muy cargados para que los textos se lean mejor.
- Se reforzo la jerarquia visual base de la app:
  - textos secundarios y muted con mejor contraste,
  - breadcrumbs, subtitulos y detalles del analisis mas legibles,
  - la UI se siente menos lavada en paneles secundarios.
- Se implemento una primera version del Modo Arranque para clientes sin datos o sin presupuesto:
  - el dashboard ahora detecta ese escenario,
  - muestra un checklist guiado,
  - y empuja primero a medicion minima, analisis y estrategia organica.
- Se amplio el onboarding para capturar contexto estrategico clave:
  - pais prioritario,
  - region o ciudad clave,
  - idioma principal,
  - alcance de crecimiento,
  - y nivel de presupuesto actual.
- Ese nuevo contexto ya viaja tambien al Plan Estrategico para evitar planes genericos y ajustar mejor SEO, contenido, expansion geografica y roadmap de pago.
- Se agrego BearAds Tracking v1:
  - endpoint publico de tracking,
  - script instalable `/bearads-tracker.js`,
  - resumen basico de pageviews, clicks y formularios,
  - y tarjeta visible en Integraciones con snippet de instalacion y estado de medicion.
- Se reforzo la experiencia del Modo Arranque:
  - BearAds Tracking ahora incluye pasos de instalacion visibles dentro de Integraciones,
  - y el Plan Estrategico ya muestra de forma explicita el contexto de mercado activo para que el usuario entienda desde que pais, region, idioma y alcance se esta construyendo el plan.
- Se aterrizo la ruta dual del producto dentro de la UI:
  - ahora el dashboard muestra una recomendacion central de Base de Crecimiento,
  - y esa recomendacion decide automaticamente entre Modo Arranque, Organico Ahora o Escalar con Ads segun el estado del negocio.
- El Plan Estrategico ya refleja esa misma ruta, para que la recomendacion de crecimiento y la recomendacion de activacion no se contradigan entre si.
- Se movio el bloque de contexto del negocio desde Aprendizaje hacia Plan Estrategico:
  - ahora el usuario configura ese contexto justo donde mas impacta la estrategia,
  - Aprendizaje deja de cargar esa responsabilidad en la parte superior,
  - y el mismo dato sigue reutilizandose para personalizar guias y respuestas.
- Ese contexto ya no solo se muestra en pantalla:
  - ahora tambien entra al prompt del Plan Estrategico como capa de negocio,
  - incluyendo industria, nivel de experiencia y descripcion comercial,
  - para reducir aun mas el riesgo de planes genericos.
- Se unifico el contexto de mercado dentro de Plan Estrategico:
  - el banner ya toma primero lo editado en el bloque superior,
  - ahora ese bloque tambien guarda region, idioma y alcance,
  - y el usuario puede volver a editarlo desde el propio banner sin buscar otra seccion.
- Se corrigio el presupuesto inicial del Plan Estrategico:
  - ahora el selector empieza en `$0`,
  - y si el onboarding indica `sin presupuesto`, el plan se alinea automaticamente con esa ruta organica.
- Se corrigio la navegacion de entregables en el dashboard:
  - el KPI de entregables ahora lleva al historial completo,
  - la lista de entregables recientes tambien es clickeable,
  - la navegacion interna de Aprendizaje ya contempla correctamente la pestaña de guias de plataforma,
  - y el historial de entregables ya puede abrir cada pieza completa en un modal, no solo descargarla.

Pendientes inmediatos:

- validar visualmente el flujo completo URL + Google -> analisis -> dashboard -> estrategia -> activacion,
- validar visualmente en preproduccion que el Plan Estrategico ya salga enriquecido con el contexto del analisis,
- validar en preproduccion la instalacion real de BearAds Tracking en un sitio y confirmar que lleguen pageviews, clicks y formularios,
- revisar si conviene guardar tambien dominio principal o multiples dominios permitidos para el tracker por workspace,
- revisar si conviene prellenar tambien objetivo y audiencia con logica mas fina segun onboarding y perfil,
- decidir si el siguiente paso del Modo Arranque sera un checklist tecnico de GA4/GSC, un plan organico de 30 dias o una auditoria guiada para clientes sin web madura,
- validar si la regla automatica de Base de Crecimiento se siente correcta en casos reales con:
  - cliente sin datos,
  - cliente con base organica pero sin ads,
  - y cliente listo para invertir,
- seguir reduciendo ruido de modulos no core dentro de landing, agentes y aprendizaje sin perder claridad comercial,
- revisar contraste y legibilidad en mobile para confirmar que la mejora visual tambien se mantiene ahi.

Siguiente paso recomendado:

validar en preproduccion el recorrido completo del usuario, incluyendo Modo Arranque y BearAds Tracking, y luego pulir la experiencia organica para clientes sin presupuesto antes de seguir abriendo mas modulos.

## Direccion de producto aterrizada

### Tesis oficial

BearAds no debe ser solo una app de analisis ni solo una app de ads.

BearAds debe ser una plataforma de crecimiento con dos caminos activos:

- base organica para negocios que aun no pueden o no deben invertir,
- y escalamiento pago para negocios listos para acelerar.

La promesa no es "hacer solo SEO" ni "lanzar anuncios porque si".
La promesa es:

construir una base de crecimiento que permita crecer hoy y escalar mejor cuando llegue el momento de invertir.

### Nombre de la ruta

Nombre recomendado:

Base de Crecimiento

Dentro de Base de Crecimiento existen dos ramas:

- Organico Ahora
- Escalar con Ads

### Como debe funcionar BearAds

#### 1. Cliente sin datos

BearAds debe activar Modo Arranque.

Objetivo:

- instalar medicion minima,
- ordenar negocio y mercado,
- hacer primer analisis,
- y construir una base organica util.

BearAds Tracking, GA4, Search Console y onboarding deben servir para sacar al cliente del estado "no se nada" o "no mido nada".

#### 2. Cliente sin presupuesto

BearAds debe activar Organico Ahora.

Objetivo:

- SEO tecnico,
- contenido con intencion,
- CRO,
- claridad de oferta,
- paginas clave,
- y distribucion organica.

Esto no significa excluir ads.
Significa preparar el terreno para que cuando haya presupuesto, no se desperdicie.

#### 3. Cliente con capacidad de invertir

BearAds debe activar Escalar con Ads.

Objetivo:

- usar Google Ads y Meta Ads,
- lanzar campañas mas rapido,
- usar el contexto ya guardado del negocio,
- y tomar decisiones con datos reales.

La inversion paga debe venir sobre una base mas clara, no sobre improvisacion.

#### 4. Cliente tipo agencia o con muchos proyectos

BearAds debe activar Modo Agencia.

Objetivo:

- ordenar varios clientes o proyectos,
- conectar fuentes una sola vez por cuenta,
- reutilizar contexto, estrategia y activacion,
- y reducir trabajo operativo repetido.

En este caso el valor no es solo crecer un negocio.
Es poder escalar la operacion de varios negocios con mas consistencia.

### Reglas de decision del producto

BearAds debe decidir entre "seguir fortaleciendo organico" o "ya es momento de ads" segun estas señales:

#### Todavia organico

- no hay medicion minima,
- no hay mercado objetivo claro,
- no hay propuesta de valor clara,
- no hay paginas o landings utilizables,
- no hay conversion minima,
- no hay trafico suficiente para aprender,
- o el presupuesto actual es inexistente.

En ese caso BearAds recomienda:

- instalar tracking,
- definir pais/region/idioma,
- mejorar sitio y conversion,
- y crear un plan organico de 30 a 90 dias.

#### Ya es momento de invertir en ads

- ya existe medicion minima,
- ya hay una oferta entendible,
- ya hay mercado objetivo definido,
- ya hay pagina o landing util,
- ya hay algun signo de traccion,
- o el cliente ya tiene capacidad real de invertir.

En ese caso BearAds recomienda:

- activar Google Ads o Meta Ads,
- usar creativos y campañas guiadas,
- priorizar canal segun objetivo,
- y medir el retorno desde el primer ciclo.

### Como debe verse en el producto

#### Onboarding

Debe capturar:

- tipo de negocio,
- objetivo,
- pais prioritario,
- region o ciudad,
- idioma,
- alcance,
- presupuesto actual,
- y plataformas existentes.

Con eso BearAds decide la ruta inicial.

#### Dashboard

Debe mostrar un bloque central llamado Base de Crecimiento.

Ese bloque debe decir una de estas tres cosas:

- primero mide y ordena,
- primero fortalece tu base organica,
- ya puedes escalar con ads.

Y para el escenario agencia debe decir:

- organiza, replica y escala varios proyectos.

#### Plan Estrategico

Debe devolver dos capas:

- que hacer ahora,
- y que desbloquea la siguiente etapa.

Ejemplo:

- hoy: SEO, CRO, contenido, tracking
- despues: Google Ads o Meta Ads

#### Campanas y Creativos

No deben sentirse aislados.
Deben sentirse como la fase de aceleracion cuando el negocio ya esta listo.

### Ventaja competitiva real

Esto hace a BearAds mas competitivo porque:

- no excluye negocios pequenos o inmaduros,
- no obliga a tener presupuesto desde el inicio,
- no se queda solo en diagnostico,
- y tampoco se queda solo en generacion de copies.

BearAds acompana al negocio desde:

- sin datos,
- sin presupuesto,
- con crecimiento organico,
- hasta escalamiento pago.

### Decision recomendada

La direccion oficial del producto debe ser:

BearAds construye la base de crecimiento del negocio y activa ads cuando el negocio ya esta listo para escalar mejor.
## 2026-04-11 — Plan Estratégico guiado por ruta

- El `Plan Estratégico` ahora hereda explícitamente la ruta detectada por BearAds: `Modo Arranque`, `Orgánico Ahora`, `Escalar con Ads` o `Modo Agencia`.
- Se añadió una tarjeta visible arriba del plan generado para mostrar:
  - ruta detectada,
  - mercado activo,
  - fuentes conectadas,
  - presupuesto actual.
- El endpoint `/api/strategic-plan` ya recibe `routeMode`, `routeBadge`, `routeTitle` y `routeCopy`, y usa esa señal para cambiar la lógica del prompt.
- Cada ruta ahora tiene instrucciones específicas:
  - `arranque`: medición mínima, orden de base y frenos a evitar,
  - `organico`: SEO/contenido/CRO primero y señales para empezar ads,
  - `ads`: mix orgánico + pago con control de escalamiento,
  - `agencia`: playbook reutilizable y operación multi-cuenta.
- Con esto el plan deja de ser un documento genérico y empieza a responder a la etapa real del cliente dentro del sistema.

## 2026-04-11 — Onboarding flexible para Modo Agencia

- El onboarding ya no bloquea `Modo Agencia` por faltar preguntas pensadas para un negocio individual.
- Si el usuario elige `Agencia / equipo experto`, ahora basta con completar:
  - nivel,
  - modelo del negocio.
- Para destrabar el flujo se asignan defaults razonables:
  - meta principal: `escalar operacion de varios clientes`,
  - país prioritario: `Multi-mercado`,
  - alcance: `regional`.
- Esto facilita probar y usar la ruta `MODO AGENCIA` sin obligar a llenar un formulario que no siempre aplica a una agencia multi-proyecto.

## 2026-04-12 — Fix guardado final del onboarding

- Se corrigió un bug en `completeOnboarding()`:
  - al guardar desde la última pantalla del modal, la función intentaba leer campos que ya no estaban montados en el DOM,
  - eso provocaba el toast `Completa las preguntas principales para continuar` aunque el usuario sí hubiera llenado los pasos previos.
- Ahora el guardado toma como fallback el estado persistido del onboarding (`getOnboardingState()`), así que:
  - el modal ya no falla por cambiar de pantalla,
  - el guardado final usa correctamente `knowledgeLevel`, `businessModel`, `mainGoal`, `mercado`, `alcance` y `platforms`,
  - y la ventana se cierra bien cuando la configuración se guarda.

## 2026-04-12 — Fix doble click handler en onboarding modal

- El botón principal del modal de onboarding tenía dos fuentes de acción:
  - `onclick` inline en el HTML,
  - y `primary.onclick` asignado dinámicamente en `renderOnboardingModal()`.
- Eso podía disparar validaciones o acciones duplicadas y dejar toasts engañosos como `Completa las preguntas principales para continuar`.
- Se eliminaron los `onclick` inline de los botones primario/secundario y quedaron como `type="button"` para que solo manden la acción definida por el render actual de la pantalla.

## 2026-04-12 — Onboarding validado por pantalla y login separado

- El modal de onboarding ahora valida por pantalla antes de avanzar:
  - pantalla 1: nivel, tipo de negocio y meta principal,
  - pantalla 2: país prioritario y alcance,
  - `Modo Agencia` mantiene una validación más ligera.
- Si falta algo, el sistema:
  - marca visualmente el campo,
  - muestra un toast específico,
  - y enfoca el primer campo pendiente.
- También se retiró del onboarding el bloque `Registro con correo`, porque ese mensaje pertenece al momento de autenticación/login, no al setup inicial del workspace.

## 2026-04-12 — Fix raíz del draft de onboarding

- Se identificó la causa principal del bucle del modal:
  - `getOnboardingState()` mezclaba estado local + remoto,
  - pero el estado remoto devolvía campos vacíos por defecto,
  - y esos vacíos terminaban pisando el draft local mientras el usuario avanzaba entre pantallas.
- Se corrigió la mezcla para que:
  - los valores locales sobrevivan cuando el remoto venga vacío,
  - `platforms` también conserve el draft local si el backend aún no tiene datos.
- Esto estabiliza el flujo de retroceder/avanzar y evita falsos `Completa las preguntas principales para continuar` al guardar.

## 2026-04-12 — Arquitectura comercial propuesta: Negocio, Expansión y Agency

### Tesis de pricing

BearAds no debería obligar a un negocio a “volverse agencia” solo porque quiere crecer.

La estructura comercial recomendada es:
- `Negocio`: una marca principal, un equipo pequeño, una operación central.
- `Expansión`: el mismo negocio, pero con más mercados, idiomas, regiones o una línea relacionada.
- `Agency`: operación multi-cliente o multi-marca para terceros.
- `Enterprise`: capas avanzadas de operación, seguridad y servicio.

La lógica comercial debe diferenciar:
- crecimiento del mismo negocio,
- vs operación para múltiples clientes.

### Nombres finales de planes

#### 1. BearAds Start

Para un negocio que quiere ordenar su base, medir y ejecutar lo esencial.

#### 2. BearAds Growth

Para un negocio que ya tiene base y quiere crecer en más canales, mercados o campañas.

#### 3. BearAds Expansion Add-on

Add-on del plan negocio. No es un plan separado: sirve para cubrir expansión por mercado, idioma, región o segunda línea de negocio relacionada.

#### 4. BearAds Agency

Para agencias o equipos que gestionan varios clientes, marcas o workspaces.

#### 5. BearAds Enterprise

Para operaciones más grandes con necesidades de control, soporte y escalamiento custom.

### Estructura recomendada de planes

| Plan | Quién es | Workspaces | Usuarios incluidos | Cliente / marca | Uso principal |
|---|---|---:|---:|---|---|
| Start | PyME o marca única | 1 | 1 | 1 marca principal | Diagnóstico, estrategia y activación base |
| Growth | Negocio en crecimiento | 1 | 3 | 1 marca principal | Más campañas, más automatización, más ejecución |
| Expansion Add-on | Negocio que entra a nuevos mercados | +0 | +0 o +1 opcional | misma empresa | Países, regiones, idiomas o segunda línea |
| Agency | Agencia o multi-cliente | 5 incluidos | 5 | múltiples clientes / marcas | Operación repetible y escalable |
| Enterprise | Equipos grandes | custom | custom | custom | seguridad, procesos, soporte y límites altos |

### Tabla de features recomendada

| Feature | Start | Growth | Expansion Add-on | Agency | Enterprise |
|---|---|---|---|---|---|
| 1 workspace | Sí | Sí | Mantiene el mismo | Sí, múltiples | Sí |
| Diagnóstico del sitio | Sí | Sí | Sí | Sí | Sí |
| Plan estratégico | Sí | Sí | Sí, ajustado por mercado | Sí | Sí |
| Integraciones Google | Sí | Sí | Sí | Sí | Sí |
| Campañas básicas | Sí | Sí | Sí | Sí | Sí |
| Creativos y copy | Sí | Sí | Sí | Sí | Sí |
| Tracking BearAds | Sí | Sí | Sí | Sí | Sí |
| Mercados / idiomas adicionales | No | Parcial | Sí | Sí | Sí |
| Usuarios extra | No | Sí | opcional | Sí | Sí |
| Workspaces / clientes múltiples | No | No | No | Sí | Sí |
| Roles y permisos | básico | medio | igual al plan base | avanzado | avanzado |
| Plantillas reutilizables | No | parcial | No | Sí | Sí |
| Dashboard por cartera | No | No | No | Sí | Sí |
| Soporte / onboarding premium | No | No | No | parcial | Sí |

### Regla de clasificación del cliente

BearAds no debe depender de una sola pregunta del onboarding. Debe combinar:
- `tipo declarado`,
- `estructura de la cuenta`,
- `uso real`.

#### Señales de `Negocio`
- 1 workspace
- 1 dominio principal
- 1 cuenta principal de ads
- 1-3 usuarios
- una sola marca

#### Señales de `Expansión`
- sigue siendo una sola empresa
- quiere crecer en otro país, región o idioma
- necesita contenido / campañas / SEO diferenciados por mercado
- puede tener una segunda línea relacionada, pero no opera clientes externos

#### Señales de `Agency`
- gestiona marcas de terceros o varios clientes
- múltiples dominios independientes
- múltiples cuentas de ads o assets por cliente
- varios usuarios internos
- necesidad de templates, handoff, permisos y repetición operativa

### Triggers de upgrade recomendados

#### Start → Growth
- más de 1 usuario activo en operación recurrente
- más campañas o creativos de los límites base
- uso recurrente de Google Ads / Meta / automatizaciones
- ya no solo diagnostica: también ejecuta semanalmente

#### Growth → Expansion Add-on
- el cliente mantiene la misma empresa, pero:
  - abre otro país o región,
  - cambia idioma,
  - necesita un plan diferenciado por mercado,
  - quiere separar reporting por geografía o línea.

#### Growth / Expansion → Agency
- más de 1 marca independiente o clientes de terceros
- más de 1 workspace real
- necesidad de permisos por equipo
- necesidad de reutilizar procesos en varias cuentas
- múltiples dominios o activos separados por cliente

#### Agency → Enterprise
- 10+ usuarios
- necesidades de seguridad, soporte o control avanzados
- operaciones complejas de múltiples equipos o unidades

### Reglas de producto para mantener el engagement

#### 1. No castigar el crecimiento

Un negocio que crece a otro país no debe sentir que “ya no cabe”.
Por eso `Expansion` debe ser add-on, no una migración traumática a otro tipo de plan.

#### 2. Cobrar por complejidad real

La complejidad real en BearAds viene de:
- más usuarios,
- más workspaces/clientes,
- más mercados,
- más ejecución y automatización.

No solo del número de features activadas.

#### 3. Mantener continuidad

El usuario debe sentir:
- `empecé con un plan pequeño`,
- `crecí sin salir de BearAds`,
- `cuando necesité más operación, simplemente amplié`.

### Copy listo para landing

#### Sección de pricing — intro

`BearAds crece contigo. Empieza con un solo negocio, añade expansión cuando abras nuevos mercados y pasa a Agency solo cuando realmente operes varios clientes.`

#### Plan Start

`Para una marca que necesita orden, datos y una ruta clara para crecer.`

#### Plan Growth

`Para negocios que ya no solo analizan: ahora ejecutan campañas, contenidos y optimizaciones de forma constante.`

#### Expansion Add-on

`Abre nuevos mercados sin cambiar de plataforma. Añade países, idiomas o regiones manteniendo la misma operación central.`

#### Plan Agency

`Para equipos que gestionan varios clientes y necesitan repetir procesos, ordenar workspaces y escalar con más velocidad.`

#### Enterprise

`Para operaciones más complejas que necesitan soporte, control y escalamiento a medida.`

### Copy listo para billing / upgrade prompts

#### Upgrade Start → Growth

`Ya estás usando BearAds para ejecutar, no solo para diagnosticar. Growth te da más capacidad para campañas, usuarios y activación continua.`

#### Upgrade Growth → Expansion

`Tu negocio ya está creciendo a nuevos mercados. Añade Expansion para separar estrategia, campañas y contexto por país, región o idioma sin salir de tu operación actual.`

#### Upgrade a Agency

`Ya no operas una sola marca. Agency te ayuda a gestionar varios clientes, workspaces y equipos sin improvisar procesos.`

#### Upgrade a Enterprise

`Tu operación ya necesita más control, soporte y escalabilidad. Enterprise adapta BearAds a tu estructura real.`

### Recomendación de empaque comercial

- `Start` y `Growth` deben estar visibles en la landing.
- `Expansion Add-on` debe mostrarse dentro del plan negocio como una ampliación natural.
- `Agency` debe tener CTA separado: `Hablar con ventas` o `Activar Agency`.
- `Enterprise` debe ser principalmente comercial / consultivo.

### Recomendación UX dentro de BearAds

En el producto, el usuario debería ver uno de estos estados:
- `Plan actual: Start`
- `Plan actual: Growth`
- `Add-on activo: Expansion`
- `Modo Agency`

Y el sistema debería disparar recomendaciones como:
- `Tu negocio ya está listo para Growth`
- `Parece que estás abriendo nuevos mercados`
- `Tu operación ya se comporta como una agencia`

## 2026-04-12 — Pricing visible en landing + billing modal v1

- Se actualizó la sección de precios de la landing para reflejar la nueva arquitectura comercial:
  - `BearAds Start`
  - `BearAds Growth`
  - `BearAds Agency`
  - bloque explícito para `Expansion Add-on`
- La landing ya comunica que:
  - un negocio puede crecer sin saltar a Agency,
  - `Expansion` cubre países, idiomas y regiones,
  - `Agency` se reserva para operación multi-cliente real.

- También se creó una primera versión del `billing modal` dentro de la app:
  - muestra recomendación actual de plan,
  - muestra cards resumidas de `Start`, `Growth` y `Agency`,
  - revela el bloque `Expansion Add-on` cuando detecta expansión geográfica,
  - y lista `triggers de upgrade` según el uso real del workspace.

- La lógica del modal de plan ahora cruza:
  - onboarding,
  - ruta detectada,
  - uso de análisis,
  - tipo de operación (`negocio`, `expansión`, `agencia`).

- Esto baja la estrategia comercial a interfaz real y prepara el siguiente paso:
  - conectar el modal con billing/checkout real,
  - disparar recomendaciones automáticas más precisas dentro del producto.

## 2026-04-12 — Acciones reales en billing modal v1

- El modal de plan ya no se queda solo en sugerencias visuales.
- Se agregó una capa persistente `commercial` al workspace para guardar intención comercial del usuario:
  - `targetPlan`
  - `addOns`
  - `agencyLead`
  - `contactRequested`
  - `lastIntentAt`
  - `lastIntentSource`

- Ahora el botón principal del modal ejecuta acciones reales:
  - `Growth`: guarda intención de upgrade a growth,
  - `Expansion`: guarda `growth + expansion`,
  - `Agency`: marca interés comercial y lead de agency.
- Además, en esta etapa interna, el botón también puede dejar el plan activo de forma inmediata dentro del workspace para evaluación de producto, sin depender todavía de la pasarela de pagos.

## 2026-04-12 — Billing modal v2: selección real y cancelación

- El modal de plan ya funciona como selector explícito:
  - `Start`
  - `Growth`
  - `Agency`
- Cada card es clickeable y el CTA principal cambia según el plan elegido.
- Se añadió un comparativo visible entre:
  - plan actual,
  - plan seleccionado,
  - y el efecto esperado del cambio.
- El sistema ahora valida si el usuario ya está en el plan seleccionado y desactiva el CTA para evitar upgrades redundantes.
- Se retiró el botón `Reset`.
- Se añadió `Cancelar plan actual`, que por ahora devuelve la cuenta a `BearAds Start` para pruebas internas.
- Para pruebas más finas, el superadmin sigue pudiendo cambiar el plan desde billing sin depender del modal del usuario final.

- Esto permite que BearAds recuerde el siguiente paso comercial del usuario incluso antes de tener checkout real integrado.

## 2026-04-17 — Planes alineados a Trial / Starter / Pro / Agency

- Se unificó la nomenclatura comercial en producto y landing:
  - `Trial`
  - `Starter`
  - `Pro`
  - `Agency`
- El modal de planes ya no usa `Start / Growth`; ahora refleja mejor la realidad comercial del producto.
- `Cancelar plan actual` quedó visible y coherente:
  - si la cuenta ya está en `Trial`, el botón aparece deshabilitado con mensaje claro;
  - si la cuenta está en `Starter`, `Pro` o `Agency`, permite volver a `Trial` para evaluación interna.
- Se agregó una matriz base de funciones por plan en frontend para evaluación de producto:
  - `Trial`: sin campañas, imágenes ni PDF
  - `Starter`: diagnóstico, agentes y estrategia, pero sin Ads ni creativos avanzados
  - `Pro`: campañas, Ads, creativos, imágenes y PDF
  - `Agency`: todo Pro + operación multi-cliente
- Las funciones bloqueadas ahora cambian su CTA a `Actualizar plan` y abren el modal comercial:
  - campañas
  - Meta Ads
  - Google Ads
  - creativos con IA
  - generación de imágenes
  - descarga de PDF
- Además, se añadió una primera capa de enforcement en backend para rutas de mayor costo o riesgo:
  - `generate-creative`
  - `generate-image`
  - endpoints reales de `Google Ads`
  - acceso real a `Meta Ads`
- El límite de `4 análisis por día` para `Trial / free` ya quedó también en backend:
  - se guarda por workspace en un contador diario propio,
  - se valida dentro de `/api/analyze`,
  - y devuelve `429` + `daily_analysis_limit` cuando se llega al tope,
  - evitando que el límite se pueda saltar solo limpiando el navegador o pegándole directo al endpoint.
- El superadmin en `Billing` ya tiene una acción visible para `Reabrir onboarding desde cero`, limpiando:
  - estado remoto del workspace
  - estado local del navegador
- El cambio manual de plan desde superadmin ahora también sincroniza el estado comercial del workspace, para que el modal y las recomendaciones no queden desfasadas.
- La landing de precios se actualizó para mostrar:
  - `Trial`
  - `Starter`
  - `Pro`
  - `Agency`
  - más explicación del `Expansion Add-on` sobre `Pro`
- En `Trial / free` se fijó un límite operativo de `4 análisis por día` usando el historial diario del usuario dentro de la app, con CTA a upgrade cuando llega al tope.
- Los `12 agentes` ya quedaron como función paga:
  - en `Trial` el usuario puede analizar, pero no abrir agentes,
  - desde `Starter` en adelante se habilita el acceso completo,
  - el sidebar, la página de agentes y la apertura real del workspace ya respetan esta regla.
- El producto ahora deja mucho más claro qué significa cada etapa del plan:
  - en `Trial` se bloquean visualmente `Campañas` y `Creativos` desde la navegación y el dashboard,
  - `Integraciones` sigue accesible para conectar la base, pero sus tabs avanzadas (`Meta Ads`, `Google Ads`, `Email`, `Webhooks`) ya empujan a upgrade,
  - el dashboard muestra explícitamente la progresión: `En Trial analizas. En Starter activas agentes. En Pro ejecutas campañas.`
- Se reforzó la lectura comercial directamente en UI:
  - el sidebar ahora muestra chips contextuales como `STARTER` o `PRO` cuando un módulo requiere upgrade,
  - los headers de `Agentes`, `Campañas`, `Creativos` e `Integraciones` muestran chips de disponibilidad (`Desde Starter`, `Desde Pro`, `Base en Trial`, etc.),
  - así el usuario entiende el alcance del plan antes de hacer clic.
- El sidebar se simplificó para no duplicar el módulo de agentes:
  - se eliminó la lista larga de agentes individuales del lateral,
  - queda una sola entrada `Agentes de apoyo`, más limpia y coherente con la navegación principal.
- El `Plan Modal` y el footer del sidebar ahora hablan más en lenguaje de producto:
  - muestran qué puedes hacer hoy con tu plan actual,
  - y presentan los planes por capacidad (`diagnóstico`, `agentes`, `campañas`, `multi-cliente`) en vez de verse como estado técnico.
- Se hizo una pasada de consistencia final de copy entre:
  - `landing`,
  - `dashboard`,
  - `plan modal`,
  - `billing/superadmin`.
- La narrativa ya quedó unificada así:
  - `Trial`: diagnostica y conecta la base,
  - `Starter`: activa agentes y estrategia,
  - `Pro`: ejecuta campañas, creativos e informes,
  - `Agency`: escala cartera, usuarios y operación multi-cliente.
- También se hizo una pasada final de microcopy en botones, comparativos y toasts:
  - se priorizó `ver planes`, `elegir`, `pasar a` y `etapa actual`,
  - y se redujo la mezcla previa con `actualizar`, `subir`, `mejorar` y `plan actual`.
- La campana del topbar ahora sí funciona como preferencia real de notificaciones del navegador:
  - el usuario puede activarlas o desactivarlas con el botón `🔔`,
  - BearAds avisa cuando termina una tarea larga si la pestaña quedó en segundo plano,
  - se cubrieron al menos `análisis`, `plan estratégico`, `campañas`, `creativos` e `imagen`.
- Se hizo una pasada visual final sobre estados vacíos, banners y helpers:
  - `dashboard`, `estrategia`, `campañas`, `integraciones`, `creativos`, `score semanal`, `agentes` y `análisis` ahora usan un lenguaje más orientado a producto,
  - el tono dejó de sonar como mensajes aislados y ahora refuerza la ruta `base -> estrategia -> ejecución -> escalamiento`,
  - los estados vacíos explican mejor qué desbloquea cada siguiente paso dentro de BearAds.
- Se reforzó una segunda capa de jerarquía visual en `dashboard` y `plan estratégico`:
  - los vacíos ahora usan CTAs reales en botón y no solo links de texto,
  - el banner guiado del dashboard quedó menos denso y con un bloque más fuerte de `haz esto ahora`,
  - la salida del plan resalta mejor el siguiente paso recomendado con cards de acción más visibles.
