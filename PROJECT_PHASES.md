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
