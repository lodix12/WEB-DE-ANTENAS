# RadioMapa España · Mapa y Censo de Antenas de Redes Móviles

Aplicación web cartográfica de ingeniería RF y explorador de datos abiertos para consultar las estaciones base de telefonía móvil registradas en toda España (**Movistar**, **Orange / MasOrange**, **Vodafone**, **Yoigo / Grupo MásMóvil**, **DIGI** y operadores regionales), sincronizada automáticamente cada **24 horas** con la fuente oficial **Infoantenas** del Ministerio para la Transformación Digital y de la Función Pública (MINETUR).

---

## Características Principales

- **Mapa Vectorial de Alto Rendimiento (MapLibre GL JS + OpenFreeMap)**:
  - Renderizado WebGL fluido de decenas de miles de emplazamientos en Península, Islas Baleares, Islas Canarias, Ceuta y Melilla con agrupación dinámica (*clustering*), codificación cromática por operador y **agrupación visual multi-operador (`< 35 m`)** en un icono multicolor compartido cuando distintas redes comparten mástil o azotea (sin fusionar jamás estaciones de Telefónica consigo mismas).
  - Cinco estilos cartográficos vectoriales sin claves ni límites de cuota (**Liberty**, **Positron**, **Bright**, **Dark Matter** y **Fiord**) sincronizados con el selector de **Modo Claro / Modo Oscuro**.
- **Medición de Distancia entre 2 Puntos y Radar GPS 4G/5G**:
  - La función **"Medir en mapa"** permite seleccionar **2 puntos cualesquiera en el mapa** (Punto A y Punto B) mostrando el segmento geodésico y la distancia exacta entre ambos.
  - Además, permite usar el **GPS del dispositivo** o escribir **coordenadas WGS84 directas** (ej. `40.4168, -3.7038`) para localizar las estaciones más cercanas en radios de `500 m` a `10 km` con su rumbo de brújula (`acimut`).
- **Ficha Técnica de Estación y Co-emplazamiento (`< 35 m` / `< 100 m`)**:
  - Inspección completa de operador comercial, razón social concesionaria, `Gis_ID` (incluyendo expedientes fusionados `mergedGids`), dirección postal, coordenadas copiables en un clic, selector rápido de operadores integrados en el mismo icono (`< 35 m`) y detección de estaciones próximas (`< 100 m`).
  - Enlace directo al expediente oficial `detalleEstacion.do` del Ministerio para consultar las **bandas activas en MHz** (`700–3500 MHz`) y los **niveles certificados de exposición radioeléctrica (`µW/cm²`)**, además de accesos rápidos a **Google Street View** y **OpenStreetMap**.
- **Explorador Virtualizado de Datos (`/explorar`) y Exportación Abierta**:
  - Tabla de alta densidad capaz de desplazar y ordenar más de **60.000 filas a 60 FPS** sin paginación gracias a `@tanstack/react-table` v9 + `@tanstack/react-virtual`.
  - Filtros en cascada por provincia y municipio, filtrado por operador, ordenación instantánea por distancia/acimut y exportación directa en **JSON propio (`.json`)**, **CSV (Excel UTF-8)** y opción secundaria SIG (`GeoJSON` para QGIS/ArcGIS).
- **Estadísticas Territoriales (`/estadisticas`)**:
  - Cuotas nacionales por operador y razón social (con **deduplicación espacial de declaraciones duplicadas de Vodafone a `< 35 m`** contabilizadas como 1 única estación, mientras que las antenas de Telefónica nunca se fusionan consigo mismas), desglose completo de las 52 provincias y ciudades autónomas con barras multi-operador apiladas y estado del pipeline diario.

---

## Arquitectura Tecnológica

| Capa | Tecnología | Propósito |
| :--- | :--- | :--- |
| **Interfaz y Bundler** | React 19 + TypeScript 7 + Vite 8 | Arquitectura modular tipada con *bundle splitting* optimizado |
| **Enrutamiento SPA** | `@tanstack/react-router` (`createHashHistory`) | Rutas `#/`, `#/explorar` y `#/estadisticas` sin errores 404 en GitHub Pages |
| **Datos y Caché** | `@tanstack/react-query` v5 + JSON Propio | Importación exclusiva de `data/antenas.json` (con validación de esquema propio), caché en memoria e índices `O(1)` |
| **Tabla + Virtualización** | `@tanstack/react-table` v9 + `@tanstack/react-virtual` | Ordenación reactiva y renderizado virtual de 62.230+ estaciones |
| **Motor Cartográfico** | `maplibre-gl` v6 + OpenFreeMap | Teselas vectoriales libres, renderizado WebGL en GPU desde el JSON propio y línea de vista RF |
| **Pipeline de Datos** | Python 3.12 (`scripts/fetch_antenas.py`) | Barrido iterativo *quadtree* que transforma e importa las estaciones en el esquema JSON propio `public/data/antenas.json` |
| **CI/CD y Hosting** | GitHub Actions + GitHub Pages | Sincronización automática cada 24 h (`04:00 UTC`) y despliegue estático |

---

## Esquema JSON Propio y Recolector Diario (`scripts/fetch_antenas.py` → `public/data/antenas.json`)

**El frontend estático carga únicamente nuestro archivo JSON propio (`data/antenas.json`)** y jamás realiza peticiones al endpoint GeoJSON de MINETUR desde el navegador del usuario (rechazando explícitamente cualquier `FeatureCollection` cruda en tiempo de validación).

Para construir y mantener al día `public/data/antenas.json`, el recolector diario `scripts/fetch_antenas.py` (ejecutado en GitHub Actions cada 24 h) consulta por lotes las celdas del Geoportal oficial salvando su límite de `1.000` registros por caja delimitadora (`bbox`):

1. **Malla Territorial Completa**: Recorre de noroeste (NO) a sureste (SE) la Península Ibérica, Islas Baleares, Islas Canarias, Ceuta y Melilla.
2. **Subdivisión Adaptativa Quadtree**: Cuando una celda alcanza el tope de `1.000` registros (áreas metropolitanas densas), el script la subdivide recursivamente en 4 cuadrantes con un solape de seguridad de `0.0001°`.
3. **Pausa de Cortesía y Decodificación**: Garantiza una espera mínima de `1.0 s` entre peticiones HTTP consecutivas, reintentos con *backoff* exponencial, *checkpoints* reanudables y decodificación estricta `ISO-8859-1 → UTF-8` para conservar eñes y tildes.
4. **Fusión de Duplicados de Vodafone (`< 35 m`), Agrupación Visual Multi-Operador (`< 35 m`) y No-Fusión de Telefónica**:
   - **Vodafone (`< 35 m`)**: Fusiona mediante malla espacial y componentes conexas las declaraciones administrativas duplicadas de Vodafone situadas a menos de `35 metros` en **1 única antena canónica** (conservando todos sus códigos en `mergedGids` y registrando el total descontado en `crawlStats.vodafoneFusedDuplicates`), contabilizándose siempre como **1 sola estación** en el censo y en todas las estadísticas.
   - **Distintos operadores (`< 35 m`)**: Las estaciones de operadores diferentes ubicadas a menos de `35 metros` se agrupan visualmente en el mapa en un icono multicolor compartido mostrando los colores de todas las redes presentes, pero mantienen intacto el recuento individual de cada operador en estadísticas.
   - **Telefónica (`Movistar`)**: Las antenas de Telefónica **nunca se fusionan con otras antenas de ella misma** (ni en el censo/estadísticas ni en el mapa), preservando cada declaración oficial independiente.
5. **Extracción Incremental de Bandas y Frecuencias RF (`detalleEstacion.do` a `1.0 s/req`)**:
   - Consulta `https://geoportal.minetur.gob.es/VCTEL/detalleEstacion.do?emplazamiento=<Gis_ID>` respetando estrictamente **`>= 1.0 s` de pausa** entre peticiones consecutivas y decodificación `ISO-8859-1`.
   - Analiza exclusivamente la tabla `CARACTERISTICAS TÉCNICAS` (ignorando `NIVELES MEDIDOS`), separa las frecuencias por operador normalizado cuando varios operadores comparten un mismo `Gis_ID` (obteniendo múltiples antenas en 1 sola petición HTTP) y une (`union`) todos los `mergedGids` en estaciones Vodafone fusionadas.
   - Clasifica cada rango en bandas comerciales españolas (`700 MHz`, `800 MHz`, `900 MHz`, `1500 MHz`, `1800 MHz`, `2100 MHz`, `2600 MHz`, `3500 MHz`, `26 GHz`) y conserva automáticamente las bandas ya descargadas en cada barrido diario (`--preserve-from`).
6. **Transformación a Esquema JSON Propio (`AntenasDataset`)**: Elimina duplicados por clave oficial única, normaliza operadores y los 52 códigos provinciales INE, y exporta el censo compacto en `public/data/antenas.json`:

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
    "bandsPopulatedCount": 89,
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
      ]
    }
  ]
}
```

```bash
# Prueba rápida de validación (2 celdas de muestra → JSON propio)
python3 scripts/fetch_antenas.py --region sample --output public/data/antenas.json

# Barrido completo de España preservando bandas previas y poblando antenas nuevas (>= 1.0 s/req)
python3 scripts/fetch_antenas.py --region all --output public/data/antenas.json --delay 1.0 --preserve-from public/data/antenas.json --fetch-bands --max-band-seconds 14400

# Enriquecimiento incremental solo de antenas sin bandas (checkpoints atómicos cada 50 peticiones)
python3 scripts/fetch_antenas.py --enrich-bands-only --input public/data/antenas.json --output public/data/antenas.json --delay 1.0 --max-band-seconds 18000
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

## Activación de GitHub Pages y Sincronización Automática (Censo 24h + Bandas RF 6h)

Los flujos `.github/workflows/update-and-deploy.yml` y `.github/workflows/enrich-bandas.yml` están coordinados mediante el grupo de concurrencia `'pages-update-and-deploy'` para funcionar de forma 100 % autónoma:

1. Sube el repositorio a GitHub con la rama principal `main`.
2. En tu repositorio de GitHub, abre **Settings → Pages**.
3. En **Build and deployment → Source**, selecciona **GitHub Actions**.
4. Ve a la pestaña **Actions**, selecciona **«Actualizar Censo Infoantenas y Desplegar en GitHub Pages»** o **«Enriquecer Bandas y Frecuencias RF (Incremental)»** y pulsa **Run workflow**.
5. A partir de ese momento:
   - **Enriquecimiento incremental de bandas (`enrich-bandas.yml`, cada 6 h — `20 */6 * * *`)**: dado que consultar ~60.000 emplazamientos respetando `1.0 s` por petición requiere ~17 horas y cada *job* de GitHub Actions tiene un tope de 6 h, este flujo ejecuta lotes de hasta `5 h` (`--max-band-seconds 18000`), confirma el progreso en `main` y redespliega GitHub Pages. Una vez que `pendientes == 0`, finaliza en ~2 segundos sin realizar commits ni redespliegues innecesarios.
   - **Sincronización diaria del censo (`update-and-deploy.yml`, cada 24 h — `04:00 UTC`)**: actualiza el censo nacional de Infoantenas conservando siempre el 100 % de las `bandas` y `frecuencias` ya almacenadas (`--preserve-from public/data/antenas.json`) y descarga automáticamente a `1.0 s/req` las bandas de cualquier antena nueva (`--fetch-bands --max-band-seconds 14400`).
   - Cualquier `push` a `main` recompilará y desplegará la interfaz al instante sin necesidad de repetir el barrido completo de datos.

---

## Fuente de Datos y Aviso Legal

Datos públicos procedentes del [Geoportal de Estaciones de Telecomunicaciones (Infoantenas)](https://geoportal.minetur.gob.es/VCTEL/vcne.do) del Ministerio para la Transformación Digital y de la Función Pública de España. Herramienta independiente de visualización cartográfica y divulgación técnica en radiofrecuencia.
