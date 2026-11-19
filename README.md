# RadioMapa España · Mapa y Censo de Antenas de Redes Móviles

Aplicación web cartográfica de ingeniería RF y explorador de datos abiertos para consultar las estaciones base de telefonía móvil registradas en toda España (**Movistar**, **Orange / MasOrange**, **Vodafone**, **Yoigo / Grupo MásMóvil**, **DIGI** y operadores regionales), sincronizada automáticamente todos los días a las **18:00 (`Europe/Madrid`)** con la fuente oficial **Infoantenas** del Ministerio para la Transformación Digital y de la Función Pública (MINETUR).

---

## Características Principales

- **Mapa Vectorial de Alto Rendimiento (MapLibre GL JS + OpenFreeMap)**:
  - Renderizado WebGL fluido de decenas de miles de emplazamientos en Península, Islas Baleares, Islas Canarias, Ceuta y Melilla con agrupación dinámica (*clustering*), codificación cromática por operador y **agrupación visual multi-operador (`< 35 m`)** en un icono multicolor compartido cuando distintas redes comparten mástil o azotea (sin fusionar jamás estaciones de Telefónica consigo mismas).
  - Seis estilos cartográficos sin claves ni límites de cuota: **OSM Retina** (teselas oficiales de OpenStreetMap en modo Retina 4× con `tileSize: 64`) junto a los estilos vectoriales de OpenFreeMap **Liberty**, **Positron**, **Bright**, **Dark Matter** y **Fiord**, sincronizados con el selector de **Modo Claro / Modo Oscuro**, bloqueo de vista 3D/vertical activado por defecto y *zoom out* completo (`minZoom: 0`).
- **Medición de Distancia entre 2 Puntos**:
  - La función **"Medir en mapa"** permite seleccionar **2 puntos cualesquiera en el mapa** (Punto A y Punto B) mostrando directamente sobre la cartografía el segmento geodésico y la distancia exacta entre ambos.
- **Ficha Técnica de Estación, Bandas MHz y Co-emplazamiento (`< 35 m` / `< 100 m`)**:
  - Inspección completa de operador comercial, razón social concesionaria, `Gis_ID` (incluyendo expedientes fusionados `mergedGids`), bandas, rangos de frecuencias y concesiones administrativas (`Referencia` + frecuencia declarada) extraídas de `detalleEstacion.do`, dirección postal, coordenadas copiables en un clic, selector rápido de operadores integrados en el mismo icono (`< 35 m`) y detección de estaciones próximas (`< 100 m`).
  - Enlace directo al expediente oficial `detalleEstacion.do?emplazamiento=<Gis_ID>` del Ministerio además de accesos rápidos a **Google Street View** y **OpenStreetMap**.
- **Filtrado Avanzado y Exportación Abierta**:
  - Filtros en cascada por provincia y municipio, filtrado por operador y banda de frecuencia (MHz), búsqueda por coordenadas/dirección/`Gis_ID` y exportación directa en **JSON propio (`.json`)**, **CSV (Excel UTF-8)** y opción secundaria SIG (`GeoJSON` para QGIS/ArcGIS).
- **Sección de Novedades (`#/novedades`)**:
  - Incluye en su cabecera un **monitor en tiempo real del porcentaje de antenas escaneadas** (activo tanto durante el escaneo diario de las 18:00 como en cualquier escaneo manual forzado, mediante telemetría publicada en `scan-status`) junto a las casillas de **Antenas nuevas**, **Frecuencias nuevas** y **Último escaneo**.
  - Tabla única con las antenas nuevas y las frecuencias/concesiones nuevas detectadas respecto al escaneo anterior (`public/data/novedades.json`), donde cada fila lleva como fondo el color oficial de su operadora con un **50 % de transparencia**, acompañada de filtros por **Operadora**, tipo de novedad, banda/frecuencia, ubicación, fecha de escaneo y búsqueda libre, y las 6 columnas exactas:
    - **Novedad**: indica si es una **antena nueva** o una **frecuencia nueva** junto con el operador asociado.
    - **Código**: código `Gis_ID` de la estación con enlace directo para abrir y centrar esa antena en el mapa de la web.
    - **Código Banda**: referencia oficial asociada a la concesión/banda nueva (`Referencia` de MINETUR, p. ej. `M M -2205199`) cuando la novedad corresponde a una frecuencia.
    - **Frecuencia**: rango exacto tal como figura declarado en el Ministerio sin abreviaciones (p. ej. `3460.00 - 3600.00 MHz`).
    - **Ubicación**: municipio/ciudad (o provincia en su defecto) de la antena o frecuencia nueva.
    - **Fecha**: fecha y hora exacta en que fue escaneada en huso horario español (`DD/MM/YYYY HH:MM:SS`, `Europe/Madrid`).
- **Estadísticas Territoriales (`#/estadisticas`)**:
  - Cuotas nacionales por operador y razón social (con **deduplicación espacial de declaraciones duplicadas de Vodafone a `< 35 m`** contabilizadas como 1 única estación, mientras que las antenas de Telefónica nunca se fusionan consigo mismas), desglose por bandas de frecuencia, ranking de las 52 provincias y ciudades autónomas con barras multi-operador apiladas y estado del pipeline diario.

---

## Arquitectura Tecnológica

| Capa | Tecnología | Propósito |
| :--- | :--- | :--- |
| **Interfaz y Bundler** | React 19 + TypeScript 7 + Vite 8 | Arquitectura modular tipada con *bundle splitting* optimizado |
| **Enrutamiento SPA** | `@tanstack/react-router` (`createHashHistory`) | Rutas `#/`, `#/novedades` y `#/estadisticas` sin errores 404 en GitHub Pages |
| **Datos y Caché** | `@tanstack/react-query` v5 + JSON Propio | Importación exclusiva de `data/antenas.json` y `data/novedades.json` (con validación de esquema propio), caché en memoria e índices `O(1)` |
| **Motor Cartográfico** | `maplibre-gl` v6 + OpenFreeMap + OSM Retina | 6 estilos cartográficos libres: **OSM Retina** (teselas oficiales de OpenStreetMap en modo Retina 4× con `tileSize: 64`) y estilos vectoriales OpenFreeMap (**Liberty**, **Positron**, **Bright**, **Dark Matter** y **Fiord**), renderizado WebGL en GPU desde el JSON propio |
| **Pipeline y Motor Diff** | Python 3.12 (`scripts/fetch_antenas.py`) | Barrido *quadtree*, re-escaneo de concesiones RF y cálculo diferencial de altas en `public/data/antenas.json` y `public/data/novedades.json` |
| **CI/CD y Hosting** | GitHub Actions + GitHub Pages | Escaneo diario automático a las **18:00 (`Europe/Madrid`)** en 4 tramos encadenados y despliegue estático |

---

## Esquema JSON Propio y Recolector Diario (`scripts/fetch_antenas.py` → `public/data/antenas.json` y `public/data/novedades.json`)

**El frontend estático carga únicamente nuestros archivos JSON propios (`data/antenas.json` y `data/novedades.json`)** y jamás realiza peticiones al endpoint GeoJSON de MINETUR desde el navegador del usuario (rechazando explícitamente cualquier `FeatureCollection` cruda en tiempo de validación).

Para construir y mantener al día `public/data/antenas.json` y `public/data/novedades.json`, el recolector diario `scripts/fetch_antenas.py` (ejecutado en GitHub Actions todos los días a las **18:00 hora española**) consulta por lotes las celdas del Geoportal oficial salvando su límite de `1.000` registros por caja delimitadora (`bbox`):

1. **Malla Territorial Completa**: Recorre de noroeste (NO) a sureste (SE) la Península Ibérica, Islas Baleares, Islas Canarias, Ceuta y Melilla.
2. **Subdivisión Adaptativa Quadtree**: Cuando una celda alcanza el tope de `1.000` registros (áreas metropolitanas densas), el script la subdivide recursivamente en 4 cuadrantes con un solape de seguridad de `0.0001°`.
3. **Pausa de Cortesía y Decodificación**: Garantiza una espera mínima de `1.0 s` entre peticiones HTTP consecutivas, reintentos con *backoff* exponencial, *checkpoints* atómicos reanudables y decodificación estricta `ISO-8859-1 → UTF-8` para conservar eñes y tildes.
4. **Fusión de Duplicados de Vodafone (`< 35 m`), Agrupación Visual Multi-Operador (`< 35 m`) y No-Fusión de Telefónica**:
   - **Vodafone (`< 35 m`)**: Fusiona mediante malla espacial y componentes conexas las declaraciones administrativas duplicadas de Vodafone situadas a menos de `35 metros` en **1 única antena canónica** (conservando todos sus códigos en `mergedGids` y registrando el total descontado en `crawlStats.vodafoneFusedDuplicates`), contabilizándose siempre como **1 sola estación** en el censo, en `Novedades` y en todas las estadísticas.
   - **Distintos operadores (`< 35 m`)**: Las estaciones de operadores diferentes ubicadas a menos de `35 metros` se agrupan visualmente en el mapa en un icono multicolor compartido mostrando los colores de todas las redes presentes, pero mantienen intacto el recuento individual de cada operador en estadísticas.
   - **Telefónica (`Movistar`)**: Las antenas de Telefónica **nunca se fusionan con otras antenas de ella misma** (ni en el censo/estadísticas ni en el mapa), preservando cada declaración oficial independiente.
5. **Extracción y Re-escaneo Diario de Concesiones, Bandas y Frecuencias RF (`detalleEstacion.do` a `1.0 s/req`)**:
   - Consulta `https://geoportal.minetur.gob.es/VCTEL/detalleEstacion.do?emplazamiento=<Gis_ID>` respetando estrictamente **`>= 1.0 s` de pausa** entre peticiones consecutivas y decodificación `ISO-8859-1`.
   - Analiza exclusivamente la tabla `CARACTERISTICAS TÉCNICAS` (ignorando `NIVELES MEDIDOS`), separa las concesiones (`Referencia` + rango exacto declarado) por operador normalizado cuando varios operadores comparten un mismo `Gis_ID` (obteniendo múltiples antenas en 1 sola petición HTTP) y une (`union`) todos los `mergedGids` en estaciones Vodafone fusionadas.
   - Almacena en cada estación `bandas`, `frecuencias`, `concesiones` (`{"ref": "...", "freq": "..."}`) y la marca temporal `bandsScannedAt`, priorizando en cada ciclo de re-escaneo (`--rescan-since`) primero las antenas nuevas, después las no escaneadas y por último las más antiguas.
6. **Motor Diferencial de `Novedades` (`public/data/novedades.json`) y Modo Línea Base (`--skip-novedades`)**:
   - Compara el censo entrante con el dataset previo (`--preserve-from`) para registrar altas de antenas (`tipo = "antena"`) y compara las concesiones/frecuencias re-escaneadas sobre estaciones previamente escaneadas para detectar nuevas frecuencias (`tipo = "frecuencia"`, sin generar falsos positivos en estaciones escaneadas por primera vez ni en antenas recién dadas de alta).
   - Cuando se ejecuta con `--skip-novedades` (p. ej. un escaneo manual forzado de línea base), actualiza íntegramente `antenas.json` pero no contabiliza ningún registro en `public/data/novedades.json` (`isBaselineScan: true`, `total: 0`).
7. **Transformación a Esquema JSON Propio (`AntenasDataset`)**: Elimina duplicados por clave oficial única, normaliza operadores y los 52 códigos provinciales INE, y exporta el censo compacto en `public/data/antenas.json`:

```json
{
  "updatedAt": "2026-11-15T21:25:00Z",
  "sourceUrl": "https://geoportal.minetur.gob.es/VCTEL/vcne.do",
  "total": 62230,
  "crawlStats": {
    "requestsCount": 239,
    "durationSeconds": 550.14,
    "gridBoxesVisited": 239,
    "subdividedBoxes": 43,
    "zoomParam": 7,
    "delaySeconds": 1.0,
    "vodafoneFusedDuplicates": 7604,
    "bandsPopulatedCount": 62230,
    "bandRequestsCount": 45
  },
  "operators": { "...": "..." },
  "provinces": [ { "provincia": "MADRID", "count": 6643, "byOperator": { "...": 0 } } ],
  "antenas": [
    {
      "id": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800006",
      "gid": "2800006",
      "op": "movistar",
      "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
      "lat": 40.434322,
      "lon": -3.642914,
      "dir": "CL EMILIO FERRARI, 11",
      "mun": "MADRID",
      "prov": "MADRID",
      "bandas": ["700 MHz", "800 MHz", "900 MHz", "1800 MHz", "2100 MHz", "2600 MHz", "3500 MHz"],
      "frecuencias": [
        "778.00 - 788.00",
        "852.00 - 862.00",
        "935.10 - 949.90",
        "1805.10 - 1825.10",
        "2155.00 - 2170.00",
        "2620.00 - 2640.00",
        "3460.00 - 3600.00"
      ],
      "concesiones": [
        { "ref": "M M -2205199", "freq": "3460.00 - 3600.00" }
      ],
      "bandsScannedAt": "2026-11-15T17:14:09Z"
    }
  ]
}
```

```bash
# Prueba rápida de validación (2 celdas de muestra → JSON propio)
python3 scripts/fetch_antenas.py --region sample --output public/data/antenas.json

# Escaneo diario completo de España + primer tramo de re-escaneo de bandas y generación de Novedades (>= 1.0 s/req)
python3 scripts/fetch_antenas.py \
  --region all \
  --output public/data/antenas.json \
  --delay 1.0 \
  --preserve-from public/data/antenas.json \
  --fetch-bands \
  --max-band-seconds 17400 \
  --rescan-since "2026-11-16T17:00:00Z" \
  --novedades-output public/data/novedades.json \
  --novedades-mode reset \
  --scan-id "daily-20261116"

# Continuación por lotes del re-escaneo de bandas acumulando Novedades del mismo ciclo
python3 scripts/fetch_antenas.py \
  --enrich-bands-only \
  --input public/data/antenas.json \
  --output public/data/antenas.json \
  --delay 1.0 \
  --max-band-seconds 18600 \
  --rescan-since "2026-11-16T17:00:00Z" \
  --novedades-output public/data/novedades.json \
  --novedades-mode append \
  --scan-id "daily-20261116"

# Escaneo forzado de línea base (actualiza antenas y frecuencias SIN contabilizar en Novedades)
python3 scripts/fetch_antenas.py \
  --region all \
  --output public/data/antenas.json \
  --delay 1.0 \
  --preserve-from public/data/antenas.json \
  --fetch-bands \
  --max-band-seconds 17400 \
  --rescan-since "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --novedades-output public/data/novedades.json \
  --novedades-mode reset \
  --skip-novedades
```

---

## Desarrollo Local

### Requisitos previos
- **Node.js** `>= 22` y `npm`
- **Python** `>= 3.11` (únicamente si deseas ejecutar localmente el recolector de datos)

### Comandos disponibles

```bash
# 1. Instalar dependencias
npm install

# 2. Iniciar servidor de desarrollo en caliente (Vite)
npm run dev

# 3. Ejecutar pruebas unitarias (Vitest + pruebas del recolector)
npm test
python3 -m unittest scripts/test_fetch_antenas.py

# 4. Analizar código con Oxlint
npm run lint

# 5. Compilar versión estática de producción en ./dist
npm run build

# 6. Previsualizar compilación de producción
npm run preview
```

---

## Activación de GitHub Pages y Escaneo Automático Diario a las 18:00 (`Europe/Madrid`)

El flujo `.github/workflows/update-and-deploy.yml` coordina el escaneo nacional diario y el despliegue estático mediante los grupos de concurrencia `'infoantenas-crawl-worker'` y `'pages-update-and-deploy'`:

1. Sube el repositorio a GitHub con la rama principal `main`.
2. En tu repositorio de GitHub, abre **Settings → Pages**.
3. En **Build and deployment → Source**, selecciona **GitHub Actions**.
4. Para **forzar un escaneo completo ahora sin contabilizarlo en `Novedades`** (línea base):
   - Desde la interfaz web: ve a **Actions → «Actualizar Censo Infoantenas y Desplegar en GitHub Pages» → Run workflow**, mantén `refresh_data = true` y **desmarca `record_novedades` (`false`)**.
   - O desde GitHub CLI:
     ```bash
     gh workflow run update-and-deploy.yml -f refresh_data=true -f record_novedades=false
     ```
5. Funcionamiento automático diario:
   - **Disparo horario exacto a las 18:00 hora española (`Europe/Madrid`)**: el cron `'0 16,17 * * *'` junto al filtro `TZ=Europe/Madrid date +%H == 18` garantiza que el escaneo arranque siempre a las **18:00** tanto en horario de invierno (`CET`, `UTC+1`) como en horario de verano (`CEST`, `UTC+2`).
   - **Escaneo encadenado en 4 tramos (`scan-part-1` → `scan-part-4`)**: dado que consultar todos los emplazamientos de España respetando `>= 1.0 s/req` requiere ~17 horas y cada *job* de GitHub Actions tiene un límite de 6 h, el flujo encadena automáticamente hasta 4 tramos (`17.400 s` + `3 × 18.600 s` = `73.200 s` de presupuesto), confirmando checkpoints en `main`, acumulando las altas en `public/data/novedades.json` (`reset` en el tramo 1 y `append` en los tramos 2–4) y desplegando finalmente la aplicación actualizada en GitHub Pages.
   - Cualquier `push` a `main` recompilará y desplegará la interfaz al instante sin repetir el barrido de datos.

---

## Fuente de Datos y Aviso Legal

Datos públicos procedentes del [Geoportal de Estaciones de Telecomunicaciones (Infoantenas)](https://geoportal.minetur.gob.es/VCTEL/vcne.do) del Ministerio para la Transformación Digital y de la Función Pública de España. Herramienta independiente de visualización cartográfica y divulgación técnica en radiofrecuencia.
