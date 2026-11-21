# RadioMapa España · Mapa y Censo de Antenas de Redes Móviles

Aplicación web cartográfica de ingeniería RF y explorador de datos abiertos para consultar las estaciones base de telefonía móvil registradas en toda España (**Movistar**, **Orange / MasOrange**, **Vodafone**, **DIGI** y operadores regionales) a partir del censo estático procedente de **Infoantenas** del Ministerio para la Transformación Digital y de la Función Pública (MINETUR).

---

## Características Principales

- **Mapa Vectorial de Alto Rendimiento (MapLibre GL JS + OpenFreeMap)**:
  - Renderizado WebGL fluido de decenas de miles de emplazamientos en Península, Islas Baleares, Islas Canarias, Ceuta y Melilla con agrupación dinámica (*clustering*), codificación cromática por operador y **agrupación visual multi-operador (`< 30 m`)** en un icono multicolor compartido cuando distintas redes comparten mástil o azotea (sin fusionar jamás estaciones de Telefónica consigo mismas).
  - Seis estilos cartográficos sin claves ni límites de cuota: **OSM Retina** (teselas oficiales de OpenStreetMap en modo Retina 4× con `tileSize: 64`) junto a los estilos vectoriales de OpenFreeMap **Liberty**, **Positron**, **Bright**, **Dark Matter** y **Fiord**, sincronizados con el selector de **Modo Claro / Modo Oscuro**, bloqueo de vista 3D/vertical activado por defecto y *zoom out* completo (`minZoom: 0`).
- **Medición de Distancia en Mapa**:
  - Permite seleccionar múltiples puntos sobre la cartografía mostrando los segmentos geodésicos y la distancia exacta.
- **Ficha Técnica de Estación y Bandas RF**:
  - Inspección completa de operador comercial, razón social concesionaria, `Gis_ID` (incluyendo expedientes fusionados `mergedGids`), bandas comerciales, rangos de frecuencias y concesiones administrativas (`Referencia` + frecuencia declarada), dirección postal, coordenadas copiables en un clic y acceso directo al expediente oficial `detalleEstacion.do?emplazamiento=<Gis_ID>`, **Google Street View** y **OpenStreetMap**.
- **Filtrado Avanzado y Exportación Abierta**:
  - Filtros en cascada por comunidad autónoma, provincia y municipio, filtrado por operador y banda de frecuencia RF (`N28`, `N28+`, `B20`, `G9`, `B3`, `B1`, `B38`, `B7`, `B7+`, `N78`, `N258`), búsqueda por coordenadas/dirección/`Gis_ID` y exportación en **JSON propio (`.json`)**, **CSV (Excel UTF-8)** y **GeoJSON**.
- **Sección de Novedades (`#/novedades`) y Estadísticas (`#/estadisticas`)**:
  - Historial acumulativo de antenas y frecuencias registradas en `public/data/novedades.json`, cuotas nacionales por operador, desglose por bandas de frecuencia y ranking de las 52 provincias y ciudades autónomas.

---

## Arquitectura Tecnológica

| Capa | Tecnología | Propósito |
| :--- | :--- | :--- |
| **Interfaz y Bundler** | React 19 + TypeScript 7 + Vite 8 | Arquitectura modular tipada con *bundle splitting* optimizado |
| **Enrutamiento SPA** | `@tanstack/react-router` (`createHashHistory`) | Rutas `#/`, `#/novedades` y `#/estadisticas` sin errores 404 en GitHub Pages |
| **Datos y Caché** | `@tanstack/react-query` v5 + JSON Propio | Importación exclusiva de `public/data/antenas.json` y `public/data/novedades.json` (validación estricta anti-GeoJSON), caché en memoria e índices `O(1)` |
| **Motor Cartográfico** | `maplibre-gl` v6 + OpenFreeMap + OSM Retina | 6 estilos cartográficos libres con renderizado WebGL en GPU |
| **Despliegue** | GitHub Actions (`.github/workflows/deploy-pages.yml`) + GitHub Pages | Verificación (lint, tests, build) y publicación estática en cada `push` a `main` |

---

## Desarrollo Local

### Requisitos previos
- **Node.js** `>= 22` y `npm`

### Comandos disponibles

```bash
# 1. Instalar dependencias
npm install

# 2. Iniciar servidor de desarrollo en caliente (Vite)
npm run dev

# 3. Ejecutar pruebas unitarias (Vitest)
npm test

# 4. Analizar código con Oxlint
npm run lint

# 5. Compilar versión estática de producción en ./dist
npm run build

# 6. Previsualizar compilación de producción
npm run preview
```

---

## Despliegue en GitHub Pages

El flujo `.github/workflows/deploy-pages.yml` compila y publica automáticamente el sitio estático en GitHub Pages ante cada `push` a `main` o disparo manual (`workflow_dispatch`), sin ejecutar ningún programa de escaneo automático.

---

## Fuente de Datos y Aviso Legal

Datos públicos procedentes del [Geoportal de Estaciones de Telecomunicaciones (Infoantenas)](https://geoportal.minetur.gob.es/VCTEL/vcne.do) del Ministerio para la Transformación Digital y de la Función Pública de España. Herramienta independiente de visualización cartográfica y divulgación técnica en radiofrecuencia.
