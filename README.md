# Redes Moviles España · Mapa y Censo de Antenas de Redes Móviles

Aplicación web cartográfica de ingeniería RF y explorador de datos abiertos para consultar las estaciones base de telefonía móvil registradas en toda España (**Movistar**, **Orange / MasOrange**, **Vodafone**, **DIGI** y operadores regionales) a partir de la fuente oficial **Infoantenas** del Ministerio para la Transformación Digital y de la Función Pública (MINETUR).

---

## Características Principales

- **Mapa Vectorial de Alto Rendimiento (MapLibre GL JS + OpenFreeMap)**:
  - Renderizado WebGL fluido de decenas de miles de emplazamientos en Península, Islas Baleares, Islas Canarias, Ceuta y Melilla con agrupación dinámica (*clustering*), codificación cromática por operador, **fusión de declaraciones duplicadas de una misma operadora en la misma coordenada exacta** (incluyendo Orange y Telefónica, salvo cuando dos antenas de Telefónica disponen de banda N78 cada una) y **agrupación visual multi-operador (`< 15 m`)** en un icono multicolor compartido cuando distintas redes comparten mástil o azotea (sin fusionar estaciones de Telefónica en coordenadas distintas ni parejas Telefónica con N78 en ambas).
  - Ocho estilos cartográficos sin claves ni límites de cuota: **OSM Retina** (teselas oficiales de OpenStreetMap en modo Retina 4× con `tileSize: 64`), **Google Estándar** (callejero HD 8× con `scale=4`, teselas `1024×1024px` en `tileSize: 128`) y **Google Satélite** (vista aérea híbrida con calles y etiquetas HD 8× con `scale=4`, `tileSize: 128` y `maxzoom: 20`) junto a los estilos vectoriales de OpenFreeMap **Liberty**, **Positron**, **Bright**, **Dark Matter** y **Fiord**, sincronizados con el selector de **Modo Claro / Modo Oscuro**, bloqueo de vista 3D/vertical activado por defecto y *zoom out* completo (`minZoom: 0`).
- **Medición de Distancia en Mapa**:
  - Permite seleccionar múltiples puntos sobre la cartografía mostrando los segmentos geodésicos y la distancia exacta.
- **Ficha Técnica de Estación y Bandas RF**:
  - Inspección completa de operador comercial, razón social concesionaria, `Gis_ID` (incluyendo expedientes fusionados `mergedGids`), bandas comerciales, rangos de frecuencias y concesiones administrativas (`Referencia` + frecuencia declarada), dirección postal, coordenadas copiables en un clic y acceso directo al expediente oficial `detalleEstacion.do?emplazamiento=<Gis_ID>`, **Google Street View** y **OpenStreetMap**.
- **Filtrado Avanzado y Exportación Abierta**:
  - Filtros en cascada por comunidad autónoma, provincia y municipio, filtrado por operador y banda de frecuencia RF (`N28`, `N28+`, `B20`, `G9`, `B3`, `B1`, `B38`, `B7`, `B7+`, `N78`, `N258`), búsqueda por coordenadas/dirección/`Gis_ID` y exportación en **JSON propio (`.json`)**, **CSV (Excel UTF-8)** y **GeoJSON**.
- **Sección de Novedades (`#/novedades`), Eliminaciones (`#/eliminaciones`), Estadísticas (`#/estadisticas`) y UNICO 5G (`#/unico-5g`)**:
  - Monitor en tiempo real durante escaneos forzados manuales (telemetría en la rama `scan-status`), historial acumulativo permanente en `public/data/novedades.json`, cuotas nacionales por operador y desglose por bandas de frecuencia.
  - Panel simplificado **UNICO 5G** (`#/unico-5g`) con las **9.291 antenas subvencionadas** de **Fase 1 (7.330)** y **Fase 2 (1.961)**, unificación de proyectos de **Orange y Avatel** bajo **Orange**, filtros por provincia, comunidad autónoma y fase, reparto por operadora y detección automática de **antenas ya declaradas** (emparejamiento 1-a-1 por operadora hasta **1.200 m** dando preferencia a antenas con **N78** o **N28+** antes que **solo N28**, y buscando de más cercano a lejano con los saltos necesarios sobre antenas no válidas u ocupadas).

---

## Arquitectura Tecnológica

| Capa | Tecnología | Propósito |
| :--- | :--- | :--- |
| **Interfaz y Bundler** | React 19 + TypeScript 7 + Vite 8 | Arquitectura modular tipada con *bundle splitting* optimizado |
| **Enrutamiento SPA** | `@tanstack/react-router` (`createHashHistory`) | Rutas `#/`, `#/novedades`, `#/eliminaciones`, `#/estadisticas` y `#/unico-5g` sin errores 404 en GitHub Pages |
| **Datos y Caché** | `@tanstack/react-query` v5 + JSON Propio | Importación exclusiva de `public/data/antenas.json`, `novedades.json`, `eliminaciones.json` y `unico-5g.json` (validación estricta anti-GeoJSON), caché en memoria e índices `O(1)` |
| **Motor Cartográfico** | `maplibre-gl` v6 + OpenFreeMap + OSM Retina + Google Maps | 8 estilos cartográficos (vectoriales, OSM Retina y Google Estándar / Satélite Híbrido) con renderizado WebGL en GPU |
| **Escaneo y Procesamiento** | Python 3.12 (`scripts/fetch_antenas.py` + `scripts/build_unico_5g.py`) | Recolección bajo demanda desde MINETUR y generación determinista del censo UNICO 5G Fase 1 y Fase 2 |
| **CI/CD y Hosting** | GitHub Actions (`.github/workflows/update-and-deploy.yml`) + GitHub Pages | Escaneo forzado manual (`workflow_dispatch`) y despliegue estático en cada `push` a `main` |

---

## Desarrollo Local

### Requisitos previos
- **Node.js** `>= 22` y `npm`
- **Python** `>= 3.11` (solo si deseas ejecutar localmente el escaneo forzado)

### Comandos disponibles

```bash
# 1. Instalar dependencias
npm install

# 2. Iniciar servidor de desarrollo en caliente (Vite)
npm run dev

# 3. Ejecutar pruebas unitarias (Vitest + pruebas de recolectores Python)
npm test
python3 -m unittest scripts/test_fetch_antenas.py
python3 -m unittest scripts/test_build_unico_5g.py

# 4. Analizar código con Oxlint
npm run lint

# 5. Compilar versión estática de producción en ./dist
npm run build

# 6. Previsualizar compilación de producción
npm run preview
```

---

## Despliegue en GitHub Pages y Escaneo Forzado Manual

El flujo `.github/workflows/update-and-deploy.yml` **no tiene ningún cron ni escaneo automático diario programado**. Se ejecuta exclusivamente bajo demanda o al subir cambios:

- **Despliegue automático en cada `push` a `main`**: ejecuta las pruebas, compila `dist/` (con respaldo `404.html`) y publica en GitHub Pages sin lanzar escaneos.
- **Escaneo forzado manual (`workflow_dispatch`)**:
  - Desde el botón de **escaneo forzado** de la propia web (`#/novedades`).
  - Desde GitHub Actions: **Actions → «Actualizar Censo Infoantenas y Desplegar en GitHub Pages» → Run workflow**.
  - Desde GitHub CLI:
    ```bash
    # Escaneo forzado contabilizando novedades
    gh workflow run update-and-deploy.yml -f refresh_data=true -f record_novedades=true

    # Escaneo forzado de línea base (sin contabilizar en Novedades)
    gh workflow run update-and-deploy.yml -f refresh_data=true -f record_novedades=false
    ```

---

## Fuente de Datos y Aviso Legal

Datos públicos procedentes del [Geoportal de Estaciones de Telecomunicaciones (Infoantenas)](https://geoportal.minetur.gob.es/VCTEL/vcne.do) del Ministerio para la Transformación Digital y de la Función Pública de España. Herramienta independiente de visualización cartográfica y divulgación técnica en radiofrecuencia.
