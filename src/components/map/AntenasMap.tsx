import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type {
  Feature,
  FeatureCollection,
  LineString,
  Point,
} from 'geojson';
import {
  OPENFREEMAP_STYLES,
  OPERATOR_META,
  type AntennaRecord,
  type OperatorKey,
} from '../../types/antena';
import { normalizeAntennaBandsList } from '../../hooks/useAntenasData';
import type { AntenasMapProps, MeasurePoint } from '../../types/map';
import {
  BAND_CARD_KEY_PREFIX,
  BAND_CARD_PIXEL_RATIO,
  buildSiteBandCardKey,
  getOrCreateBandCardSprite,
} from '../../utils/bandCard';
import {
  MULTI_OPERATOR_SITE_MAX_DISTANCE_METERS,
  SPAIN_REGION_PRESETS,
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
const MEASURE_SOURCE_ID = 'measure-source';

const LAYER_MEASURE_CASING = 'measure-line-casing';
const LAYER_MEASURE_LINE = 'measure-line';
const LAYER_MEASURE_POINTS_HALO = 'measure-points-halo';
const LAYER_MEASURE_POINTS = 'measure-points';
const LAYER_MEASURE_POINT_LABELS = 'measure-point-labels';
const LAYER_MEASURE_DISTANCE_LABEL = 'measure-distance-label';

const LAYER_CLUSTERS = 'antenas-clusters';
const LAYER_CLUSTER_COUNT = 'antenas-cluster-count';
const LAYER_UNCLUSTERED = 'antenas-unclustered';
const LAYER_UNCLUSTERED_MULTI = 'antenas-unclustered-multi';
const LAYER_SELECTED_HALO = 'antenas-selected-halo';
const LAYER_SELECTED_RING = 'antenas-selected-ring';
const LAYER_UNCLUSTERED_BANDS = 'antenas-unclustered-bands';

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
  bandCardKey: string;
  operatorsCsv: string;
  stationCount: number;
  memberIdsPipe: string;
}

interface MeasureFeatureProperties {
  kind: 'measure-line' | 'measure-point' | 'measure-midpoint';
  pointTag?: 'A' | 'B';
  distanceLabel?: string;
}

function applyPitchLock(map: maplibregl.Map, locked: boolean): void {
  if (locked) {
    if (map.getPitch() !== 0) {
      map.jumpTo({ pitch: 0 });
    }
    map.setMaxPitch(0);
    map.touchPitch?.disable();
  } else {
    map.setMaxPitch(85);
    map.touchPitch?.enable();
  }
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

const MULTI_SPRITE_RADIUS_PX = 27;
const MULTI_SPRITE_PIXEL_RATIO = 2;
/** Radio base en píxeles CSS del icono multicolor cuando `icon-size` = 1 (`27 / 2 = 13.5` px) */
const MULTI_SPRITE_BASE_CSS_RADIUS =
  MULTI_SPRITE_RADIUS_PX / MULTI_SPRITE_PIXEL_RATIO;

const CLUSTERED_MULTI_ICON_STOPS: readonly [number, number][] = [
  [5, 0.34],
  [8, 0.44],
  [11, 0.54],
  [14, 0.68],
  [17, 0.88],
];

const UNCLUSTERED_MULTI_ICON_STOPS: readonly [number, number][] = [
  [3, 0.13],
  [5, 0.19],
  [7, 0.29],
  [9, 0.4],
  [11, 0.53],
  [14, 0.68],
  [17, 0.88],
];

/**
 * Genera en Canvas 2D (`64x64` px, `pixelRatio: 2`) un icono circular multicolor de relleno
 * plano y sólido sin bordes exteriores ni líneas separadoras blancas, repartiendo en sectores
 * iguales los colores de los operadores integrados sin costuras de antialiasing.
 */
function createMultiOperatorSprite(operators: OperatorKey[]): ImageData {
  const size = 64;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 27;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return new ImageData(size, size);
  }

  const ops: OperatorKey[] = operators.length > 0 ? operators : ['otros'];
  const firstColor = OPERATOR_META[ops[0]]?.color ?? OPERATOR_META.otros.color;

  // Círculo base completo con el primer operador para un antialiasing exterior uniforme y sin huecos
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = firstColor;
  ctx.fill();

  if (ops.length >= 2) {
    const sliceAngle = (Math.PI * 2) / ops.length;
    const startBase = -Math.PI / 2;

    for (let i = 0; i < ops.length; i++) {
      const startAngle = startBase + i * sliceAngle;
      const endAngle =
        startAngle + sliceAngle + (i < ops.length - 1 ? 0.014 : 0);
      const meta = OPERATOR_META[ops[i]] ?? OPERATOR_META.otros;

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, startAngle, endAngle);
      ctx.closePath();
      ctx.fillStyle = meta.color;
      ctx.fill();
    }
  }

  return ctx.getImageData(0, 0, size, size);
}

function registerMultiOperatorSprite(
  map: maplibregl.Map,
  iconKey: string,
): void {
  if (!iconKey.startsWith('multi:') || map.hasImage(iconKey)) {
    return;
  }
  const operators = parseOperatorsFromIconKey(iconKey);
  if (operators.length === 0) {
    return;
  }
  const cacheKey = `flat:${iconKey}`;
  let imageData = MULTI_SPRITE_CACHE.get(cacheKey);
  if (!imageData) {
    imageData = createMultiOperatorSprite(operators);
    MULTI_SPRITE_CACHE.set(cacheKey, imageData);
  }
  if (!map.hasImage(iconKey)) {
    map.addImage(iconKey, imageData, { pixelRatio: MULTI_SPRITE_PIXEL_RATIO });
  }
}

function registerBandCardSprite(map: maplibregl.Map, key: string): void {
  if (!key.startsWith(BAND_CARD_KEY_PREFIX) || map.hasImage(key)) {
    return;
  }
  const imageData = getOrCreateBandCardSprite(key);
  if (!imageData) {
    return;
  }
  if (!map.hasImage(key)) {
    map.addImage(key, imageData, { pixelRatio: BAND_CARD_PIXEL_RATIO });
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

/* oxlint-disable react/only-export-components */
export function buildClusterExactCountExpr(): maplibregl.ExpressionSpecification {
  return [
    'round',
    ['coalesce', ['get', 'stationSum'], ['get', 'point_count']],
  ] as maplibregl.ExpressionSpecification;
}

export function buildClusterCountTextFieldExpr(): maplibregl.ExpressionSpecification {
  return [
    'to-string',
    buildClusterExactCountExpr(),
  ] as maplibregl.ExpressionSpecification;
}

export function buildClusterCircleRadiusExpr(): maplibregl.ExpressionSpecification {
  return [
    'step',
    buildClusterExactCountExpr(),
    15.5,
    50,
    19,
    250,
    23,
    1000,
    27.5,
    5000,
    31,
    10000,
    34,
  ] as maplibregl.ExpressionSpecification;
}

export function buildClusterCountTextSizeExpr(): maplibregl.ExpressionSpecification {
  return [
    'step',
    buildClusterExactCountExpr(),
    11,
    250,
    11.5,
  ] as maplibregl.ExpressionSpecification;
}

export function evaluateClusterCountLabel(props: {
  stationSum?: number;
  point_count?: number;
}): string {
  return String(
    Math.max(
      0,
      Math.round(
        typeof props.stationSum === 'number' &&
          Number.isFinite(props.stationSum)
          ? props.stationSum
          : typeof props.point_count === 'number' &&
              Number.isFinite(props.point_count)
            ? props.point_count
            : 0,
      ),
    ),
  );
}
/* oxlint-enable react/only-export-components */

function buildUnclusteredCircleRadiusExpr(
  disableClustering: boolean,
): maplibregl.ExpressionSpecification {
  const stops = disableClustering
    ? UNCLUSTERED_MULTI_ICON_STOPS
    : CLUSTERED_MULTI_ICON_STOPS;
  const expr: unknown[] = ['interpolate', ['linear'], ['zoom']];
  for (let i = 0; i < stops.length; i++) {
    const [zoom, iconScale] = stops[i];
    expr.push(
      zoom,
      Number((MULTI_SPRITE_BASE_CSS_RADIUS * iconScale).toFixed(4)),
    );
  }
  return expr as maplibregl.ExpressionSpecification;
}

function buildUnclusteredMultiIconSizeExpr(
  disableClustering: boolean,
): maplibregl.ExpressionSpecification {
  const stops = disableClustering
    ? UNCLUSTERED_MULTI_ICON_STOPS
    : CLUSTERED_MULTI_ICON_STOPS;
  const expr: unknown[] = ['interpolate', ['linear'], ['zoom']];
  for (let i = 0; i < stops.length; i++) {
    const [zoom, iconScale] = stops[i];
    expr.push(zoom, iconScale);
  }
  return expr as maplibregl.ExpressionSpecification;
}

function syncClusteringVisualLayers(
  map: maplibregl.Map,
  disableClustering: boolean,
): void {
  const clusterVisibility = disableClustering ? 'none' : 'visible';
  if (map.getLayer(LAYER_CLUSTERS)) {
    map.setLayoutProperty(LAYER_CLUSTERS, 'visibility', clusterVisibility);
  }
  if (map.getLayer(LAYER_CLUSTER_COUNT)) {
    map.setLayoutProperty(LAYER_CLUSTER_COUNT, 'visibility', clusterVisibility);
  }
  if (map.getLayer(LAYER_UNCLUSTERED)) {
    map.setPaintProperty(
      LAYER_UNCLUSTERED,
      'circle-radius',
      buildUnclusteredCircleRadiusExpr(disableClustering),
    );
  }
  if (map.getLayer(LAYER_UNCLUSTERED_MULTI)) {
    map.setLayoutProperty(
      LAYER_UNCLUSTERED_MULTI,
      'icon-size',
      buildUnclusteredMultiIconSizeExpr(disableClustering),
    );
  }
}

function buildPopupHtml(
  props: AntennaFeatureProperties,
  site?: MapSiteEntry,
  primaryAnt?: AntennaRecord,
): string {
  const locationLine = [props.mun, props.prov].filter(Boolean).join(', ');
  const safeLocation = escapeHtml(locationLine || 'Ubicación registrada');
  const safeDir = escapeHtml(props.dir || 'Sin dirección postal detallada');
  const popupBands = primaryAnt?.bandas
    ? normalizeAntennaBandsList(primaryAnt.bandas)
    : [];
  const bandsHtml =
    popupBands.length > 0
      ? `<div class="map-popup-bands">${popupBands
          .map(
            (band) =>
              `<span class="map-popup-band-chip">${escapeHtml(band)}</span>`,
          )
          .join('')}</div>`
      : '';

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
        <span class="map-popup-shared-badge">Emplazamiento compartido (&lt; ${MULTI_OPERATOR_SITE_MAX_DISTANCE_METERS} m)</span>
        <span class="map-popup-gid">${opCount} oper.</span>
      </div>
      <div class="map-popup-multi-list">${pillsHtml}</div>
      <div class="map-popup-loc">${safeLocation}</div>
      <div class="map-popup-dir">${safeDir}</div>
      ${bandsHtml}
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
    ${bandsHtml}
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
    measurePoints,
    onMeasurePointsChange,
    measureModeActive,
    onToggleMeasureMode,
    lock3dPitch,
    onToggleLock3dPitch,
    showBandsOnMap,
    onToggleShowBandsOnMap,
    disableClustering,
    onToggleDisableClustering,
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

  // Bloqueo 3D / vertical activado SIEMPRE por defecto al cargar la web (nunca se lee de localStorage)
  const [internalLock3dPitch, setInternalLock3dPitch] = useState<boolean>(true);
  const effectiveLock3dPitch = lock3dPitch ?? internalLock3dPitch;
  const lock3dPitchRef = useRef<boolean>(effectiveLock3dPitch);

  const handleToggleLock3dPitch = useCallback(() => {
    if (onToggleLock3dPitch) {
      onToggleLock3dPitch();
    } else {
      setInternalLock3dPitch((prev) => !prev);
    }
  }, [onToggleLock3dPitch]);

  // Soporte híbrido controlado o autónomo para etiquetas de bandas flotantes en el mapa ("Ver bandas")
  const [internalShowBandsOnMap, setInternalShowBandsOnMap] =
    useState<boolean>(false);
  const effectiveShowBandsOnMap = showBandsOnMap ?? internalShowBandsOnMap;
  const showBandsOnMapRef = useRef<boolean>(effectiveShowBandsOnMap);

  const handleToggleShowBandsOnMap = useCallback(() => {
    if (onToggleShowBandsOnMap) {
      onToggleShowBandsOnMap();
    } else {
      setInternalShowBandsOnMap((prev) => !prev);
    }
  }, [onToggleShowBandsOnMap]);

  // Soporte híbrido controlado o autónomo para desactivar clústeres al hacer zoom out ("Eliminar clustering")
  const [internalDisableClustering, setInternalDisableClustering] =
    useState<boolean>(() => disableClustering ?? false);
  const isDisableClusteringControlled =
    disableClustering !== undefined &&
    onToggleDisableClustering !== undefined;
  const effectiveDisableClustering = isDisableClusteringControlled
    ? disableClustering
    : internalDisableClustering;
  const disableClusteringRef = useRef<boolean>(effectiveDisableClustering);

  const handleToggleDisableClustering = useCallback(() => {
    if (isDisableClusteringControlled) {
      onToggleDisableClustering();
    } else {
      setInternalDisableClustering((prev) => !prev);
      onToggleDisableClustering?.();
    }
  }, [isDisableClusteringControlled, onToggleDisableClustering]);

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
      if (effectiveMeasureModeActive) {
        onMeasurePointsChange?.([]);
      }
      onToggleMeasureMode();
    } else {
      setInternalMeasureMode((prev) => {
        if (prev) {
          setInternalMeasurePoints([]);
        }
        return !prev;
      });
    }
  }, [onToggleMeasureMode, effectiveMeasureModeActive, onMeasurePointsChange]);

  const currentStyleOption = useMemo(
    () =>
      OPENFREEMAP_STYLES.find((opt) => opt.id === styleId) ??
      OPENFREEMAP_STYLES[0],
    [styleId],
  );

  // Agrupación espacial en memoria (< 30 m entre distintos operadores sin auto-fusionar Telefónica + fusión defensiva Vodafone < 35 m)
  // hacia geometrías puntuales para el motor WebGL de MapLibre GL JS
  const { antenasGeoJson, antenasById, sitesById, multiIconKeys } =
    useMemo(() => {
      const byId = new Map<string, AntennaRecord>();
      for (let i = 0; i < antenas.length; i++) {
        const ant = antenas[i];
        if (Number.isFinite(ant.lat) && Number.isFinite(ant.lon)) {
          byId.set(ant.id, ant);
        }
      }

      const groupedSites = groupColocatedAntennasForMap(
        antenas,
        MULTI_OPERATOR_SITE_MAX_DISTANCE_METERS,
      );
      const bySiteId = new Map<string, MapSiteEntry>();
      const iconKeys = new Set<string>();
      const features: Feature<Point, AntennaFeatureProperties>[] = [];

      for (let i = 0; i < groupedSites.length; i++) {
        const site = groupedSites[i];
        bySiteId.set(site.siteId, site);
        if (site.isMultiOperator) {
          iconKeys.add(site.iconKey);
        }

        const primary = site.primary;
        const bandCardKey = buildSiteBandCardKey(site);
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
            bandCardKey,
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
        multiIconKeys: Array.from(iconKeys),
      };
    }, [antenas]);

  // Construcción memorizada de la regla de medición entre 2 puntos (Punto A, Punto B, segmento geodésico y etiqueta central)
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
  const measureGeoJsonRef = useRef(measureGeoJson);
  const selectedAntennaRef = useRef(selectedAntenna);
  const onSelectAntennaRef = useRef(onSelectAntenna);
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
    measureGeoJsonRef.current = measureGeoJson;
  }, [measureGeoJson]);

  useEffect(() => {
    selectedAntennaRef.current = selectedAntenna;
    onSelectAntennaRef.current = onSelectAntenna;
  }, [selectedAntenna, onSelectAntenna]);

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

  // Aplicar bloqueo/desbloqueo de inclinación vertical 3D inmediatamente en el motor de MapLibre
  useEffect(() => {
    lock3dPitchRef.current = effectiveLock3dPitch;
    const map = mapRef.current;
    if (!map) {
      return;
    }
    applyPitchLock(map, effectiveLock3dPitch);
  }, [effectiveLock3dPitch]);

  // Sincronización inmediata en GPU de la visibilidad de tarjetas flotantes de bandas ("Ver bandas")
  useEffect(() => {
    showBandsOnMapRef.current = effectiveShowBandsOnMap;
    const map = mapRef.current;
    if (!map) {
      return;
    }
    if (map.getLayer(LAYER_UNCLUSTERED_BANDS)) {
      map.setLayoutProperty(
        LAYER_UNCLUSTERED_BANDS,
        'visibility',
        effectiveShowBandsOnMap ? 'visible' : 'none',
      );
    }
    if (!effectiveShowBandsOnMap && hoveredIdRef.current !== null) {
      hoveredIdRef.current = null;
      popupRef.current?.remove();
    }
  }, [effectiveShowBandsOnMap]);

  // Sincronización inmediata en GPU al activar/desactivar la agrupación en clústeres ("Eliminar clustering")
  useEffect(() => {
    disableClusteringRef.current = effectiveDisableClustering;
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const source = map.getSource(ANTENAS_SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (source && typeof source.setClusterOptions === 'function') {
      void source
        .setClusterOptions({
          cluster: !effectiveDisableClustering,
          clusterMaxZoom: 12,
          clusterRadius: 46,
        })
        .catch(() => {
          // Ignorar si el estilo cambia durante la actualización del worker
        });
    }
    syncClusteringVisualLayers(map, effectiveDisableClustering);
  }, [effectiveDisableClustering]);

  // Permitir cancelar o limpiar la medición de 2 puntos pulsando la tecla Escape
  useEffect(() => {
    if (!effectiveMeasureModeActive && effectiveMeasurePoints.length === 0) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      if (effectiveMeasurePoints.length > 0) {
        handleMeasurePointsChange([]);
      }
      if (effectiveMeasureModeActive) {
        handleToggleMeasureMode();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    effectiveMeasureModeActive,
    effectiveMeasurePoints.length,
    handleMeasurePointsChange,
    handleToggleMeasureMode,
  ]);

  // Registro idempotente de fuentes y capas tras carga inicial o cambio de estilo OpenFreeMap
  const ensureCustomSourcesAndLayers = useCallback((map: maplibregl.Map) => {
    if (!map.getStyle()) {
      return;
    }

    const isDark = isDarkStyleRef.current;
    const disableClusteringActive = disableClusteringRef.current;

    // Registrar todos los sprites multicolor activos en el atlas WebGL del estilo actual
    const activeIconKeys = multiIconKeysRef.current;
    for (let i = 0; i < activeIconKeys.length; i++) {
      registerMultiOperatorSprite(map, activeIconKeys[i]);
    }

    // 1. Fuente principal clusterizada con suma exacta de estaciones integradas (`stationSum`)
    if (!map.getSource(ANTENAS_SOURCE_ID)) {
      map.addSource(ANTENAS_SOURCE_ID, {
        type: 'geojson',
        data: antenasGeoJsonRef.current,
        cluster: !disableClusteringActive,
        clusterMaxZoom: 12,
        clusterRadius: 46,
        clusterProperties: {
          stationSum: ['+', ['get', 'stationCount']],
        },
      });
      lastAppliedGeoJsonRef.current = antenasGeoJsonRef.current;
    }

    const clusterCountExpr = buildClusterExactCountExpr();

    if (!map.getLayer(LAYER_CLUSTERS)) {
      map.addLayer({
        id: LAYER_CLUSTERS,
        type: 'circle',
        source: ANTENAS_SOURCE_ID,
        filter: ['has', 'point_count'],
        layout: {
          visibility: disableClusteringActive ? 'none' : 'visible',
        },
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
          'circle-radius': buildClusterCircleRadiusExpr(),
          'circle-stroke-width': 0,
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
          visibility: disableClusteringActive ? 'none' : 'visible',
          'text-field': buildClusterCountTextFieldExpr(),
          'text-font': ['Noto Sans Regular'],
          'text-size': buildClusterCountTextSizeExpr(),
          'text-allow-overlap': true,
          'text-ignore-placement': true,
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
            'digi',
            OPERATOR_META.digi.color,
            OPERATOR_META.otros.color,
          ],
          'circle-radius': buildUnclusteredCircleRadiusExpr(
            disableClusteringActive,
          ),
          'circle-pitch-scale': 'viewport',
          'circle-stroke-width': 0,
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
          'icon-size': buildUnclusteredMultiIconSizeExpr(
            disableClusteringActive,
          ),
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
            0,
            11,
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
            0,
            7,
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

    if (!map.getLayer(LAYER_UNCLUSTERED_BANDS)) {
      map.addLayer({
        id: LAYER_UNCLUSTERED_BANDS,
        type: 'symbol',
        source: ANTENAS_SOURCE_ID,
        filter: [
          'all',
          ['!', ['has', 'point_count']],
          ['!=', ['get', 'bandCardKey'], ''],
        ],
        layout: {
          visibility: showBandsOnMapRef.current ? 'visible' : 'none',
          'icon-image': ['get', 'bandCardKey'],
          'icon-anchor': 'top',
          'icon-offset': [
            'interpolate',
            ['linear'],
            ['zoom'],
            5,
            ['literal', [0, 5]],
            11,
            ['literal', [0, 8]],
            14,
            ['literal', [0, 10]],
            17,
            ['literal', [0, 13]],
          ],
          'icon-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            6,
            0.78,
            12,
            0.9,
            15,
            1,
          ],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      });
    }

    // 2. Capas de la regla de distancia entre 2 puntos (Punto A -> Punto B), aisladas en try/catch
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
            'text-size': 13,
            'text-offset': [0, -1.15],
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': isDark ? '#FAF5FF' : '#3B0764',
            'text-halo-color': isDark ? '#0F172A' : '#FFFFFF',
            'text-halo-width': 2.5,
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
      pitch: 0,
      maxPitch: lock3dPitchRef.current ? 0 : 85,
      pitchWithRotate: true,
      minZoom: 0,
      maxZoom: 22,
      attributionControl: false,
    });

    map.setMinZoom(0);
    applyPitchLock(map, lock3dPitchRef.current);

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

    const resolveMissingStyleImage = (id: string) => {
      if (id.startsWith('multi:')) {
        registerMultiOperatorSprite(map, id);
      } else if (id.startsWith(BAND_CARD_KEY_PREFIX)) {
        registerBandCardSprite(map, id);
      }
    };

    const handleStyleImageMissing = (event: { id: string }) => {
      resolveMissingStyleImage(event.id);
    };

    map.setMissingStyleImageResolver(resolveMissingStyleImage);

    const handleStyleLoad = () => {
      hasLoadedOnceRef.current = true;
      map.setMinZoom(0);
      applyPitchLock(map, lock3dPitchRef.current);
      ensureCustomSourcesAndLayers(map);
      if (map.getLayer(LAYER_UNCLUSTERED_BANDS)) {
        map.setLayoutProperty(
          LAYER_UNCLUSTERED_BANDS,
          'visibility',
          showBandsOnMapRef.current ? 'visible' : 'none',
        );
      }
      const antSource = map.getSource(ANTENAS_SOURCE_ID) as
        | maplibregl.GeoJSONSource
        | undefined;
      if (antSource && typeof antSource.setClusterOptions === 'function') {
        const currentCluster =
          typeof antSource.getClusterOptions === 'function'
            ? antSource.getClusterOptions().cluster
            : undefined;
        if (currentCluster !== !disableClusteringRef.current) {
          void antSource
            .setClusterOptions({
              cluster: !disableClusteringRef.current,
              clusterMaxZoom: 12,
              clusterRadius: 46,
            })
            .catch(() => {
              // Ignorar si el estilo cambia durante la actualización del worker
            });
        }
      }
      syncClusteringVisualLayers(map, disableClusteringRef.current);
      if (
        antSource &&
        lastAppliedGeoJsonRef.current !== antenasGeoJsonRef.current
      ) {
        antSource.setData(antenasGeoJsonRef.current);
        lastAppliedGeoJsonRef.current = antenasGeoJsonRef.current;
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
      if (
        showBandsOnMapRef.current &&
        map.getLayer(LAYER_UNCLUSTERED_BANDS)
      ) {
        layers.push(LAYER_UNCLUSTERED_BANDS);
      }
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
      const hasClusterLayer =
        !disableClusteringRef.current && Boolean(map.getLayer(LAYER_CLUSTERS));

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

      // 1. Priorizar clic directo sobre una estación desagrupada (icono multicolor < 30 m o círculo individual)
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

      // 3. Clic en el fondo del mapa: limpiar selección activa
      if (selectedAntennaRef.current) {
        onSelectAntennaRef.current(null);
      }
    };

    const handleMouseMove = (event: maplibregl.MapMouseEvent) => {
      const isCrosshairActive = measureModeActiveRef.current;
      const interactiveLayers = getActiveUnclusteredLayers();
      if (!disableClusteringRef.current && map.getLayer(LAYER_CLUSTERS)) {
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
        (topHit.layer.id === LAYER_UNCLUSTERED_BANDS ||
          topHit.layer.id === LAYER_UNCLUSTERED_MULTI ||
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
            bandCardKey: String(raw.bandCardKey ?? ''),
            operatorsCsv: String(raw.operatorsCsv ?? ''),
            stationCount: Number(raw.stationCount ?? 1),
            memberIdsPipe: String(raw.memberIdsPipe ?? ''),
          };
          const primaryAnt =
            matchedSite?.primary ??
            antenasByIdRef.current.get(popupProps.primaryId);
          popup.setHTML(buildPopupHtml(popupProps, matchedSite, primaryAnt));
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
      map.setMissingStyleImageResolver(null);
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
        registerMultiOperatorSprite(map, multiIconKeys[i]);
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

  // Cursor de retícula al activar/desactivar el modo medición
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    map.getCanvas().style.cursor = effectiveMeasureModeActive
      ? 'crosshair'
      : '';
  }, [effectiveMeasureModeActive]);

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
    (lon: number, lat: number, zoom: number) => {
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
        styleId={styleId}
        onStyleChange={onStyleChange}
        measurePoints={effectiveMeasurePoints}
        onMeasurePointsChange={handleMeasurePointsChange}
        measureModeActive={effectiveMeasureModeActive}
        onToggleMeasureMode={handleToggleMeasureMode}
        lock3dPitch={effectiveLock3dPitch}
        onToggleLock3dPitch={handleToggleLock3dPitch}
        showBandsOnMap={effectiveShowBandsOnMap}
        onToggleShowBandsOnMap={handleToggleShowBandsOnMap}
        disableClustering={effectiveDisableClustering}
        onToggleDisableClustering={handleToggleDisableClustering}
        onFlyToRegion={handleFlyToRegion}
      />
    </div>
  );
}
