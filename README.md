# BearAds

Plataforma web de marketing con IA para analisis, estrategia, campañas, integraciones y operacion guiada.

## Version recomendada

- Node.js `22`
- npm `10+`

Este repo incluye [`.nvmrc`](/Users/dannyossagonzalez/Documents/BearAds/.nvmrc) para unificar la version entre Mac y Windows.

## Regla de trabajo

- OneDrive puede usarse como respaldo del proyecto.
- El proyecto debe estar siempre descargado y ejecutarse desde disco local.
- No correr BearAds directamente desde una carpeta que este sincronizandose en tiempo real si empieza a dar errores con `node_modules`.
- No copiar `node_modules` entre maquinas.
- Cada equipo debe hacer su propio `npm install`.

## Instalacion limpia

### Mac

```bash
cd /ruta/al/proyecto
rm -rf node_modules package-lock.json
npm cache verify
npm install
node server.js
```

### Windows PowerShell

```powershell
cd "C:\ruta\al\proyecto"
if (Test-Path node_modules) { Remove-Item -Recurse -Force node_modules }
if (Test-Path package-lock.json) { Remove-Item -Force package-lock.json }
npm cache verify
npm install
node server.js
```

## Variables de entorno

1. duplica [env.example](/Users/dannyossagonzalez/Documents/BearAds/env.example) como `.env`
2. completa las llaves que vayas a usar
3. reinicia el servidor cuando cambies variables

Variables base:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `SESSION_SECRET`
- `PORT`
- `APP_BASE_URL`

## Stripe

BearAds ya incluye `stripe` dentro de las dependencias del proyecto. No hace falta instalarlo aparte si corres:

```bash
npm install
```

Para activar billing real en local, completa estas variables en `.env`:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_STARTER_MONTHLY`
- `STRIPE_PRICE_STARTER_ANNUAL`
- `STRIPE_PRICE_PRO_MONTHLY`
- `STRIPE_PRICE_PRO_ANNUAL`
- `STRIPE_PRICE_AGENCY_MONTHLY`
- `STRIPE_PRICE_AGENCY_ANNUAL`

Si esas variables no existen, BearAds sigue funcionando en `modo pruebas` y el modal de planes usa la activacion interna para QA.

### Flujo local recomendado con Stripe

1. crear los productos y precios en Stripe
2. copiar los `price_...` al `.env`
3. definir `APP_BASE_URL=http://localhost:3000`
4. arrancar BearAds con:

```bash
npm run dev
```

5. escuchar webhooks con Stripe CLI:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

6. copiar el `whsec_...` que entregue Stripe CLI a `STRIPE_WEBHOOK_SECRET`

### Crear productos y precios en Stripe

Configuracion recomendada:

- `BearAds Starter`
  - mensual
  - anual
- `BearAds Pro`
  - mensual
  - anual
- `BearAds Agency`
  - mensual
  - anual

Cada precio creado en Stripe devuelve un `price_...`. Ese valor es el que debes copiar al `.env`:

- `STRIPE_PRICE_STARTER_MONTHLY`
- `STRIPE_PRICE_STARTER_ANNUAL`
- `STRIPE_PRICE_PRO_MONTHLY`
- `STRIPE_PRICE_PRO_ANNUAL`
- `STRIPE_PRICE_AGENCY_MONTHLY`
- `STRIPE_PRICE_AGENCY_ANNUAL`

### Prueba punta a punta de billing

Checklist local recomendado:

1. completar `.env` con `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `APP_BASE_URL` y todos los `price_...`
2. arrancar BearAds con `npm run dev`
3. arrancar Stripe CLI con:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

4. entrar a BearAds con una cuenta de prueba
5. abrir `Plan`
6. elegir `Starter`, `Pro` o `Agency`
7. confirmar que BearAds redirige a Stripe Checkout
8. completar el pago de prueba con una tarjeta de testing
9. validar que Stripe envía el webhook
10. volver a BearAds y comprobar:
   - que `/api/billing/status` devuelve la nueva suscripción,
   - que el workspace cambió de etapa,
   - y que las funciones bloqueadas por plan ya quedaron activas
11. abrir `Cancelar plan actual`
12. confirmar que BearAds abre Stripe Portal y permite gestionar la suscripción

### Tarea adicional recomendada

Agregar una verificación visible en `Superadmin` para billing real:

- mostrar si Stripe está configurado o no,
- mostrar el `plan`, `status` y `customer/subscription id`,
- y dejar un botón simple de `refrescar estado de billing`.

### Endpoints de billing real

- `GET /api/billing/status`
- `POST /api/billing/create-checkout`
- `POST /api/billing/create-portal`
- `POST /api/stripe/webhook`

## Arranque normal

```bash
npm install
npm start
```

O en desarrollo:

```bash
npm run dev
```

## Problema comun en Windows

Si aparece un error como este:

```txt
Error: Cannot find module './common'
```

La causa mas probable es una instalacion corrupta de `node_modules`.

La solucion es:

1. entrar a la carpeta correcta del proyecto
2. borrar `node_modules`
3. borrar `package-lock.json`
4. correr `npm cache verify`
5. correr `npm install`

## Verificaciones utiles

Comprobar version de Node:

```bash
node -v
```

Comprobar version de npm:

```bash
npm -v
```

Comprobar sintaxis del servidor:

```bash
node --check server.js
```
