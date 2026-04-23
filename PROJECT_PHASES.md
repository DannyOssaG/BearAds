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
iniciada.

Bloque activo:

- validación por escenarios `Trial / Starter / Pro / Agency`,
- coherencia entre gating visible y gating real,
- mensajes de upgrade alineados con el plan correcto,
- y revisión de recorridos completos sin contradicciones entre módulos.

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
- Fase 5: muy avanzada.
- Fase 6: iniciada.
- Fase 7: futura.

La conclusion practica es:

no debemos abrir nuevas lineas de producto.
Debemos cerrar primero el flujo principal:

URL + Google -> analisis -> estrategia -> campanas.

## Orden recomendado de cierre

1. Cerrar Fase 2.
2. Cerrar Fase 3.
3. Cerrar Fase 4.
4. Cerrar Fase 5.
5. Ejecutar y cerrar Fase 6.

## Matriz activa de Fase 6

Escenarios que se están validando ahora:

1. `Trial`
- puede analizar,
- no puede abrir agentes,
- no puede ejecutar campañas ni creativos,
- ve CTA claros para pasar a Starter o Pro,
- y no cae por error en tabs o módulos que no le corresponden.

2. `Starter`
- puede usar agentes y estrategia,
- no puede ejecutar campañas ni creativos,
- ve bloqueos coherentes hacia Pro,
- y no encuentra navegación que prometa ejecución antes de tiempo.

3. `Pro`
- puede usar agentes, campañas, creativos, imágenes y reportes,
- puede entrar a integraciones avanzadas,
- y no encuentra bloqueos visibles que contradigan su plan.

4. `Agency`
- mantiene todo lo de Pro,
- puede entrar a capacidades avanzadas de operación,
- y el producto le habla como operación multi-cliente, no como negocio único.

5. `Superadmin`
- puede reiniciar onboarding,
- cambiar etapa comercial,
- revisar billing,
- y usar ese entorno para pruebas manuales sin romper el flujo del usuario final.

Avance reciente de esta fase:

- el backend ya alinea Google Ads y Meta Ads con el plan real del workspace;
- `gads/test`, `gads/campaigns`, `gads/keywords`, `gads/optimize`, `meta/verify` y `meta/optimize` ahora exigen autenticación y plan correcto;
- cuando una llamada del frontend cae por `plan_limit`, la app abre el modal de planes y propone la etapa correcta en vez de quedarse en error técnico;
- los flujos de Google Ads y Meta dentro de la app ya consumen esa capa común, así que `Trial` y `Starter` reciben upgrade claro también si el bloqueo viene del servidor.
- `Score Semanal` quedó alineado con `Pro`: navegación, chips, preview, envío y suscripción ya no quedan abiertos para `Trial` o `Starter`;
- los endpoints de email (`subscribe`, `preview`, `send-now`) ahora exigen autenticación y el feature de reportes.
- también quedó protegido `email/subscriptions`, para que el módulo de reportes no tenga una ruta lateral abierta fuera de `Pro`.
- Stripe ya quedó instalado como dependencia del proyecto.
- Se montó la base real de `Fase 7`:
  - `GET /api/billing/status`
  - `POST /api/billing/create-checkout`
  - `POST /api/billing/create-portal`
  - `POST /api/stripe/webhook`
- El modal de planes ya sabe distinguir entre `modo pruebas` y `checkout real`: si Stripe está configurado, abre Checkout o Portal; si no, sigue usando activación interna para QA.
- Queda como tarea adicional del bloque de billing:
  - mostrar en `Superadmin` si Stripe está configurado,
  - exponer `plan`, `status`, `customer id` y `subscription id`,
  - y añadir una acción simple de `refrescar estado de billing`.

## Checklist ejecutable de cierre final

Este bloque sirve para cerrar producto con criterio real, no solo con percepción.

Regla de uso:

- Cada escenario debe quedar marcado como:
  - `cerrado`
  - `pendiente`
  - `fallo`
- Si una sola prueba crítica falla, la fase no se cierra.
- La validación debe hacerse idealmente en servidor de pruebas, no solo en local.

### Escenario 1 - Trial

Objetivo:
confirmar que `Trial` deja entrar al valor base sin prometer ejecución premium.

Checklist:

- login correcto y sesión estable;
- onboarding abre, guarda, salta y no reaparece roto;
- dashboard muestra mensaje correcto:
  - `En Trial analizas`
  - `En Starter activas agentes`
  - `En Pro ejecutas campañas`
- `Analizar Sitio` funciona y respeta límite diario;
- al llegar al límite diario, aparece CTA correcto de plan;
- `Agentes de apoyo` no abre y empuja a `Starter`;
- `Campañas` no abre y empuja a `Pro`;
- `Creativos` no abre y empuja a `Pro`;
- `Score Semanal` no abre y empuja a `Pro`;
- `Integraciones` deja conectar base, pero tabs avanzadas quedan bloqueadas;
- `Perfil` deja ver `Plan` y `Facturas y suscripción` con copy correcto según billing real o modo pruebas;
- no hay errores técnicos crudos visibles al usuario.

Criterio de cierre:

- el usuario siente valor inicial,
- entiende por qué está en Trial,
- y nunca entra a módulos premium como si fueran suyos.

### Escenario 2 - Starter

Objetivo:
confirmar que `Starter` abre estrategia y agentes, pero no finge ejecución completa.

Checklist:

- login y sesión correctos;
- dashboard refleja que ya puede activar agentes y estrategia;
- `Plan Estratégico` funciona con contexto, mercado y plan detectado;
- `Agentes de apoyo` abre normal;
- filtros, búsqueda e historial de agentes funcionan;
- `Campañas` sigue bloqueado hacia `Pro`;
- `Creativos` sigue bloqueado hacia `Pro`;
- `Score Semanal` sigue bloqueado hacia `Pro`;
- tabs avanzadas de `Integraciones` siguen protegidas si dependen de `Pro`;
- entregables e historial funcionan sin prometer descargas premium si no aplican;
- mensajes de upgrade apuntan siempre a `Pro`, no a otro plan equivocado.

Criterio de cierre:

- el usuario puede pasar de análisis a estrategia,
- usar agentes,
- y entiende claramente que la ejecución completa vive en `Pro`.

### Escenario 3 - Pro

Objetivo:
confirmar que `Pro` puede ejecutar de verdad sin bloqueos falsos.

Checklist:

- login y sesión correctos;
- dashboard y modal de plan muestran `Pro` correctamente;
- `Agentes de apoyo` abre normal;
- `Campañas` genera campañas;
- `Creativos & Ads` genera copies;
- `Generación de imagen` funciona;
- `Score Semanal` deja preview, suscripción y envío;
- `Integraciones` deja usar Google Ads / Meta / Email según estado real;
- entregables pueden abrirse y descargarse;
- no aparecen badges o bloqueos de upgrade en módulos que ya pertenecen a `Pro`;
- backend no devuelve `plan_limit` por error en rutas de `Pro`.

Criterio de cierre:

- `Pro` se siente como ejecución real, no como demo maquillada.

### Escenario 4 - Agency

Objetivo:
confirmar que `Agency` mantiene todo lo de `Pro` y además comunica operación multi-cliente.

Checklist:

- onboarding / contexto en modo agencia no bloquea guardado;
- dashboard detecta `Modo Agencia`;
- `Plan Estratégico` detecta `Modo Agencia`;
- modal de planes muestra narrativa multi-cliente correcta;
- el producto habla de cartera, cuentas, usuarios y reutilización;
- `Agency` no pierde nada de lo que ya tenía `Pro`;
- permisos y paneles avanzados no muestran contradicciones visibles;
- `Superadmin` puede seguir probando cambios de etapa sobre workspaces agency.

Criterio de cierre:

- `Agency` se siente como operación multi-cliente,
- no solo como `Pro` con otro nombre.

### Escenario 5 - Stripe y billing real

Objetivo:
cerrar el flujo comercial real de punta a punta.

Checklist:

- Stripe configurado con:
  - `sk_...`
  - `whsec_...`
  - `price_...` mensual y anual por plan;
- `Plan Modal` deja elegir:
  - `mensual`
  - `anual`
- checkout abre con el plan correcto;
- checkout abre con el intervalo correcto;
- al volver con `billing=success`, la app sincroniza el plan;
- `billing=cancel` no rompe estado;
- `billing=portal` refresca estado correctamente;
- `Superadmin > Billing` muestra:
  - `customer id`
  - `subscription id`
  - `price id`
  - estado comercial;
- el rol de usuario se actualiza:
  - `member_trial`
  - `member_paid`
- `Perfil` muestra:
  - `Plan`
  - `Facturas y suscripción`
- `Facturas y suscripción` abre Stripe portal cuando corresponde;
- downgrade abre modal de confirmación y retención;
- downgrade a un plan menor o a trial no ocurre “de golpe” sin confirmación;
- upgrade, downgrade y cancelación dejan el estado correcto en UI y backend.

Criterio de cierre:

- el sistema comercial deja de depender de activación manual para validarse.

### Escenario 6 - Superadmin y pruebas operativas

Objetivo:
confirmar que el entorno interno sirve para probar sin romper la experiencia final.

Checklist:

- `Superadmin` abre solo para perfiles autorizados;
- tabs visibles coinciden con permisos;
- `Usuarios` deja buscar por:
  - correo
  - nombre
  - ID de perfil;
- `Billing` deja buscar usuarios sin perder foco;
- `Reiniciar trial` por usuario funciona;
- `Reiniciar trial del workspace` funciona;
- `Reabrir onboarding desde cero` funciona;
- cambio manual de etapa comercial se guarda;
- refresh de billing funciona;
- notas internas de billing se guardan;
- no hay botones muertos en `Superadmin`.

Criterio de cierre:

- el equipo interno puede probar todo el flujo sin tocar datos manualmente en archivos.

## Cierre formal recomendado

Orden inmediato para cerrar fases:

1. ejecutar completo el checklist de `Trial`;
2. ejecutar completo el checklist de `Starter`;
3. ejecutar completo el checklist de `Pro`;
4. ejecutar completo el checklist de `Agency`;
5. ejecutar completo el checklist de `Stripe y billing real`;
6. ejecutar completo el checklist de `Superadmin`;
7. corregir hallazgos abiertos;
8. declarar cerradas:
  - `Fase 2`
  - `Fase 3`
  - `Fase 4`
  - `Fase 5`
  - `Fase 6`

Condición:

si billing real queda estable y la QA por planes sale limpia, la base web puede considerarse lista para pasar a la etapa móvil.

## 2026-04-23 — Resultado real de la ronda final QA

### Hallazgo corregido

- Se encontró y corrigió un bug real en `Superadmin > Billing`:
  - al cambiar manualmente un workspace entre `Trial` y `Starter/Pro`, el `workspace.subscription` sí cambiaba,
  - pero las membresías no se sincronizaban en esa misma ruta,
  - por eso `/api/session` podía seguir mostrando `member_paid` o `member_trial` aunque el plan ya hubiera cambiado.
- Fix aplicado:
  - `app.patch('/api/admin/billing-overview')` ahora ejecuta `syncWorkspaceMembershipPlanRoles(workspace)` antes de persistir cambios.
- Resultado validado:
  - `Trial` devuelve `membership.role = member_trial`
  - `Starter` devuelve `membership.role = member_paid`

### Resultado por escenario

#### Trial

- Validado con servidor local corriendo y sesión autenticada real.
- Confirmado:
  - `/api/session` devuelve `plan: trial`, `status: trialing`, `role: member_trial`
  - `/api/gads/test` responde `plan_limit`
  - `/api/email/preview` responde `plan_limit`

Estado:
- cerrado en backend para este bloque.

#### Starter

- Validado con servidor local y sesión autenticada real.
- Confirmado:
  - `/api/session` devuelve `plan: starter`, `status: active`, `role: member_paid`
  - `/api/billing/status` refleja `stripeConfigured: true`
  - `/api/admin/billing-overview` refleja `customerId`, `subscriptionId`, `priceId`

Estado:
- cerrado en backend para este bloque.

#### Pro

- Validado temporalmente cambiando el workspace desde `Superadmin > Billing`.
- Confirmado:
  - `/api/session` devuelve `plan: pro`, `status: active`
  - `/api/gads/test` deja de bloquear por plan y entra al flujo real de Google Ads
  - `/api/email/preview` deja de bloquear por plan y genera HTML del reporte

Estado:
- cerrado en backend para este bloque.

#### Agency

- Validado temporalmente cambiando el workspace desde `Superadmin > Billing`.
- Confirmado:
  - mantiene el comportamiento base de `Pro`
  - no pierde acceso a rutas que ya pertenecen a ejecución premium

Riesgo residual:
- la parte diferencial de `Agency` sigue siendo más de producto/UX/comunicación que de una capa técnica separada y profunda.

Estado:
- funcional para esta etapa, pero todavía no “enterprise-complete”.

#### Stripe y billing real

- Validado con checkout de prueba aprobado en Stripe.
- Confirmado:
  - `create-checkout` genera sesión real
  - `create-portal` devuelve portal real
  - `billing-overview` y `billing/status` muestran `customer`, `subscription` y `price`
  - el workspace quedó sincronizado después del checkout
  - el rol del miembro también quedó alineado al plan pagado

Estado:
- operativo para cierre web.

#### Superadmin

- Validado con endpoints y panel reales.
- Confirmado:
  - `Billing` lista usuarios y busca por correo / nombre / ID
  - `Reiniciar trial` funciona
  - cambios manuales de etapa comercial persisten
  - notas de billing quedan trazadas

Estado:
- operativo para QA y soporte interno.

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
- Se hizo una lectura formal del frente móvil para preparar la app:
  - la versión actual responsive/PWA sí sirve como referencia funcional,
  - pero no conviene usarla como base final de app porque sigue siendo una web grande comprimida en móvil,
  - se propuso una ruta `React Native + Expo` reutilizando backend, auth, planes y lógica del producto.

## Cierre Web Antes de Móvil

Antes de abrir la fase móvil, BearAds debe cerrar su base web en este orden:

1. Estabilidad funcional
   - revisar flujos completos de análisis, estrategia, campañas, creativos, entregables, integraciones, billing y onboarding,
   - corregir errores de navegación, modales, loaders, estados vacíos y edge cases.

2. Gating real por plan
   - asegurar enforcement consistente entre frontend y backend para `Trial`, `Starter`, `Pro` y `Agency`,
   - evitar que funciones pagas se puedan usar por rutas sueltas o llamadas directas.

3. Integraciones y datos reales
   - validar Google, GSC, GA4, Google Ads, Meta y BearAds Tracking,
   - revisar estados de error por permisos, reconexión, tokens vencidos y cuentas sin acceso.

4. Persistencia y memoria
   - dejar firmes drafts, onboarding, contexto estratégico, entregables, commercial state y selección de workspace,
   - asegurar que al recargar no se rompa el contexto del usuario.

5. UX final web
   - cerrar responsive fino,
   - consistencia visual,
   - jerarquía de CTA,
   - banners, helpers, estados vacíos y navegación final.

6. QA de producto
   - probar por tipo de cuenta: `Trial`, `Starter`, `Pro`, `Agency`, `Superadmin`,
   - probar por escenario: sin datos, orgánico, listo para ads, agencia/multi-proyecto.

7. Prueba real de pasarela de pagos
   - validar selección de plan, checkout, upgrade, downgrade, cancelación, renovación y webhooks,
   - comprobar que el cambio de plan sincroniza bien el workspace y bloquea/desbloquea funciones como corresponde.

### Fase 1 — Estabilidad funcional (bloque operativo)

Objetivo:
dejar la base web sin pasos rotos, con estados consistentes y con criterios claros de “esto ya está cerrado”.

#### Onboarding

Checklist:

- el flujo avanza sin perder datos entre pasos;
- `Atrás`, `Siguiente` y `Guardar y continuar` responden bien;
- modo `agencia` no se bloquea por validaciones pensadas para negocio único;
- `Saltar por ahora` no reaparece de forma inconsistente al volver a entrar;
- reiniciar onboarding desde superadmin limpia estado local y remoto;
- al terminar, se cierra la modal y se refleja el contexto en dashboard y estrategia.

Criterio de cierre:

- el usuario puede empezar desde cero, completar onboarding, volver atrás, corregir y terminar sin toasts falsos ni pérdida de información.

#### Dashboard

Checklist:

- KPI de análisis, entregables y score cargan bien;
- CTA rápidos llevan a la vista correcta;
- vacíos de análisis y entregables responden con CTA funcional;
- bloque `Base de Crecimiento` o recomendación principal siempre muestra una ruta válida;
- historial reciente de análisis y entregables abre bien sus destinos;
- no quedan cards que aparenten ser clickeables pero no hagan nada.

Criterio de cierre:

- el dashboard funciona como punto de entrada real y siempre ofrece un siguiente paso claro.

#### Analizar Sitio

Checklist:

- URL obligatoria valida bien;
- loader entra y sale sin dejar pantalla colgada;
- errores de análisis se muestran con mensaje útil;
- análisis exitoso guarda historial y renderiza resultados completos;
- análisis anteriores se pueden reabrir;
- CTA post-análisis a estrategia funciona;
- límite diario de `Trial` muestra mensaje correcto y CTA a planes.

Criterio de cierre:

- un usuario puede analizar, fallar, reintentar, revisar historial y pasar a estrategia sin perder el flujo.

#### Estrategia Inteligente

Checklist:

- prefill de negocio, URL, mercado y contexto funciona;
- templates rápidos rellenan campos válidos;
- generar estrategia no falla por contexto vacío cuando hay datos base;
- loader, error y éxito se ven consistentes;
- guardar estrategia funciona;
- el bloque `ruta detectada` y `siguiente paso recomendado` aparece correctamente;
- CTA desde el resultado lleva a campañas, creativos o agentes según corresponda.

Criterio de cierre:

- el plan no se siente como texto aislado, sino como puente entre diagnóstico y ejecución.

#### Campañas

Checklist:

- selector de plataforma responde bien;
- plantillas rápidas funcionan;
- generación de campaña muestra loading, error y éxito correctos;
- guardar campaña funciona;
- pestaña de campañas guardadas carga bien;
- gating por plan no deja pasar a `Trial`;
- CTA desde estrategia o dashboard aterriza bien en campañas.

Criterio de cierre:

- un usuario `Pro` puede pasar de idea a campaña sin pasos muertos; un usuario `Trial` entiende claramente por qué no puede.

#### Creativos & Ads

Checklist:

- generación de copy funciona con contexto mínimo;
- guardar entregable funciona;
- generación de imagen responde bien y deja preview/descarga;
- tabs `Google Ads Real` y `Meta Ads Real` muestran estado coherente;
- gating por plan no deja pasar a `Trial/Starter` donde no corresponde;
- errores de autenticación o conexión se explican bien.

Criterio de cierre:

- el módulo permite producir piezas útiles o, si está bloqueado, explica el siguiente paso sin confundir.

#### Integraciones

Checklist:

- estado de Google se refleja correctamente;
- GSC, GA4 y Google Ads cargan su estado real;
- BearAds Tracking muestra snippet, copia y estado;
- tabs avanzadas bloqueadas por plan responden con CTA correcto;
- campos de Meta, Email y E-commerce guardan sin romper la vista;
- la recomendación de siguiente conexión cambia según el contexto del negocio.

Criterio de cierre:

- integraciones ya no se sienten como settings sueltos, sino como parte de la base operativa del producto.

#### Agentes de apoyo

Checklist:

- filtros por objetivo funcionan;
- búsqueda funciona;
- `Todos` no se resetea sola;
- abrir agente funciona desde cards y recomendaciones;
- historial/entregables del agente abre bien;
- `Trial` queda bloqueado correctamente;
- contexto manual o desde análisis entra bien al agente.

Criterio de cierre:

- los agentes se sienten como apoyo especializado real y no como un módulo roto o redundante.

#### Entregables / Aprendizaje

Checklist:

- historial abre desde KPI y desde listas recientes;
- cada entregable se puede abrir completo;
- copiar y descargar funcionan;
- tabs de aprendizaje cambian bien;
- vacíos y listas guardadas usan texto consistente.

Criterio de cierre:

- todo lo generado por BearAds queda accesible, abrible y reutilizable.

#### Score Semanal

Checklist:

- vista previa carga sin romper layout;
- enviar ahora responde con éxito o error claro;
- activar reporte guarda configuración;
- vacío, loading y preview hablan el mismo idioma del resto del producto.

Criterio de cierre:

- el módulo se comporta como un entregable complementario estable, no como experimento suelto.

#### Billing / Plan Modal / Superadmin

Checklist:

- modal de plan abre siempre;
- seleccionar plan actualiza el estado comercial;
- comparativo entre etapa actual y destino se renderiza bien;
- volver a `Trial` funciona en entorno interno;
- superadmin muestra y guarda estado comercial sin inconsistencias;
- CTA de upgrade abre el modal desde módulos bloqueados.

Criterio de cierre:

- la capa comercial deja de ser solo decorativa y pasa a ser una parte estable del producto.

#### Cierre transversal de Fase 1

La fase 1 se considera cerrada cuando:

- no hay modales que se queden trabadas;
- no hay CTAs principales que no hagan nada;
- no se pierde estado al navegar entre pasos normales;
- cada módulo principal tiene:
  - vacío,
  - loading,
  - éxito,
  - error,
  - y CTA siguiente;
- el flujo completo `onboarding -> análisis -> estrategia -> activación -> entregables` se puede recorrer sin puntos muertos.

#### Estado inicial de Fase 1 (corte actual)

Nota:
este estado es una lectura operativa del producto actual y de lo ya implementado.
Sirve para priorizar trabajo, pero no reemplaza la ronda formal de QA de la fase 6.

| Módulo | Estado inicial | Lectura actual |
|---|---|---|
| Onboarding | Cerrado operativo | Ya se corrigieron avance, retroceso, guardado, modo agencia y persistencia consistente entre completar, saltar y reiniciar. Queda pendiente validación dentro de QA formal, pero ya no debería bloquear el cierre funcional. |
| Dashboard | Cerrado operativo | KPI, vacíos, listas recientes, score, datos en vivo y CTA de historial ya limpian y renderizan bien tanto con datos como sin ellos. Queda pendiente QA formal, pero el flujo base ya no debería dejar estados viejos pegados. |
| Analizar Sitio | Cerrado operativo | El flujo base, historial y CTA a estrategia ya están conectados. Ya limpia mejor los estados de carga/reintento, normaliza mejor URLs antes de analizar y da salidas más claras en errores. La validación dura con red real queda para la fase 6. |
| Estrategia Inteligente | Cerrado operativo | Prefill, contexto, ruta detectada, restauración del último plan y siguiente paso ya están integrados de forma consistente. Queda QA formal y prueba de escenarios extremos, pero el flujo base ya no debería perder la continuidad al volver a entrar. |
| Campañas | Cerrado operativo | La generación, guardado, reapertura desde campañas guardadas, tabs y feedback de contexto ya quedaron más consistentes. También responde mejor cuando falta sesión y al reabrir campañas guardadas. La validación fuerte por plataforma y plan queda para la fase 6. |
| Creativos & Ads | Cerrado operativo | La generación de copy, gating, auth, preview de imagen y manejo de errores ya quedaron más consistentes. También se alineó mejor la generación de imagen con la sesión activa y se limpiaron mejor previews viejas. La validación operativa real en Ads e imagen queda para la fase 6. |
| Integraciones | Cerrado operativo | Ya mejora mejor los estados visibles de conexión, tabs bloqueadas por plan, tracking y reseteo visual cuando cambia la sesión. Además recuerda mejor el foco/tab en el que venía trabajando el usuario sin reabrir tabs bloqueadas por error en Trial. La validación real de OAuth y datos conectados queda para la fase 6. |
| Agentes de apoyo | Cerrado operativo | Filtros, búsqueda, gating y accesos principales ya están mejor resueltos. Además ya recuerda mejor el filtro y la búsqueda elegidos al volver al módulo. La prueba completa de contexto, outputs y recorridos por agente queda para la fase 6. |
| Entregables / Aprendizaje | Cerrado operativo | Abrir, copiar, descargar y navegar desde dashboard ya funciona. También recuerda mejor la pestaña activa al volver al módulo y el vacío del historial ya empuja a generar algo útil según la etapa del usuario. La validación final de consistencia queda para la fase 6. |
| Score Semanal | Cerrado operativo | Ya restaura mejor la configuración guardada y limpia mejor los estados entre preview y envío. La prueba funcional real con correo y datos conectados queda para la fase 6. |
| Billing / Plan Modal / Superadmin | Cerrado operativo | El modal ya responde mejor al plan actual, oculta mejor acciones que no aplican en Trial y el copy comercial quedó más consistente. También quedó más alineada la capa visible de gating entre Trial, Starter y Pro en navegación e integraciones. La prueba final de cambios de etapa y cancelación queda para la fase 6. |

##### Prioridad sugerida dentro de Fase 1

Orden práctico para cerrar primero:

1. Onboarding
2. Dashboard
3. Analizar Sitio
4. Estrategia Inteligente
5. Entregables / Aprendizaje
6. Campañas
7. Creativos & Ads
8. Integraciones
9. Billing / Plan Modal / Superadmin
10. Score Semanal
11. Agentes de apoyo

##### Lectura ejecutiva

Hoy BearAds ya tiene una base web bastante avanzada.
La fase 1 puede considerarse cerrada en términos operativos.

La parte más madura del flujo quedó así:

- onboarding,
- dashboard,
- análisis,
- estrategia,
- entregables.

Lo más sensible ya no es estabilización base, sino QA formal de la fase 6 sobre:

- campañas,
- creativos,
- integraciones reales,
- billing real,
- y score semanal con correo/datos conectados.

##### Cierre formal de Fase 1

La Fase 1 queda cerrada como:

- cierre operativo completado,
- sin puntos muertos importantes en el flujo principal,
- con persistencia y estados más consistentes entre módulos,
- y lista para pasar a validación funcional formal en la Fase 6.

Importante:
este cierre no reemplaza QA real con casos, cuentas y servicios conectados.
Lo que se cierra aquí es la base funcional web para seguir con las fases siguientes sin seguir corrigiendo fundamentos de UI/flujo.
