import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type {
  Feature,
  FeatureCollection,
  LineString,
  Point,
  Polygon,
} from 'geojson';
import {
  OPENFREEMAP_STYLES,
  OPERATOR_META,
  type AntennaRecord,
  type OperatorKey,
} from '../../types/antena';
import type { AntenasMapProps, MeasurePoint } from '../../types/map';
import {
  SPAIN_REGION_PRESETS,
  createCirclePolygonGeoJSON,
  formatDistance,
  groupColocatedAntennasForMap,
  haversineDistanceKm,
  type MapSiteEntry,
} from '../../utils/geo';
import { MapOverlays } from './MapOverlays';
import '../../styles/map.css';

// Configuración explícita del Web Worker ESM de MapLibre GL JS v6.18.0:
// - En `vite dev`, `maplibreWorkerUrl` arranca con `/` (ej. `/node_modules/...`).
// - En `vite build` con `base: './'`, Vite resuelve `maplibreWorkerUrl` vía `import.meta.url`
//   a una URL absoluta válida bajo cualquier subruta (ej. `https://.../WEB-DE-ANTENAS/assets/...`).
// `new URL(maplibreWorkerUrl, window.location.href).href` resuelve ambos casos de forma determinista.
if (typeof window !== 'undefined') {
  maplibregl.setWorkerUrl(
    new URL(maplibreWorkerUrl, window.location.href).href,
  );
}

const ANTENAS_SOURCE_ID = 'antenas-source';
const RADAR_SOURCE_ID = 'radar-source';
const MEASURE_SOURCE_ID = 'measure-source';

const LAYER_RADAR_FILL = 'radar-coverage-fill';
const LAYER_RADAR_OUTLINE = 'radar-coverage-outline';
const LAYER_RADAR_LOS_CASING = 'radar-los-casing';
const LAYER_RADAR_LOS_LINE = 'radar-los-line';
const LAYER_RADAR_LOS_LABEL = 'radar-los-label';
const LAYER_RADAR_ORIGIN_HALO = 'radar-origin-halo';
const LAYER_RADAR_ORIGIN_POINT = 'radar-origin-point';

const LAYER_MEASURE_CASING = 'measure-line-casing';
const LAYER_MEASURE_LINE = 'measure-line';
const LAYER_MEASURE_POINTS_HALO = 'measure-points-halo';
const LAYER_MEASURE_POINTS = 'measure-points';
const LAYER_MEASURE_POINT_LABELS = 'measure-point-labels';
const LAYER_MEASURE_DISTANCE_LABEL = 'measure-distance-label';

const LAYER_CLUSTERS_HALO = 'antenas-clusters-halo';
const LAYER_CLUSTERS = 'antenas-clusters';
const LAYER_CLUSTER_COUNT = 'antenas-cluster-count';
const LAYER_UNCLUSTERED = 'antenas-unclustered';
const LAYER_UNCLUSTERED_MULTI = 'antenas-unclustered-multi';
const LAYER_SELECTED_HALO = 'antenas-selected-halo';
const LAYER_SELECTED_RING = 'antenas-selected-ring';

const NONE_SELECTED_SENTINEL = '__none_selected__';
const MULTI_SPRITE_CACHE = new Map<string, ImageData>();

interface AntennaFeatureProperties {
  idx: number;
  id: string;
  primaryId: string;
  gid: string;
  op: OperatorKey;
  opRaw: string;
  dir: string;
  mun: string;
  prov: string;
  lat: number;
  lon: number;
  isMultiOp: boolean;
  iconKey: string;
  operatorsCsv: string;
  stationCount: number;
  memberIdsPipe: string;
}

interface RadarFeatureProperties {
  kind: 'coverage' | 'origin' | 'los';
  radiusKm?: number;
  label?: string;
  distanceLabel?: string;
}

interface MeasureFeatureProperties {
  kind: 'measure-line' | 'measure-point' | 'measure-midpoint';
  pointTag?: 'A' | 'B';
  distanceLabel?: string;
}

function formatMeasureDistanceLabel(km: number): string {
  const meters = km * 1000;
  if (meters < 100) {
    return `${meters.toLocaleString('es-ES', {
      minimumFractionDigits: meters < 10 ? 2 : 1,
      maximumFractionDigits: meters < 10 ? 2 : 1,
    })} m`;
  }
  if (km < 1) {
    return `${Math.round(meters).toLocaleString('es-ES')} m`;
  }
  return formatDistance(km);
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isValidOperatorKey(value: unknown): value is OperatorKey {
  return (
    value === 'movistar' ||
    value === 'orange' ||
    value === 'vodafone' ||
    value === 'masmovil' ||
    value === 'digi' ||
    value === 'otros'
  );
}

function parseOperatorsFromIconKey(iconKey: string): OperatorKey[] {
  if (!iconKey.startsWith('multi:')) {
    return [];
  }
  const parts = iconKey.slice('multi:'.length).split('|');
  const operators: OperatorKey[] = [];
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    if (isValidOperatorKey(item) && !operators.includes(item)) {
      operators.push(item);
    }
  }
  return operators;
}

/**
 * Genera en Canvas 2D (`64x64` px, `pixelRatio: 2`) un icono circular multicolor de alta legibilidad
 * cartográfica con sectores iguales de los operadores integrados, separadores radiales blancos nítidos,
 * núcleo técnico central y borde exterior blanco de alto contraste.
 */
function createMultiOperatorSprite(
  operators: OperatorKey[],
  isDark: boolean,
): ImageData {
  const size = 64;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 24.5;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return new ImageData(size, size);
  }

  // Sombra/contorno exterior oscuro sutil para garantizar contraste en fondos claros u oscuros
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy + 0.8, radius + 3.2, 0, Math.PI * 2);
  ctx.fillStyle = isDark
    ? 'rgba(2, 6, 23, 0.74)'
    : 'rgba(15, 23, 42, 0.30)';
  ctx.fill();
  ctx.restore();

  const ops: OperatorKey[] = operators.length > 0 ? operators : ['otros'];
  const sliceAngle = (Math.PI * 2) / ops.length;
  const startBase = -Math.PI / 2;

  for (let i = 0; i < ops.length; i++) {
    const startAngle = startBase + i * sliceAngle;
    const endAngle = startAngle + sliceAngle;
    const meta = OPERATOR_META[ops[i]] ?? OPERATOR_META.otros;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = meta.color;
    ctx.fill();
  }

  // Separadores radiales blancos nítidos (`lineWidth = 3` a 2x) para distinguir colores cálidos adyacentes
  if (ops.length >= 2) {
    ctx.save();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 3;
    ctx.lineCap = 'butt';
    for (let i = 0; i < ops.length; i++) {
      const angle = startBase + i * sliceAngle;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(
        cx + Math.cos(angle) * radius,
        cy + Math.sin(angle) * radius,
      );
      ctx.stroke();
    }
    ctx.restore();
  }

  // Pequeño núcleo central limpio
  ctx.beginPath();
  ctx.arc(cx, cy, 4.8, 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = '#0F172A';
  ctx.fill();

  // Borde exterior blanco de alto contraste (`lineWidth = 4.5` a 2x) + perfil técnico exterior
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 4.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, radius + 2.5, 0, Math.PI * 2);
  ctx.strokeStyle = isDark
    ? 'rgba(2, 6, 23, 0.86)'
    : 'rgba(15, 23, 42, 0.36)';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  return ctx.getImageData(0, 0, size, size);
}

function registerMultiOperatorSprite(
  map: maplibregl.Map,
  iconKey: string,
  isDark: boolean,
): void {
  if (!iconKey.startsWith('multi:') || map.hasImage(iconKey)) {
    return;
  }
  const operators = parseOperatorsFromIconKey(iconKey);
  if (operators.length === 0) {
    return;
  }
  const cacheKey = `${isDark ? 'dark' : 'light'}:${iconKey}`;
  let imageData = MULTI_SPRITE_CACHE.get(cacheKey);
  if (!imageData) {
    imageData = createMultiOperatorSprite(operators, isDark);
    MULTI_SPRITE_CACHE.set(cacheKey, imageData);
  }
  if (!map.hasImage(iconKey)) {
    map.addImage(iconKey, imageData, { pixelRatio: 2 });
  }
}

function buildSelectedFilter(
  selectedId: string | null | undefined,
): maplibregl.FilterSpecification {
  const token = `|${selectedId ?? NONE_SELECTED_SENTINEL}|`;
  return [
    'all',
    ['!', ['has', 'point_count']],
    ['in', token, ['get', 'memberIdsPipe']],
  ];
}

function buildPopupHtml(
  props: AntennaFeatureProperties,
  site?: MapSiteEntry,
): string {
  const locationLine = [props.mun, props.prov].filter(Boolean).join(', ');
  const safeLocation = escapeHtml(locationLine || 'Ubicación registrada');
  const safeDir = escapeHtml(props.dir || 'Sin dirección postal detallada');

  if (props.isMultiOp) {
    const pillsHtml = site
      ? site.members
          .map((member) => {
            const mMeta = OPERATOR_META[member.op] ?? OPERATOR_META.otros;
            const safeShort = escapeHtml(mMeta.shortName);
            const safeMemberGid = escapeHtml(member.gid || 'S/D');
            return `
              <span class="map-popup-multi-pill">
                <span class="map-popup-op-dot" style="background-color:${mMeta.color}"></span>
                <span>${safeShort}</span>
                <span class="map-popup-multi-gid">#${safeMemberGid}</span>
              </span>
            `;
          })
          .join('')
      : parseOperatorsFromIconKey(props.iconKey)
          .map((op) => {
            const mMeta = OPERATOR_META[op] ?? OPERATOR_META.otros;
            return `
              <span class="map-popup-multi-pill">
                <span class="map-popup-op-dot" style="background-color:${mMeta.color}"></span>
                <span>${escapeHtml(mMeta.shortName)}</span>
              </span>
            `;
          })
          .join('');

    const opCount = site
      ? site.operators.length
      : Math.max(2, parseOperatorsFromIconKey(props.iconKey).length);

    return `
      <div class="map-popup-head">
        <span class="map-popup-shared-badge">Emplazamiento compartido (&lt; 5 m)</span>
        <span class="map-popup-gid">${opCount} oper.</span>
      </div>
      <div class="map-popup-multi-list">${pillsHtml}</div>
      <div class="map-popup-loc">${safeLocation}</div>
      <div class="map-popup-dir">${safeDir}</div>
      <div class="map-popup-hint">Clic para inspeccionar operadores integrados</div>
    `;
  }

  const opMeta = OPERATOR_META[props.op] ?? OPERATOR_META.otros;
  const safeOpName = escapeHtml(opMeta.shortName);
  const safeGid = escapeHtml(props.gid || 'S/D');

  return `
    <div class="map-popup-head">
      <span class="map-popup-op-pill">
        <span class="map-popup-op-dot" style="background-color:${opMeta.color}"></span>
        ${safeOpName}
      </span>
      <span class="map-popup-gid">ID ${safeGid}</span>
    </div>
    <div class="map-popup-loc">${safeLocation}</div>
    <div class="map-popup-dir">${safeDir}</div>
    <div class="map-popup-hint">Clic para inspeccionar ficha técnica</div>
  `;
}

const EMPTY_MEASURE_POINTS: MeasurePoint[] = [];

export function AntenasMap(props: AntenasMapProps) {
  const {
    antenas,
    selectedAntenna,
    onSelectAntenna,
    styleId,
    onStyleChange,
    flyToTarget,
    radarPoint,
    onRadarPointChange,
    radarModeActive = false,
    onToggleRadarMode,
    measurePoints,
    onMeasurePointsChange,
    measureModeActive,
    onToggleMeasureMode,
    activeOperators,
    onToggleOperator,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const hoveredIdRef = useRef<string | null>(null);
  const appliedStyleIdRef = useRef<AntenasMapProps['styleId']>(styleId);
  const lastFlyTokenRef = useRef<number | string | null>(null);
  const hasLoadedOnceRef = useRef(false);
  const lastAppliedGeoJsonRef = useRef<FeatureCollection<
    Point,
    AntennaFeatureProperties
  > | null>(null);

  const [activeRegionId, setActiveRegionId] = useState<string | null>(() =>
    flyToTarget ? null : 'peninsula',
  );

  // Soporte híbrido controlado o autónomo para la regla de distancia entre 2 puntos ("Medir en mapa")
  const [internalMeasurePoints, setInternalMeasurePoints] = useState<
    MeasurePoint[]
  >([]);
  const [internalMeasureMode, setInternalMeasureMode] = useState(false);

  const isMeasureControlled =
    onMeasurePointsChange !== undefined || onToggleMeasureMode !== undefined;
  const effectiveMeasurePoints = isMeasureControlled
    ? (measurePoints ?? EMPTY_MEASURE_POINTS)
    : internalMeasurePoints;
  const effectiveMeasureModeActive = isMeasureControlled
    ? Boolean(measureModeActive)
    : internalMeasureMode;

  const handleMeasurePointsChange = useCallback(
    (nextPoints: MeasurePoint[]) => {
      if (onMeasurePointsChange) {
        onMeasurePointsChange(nextPoints);
      } else {
        setInternalMeasurePoints(nextPoints);
      }
    },
    [onMeasurePointsChange],
  );

  const handleToggleMeasureMode = useCallback(() => {
    if (onToggleMeasureMode) {
      onToggleMeasureMode();
    } else {
      setInternalMeasureMode((prev) => !prev);
    }
  }, [onToggleMeasureMode]);

  const currentStyleOption = useMemo(
    () =>
      OPENFREEMAP_STYLES.find((opt) => opt.id === styleId) ??
      OPENFREEMAP_STYLES[0],
    [styleId],
  );

  // Agrupación espacial en memoria (< 5 m entre distintos operadores + fusión defensiva Vodafone < 10 m)
  // hacia geometrías puntuales para el motor WebGL de MapLibre GL JS
  const {
    antenasGeoJson,
    antenasById,
    sitesById,
    siteByMemberAntennaId,
    multiIconKeys,
  } = useMemo(() => {
    const byId = new Map<string, AntennaRecord>();
    for (let i = 0; i < antenas.length; i++) {
      const ant = antenas[i];
      if (Number.isFinite(ant.lat) && Number.isFinite(ant.lon)) {
        byId.set(ant.id, ant);
      }
    }

    const groupedSites = groupColocatedAntennasForMap(antenas, 5);
    const bySiteId = new Map<string, MapSiteEntry>();
    const byMemberId = new Map<string, MapSiteEntry>();
    const iconKeys = new Set<string>();
    const features: Feature<Point, AntennaFeatureProperties>[] = [];

    for (let i = 0; i < groupedSites.length; i++) {
      const site = groupedSites[i];
      bySiteId.set(site.siteId, site);
      for (let m = 0; m < site.memberIds.length; m++) {
        byMemberId.set(site.memberIds[m], site);
      }
      if (site.isMultiOperator) {
        iconKeys.add(site.iconKey);
      }

      const primary = site.primary;
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [site.lon, site.lat],
        },
        properties: {
          idx: i,
          id: site.siteId,
          primaryId: primary.id,
          gid: primary.gid,
          op: primary.op,
          opRaw: primary.opRaw,
          dir: primary.dir,
          mun: primary.mun,
          prov: primary.prov,
          lat: site.lat,
          lon: site.lon,
          isMultiOp: site.isMultiOperator,
          iconKey: site.iconKey,
          operatorsCsv: site.operators.join('|'),
          stationCount: site.members.length,
          memberIdsPipe: `|${site.memberIds.join('|')}|`,
        },
      });
    }

    const collection: FeatureCollection<Point, AntennaFeatureProperties> = {
      type: 'FeatureCollection',
      features,
    };

    return {
      antenasGeoJson: collection,
      antenasById: byId,
      sitesById: bySiteId,
      siteByMemberAntennaId: byMemberId,
      multiIconKeys: Array.from(iconKeys),
    };
  }, [antenas]);

  // Construcción memorizada en memoria de geometrías auxiliares de radar RF (cobertura, pin central y vector LOS)
  const radarGeoJson = useMemo<
    FeatureCollection<Polygon | Point | LineString, RadarFeatureProperties>
  >(() => {
    const features: Feature<
      Polygon | Point | LineString,
      RadarFeatureProperties
    >[] = [];

    if (
      radarPoint &&
      Number.isFinite(radarPoint.lat) &&
      Number.isFinite(radarPoint.lon)
    ) {
      const radiusKm = radarPoint.radiusKm ?? 2;
      const circlePoly = createCirclePolygonGeoJSON(
        radarPoint.lon,
        radarPoint.lat,
        radiusKm,
        72,
      );
      features.push({
        type: 'Feature',
        geometry: circlePoly.geometry,
        properties: {
          kind: 'coverage',
          radiusKm,
        },
      });

      if (
        selectedAntenna &&
        Number.isFinite(selectedAntenna.lat) &&
        Number.isFinite(selectedAntenna.lon)
      ) {
        const distKm = haversineDistanceKm(
          radarPoint.lat,
          radarPoint.lon,
          selectedAntenna.lat,
          selectedAntenna.lon,
        );
        const matchedSite = siteByMemberAntennaId.get(selectedAntenna.id);
        const targetLon = matchedSite ? matchedSite.lon : selectedAntenna.lon;
        const targetLat = matchedSite ? matchedSite.lat : selectedAntenna.lat;

        features.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [radarPoint.lon, radarPoint.lat],
              [targetLon, targetLat],
            ],
          },
          properties: {
            kind: 'los',
            distanceLabel: formatDistance(distKm),
          },
        });
      }

      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [radarPoint.lon, radarPoint.lat],
        },
        properties: {
          kind: 'origin',
          label: radarPoint.label ?? 'Punto seleccionado',
        },
      });
    }

    return {
      type: 'FeatureCollection',
      features,
    };
  }, [radarPoint, selectedAntenna, siteByMemberAntennaId]);

  // Construcción memorizada de la regla de medición entre 2 puntos (Punto A, Punto B, segmento y etiqueta)
  const measureGeoJson = useMemo<
    FeatureCollection<Point | LineString, MeasureFeatureProperties>
  >(() => {
    const features: Feature<Point | LineString, MeasureFeatureProperties>[] =
      [];
    const pts = effectiveMeasurePoints.filter(
      (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon),
    );

    if (pts.length >= 2) {
      const pA = pts[0];
      const pB = pts[1];
      const distKm = haversineDistanceKm(pA.lat, pA.lon, pB.lat, pB.lon);
      const distanceLabel = formatMeasureDistanceLabel(distKm);

      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [pA.lon, pA.lat],
            [pB.lon, pB.lat],
          ],
        },
        properties: {
          kind: 'measure-line',
          distanceLabel,
        },
      });

      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [(pA.lon + pB.lon) / 2, (pA.lat + pB.lat) / 2],
        },
        properties: {
          kind: 'measure-midpoint',
          distanceLabel,
        },
      });
    }

    if (pts.length >= 1) {
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [pts[0].lon, pts[0].lat],
        },
        properties: {
          kind: 'measure-point',
          pointTag: 'A',
        },
      });
    }

    if (pts.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [pts[1].lon, pts[1].lat],
        },
        properties: {
          kind: 'measure-point',
          pointTag: 'B',
        },
      });
    }

    return {
      type: 'FeatureCollection',
      features,
    };
  }, [effectiveMeasurePoints]);

  // Referencias vivas sincronizadas en efectos para acceso estable desde listeners imperativos de MapLibre
  const antenasGeoJsonRef = useRef(antenasGeoJson);
  const antenasByIdRef = useRef(antenasById);
  const sitesByIdRef = useRef(sitesById);
  const multiIconKeysRef = useRef(multiIconKeys);
  const radarGeoJsonRef = useRef(radarGeoJson);
  const measureGeoJsonRef = useRef(measureGeoJson);
  const selectedAntennaRef = useRef(selectedAntenna);
  const onSelectAntennaRef = useRef(onSelectAntenna);
  const radarModeActiveRef = useRef(radarModeActive);
  const radarPointRef = useRef(radarPoint);
  const onRadarPointChangeRef = useRef(onRadarPointChange);
  const measureModeActiveRef = useRef(effectiveMeasureModeActive);
  const measurePointsRef = useRef(effectiveMeasurePoints);
  const onMeasurePointsChangeRef = useRef(handleMeasurePointsChange);
  const flyToTargetRef = useRef(flyToTarget);
  const isDarkStyleRef = useRef(currentStyleOption.isDark);

  useEffect(() => {
    antenasGeoJsonRef.current = antenasGeoJson;
    antenasByIdRef.current = antenasById;
    sitesByIdRef.current = sitesById;
    multiIconKeysRef.current = multiIconKeys;
  }, [antenasGeoJson, antenasById, sitesById, multiIconKeys]);

  useEffect(() => {
    radarGeoJsonRef.current = radarGeoJson;
  }, [radarGeoJson]);

  useEffect(() => {
    measureGeoJsonRef.current = measureGeoJson;
  }, [measureGeoJson]);

  useEffect(() => {
    selectedAntennaRef.current = selectedAntenna;
    onSelectAntennaRef.current = onSelectAntenna;
  }, [selectedAntenna, onSelectAntenna]);

  useEffect(() => {
    radarModeActiveRef.current = radarModeActive;
    radarPointRef.current = radarPoint;
    onRadarPointChangeRef.current = onRadarPointChange;
  }, [radarModeActive, radarPoint, onRadarPointChange]);

  useEffect(() => {
    measureModeActiveRef.current = effectiveMeasureModeActive;
    measurePointsRef.current = effectiveMeasurePoints;
    onMeasurePointsChangeRef.current = handleMeasurePointsChange;
  }, [
    effectiveMeasureModeActive,
    effectiveMeasurePoints,
    handleMeasurePointsChange,
  ]);

  useEffect(() => {
    flyToTargetRef.current = flyToTarget;
  }, [flyToTarget]);

  useEffect(() => {
    isDarkStyleRef.current = currentStyleOption.isDark;
  }, [currentStyleOption.isDark]);

  // Registro idempotente de fuentes y capas tras carga inicial o cambio de estilo OpenFreeMap:
  // Se registra SIEMPRE PRIMERO la fuente principal de antenas y sus capas, y DESPUÉS el radar auxiliar aislado en try/catch.
  const ensureCustomSourcesAndLayers = useCallback((map: maplibregl.Map) => {
    if (!map.getStyle()) {
      return;
    }

    const isDark = isDarkStyleRef.current;

    // Registrar todos los sprites multicolor activos en el atlas WebGL del estilo actual
    const activeIconKeys = multiIconKeysRef.current;
    for (let i = 0; i < activeIconKeys.length; i++) {
      registerMultiOperatorSprite(map, activeIconKeys[i], isDark);
    }

    // 1. Fuente principal clusterizada con suma exacta de estaciones integradas (`stationSum`)
    if (!map.getSource(ANTENAS_SOURCE_ID)) {
      map.addSource(ANTENAS_SOURCE_ID, {
        type: 'geojson',
        data: antenasGeoJsonRef.current,
        cluster: true,
        clusterMaxZoom: 12,
        clusterRadius: 46,
        clusterProperties: {
          stationSum: ['+', ['get', 'stationCount']],
        },
      });
      lastAppliedGeoJsonRef.current = antenasGeoJsonRef.current;
    }

    const clusterCountExpr: maplibregl.ExpressionSpecification = [
      'coalesce',
      ['get', 'stationSum'],
      ['get', 'point_count'],
    ];

    if (!map.getLayer(LAYER_CLUSTERS_HALO)) {
      map.addLayer({
        id: LAYER_CLUSTERS_HALO,
        type: 'circle',
        source: ANTENAS_SOURCE_ID,
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': [
            'step',
            clusterCountExpr,
            '#0284C7',
            50,
            '#0369A1',
            250,
            '#0F4C81',
            1000,
            '#1E293B',
            5000,
            '#0F172A',
          ],
          'circle-radius': [
            'step',
            clusterCountExpr,
            20,
            50,
            24,
            250,
            28,
            1000,
            33,
            5000,
            38,
          ],
          'circle-opacity': isDark ? 0.28 : 0.18,
        },
      });
    }

    if (!map.getLayer(LAYER_CLUSTERS)) {
      map.addLayer({
        id: LAYER_CLUSTERS,
        type: 'circle',
        source: ANTENAS_SOURCE_ID,
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': [
            'step',
            clusterCountExpr,
            '#0284C7',
            50,
            '#0369A1',
            250,
            '#0F4C81',
            1000,
            '#1E293B',
            5000,
            '#0F172A',
          ],
          'circle-radius': [
            'step',
            clusterCountExpr,
            15.5,
            50,
            19,
            250,
            23,
            1000,
            27.5,
            5000,
            32,
          ],
          'circle-stroke-width': 2,
          'circle-stroke-color': isDark ? '#E2E8F0' : '#FFFFFF',
        },
      });
    }

    if (!map.getLayer(LAYER_CLUSTER_COUNT)) {
      map.addLayer({
        id: LAYER_CLUSTER_COUNT,
        type: 'symbol',
        source: ANTENAS_SOURCE_ID,
        filter: ['has', 'point_count'],
        layout: {
          'text-field': [
            'step',
            clusterCountExpr,
            ['to-string', clusterCountExpr],
            1000,
            [
              'concat',
              [
                'to-string',
                ['/', ['round', ['/', clusterCountExpr, 100]], 10],
              ],
              'k',
            ],
          ],
          'text-font': ['Noto Sans Regular'],
          'text-size': [
            'step',
            clusterCountExpr,
            11,
            250,
            12,
            1000,
            13,
          ],
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#FFFFFF',
        },
      });
    }

    if (!map.getLayer(LAYER_UNCLUSTERED)) {
      map.addLayer({
        id: LAYER_UNCLUSTERED,
        type: 'circle',
        source: ANTENAS_SOURCE_ID,
        filter: [
          'all',
          ['!', ['has', 'point_count']],
          ['==', ['get', 'isMultiOp'], false],
        ],
        paint: {
          'circle-color': [
            'match',
            ['get', 'op'],
            'movistar',
            OPERATOR_META.movistar.color,
            'orange',
            OPERATOR_META.orange.color,
            'vodafone',
            OPERATOR_META.vodafone.color,
            'masmovil',
            OPERATOR_META.masmovil.color,
            'digi',
            OPERATOR_META.digi.color,
            OPERATOR_META.otros.color,
          ],
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            5,
            3.2,
            8,
            4.5,
            11,
            5.8,
            14,
            7.6,
            17,
            10.5,
          ],
          'circle-stroke-color': '#FFFFFF',
          'circle-stroke-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            5,
            0.9,
            8,
            1.3,
            13,
            1.8,
            17,
            2.4,
          ],
        },
      });
    }

    if (!map.getLayer(LAYER_UNCLUSTERED_MULTI)) {
      map.addLayer({
        id: LAYER_UNCLUSTERED_MULTI,
        type: 'symbol',
        source: ANTENAS_SOURCE_ID,
        filter: [
          'all',
          ['!', ['has', 'point_count']],
          ['==', ['get', 'isMultiOp'], true],
        ],
        layout: {
          'icon-image': ['get', 'iconKey'],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            5,
            0.34,
            8,
            0.44,
            11,
            0.54,
            14,
            0.68,
            17,
            0.88,
          ],
        },
      });
    }

    const selectedFilter = buildSelectedFilter(selectedAntennaRef.current?.id);

    if (!map.getLayer(LAYER_SELECTED_HALO)) {
      map.addLayer({
        id: LAYER_SELECTED_HALO,
        type: 'circle',
        source: ANTENAS_SOURCE_ID,
        filter: selectedFilter,
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            6,
            15,
            12,
            20,
            17,
            27,
          ],
          'circle-color': '#0EA5E9',
          'circle-opacity': 0.22,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': 'rgba(14, 165, 233, 0.6)',
        },
      });
    }

    if (!map.getLayer(LAYER_SELECTED_RING)) {
      map.addLayer({
        id: LAYER_SELECTED_RING,
        type: 'circle',
        source: ANTENAS_SOURCE_ID,
        filter: selectedFilter,
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            6,
            9.5,
            12,
            12.5,
            17,
            17,
          ],
          'circle-color': 'rgba(14, 165, 233, 0.06)',
          'circle-stroke-width': 3,
          'circle-stroke-color': isDark ? '#38BDF8' : '#0F172A',
        },
      });
    }

    // 2. Capas auxiliares de análisis radar RF y vector LOS (aisladas para no bloquear jamás las antenas)
    try {
      if (!map.getSource(RADAR_SOURCE_ID)) {
        map.addSource(RADAR_SOURCE_ID, {
          type: 'geojson',
          data: radarGeoJsonRef.current,
        });
      }

      const beforeAntenasLayer = map.getLayer(LAYER_CLUSTERS_HALO)
        ? LAYER_CLUSTERS_HALO
        : undefined;

      if (!map.getLayer(LAYER_RADAR_FILL)) {
        map.addLayer(
          {
            id: LAYER_RADAR_FILL,
            type: 'fill',
            source: RADAR_SOURCE_ID,
            filter: ['==', ['get', 'kind'], 'coverage'],
            paint: {
              'fill-color': isDark ? '#38BDF8' : '#0284C7',
              'fill-opacity': isDark ? 0.14 : 0.1,
            },
          },
          beforeAntenasLayer,
        );
      }

      if (!map.getLayer(LAYER_RADAR_OUTLINE)) {
        map.addLayer(
          {
            id: LAYER_RADAR_OUTLINE,
            type: 'line',
            source: RADAR_SOURCE_ID,
            filter: ['==', ['get', 'kind'], 'coverage'],
            paint: {
              'line-color': isDark ? '#38BDF8' : '#0284C7',
              'line-width': 2,
              'line-opacity': 0.85,
              'line-dasharray': [3, 2],
            },
          },
          beforeAntenasLayer,
        );
      }

      if (!map.getLayer(LAYER_RADAR_LOS_CASING)) {
        map.addLayer(
          {
            id: LAYER_RADAR_LOS_CASING,
            type: 'line',
            source: RADAR_SOURCE_ID,
            filter: ['==', ['get', 'kind'], 'los'],
            layout: {
              'line-cap': 'round',
              'line-join': 'round',
            },
            paint: {
              'line-color': isDark
                ? 'rgba(15, 23, 42, 0.85)'
                : 'rgba(255, 255, 255, 0.9)',
              'line-width': 4.5,
            },
          },
          beforeAntenasLayer,
        );
      }

      if (!map.getLayer(LAYER_RADAR_LOS_LINE)) {
        map.addLayer(
          {
            id: LAYER_RADAR_LOS_LINE,
            type: 'line',
            source: RADAR_SOURCE_ID,
            filter: ['==', ['get', 'kind'], 'los'],
            layout: {
              'line-cap': 'round',
              'line-join': 'round',
            },
            paint: {
              'line-color': isDark ? '#38BDF8' : '#0284C7',
              'line-width': 2.4,
              'line-dasharray': [2.2, 1.6],
            },
          },
          beforeAntenasLayer,
        );
      }

      if (!map.getLayer(LAYER_RADAR_LOS_LABEL)) {
        map.addLayer(
          {
            id: LAYER_RADAR_LOS_LABEL,
            type: 'symbol',
            source: RADAR_SOURCE_ID,
            filter: ['==', ['get', 'kind'], 'los'],
            layout: {
              'symbol-placement': 'line-center',
              'text-field': ['get', 'distanceLabel'],
              'text-font': ['Noto Sans Regular'],
              'text-size': 11,
              'text-offset': [0, -0.7],
            },
            paint: {
              'text-color': isDark ? '#F8FAFC' : '#0F172A',
              'text-halo-color': isDark ? '#0F172A' : '#FFFFFF',
              'text-halo-width': 1.8,
            },
          },
          beforeAntenasLayer,
        );
      }

      if (!map.getLayer(LAYER_RADAR_ORIGIN_HALO)) {
        map.addLayer({
          id: LAYER_RADAR_ORIGIN_HALO,
          type: 'circle',
          source: RADAR_SOURCE_ID,
          filter: ['==', ['get', 'kind'], 'origin'],
          paint: {
            'circle-radius': 13,
            'circle-color': '#0EA5E9',
            'circle-opacity': 0.26,
          },
        });
      }

      if (!map.getLayer(LAYER_RADAR_ORIGIN_POINT)) {
        map.addLayer({
          id: LAYER_RADAR_ORIGIN_POINT,
          type: 'circle',
          source: RADAR_SOURCE_ID,
          filter: ['==', ['get', 'kind'], 'origin'],
          paint: {
            'circle-radius': 6.5,
            'circle-color': '#0EA5E9',
            'circle-stroke-width': 2.5,
            'circle-stroke-color': '#FFFFFF',
          },
        });
      }
    } catch (err) {
      console.warn(
        '[AntenasMap] No se pudieron registrar las capas auxiliares de radar RF:',
        err,
      );
    }

    // 3. Capas de la regla de distancia entre 2 puntos (Punto A -> Punto B), aisladas en try/catch
    try {
      if (!map.getSource(MEASURE_SOURCE_ID)) {
        map.addSource(MEASURE_SOURCE_ID, {
          type: 'geojson',
          data: measureGeoJsonRef.current,
        });
      }

      if (!map.getLayer(LAYER_MEASURE_CASING)) {
        map.addLayer({
          id: LAYER_MEASURE_CASING,
          type: 'line',
          source: MEASURE_SOURCE_ID,
          filter: ['==', ['get', 'kind'], 'measure-line'],
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
          },
          paint: {
            'line-color': isDark
              ? 'rgba(2, 6, 23, 0.9)'
              : 'rgba(255, 255, 255, 0.94)',
            'line-width': 5,
          },
        });
      }

      if (!map.getLayer(LAYER_MEASURE_LINE)) {
        map.addLayer({
          id: LAYER_MEASURE_LINE,
          type: 'line',
          source: MEASURE_SOURCE_ID,
          filter: ['==', ['get', 'kind'], 'measure-line'],
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
          },
          paint: {
            'line-color': isDark ? '#C084FC' : '#7C3AED',
            'line-width': 2.6,
            'line-dasharray': [2.2, 1.5],
          },
        });
      }

      if (!map.getLayer(LAYER_MEASURE_POINTS_HALO)) {
        map.addLayer({
          id: LAYER_MEASURE_POINTS_HALO,
          type: 'circle',
          source: MEASURE_SOURCE_ID,
          filter: ['==', ['get', 'kind'], 'measure-point'],
          paint: {
            'circle-radius': 15,
            'circle-color': isDark ? '#C084FC' : '#7C3AED',
            'circle-opacity': 0.24,
          },
        });
      }

      if (!map.getLayer(LAYER_MEASURE_POINTS)) {
        map.addLayer({
          id: LAYER_MEASURE_POINTS,
          type: 'circle',
          source: MEASURE_SOURCE_ID,
          filter: ['==', ['get', 'kind'], 'measure-point'],
          paint: {
            'circle-radius': 9.5,
            'circle-color': isDark ? '#9333EA' : '#7C3AED',
            'circle-stroke-width': 2.5,
            'circle-stroke-color': '#FFFFFF',
          },
        });
      }

      if (!map.getLayer(LAYER_MEASURE_POINT_LABELS)) {
        map.addLayer({
          id: LAYER_MEASURE_POINT_LABELS,
          type: 'symbol',
          source: MEASURE_SOURCE_ID,
          filter: ['==', ['get', 'kind'], 'measure-point'],
          layout: {
            'text-field': ['get', 'pointTag'],
            'text-font': ['Noto Sans Regular'],
            'text-size': 10.5,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': '#FFFFFF',
          },
        });
      }

      if (!map.getLayer(LAYER_MEASURE_DISTANCE_LABEL)) {
        map.addLayer({
          id: LAYER_MEASURE_DISTANCE_LABEL,
          type: 'symbol',
          source: MEASURE_SOURCE_ID,
          filter: ['==', ['get', 'kind'], 'measure-midpoint'],
          layout: {
            'text-field': ['get', 'distanceLabel'],
            'text-font': ['Noto Sans Regular'],
            'text-size': 12,
            'text-offset': [0, -1.15],
            'text-allow-overlap': true,
          },
          paint: {
            'text-color': isDark ? '#FAF5FF' : '#3B0764',
            'text-halo-color': isDark ? '#0F172A' : '#FFFFFF',
            'text-halo-width': 2.2,
          },
        });
      }
    } catch (err) {
      console.warn(
        '[AntenasMap] No se pudieron registrar las capas de medición entre 2 puntos:',
        err,
      );
    }
  }, []);

  // Inicialización única del lienzo WebGL MapLibre GL
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const peninsulaPreset = SPAIN_REGION_PRESETS[0];
    const initialStyle =
      OPENFREEMAP_STYLES.find((opt) => opt.id === appliedStyleIdRef.current) ??
      OPENFREEMAP_STYLES[0];

    // Si ya existe un objetivo de cámara al montar (ej. enlace profundo `#/?gid=GALR0453B` o salto desde tabla),
    // arrancamos directamente sobre esas coordenadas para que el centro inicial de Península nunca lo pise.
    const initialTarget = flyToTargetRef.current;
    const hasInitialTarget = Boolean(
      initialTarget &&
        Number.isFinite(initialTarget.lat) &&
        Number.isFinite(initialTarget.lon),
    );
    const initialCenter: [number, number] =
      hasInitialTarget && initialTarget
        ? [initialTarget.lon, initialTarget.lat]
        : [peninsulaPreset.lon, peninsulaPreset.lat];
    const initialZoom =
      hasInitialTarget && initialTarget
        ? (initialTarget.zoom ?? 15)
        : peninsulaPreset.zoom;

    if (hasInitialTarget && initialTarget) {
      lastFlyTokenRef.current = initialTarget.token;
    }

    const map = new maplibregl.Map({
      container,
      style: initialStyle.url,
      center: initialCenter,
      zoom: initialZoom,
      minZoom: 3.5,
      maxZoom: 19,
      attributionControl: false,
    });

    map.addControl(
      new maplibregl.NavigationControl({
        visualizePitch: true,
        showCompass: true,
        showZoom: true,
      }),
      'bottom-right',
    );
    map.addControl(
      new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }),
      'bottom-right',
    );
    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      'bottom-right',
    );

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 12,
      maxWidth: '320px',
      className: 'antenas-map-popup',
    });

    mapRef.current = map;
    popupRef.current = popup;

    const handleStyleImageMissing = (event: { id: string }) => {
      if (event.id.startsWith('multi:')) {
        registerMultiOperatorSprite(map, event.id, isDarkStyleRef.current);
      }
    };

    const handleStyleLoad = () => {
      hasLoadedOnceRef.current = true;
      ensureCustomSourcesAndLayers(map);
      const antSource = map.getSource(ANTENAS_SOURCE_ID) as
        | maplibregl.GeoJSONSource
        | undefined;
      if (
        antSource &&
        lastAppliedGeoJsonRef.current !== antenasGeoJsonRef.current
      ) {
        antSource.setData(antenasGeoJsonRef.current);
        lastAppliedGeoJsonRef.current = antenasGeoJsonRef.current;
      }
      try {
        const radSource = map.getSource(RADAR_SOURCE_ID) as
          | maplibregl.GeoJSONSource
          | undefined;
        if (radSource) {
          radSource.setData(radarGeoJsonRef.current);
        }
      } catch (err) {
        console.warn(
          '[AntenasMap] No se pudo actualizar la fuente de radar RF:',
          err,
        );
      }
      try {
        const measSource = map.getSource(MEASURE_SOURCE_ID) as
          | maplibregl.GeoJSONSource
          | undefined;
        if (measSource) {
          measSource.setData(measureGeoJsonRef.current);
        }
      } catch (err) {
        console.warn(
          '[AntenasMap] No se pudo actualizar la fuente de medición:',
          err,
        );
      }
    };

    const handleStyleData = () => {
      if (map.isStyleLoaded()) {
        ensureCustomSourcesAndLayers(map);
      }
    };

    const getActiveUnclusteredLayers = (): string[] => {
      const layers: string[] = [];
      if (map.getLayer(LAYER_UNCLUSTERED_MULTI)) {
        layers.push(LAYER_UNCLUSTERED_MULTI);
      }
      if (map.getLayer(LAYER_UNCLUSTERED)) {
        layers.push(LAYER_UNCLUSTERED);
      }
      return layers;
    };

    const handleMapClick = (event: maplibregl.MapMouseEvent) => {
      const unclusteredLayers = getActiveUnclusteredLayers();
      const hasClusterLayer = Boolean(map.getLayer(LAYER_CLUSTERS));

      // 0. Modo "Medir en mapa" (distancia entre 2 puntos: Punto A y Punto B)
      if (measureModeActiveRef.current) {
        let targetLat = Number(event.lngLat.lat.toFixed(6));
        let targetLon = Number(event.lngLat.lng.toFixed(6));
        let targetLabel: string | undefined;

        if (unclusteredLayers.length > 0) {
          const snappedFeatures = map.queryRenderedFeatures(event.point, {
            layers: unclusteredLayers,
          });
          if (snappedFeatures.length > 0) {
            const topSnap = snappedFeatures[0];
            const snapRaw = topSnap.properties as Record<string, unknown>;
            const snapSiteId = String(snapRaw.id ?? '');
            const snapSite = sitesByIdRef.current.get(snapSiteId);
            if (snapSite) {
              targetLat = Number(snapSite.lat.toFixed(6));
              targetLon = Number(snapSite.lon.toFixed(6));
              const opShort =
                OPERATOR_META[snapSite.primary.op]?.shortName ?? 'Estación';
              targetLabel = snapSite.isMultiOperator
                ? `Mástil compartido (${snapSite.operators.length} oper.)`
                : `${opShort} #${snapSite.primary.gid}`;
            } else if (topSnap.geometry.type === 'Point') {
              targetLon = Number(topSnap.geometry.coordinates[0].toFixed(6));
              targetLat = Number(topSnap.geometry.coordinates[1].toFixed(6));
            }
          }
        }

        const currentPts = measurePointsRef.current;
        const newPoint: MeasurePoint = {
          lat: targetLat,
          lon: targetLon,
          label: targetLabel,
        };

        if (currentPts.length === 1) {
          onMeasurePointsChangeRef.current([currentPts[0], newPoint]);
        } else {
          onMeasurePointsChangeRef.current([newPoint]);
        }
        return;
      }

      // 1. Priorizar clic directo sobre una estación desagrupada (icono multicolor < 5 m o círculo individual)
      if (unclusteredLayers.length > 0) {
        const stationFeatures = map.queryRenderedFeatures(event.point, {
          layers: unclusteredLayers,
        });
        if (stationFeatures.length > 0) {
          const topFeature = stationFeatures[0];
          const rawProps = topFeature.properties as Record<string, unknown>;
          const featureId = String(rawProps.id ?? '');
          const matchedSite = sitesByIdRef.current.get(featureId);

          if (matchedSite) {
            onSelectAntennaRef.current(matchedSite.primary);
            return;
          }

          const primaryId = String(rawProps.primaryId ?? featureId);
          const matchedRecord = antenasByIdRef.current.get(primaryId);
          if (matchedRecord) {
            onSelectAntennaRef.current(matchedRecord);
            return;
          }

          if (primaryId) {
            const fallbackGeometry =
              topFeature.geometry.type === 'Point'
                ? topFeature.geometry.coordinates
                : [event.lngLat.lng, event.lngLat.lat];

            const reconstructed: AntennaRecord = {
              id: primaryId,
              gid: String(rawProps.gid ?? ''),
              op: isValidOperatorKey(rawProps.op) ? rawProps.op : 'otros',
              opRaw: String(rawProps.opRaw ?? ''),
              lat: Number(rawProps.lat ?? fallbackGeometry[1]),
              lon: Number(rawProps.lon ?? fallbackGeometry[0]),
              dir: String(rawProps.dir ?? ''),
              mun: String(rawProps.mun ?? ''),
              prov: String(rawProps.prov ?? ''),
            };
            onSelectAntennaRef.current(reconstructed);
            return;
          }
        }
      }

      // 2. Expansión suave al hacer clic en un clúster de antenas
      if (hasClusterLayer) {
        const clusterFeatures = map.queryRenderedFeatures(event.point, {
          layers: [LAYER_CLUSTERS],
        });
        if (clusterFeatures.length > 0) {
          const clusterFeature = clusterFeatures[0];
          const clusterId = Number(clusterFeature.properties?.cluster_id);
          const source = map.getSource(ANTENAS_SOURCE_ID) as
            | maplibregl.GeoJSONSource
            | undefined;

          if (
            source &&
            Number.isFinite(clusterId) &&
            clusterFeature.geometry.type === 'Point'
          ) {
            const [lon, lat] = clusterFeature.geometry.coordinates;
            void source
              .getClusterExpansionZoom(clusterId)
              .then((expansionZoom) => {
                map.easeTo({
                  center: [lon, lat],
                  zoom: Math.min(expansionZoom, 17),
                  duration: 480,
                });
              })
              .catch(() => {
                // Ignorar si el estilo o la fuente cambiaron durante la transición
              });
            return;
          }
        }
      }

      // 3. Clic en el fondo del mapa: fijar radar si modo radar legado está activo, o limpiar selección
      if (radarModeActiveRef.current) {
        onRadarPointChangeRef.current?.({
          lat: Number(event.lngLat.lat.toFixed(6)),
          lon: Number(event.lngLat.lng.toFixed(6)),
          radiusKm: radarPointRef.current?.radiusKm ?? 2,
          label: 'Punto seleccionado',
        });
        return;
      }

      if (selectedAntennaRef.current) {
        onSelectAntennaRef.current(null);
      }
    };

    const handleMouseMove = (event: maplibregl.MapMouseEvent) => {
      const isCrosshairActive =
        measureModeActiveRef.current || radarModeActiveRef.current;
      const interactiveLayers = getActiveUnclusteredLayers();
      if (map.getLayer(LAYER_CLUSTERS)) {
        interactiveLayers.push(LAYER_CLUSTERS);
      }

      if (interactiveLayers.length === 0) {
        map.getCanvas().style.cursor = isCrosshairActive ? 'crosshair' : '';
        return;
      }

      const hits = map.queryRenderedFeatures(event.point, {
        layers: interactiveLayers,
      });

      if (hits.length === 0) {
        map.getCanvas().style.cursor = isCrosshairActive ? 'crosshair' : '';
        if (hoveredIdRef.current !== null) {
          hoveredIdRef.current = null;
          popup.remove();
        }
        return;
      }

      const topHit = hits[0];
      map.getCanvas().style.cursor = measureModeActiveRef.current
        ? 'crosshair'
        : 'pointer';

      if (
        (topHit.layer.id === LAYER_UNCLUSTERED_MULTI ||
          topHit.layer.id === LAYER_UNCLUSTERED) &&
        topHit.geometry.type === 'Point'
      ) {
        const raw = topHit.properties as Record<string, unknown>;
        const stationId = String(raw.id ?? '');
        const [lon, lat] = topHit.geometry.coordinates;

        if (hoveredIdRef.current !== stationId) {
          hoveredIdRef.current = stationId;
          const matchedSite = sitesByIdRef.current.get(stationId);
          const popupProps: AntennaFeatureProperties = {
            idx: Number(raw.idx ?? 0),
            id: stationId,
            primaryId: String(raw.primaryId ?? stationId),
            gid: String(raw.gid ?? ''),
            op: isValidOperatorKey(raw.op) ? raw.op : 'otros',
            opRaw: String(raw.opRaw ?? ''),
            dir: String(raw.dir ?? ''),
            mun: String(raw.mun ?? ''),
            prov: String(raw.prov ?? ''),
            lat: Number(raw.lat ?? lat),
            lon: Number(raw.lon ?? lon),
            isMultiOp:
              raw.isMultiOp === true ||
              raw.isMultiOp === 'true' ||
              Boolean(matchedSite?.isMultiOperator),
            iconKey: String(raw.iconKey ?? matchedSite?.iconKey ?? ''),
            operatorsCsv: String(raw.operatorsCsv ?? ''),
            stationCount: Number(raw.stationCount ?? 1),
            memberIdsPipe: String(raw.memberIdsPipe ?? ''),
          };
          popup.setHTML(buildPopupHtml(popupProps, matchedSite));
        }

        popup.setLngLat([lon, lat]).addTo(map);
      } else if (hoveredIdRef.current !== null) {
        hoveredIdRef.current = null;
        popup.remove();
      }
    };

    const handleCanvasLeave = () => {
      hoveredIdRef.current = null;
      popup.remove();
    };

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            map.resize();
          })
        : null;
    resizeObserver?.observe(container);

    map.on('styleimagemissing', handleStyleImageMissing);
    map.on('load', handleStyleLoad);
    map.on('style.load', handleStyleLoad);
    map.on('styledata', handleStyleData);
    map.on('click', handleMapClick);
    map.on('mousemove', handleMouseMove);
    map.getCanvas().addEventListener('mouseleave', handleCanvasLeave);

    return () => {
      resizeObserver?.disconnect();
      map.getCanvas().removeEventListener('mouseleave', handleCanvasLeave);
      popup.remove();
      map.remove();
      mapRef.current = null;
      popupRef.current = null;
      hoveredIdRef.current = null;
      hasLoadedOnceRef.current = false;
      lastAppliedGeoJsonRef.current = null;
      lastFlyTokenRef.current = null;
    };
  }, [ensureCustomSourcesAndLayers]);

  // Cambio resiliente de estilo OpenFreeMap preservando todas las fuentes y capas
  useEffect(() => {
    isDarkStyleRef.current = currentStyleOption.isDark;
    const map = mapRef.current;
    if (!map || appliedStyleIdRef.current === styleId) {
      return;
    }

    appliedStyleIdRef.current = styleId;
    hoveredIdRef.current = null;
    lastAppliedGeoJsonRef.current = null;
    popupRef.current?.remove();

    map.setStyle(currentStyleOption.url, { diff: false });
  }, [styleId, currentStyleOption.url, currentStyleOption.isDark]);

  // Sincronización reactiva en memoria del dataset filtrado de antenas y sprites multicolor hacia WebGL
  useEffect(() => {
    antenasGeoJsonRef.current = antenasGeoJson;
    const map = mapRef.current;
    if (!map) {
      return;
    }
    if (map.getStyle()) {
      for (let i = 0; i < multiIconKeys.length; i++) {
        registerMultiOperatorSprite(
          map,
          multiIconKeys[i],
          isDarkStyleRef.current,
        );
      }
    }
    const source = map.getSource(ANTENAS_SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (source && lastAppliedGeoJsonRef.current !== antenasGeoJson) {
      source.setData(antenasGeoJson);
      lastAppliedGeoJsonRef.current = antenasGeoJson;
    }
  }, [antenasGeoJson, multiIconKeys]);

  // Sincronización reactiva aislada del círculo de cobertura radar y enlace LOS
  useEffect(() => {
    radarGeoJsonRef.current = radarGeoJson;
    const map = mapRef.current;
    if (!map) {
      return;
    }
    try {
      const source = map.getSource(RADAR_SOURCE_ID) as
        | maplibregl.GeoJSONSource
        | undefined;
      if (source) {
        source.setData(radarGeoJson);
      }
    } catch (err) {
      console.warn('[AntenasMap] No se pudo sincronizar radarGeoJson:', err);
    }
  }, [radarGeoJson]);

  // Sincronización reactiva aislada de la regla de distancia entre 2 puntos (Punto A -> Punto B)
  useEffect(() => {
    measureGeoJsonRef.current = measureGeoJson;
    const map = mapRef.current;
    if (!map) {
      return;
    }
    try {
      const source = map.getSource(MEASURE_SOURCE_ID) as
        | maplibregl.GeoJSONSource
        | undefined;
      if (source) {
        source.setData(measureGeoJson);
      }
    } catch (err) {
      console.warn('[AntenasMap] No se pudo sincronizar measureGeoJson:', err);
    }
  }, [measureGeoJson]);

  // Actualización instantánea del anillo de selección en GPU
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const filter = buildSelectedFilter(selectedAntenna?.id);
    if (map.getLayer(LAYER_SELECTED_HALO)) {
      map.setFilter(LAYER_SELECTED_HALO, filter);
    }
    if (map.getLayer(LAYER_SELECTED_RING)) {
      map.setFilter(LAYER_SELECTED_RING, filter);
    }
  }, [selectedAntenna]);

  // Cursor de retícula al activar/desactivar el modo medición o radar
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    map.getCanvas().style.cursor =
      effectiveMeasureModeActive || radarModeActive ? 'crosshair' : '';
  }, [effectiveMeasureModeActive, radarModeActive]);

  // Desplazamiento de cámara cuando cambia `flyToTarget.token` (incluidos enlaces directos `#/?gid=...`)
  useEffect(() => {
    const map = mapRef.current;
    if (
      !map ||
      !flyToTarget ||
      !Number.isFinite(flyToTarget.lat) ||
      !Number.isFinite(flyToTarget.lon)
    ) {
      return;
    }
    if (lastFlyTokenRef.current === flyToTarget.token) {
      return;
    }

    lastFlyTokenRef.current = flyToTarget.token;
    setActiveRegionId(null);

    // Sincronizar tamaño real del lienzo por si acaba de montarse el panel lateral de detalle (`StationDetailDrawer`)
    map.resize();

    if (!hasLoadedOnceRef.current) {
      // Si el enlace profundo se resuelve durante la carga inicial del mapa, colocamos la cámara directamente
      map.jumpTo({
        center: [flyToTarget.lon, flyToTarget.lat],
        zoom: flyToTarget.zoom ?? 15,
      });
      return;
    }

    map.flyTo({
      center: [flyToTarget.lon, flyToTarget.lat],
      zoom: flyToTarget.zoom ?? 15,
      duration: 1200,
      essential: true,
    });
  }, [flyToTarget]);

  const handleFlyToRegion = useCallback(
    (lon: number, lat: number, zoom: number, presetId?: string) => {
      setActiveRegionId(presetId ?? null);
      const map = mapRef.current;
      if (!map) {
        return;
      }
      map.flyTo({
        center: [lon, lat],
        zoom,
        duration: 1200,
        essential: true,
      });
    },
    [],
  );

  return (
    <div
      className="antenas-map-root"
      data-map-dark={currentStyleOption.isDark ? 'true' : 'false'}
    >
      <div
        ref={containerRef}
        className="antenas-map-canvas"
        aria-label="Mapa interactivo de estaciones base de telefonía móvil en España"
      />

      <MapOverlays
        antenas={antenas}
        selectedAntenna={selectedAntenna}
        styleId={styleId}
        onStyleChange={onStyleChange}
        radarPoint={radarPoint}
        onRadarPointChange={onRadarPointChange}
        radarModeActive={radarModeActive}
        onToggleRadarMode={onToggleRadarMode}
        measurePoints={effectiveMeasurePoints}
        onMeasurePointsChange={handleMeasurePointsChange}
        measureModeActive={effectiveMeasureModeActive}
        onToggleMeasureMode={handleToggleMeasureMode}
        activeOperators={activeOperators}
        onToggleOperator={onToggleOperator}
        activeRegionId={activeRegionId}
        onFlyToRegion={handleFlyToRegion}
      />
    </div>
  );
}
