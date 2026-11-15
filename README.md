# RadioMapa España · Mapa y Censo de Antenas de Redes Móviles

Aplicación web cartográfica de ingeniería RF y explorador de datos abiertos para consultar las estaciones base de telefonía móvil registradas en toda España (**Movistar**, **Orange / MasOrange**, **Vodafone**, **Yoigo / Grupo MásMóvil**, **DIGI** y operadores regionales), sincronizada automáticamente cada **24 horas** con la fuente oficial **Infoantenas** del Ministerio para la Transformación Digital y de la Función Pública (MINETUR).

---

## Características Principales

- **Mapa Vectorial de Alto Rendimiento (MapLibre GL JS + OpenFreeMap)**:
  - Renderizado WebGL fluido de decenas de miles de emplazamientos en Península, Islas Baleares, Islas Canarias, Ceuta y Melilla con agrupación dinámica (*clustering*) y codificación cromática por operador.
  - Cinco estilos cartográficos vectoriales sin claves ni límites de cuota (**Liberty**, **Positron**, **Bright**, **Dark Matter** y **Fiord**) sincronizados con el selector de **Modo Claro / Modo Oscuro**.
- **Radar de Cercanía y Orientación 4G/5G Rural**:
  - Permite usar el **GPS del dispositivo**, **medir cualquier punto en el mapa** o escribir **coordenadas WGS84 directas** (ej. `40.4168, -3.7038`) en el buscador.
  - Calcula las estaciones más cercanas en radios de `500 m` a `10 km`, mostrando la **distancia exacta** y el **rumbo de brújula / acimut geodésico** (`NNE 24°`) indispensable para apuntar routers y antenas exteriores directivas 4G/5G.
- **Ficha Técnica de Estación y Detección de Co-emplazamiento (`< 100 m`)**:
  - Inspección completa de operador comercial, razón social concesionaria, `Gis_ID`, dirección postal, coordenadas copiables en un clic, vector de línea de vista y detección automática de **mástiles o azoteas compartidas** con otros operadores a menos de 100 metros.
  - Enlace directo al expediente oficial `detalleEstacion.do` del Ministerio para consultar las **bandas activas en MHz** (`700–3500 MHz`) y los **niveles certificados de exposición radioeléctrica (`µW/cm²`)**, además de accesos rápidos a **Google Street View** y **OpenStreetMap**.
- **Explorador Virtualizado de Datos (`/explorar`) y Exportación Abierta**:
  - Tabla de alta densidad capaz de desplazar y ordenar más de **65.000 filas a 60 FPS** sin paginación gracias a `@tanstack/react-table` v9 + `@tanstack/react-virtual`.
  - Filtros en cascada por provincia y municipio, filtrado por operador, ordenación instantánea por distancia/acimut y exportación directa en **JSON propio (`.json`)**, **CSV (Excel UTF-8)** y opción secundaria SIG (`GeoJSON` para QGIS/ArcGIS).
- **Estadísticas Territoriales (`/estadisticas`) y Guía RF (`/metodologia`)**:
  - Cuotas nacionales por operador y razón social, desglose de las 52 provincias y ciudades autónomas con barras multi-operador apiladas, guía completa de bandas móviles en España (`n28`, `B20`, `B8`, `B3`, `B1`, `B7`, `n78`) y referencia normativa del **Real Decreto 1066/2001**.

---

## Arquitectura Tecnológica

| Capa | Tecnología | Propósito |
| :--- | :--- | :--- |
| **Interfaz y Bundler** | React 19 + TypeScript 7 + Vite 8 | Arquitectura modular tipada con *bundle splitting* optimizado |
| **Enrutamiento SPA** | `@tanstack/react-router` (`createHashHistory`) | Rutas `#/`, `#/explorar`, `#/estadisticas`, `#/metodologia` sin errores 404 en GitHub Pages |
| **Datos y Caché** | `@tanstack/react-query` v5 + JSON Propio | Importación exclusiva de `data/antenas.json` (con validación de esquema propio), caché en memoria e índices `O(1)` |
| **Tabla + Virtualización** | `@tanstack/react-table` v9 + `@tanstack/react-virtual` | Ordenación reactiva y renderizado virtual de 65.000+ estaciones |
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
4. **Transformación a Esquema JSON Propio (`AntenasDataset`)**: Elimina duplicados por clave oficial única, normaliza operadores y los 52 códigos provinciales INE, y exporta el censo compacto en `public/data/antenas.json`:

```json
{
  "updatedAt": "2026-11-15T04:00:00Z",
  "sourceUrl": "https://geoportal.minetur.gob.es/VCTEL/vcne.do",
  "total": 69834,
  "crawlStats": {
    "requestsCount": 239,
    "durationSeconds": 550.14,
    "gridBoxesVisited": 239,
    "subdividedBoxes": 43,
    "zoomParam": 7,
    "delaySeconds": 1.0
  },
  "operators": { "...": "..." },
  "provinces": [ { "provincia": "MADRID", "count": 7588, "byOperator": { "...": 0 } } ],
  "antenas": [
    {
      "id": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001",
      "gid": "2800001",
      "op": "movistar",
      "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
      "lat": 40.4168,
      "lon": -3.7038,
      "dir": "CL GRAN VIA, 28",
      "mun": "MADRID",
      "prov": "MADRID"
    }
  ]
}
```

```bash
# Prueba rápida de validación (2 celdas de muestra → JSON propio)
python3 scripts/fetch_antenas.py --region sample --output public/data/antenas.json

# Barrido completo de toda España (respeta >= 1.0 s por petición)
python3 scripts/fetch_antenas.py --region all --output public/data/antenas.json --delay 1.0
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

## Activación de GitHub Pages y Actualización Automática 24h

El flujo `.github/workflows/update-and-deploy.yml` está listo para funcionar de forma 100 % autónoma en GitHub:

1. Sube el repositorio a GitHub con la rama principal `main`.
2. En tu repositorio de GitHub, abre **Settings → Pages**.
3. En **Build and deployment → Source**, selecciona **GitHub Actions**.
4. Ve a la pestaña **Actions**, selecciona el workflow **«Actualizar Censo Infoantenas y Desplegar en GitHub Pages»** y pulsa **Run workflow** (con la casilla *refresh_data* activada para poblar el censo nacional completo en el primer despliegue).
5. A partir de ese momento:
   - Cada día a las **04:00 UTC**, GitHub Actions descargará los cambios del registro oficial de Infoantenas, guardará `public/data/antenas.json` en `main` si hay novedades y volverá a publicar automáticamente la web en `https://<usuario>.github.io/WEB-DE-ANTENAS/`.
   - Cualquier `push` a `main` recompilará y desplegará la interfaz al instante sin necesidad de repetir el barrido completo de datos.

---

## Fuente de Datos y Aviso Legal

Datos públicos procedentes del [Geoportal de Estaciones de Telecomunicaciones (Infoantenas)](https://geoportal.minetur.gob.es/VCTEL/vcne.do) del Ministerio para la Transformación Digital y de la Función Pública de España. Herramienta independiente de visualización cartográfica y divulgación técnica en radiofrecuencia.
