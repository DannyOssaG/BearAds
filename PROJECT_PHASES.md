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

Pendientes inmediatos:

- usar de forma mas automatica la seleccion guardada para disminuir pasos manuales,
- revisar el flujo completo URL + Google -> analisis -> dashboard -> estrategia,
- terminar de validar Search Console para que muestre datos reales de clicks, impresiones, CTR y keywords en el analisis,
- validar visualmente que GA4 renderice sus metricas dentro del reporte final cuando la propiedad seleccionada devuelve datos,
- seguir reduciendo ruido de modulos no core.

Siguiente paso recomendado:

cerrar el flujo principal dentro de la app para que, despues del login con Google, el usuario llegue a un analisis con contexto precargado y una ruta obvia hacia estrategia.
