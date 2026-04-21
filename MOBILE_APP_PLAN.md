# BearAds Mobile App Plan

## Objetivo

Crear una app móvil de BearAds que conserve la lógica y el recorrido del producto web, pero con:

- mejor velocidad percibida,
- navegación más nativa,
- uso de recursos del celular,
- y una experiencia más simple para el día a día.

La idea no es “meter la web en un wrapper”.
La idea es tomar el producto que ya funciona y convertirlo en una app más enfocada en ejecución rápida.

---

## Lectura del móvil actual

Hoy BearAds ya tiene una base móvil útil en `public/index.html`:

- header móvil,
- navegación inferior,
- soporte PWA,
- safe areas,
- layout responsive,
- y ocultación del sidebar en pantallas pequeñas.

Eso ayuda como referencia de producto, pero no alcanza como base ideal de app nativa porque:

1. el móvil actual sigue siendo una sola app web grande con mucho HTML inline;
2. muchas pantallas desktop simplemente colapsan a una columna;
3. varios modales siguen pensados como desktop y luego se adaptan;
4. la carga inicial sigue llevando mucha UI que en móvil no siempre se necesita;
5. el rendimiento depende del navegador y del DOM completo.

Conclusión:

La versión actual sirve muy bien como **mapa funcional**,
pero no como implementación final de app móvil.

---

## Recomendación técnica

### Opción recomendada

Construir la app con **React Native + Expo**.

### Por qué esta opción

- acelera el desarrollo para iOS y Android al mismo tiempo;
- permite usar recursos nativos del teléfono sin fricción;
- es mejor para notificaciones, almacenamiento local, archivos y cámara;
- permite mantener el backend actual de BearAds;
- es suficientemente rápida para el tipo de producto que tenemos.

### Qué se reutiliza

Se reutiliza:

- backend actual en `server.js`,
- auth y sesión,
- reglas de negocio,
- planes y gating,
- endpoints de análisis, estrategia, campañas, creativos, entregables e integraciones.

### Qué no se debería reutilizar tal cual

No conviene portar directamente:

- el HTML actual,
- las media queries como base de app,
- ni los modales desktop adaptados.

La app móvil debería tener componentes y navegación propios.

---

## Propuesta de arquitectura móvil

### Stack sugerido

- `Expo`
- `React Native`
- `Expo Router` o `React Navigation`
- `TanStack Query` para datos remotos
- `zustand` para estado liviano
- `expo-secure-store` para tokens
- `react-native-mmkv` para cache local rápida
- `expo-notifications` para push/local notifications
- `expo-image-picker` para cámara/galería
- `expo-file-system` y `expo-sharing` para exportar entregables
- `expo-haptics` para feedback táctil

### Navegación recomendada

Tabs principales:

- `Dashboard`
- `Analizar`
- `Plan`
- `Campañas`
- `Conectar`

Stacks secundarios:

- `Agentes`
- `Creativos`
- `Entregables`
- `Perfil`
- `Billing`

---

## Qué debe verse igual y qué debe cambiar

### Debe mantenerse

- la identidad visual de BearAds,
- la lógica de rutas del producto,
- la secuencia:
  - base,
  - estrategia,
  - ejecución,
  - escalamiento.

### Debe cambiar

- menos densidad por pantalla,
- cards más grandes,
- menos texto inicial,
- CTA principal por vista,
- navegación por stacks y sheets,
- no usar tablas densas como patrón principal.

---

## Estructura ideal de la app móvil

### 1. Dashboard móvil

Debe ser mucho más corto que el web.

Orden sugerido:

- estado actual de la cuenta,
- card fuerte de “siguiente paso”,
- KPIs resumidos,
- últimos análisis,
- últimos entregables,
- acceso rápido a análisis, plan y campañas.

### 2. Analizar

Pantalla enfocada a una sola acción:

- URL,
- fuente Google seleccionada,
- CTA grande,
- progreso por etapas,
- resultados en bloques expandibles.

### 3. Plan Estratégico

En móvil debe sentirse como wizard + resultado.

Primero:

- contexto del negocio,
- objetivo,
- presupuesto,
- mercado.

Luego:

- resultado con cards,
- siguiente paso,
- CTA directo a campañas o agentes.

### 4. Campañas

Más simple que web.

Primero elegir:

- objetivo,
- plataforma,
- presupuesto,
- producto.

Luego:

- ver campaña,
- guardar,
- activar,
- compartir.

### 5. Integraciones

Debe dividirse en:

- base recomendada,
- ads,
- automatización,
- tracking.

No mostrar todo con el mismo peso.

---

## Recursos nativos del celular que sí valen la pena

### 1. Notificaciones push y locales

Para avisar:

- análisis terminado,
- estrategia lista,
- campaña lista,
- reporte semanal,
- recordatorio de siguiente paso.

### 2. Cámara / galería

Útil para:

- subir creativos,
- tomar referencia visual,
- adjuntar screenshots para agentes,
- cargar logos o piezas del cliente.

### 3. Share sheet nativo

Para compartir:

- PDF,
- estrategia,
- entregable,
- resumen ejecutivo,
- imagen creativa.

### 4. Almacenamiento local rápido

Para:

- últimos análisis,
- drafts,
- estado de onboarding,
- plan actual,
- notificaciones,
- entregables recientes.

### 5. Secure storage

Para:

- sesión,
- tokens,
- preferencias sensibles.

### 6. Haptics

Útil en:

- análisis iniciado,
- guardado,
- activación de plan,
- CTA principal,
- tareas completadas.

---

## Qué no conviene hacer en la v1

- no meter todos los módulos desktop desde el día 1;
- no rehacer superadmin como prioridad;
- no portar todos los tabs avanzados tal cual;
- no depender de iframes o HTML renderizado dentro de la app;
- no intentar offline total todavía.

---

## Alcance recomendado para una v1 real

### Incluir

- login / sesión
- dashboard móvil
- análisis
- plan estratégico
- campañas base
- integraciones esenciales
- entregables
- notificaciones
- perfil / plan

### Dejar para v2

- superadmin
- agency dashboard profundo
- webhooks avanzados
- automatizaciones complejas
- reporting muy denso

---

## Fases recomendadas

### Fase 1 — Shell móvil

- crear app Expo
- auth
- tabs
- tema visual base
- sesión
- perfil

### Fase 2 — Core flow

- Dashboard
- Analizar
- Plan Estratégico
- Entregables

### Fase 3 — Activación

- Campañas
- Creativos
- Integraciones base

### Fase 4 — Native power

- push notifications
- sharing
- archivos
- haptics
- image picker

### Fase 5 — Agency / scale

- multi-workspace
- multi-cliente
- vistas agregadas
- billing más fino

---

## Mi recomendación práctica

Si empezamos ya, yo haría esto:

1. mantener el backend actual;
2. crear una app nueva en `mobile/`;
3. replicar primero solo:
   - `Dashboard`
   - `Analizar`
   - `Plan`
   - `Campañas`
   - `Conectar`;
4. usar el web actual solo como referencia visual y funcional;
5. diseñar móvil con menos densidad y más foco por pantalla.

---

## Decisión sugerida

La mejor jugada no es “hacer la web responsive más fuerte”.
La mejor jugada es:

**usar la web como fuente funcional y construir una app móvil nativa/híbrida ligera, enfocada en ejecución.**

Eso sí te daría:

- más velocidad,
- mejor retención,
- mejor sensación de producto,
- y más uso real del celular.
