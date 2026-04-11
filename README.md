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
