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
  OPERATOR_META,
  computeHighQualityMapPixelRatio,
  getMapStyleOption,
  resolveMapStyleInput,
  type AntennaRecord,
  type OperatorKey,
} from '../../types/antena';
import { isUnicoOperatorKey } from '../../hooks/useUnico5gData';
import {
  DEFAULT_CLUSTERING_LEVEL,
  MAX_MEASURE_POINTS,
  getClusteringLevelConfig,
  type AntenasMapProps,
  type ClusteringLevel,
  type MeasurePoint,
} from '../../types/map';
import {
  UNICO_OPERATOR_ORDER,
  type UnicoAntennaRecord,
  type UnicoFase,
  type UnicoOperatorKey,
} from '../../types/unico5g';
import {
  BAND_CARD_KEY_PREFIX,
  BAND_CARD_PIXEL_RATIO,
  buildSiteBandCardKey,
  getOrCreateBandCardSprite,
} from '../../utils/bandCard';
import {
  EMPTY_CODE_HIGHLIGHT_GEOJSON,
  buildCodeHighlightGeoJson,
  computeCodeHighlightAnimationFrame,
  type CodeHighlightFeatureProperties,
} from '../../utils/codeHighlight';
import {
  MULTI_OPERATOR_SITE_MAX_DISTANCE_METERS,
  SPAIN_REGION_PRESETS,
  formatDistance,
  groupColocatedAntennasForMap,
  haversineDistanceKm,
  type MapSiteEntry,
} from '../../utils/geo';
import {
  UNICO_COORD_ICON_PREFIX,
  UNICO_PROJECT_ICON_ANCHOR,
  UNICO_PROJECT_ICON_OFFSET,
  UNICO_PROJECT_ICON_STOPS,
  UNICO_PROJECT_SPRITE_PIXEL_RATIO,
  buildUnicoProjectsGeoJson,
  buildUnicoProjectsPopupHtml,
  getOrCreateUnicoProjectSprite,
  type UnicoProjectFeatureProperties,
} from '../../utils/unicoProjectsMap';
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
const UNICO_PROJECTS_SOURCE_ID = 'unico-projects-source';
const CODE_HIGHLIGHT_SOURCE_ID = 'code-highlight-source';
const MEASURE_SOURCE_ID = 'measure-source';

const LAYER_MEASURE_CASING = 'measure-line-casing';
const LAYER_MEASURE_LINE = 'measure-line';
const LAYER_MEASURE_POINTS_HALO = 'measure-points-halo';
const LAYER_MEASURE_POINTS = 'measure-points';
const LAYER_MEASURE_POINT_LABELS = 'measure-point-labels';
const LAYER_MEASURE_DISTANCE_LABEL = 'measure-distance-label';
const LAYER_MEASURE_TOTAL_LABEL = 'measure-total-label';

const LAYER_CLUSTERS = 'antenas-clusters';
const LAYER_CLUSTER_COUNT = 'antenas-cluster-count';
const LAYER_UNICO_DECLARED_HALO = 'antenas-unico-declared-halo';
const LAYER_UNICO_DECLARED_RING = 'antenas-unico-declared-ring';
const LAYER_UNCLUSTERED = 'antenas-unclustered';
const LAYER_UNCLUSTERED_MULTI = 'antenas-unclustered-multi';
const LAYER_UNICO_PROJECTS = 'unico-projects-points';
const LAYER_SELECTED_HALO = 'antenas-selected-halo';
const LAYER_SELECTED_RING = 'antenas-selected-ring';
const LAYER_UNCLUSTERED_BANDS = 'antenas-unclustered-bands';
const LAYER_CODE_HIGHLIGHT_PULSE = 'antenas-code-highlight-pulse';
const LAYER_CODE_HIGHLIGHT_PULSE_SECONDARY =
  'antenas-code-highlight-pulse-secondary';
const LAYER_CODE_HIGHLIGHT_RING_CASING = 'antenas-code-highlight-ring-casing';
const LAYER_CODE_HIGHLIGHT_RING = 'antenas-code-highlight-ring';
const LAYER_CODE_HIGHLIGHT_LABEL = 'antenas-code-highlight-label';

const UNICO_DECLARED_FILTER: maplibregl.FilterSpecification = [
  'all',
  ['!', ['has', 'point_count']],
  ['==', ['get', 'isUnicoDeclared'], true],
];

const UNICO_PIN_POPUP_OFFSET: maplibregl.Offset = {
  center: [0, -14],
  top: [0, 8],
  'top-left': [0, 8],
  'top-right': [0, 8],
  bottom: [0, -28],
  'bottom-left': [0, -28],
  'bottom-right': [0, -28],
  left: [14, -14],
  right: [-14, -14],
};

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
  isUnicoDeclared: boolean;
  iconKey: string;
  bandCardKey: string;
  operatorsCsv: string;
  stationCount: number;
  memberIdsPipe: string;
}

export interface MeasureFeatureProperties {
  kind: 'measure-line' | 'measure-point' | 'measure-midpoint' | 'measure-total';
  pointTag?: string;
  distanceLabel?: string;
  segmentIndex?: number;
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

function registerUnicoProjectSprite(
  map: maplibregl.Map,
  iconKey: string,
): void {
  if (!iconKey.startsWith(UNICO_COORD_ICON_PREFIX) || map.hasImage(iconKey)) {
    return;
  }
  const imageData = getOrCreateUnicoProjectSprite(iconKey);
  if (!imageData) {
    return;
  }
  if (!map.hasImage(iconKey)) {
    map.addImage(iconKey, imageData, {
      pixelRatio: UNICO_PROJECT_SPRITE_PIXEL_RATIO,
    });
  }
}

function registerAllUnicoProjectSprites(map: maplibregl.Map): void {
  for (let i = 0; i < UNICO_OPERATOR_ORDER.length; i++) {
    registerUnicoProjectSprite(
      map,
      `${UNICO_COORD_ICON_PREFIX}${UNICO_OPERATOR_ORDER[i]}`,
    );
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

export { MAX_MEASURE_POINTS };

export function appendMeasurePointWithLimit(
  currentPoints: readonly MeasurePoint[],
  newPoint: MeasurePoint,
  maxPoints: number = MAX_MEASURE_POINTS,
): MeasurePoint[] {
  if (currentPoints.length >= maxPoints) {
    return currentPoints as MeasurePoint[];
  }
  return [...currentPoints, newPoint];
}

export function buildMeasureGeoJson(
  points: readonly MeasurePoint[],
): FeatureCollection<Point | LineString, MeasureFeatureProperties> {
  const features: Feature<Point | LineString, MeasureFeatureProperties>[] = [];
  const validPts = points.filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon),
  );
  const pts = validPts.slice(0, MAX_MEASURE_POINTS);

  if (pts.length >= 2) {
    const segmentDistancesKm: number[] = [];
    let totalKm = 0;

    for (let i = 0; i < pts.length - 1; i++) {
      const segKm = haversineDistanceKm(
        pts[i].lat,
        pts[i].lon,
        pts[i + 1].lat,
        pts[i + 1].lon,
      );
      segmentDistancesKm.push(segKm);
      totalKm += segKm;
    }

    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: pts.map((p) => [p.lon, p.lat]),
      },
      properties: {
        kind: 'measure-line',
        distanceLabel: formatMeasureDistanceLabel(totalKm),
      },
    });

    for (let i = 0; i < pts.length - 1; i++) {
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [
            (pts[i].lon + pts[i + 1].lon) / 2,
            (pts[i].lat + pts[i + 1].lat) / 2,
          ],
        },
        properties: {
          kind: 'measure-midpoint',
          segmentIndex: i + 1,
          distanceLabel: formatMeasureDistanceLabel(segmentDistancesKm[i]),
        },
      });
    }

    if (pts.length >= 3) {
      const lastPt = pts[pts.length - 1];
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [lastPt.lon, lastPt.lat],
        },
        properties: {
          kind: 'measure-total',
          distanceLabel: `Total: ${formatMeasureDistanceLabel(totalKm)}`,
        },
      });
    }
  }

  for (let i = 0; i < pts.length; i++) {
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [pts[i].lon, pts[i].lat],
      },
      properties: {
        kind: 'measure-point',
        pointTag: String(i + 1),
      },
    });
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}
/* oxlint-enable react/only-export-components */

function buildUnicoProjectsIconSizeExpr(): maplibregl.ExpressionSpecification {
  const expr: unknown[] = ['interpolate', ['linear'], ['zoom']];
  for (let i = 0; i < UNICO_PROJECT_ICON_STOPS.length; i++) {
    expr.push(UNICO_PROJECT_ICON_STOPS[i][0], UNICO_PROJECT_ICON_STOPS[i][1]);
  }
  return expr as maplibregl.ExpressionSpecification;
}

function parseUnicoProjectFeature(
  feature: maplibregl.MapGeoJSONFeature,
): UnicoProjectFeatureProperties | null {
  if (feature.geometry.type !== 'Point') {
    return null;
  }
  const raw = feature.properties as Record<string, unknown> | undefined;
  if (!raw) {
    return null;
  }
  const [geomLon, geomLat] = feature.geometry.coordinates;
  const lat = Number(raw.lat ?? geomLat);
  const lon = Number(raw.lon ?? geomLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  const rawFase = Number(raw.fase);
  const fase: UnicoFase = rawFase === 2 ? 2 : 1;
  const op: UnicoOperatorKey = isUnicoOperatorKey(raw.op) ? raw.op : 'orange';
  const declaredBits = Number(raw.declaredBits ?? 0);
  const matchedDistanceKm = Number(raw.matchedDistanceKm ?? -1);

  return {
    idx: Number(raw.idx ?? 0),
    id: String(raw.id ?? ''),
    fase,
    op,
    empresa: String(raw.empresa ?? ''),
    ccaa: String(raw.ccaa ?? ''),
    prov: String(raw.prov ?? ''),
    mun: String(raw.mun ?? ''),
    lat,
    lon,
    iconKey: String(raw.iconKey ?? `${UNICO_COORD_ICON_PREFIX}${op}`),
    declaredBits: Number.isFinite(declaredBits) ? declaredBits : 0,
    isDeclared:
      raw.isDeclared === true ||
      raw.isDeclared === 'true' ||
      (Number.isFinite(declaredBits) && declaredBits !== 0),
    matchedAntennaId: String(raw.matchedAntennaId ?? ''),
    matchedDistanceKm: Number.isFinite(matchedDistanceKm)
      ? matchedDistanceKm
      : -1,
  };
}

function collectUnicoProjectsAtSameCoord(
  hits: readonly maplibregl.MapGeoJSONFeature[],
  anchor?: { lat: number; lon: number },
): UnicoProjectFeatureProperties[] {
  const result: UnicoProjectFeatureProperties[] = [];
  const seenIds = new Set<string>();
  let anchorLat: number | null = anchor ? anchor.lat : null;
  let anchorLon: number | null = anchor ? anchor.lon : null;

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    if (hit.layer.id !== LAYER_UNICO_PROJECTS) {
      continue;
    }
    const parsed = parseUnicoProjectFeature(hit);
    if (!parsed || (parsed.id && seenIds.has(parsed.id))) {
      continue;
    }
    if (anchorLat === null || anchorLon === null) {
      anchorLat = parsed.lat;
      anchorLon = parsed.lon;
    } else if (
      Math.abs(parsed.lat - anchorLat) > 1e-6 ||
      Math.abs(parsed.lon - anchorLon) > 1e-6
    ) {
      continue;
    }
    if (parsed.id) {
      seenIds.add(parsed.id);
    }
    result.push(parsed);
  }
  if (result.length > 1) {
    result.sort((a, b) => a.idx - b.idx || a.id.localeCompare(b.id));
  }
  return result;
}

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

const CLUSTERED_UNICO_RING_GAPS: readonly number[] = [1.0, 1.2, 1.4, 1.6, 2.0];
const UNCLUSTERED_UNICO_RING_GAPS: readonly number[] = [
  0.5, 0.7, 1.0, 1.2, 1.4, 1.6, 2.0,
];
const CLUSTERED_UNICO_RING_STROKES: readonly number[] = [
  1.7, 2.0, 2.4, 2.8, 3.2,
];
const UNCLUSTERED_UNICO_RING_STROKES: readonly number[] = [
  1.0, 1.3, 1.7, 2.0, 2.4, 2.8, 3.2,
];
const CLUSTERED_UNICO_HALO_PADS: readonly number[] = [4.8, 5.8, 6.8, 8.0, 9.6];
const UNCLUSTERED_UNICO_HALO_PADS: readonly number[] = [
  2.2, 3.0, 4.4, 5.6, 6.8, 8.0, 9.6,
];

function buildUnicoRingRadiusExpr(
  disableClustering: boolean,
): maplibregl.ExpressionSpecification {
  const stops = disableClustering
    ? UNCLUSTERED_MULTI_ICON_STOPS
    : CLUSTERED_MULTI_ICON_STOPS;
  const gaps = disableClustering
    ? UNCLUSTERED_UNICO_RING_GAPS
    : CLUSTERED_UNICO_RING_GAPS;
  const expr: unknown[] = ['interpolate', ['linear'], ['zoom']];
  for (let i = 0; i < stops.length; i++) {
    const [zoom, iconScale] = stops[i];
    const baseRadius = MULTI_SPRITE_BASE_CSS_RADIUS * iconScale;
    expr.push(zoom, Number((baseRadius + gaps[i]).toFixed(4)));
  }
  return expr as maplibregl.ExpressionSpecification;
}

function buildUnicoRingStrokeWidthExpr(
  disableClustering: boolean,
): maplibregl.ExpressionSpecification {
  const stops = disableClustering
    ? UNCLUSTERED_MULTI_ICON_STOPS
    : CLUSTERED_MULTI_ICON_STOPS;
  const strokes = disableClustering
    ? UNCLUSTERED_UNICO_RING_STROKES
    : CLUSTERED_UNICO_RING_STROKES;
  const expr: unknown[] = ['interpolate', ['linear'], ['zoom']];
  for (let i = 0; i < stops.length; i++) {
    expr.push(stops[i][0], strokes[i]);
  }
  return expr as maplibregl.ExpressionSpecification;
}

function buildUnicoHaloRadiusExpr(
  disableClustering: boolean,
): maplibregl.ExpressionSpecification {
  const stops = disableClustering
    ? UNCLUSTERED_MULTI_ICON_STOPS
    : CLUSTERED_MULTI_ICON_STOPS;
  const pads = disableClustering
    ? UNCLUSTERED_UNICO_HALO_PADS
    : CLUSTERED_UNICO_HALO_PADS;
  const expr: unknown[] = ['interpolate', ['linear'], ['zoom']];
  for (let i = 0; i < stops.length; i++) {
    const [zoom, iconScale] = stops[i];
    const baseRadius = MULTI_SPRITE_BASE_CSS_RADIUS * iconScale;
    expr.push(zoom, Number((baseRadius + pads[i]).toFixed(4)));
  }
  return expr as maplibregl.ExpressionSpecification;
}

function buildUnicoHaloStrokeWidthExpr(
  disableClustering: boolean,
): maplibregl.ExpressionSpecification {
  if (disableClustering) {
    return [
      'interpolate',
      ['linear'],
      ['zoom'],
      3,
      0.5,
      7,
      0.8,
      11,
      1.1,
      17,
      1.4,
    ] as maplibregl.ExpressionSpecification;
  }
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    5,
    0.8,
    11,
    1.1,
    17,
    1.4,
  ] as maplibregl.ExpressionSpecification;
}

interface SourceClusterOptions {
  cluster: boolean;
  clusterMaxZoom: number;
  clusterRadius: number;
}

function buildSourceClusterOptions(
  level: ClusteringLevel,
): SourceClusterOptions {
  const cfg = getClusteringLevelConfig(level);
  return {
    cluster: cfg.cluster,
    clusterMaxZoom: cfg.clusterMaxZoom,
    clusterRadius: cfg.clusterRadius,
  };
}

function hasMatchingClusterOptions(
  current: maplibregl.GetClusterOptions | undefined,
  target: SourceClusterOptions,
): boolean {
  if (!current || current.cluster !== target.cluster) {
    return false;
  }
  if (!target.cluster) {
    return true;
  }
  return (
    current.clusterMaxZoom === target.clusterMaxZoom &&
    Math.abs(current.clusterRadius - target.clusterRadius) < 0.5
  );
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
  if (map.getLayer(LAYER_UNICO_DECLARED_HALO)) {
    map.setPaintProperty(
      LAYER_UNICO_DECLARED_HALO,
      'circle-radius',
      buildUnicoHaloRadiusExpr(disableClustering),
    );
    map.setPaintProperty(
      LAYER_UNICO_DECLARED_HALO,
      'circle-stroke-width',
      buildUnicoHaloStrokeWidthExpr(disableClustering),
    );
  }
  if (map.getLayer(LAYER_UNICO_DECLARED_RING)) {
    map.setPaintProperty(
      LAYER_UNICO_DECLARED_RING,
      'circle-radius',
      buildUnicoRingRadiusExpr(disableClustering),
    );
    map.setPaintProperty(
      LAYER_UNICO_DECLARED_RING,
      'circle-stroke-width',
      buildUnicoRingStrokeWidthExpr(disableClustering),
    );
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

const EMPTY_MEASURE_POINTS: MeasurePoint[] = [];
const EMPTY_UNICO_PROJECTS: readonly UnicoAntennaRecord[] = [];
const EMPTY_UNICO_PROJECTS_GEOJSON: FeatureCollection<
  Point,
  UnicoProjectFeatureProperties
> = {
  type: 'FeatureCollection',
  features: [],
};

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
    clusteringLevel,
    onClusteringLevelChange,
    unicoDeclaredById,
    highlightUnicoDeclared,
    onToggleHighlightUnicoDeclared,
    unicoProjects = EMPTY_UNICO_PROJECTS,
    unicoDeclaredMasks,
    showUnicoProjects,
    onToggleShowUnicoProjects,
    onFocusUnicoMatchedAntenna,
    highlightedAntenna,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const pinnedUnicoPopupRef = useRef<maplibregl.Popup | null>(null);
  const pinnedUnicoCoordKeyRef = useRef<string | null>(null);
  const hoveredIdRef = useRef<string | null>(null);
  const appliedStyleIdRef = useRef<AntenasMapProps['styleId']>(styleId);
  const lastFlyTokenRef = useRef<number | string | null>(null);
  const hasLoadedOnceRef = useRef(false);
  const lastAppliedGeoJsonRef = useRef<FeatureCollection<
    Point,
    AntennaFeatureProperties
  > | null>(null);
  const lastAppliedUnicoGeoJsonRef = useRef<FeatureCollection<
    Point,
    UnicoProjectFeatureProperties
  > | null>(null);

  const clearPinnedUnicoPopup = useCallback(() => {
    if (pinnedUnicoPopupRef.current) {
      pinnedUnicoPopupRef.current.remove();
      pinnedUnicoPopupRef.current = null;
    }
    pinnedUnicoCoordKeyRef.current = null;
  }, []);

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

  // Soporte híbrido controlado o autónomo para los 4 niveles de clustering ('none' | 'normal' | 'high' | 'max')
  const [internalClusteringLevel, setInternalClusteringLevel] =
    useState<ClusteringLevel>(() => clusteringLevel ?? DEFAULT_CLUSTERING_LEVEL);
  const isClusteringLevelControlled =
    clusteringLevel !== undefined && onClusteringLevelChange !== undefined;
  const effectiveClusteringLevel = isClusteringLevelControlled
    ? clusteringLevel
    : internalClusteringLevel;
  const clusteringLevelRef = useRef<ClusteringLevel>(effectiveClusteringLevel);

  const handleClusteringLevelChange = useCallback(
    (nextLevel: ClusteringLevel) => {
      if (isClusteringLevelControlled) {
        onClusteringLevelChange(nextLevel);
      } else {
        setInternalClusteringLevel(nextLevel);
        onClusteringLevelChange?.(nextLevel);
      }
    },
    [isClusteringLevelControlled, onClusteringLevelChange],
  );

  // Resaltado visual de antenas seleccionadas como declaración UNICO 5G (activo por defecto)
  const [internalHighlightUnicoDeclared, setInternalHighlightUnicoDeclared] =
    useState<boolean>(true);
  const effectiveHighlightUnicoDeclared =
    highlightUnicoDeclared ?? internalHighlightUnicoDeclared;
  const highlightUnicoDeclaredRef = useRef<boolean>(
    effectiveHighlightUnicoDeclared,
  );

  const handleToggleHighlightUnicoDeclared = useCallback(() => {
    if (onToggleHighlightUnicoDeclared) {
      onToggleHighlightUnicoDeclared();
    } else {
      setInternalHighlightUnicoDeclared((prev) => !prev);
    }
  }, [onToggleHighlightUnicoDeclared]);

  // Capa de puntos con coordenadas oficiales exactas de los proyectos UNICO 5G (desactivada por defecto)
  const [internalShowUnicoProjects, setInternalShowUnicoProjects] =
    useState<boolean>(false);
  const effectiveShowUnicoProjects =
    showUnicoProjects ?? internalShowUnicoProjects;
  const showUnicoProjectsRef = useRef<boolean>(effectiveShowUnicoProjects);

  const handleToggleShowUnicoProjects = useCallback(() => {
    if (onToggleShowUnicoProjects) {
      onToggleShowUnicoProjects();
    } else {
      setInternalShowUnicoProjects((prev) => !prev);
    }
  }, [onToggleShowUnicoProjects]);

  // Soporte híbrido controlado o autónomo para la regla de distancia multi-punto (0..10 puntos, "Medir en mapa")
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
        setInternalMeasurePoints([]);
        return !prev;
      });
    }
  }, [onToggleMeasureMode, effectiveMeasureModeActive, onMeasurePointsChange]);

  const currentStyleOption = useMemo(
    () => getMapStyleOption(styleId),
    [styleId],
  );

  // Agrupación espacial en memoria (fusión defensiva Vodafone < 35 m + misma coordenada exacta por operadora + multioperador < 15 m)
  // desacoplada del estado UNICO para no recalcular clustering al cargar unico-5g.json
  const {
    groupedSites,
    siteBandCardKeys,
    antenasById,
    sitesById,
    siteByMemberId,
    multiIconKeys,
  } = useMemo(() => {
    const byId = new Map<string, AntennaRecord>();
    for (let i = 0; i < antenas.length; i++) {
      const ant = antenas[i];
      if (Number.isFinite(ant.lat) && Number.isFinite(ant.lon)) {
        byId.set(ant.id, ant);
      }
    }

    const sites = groupColocatedAntennasForMap(
      antenas,
      MULTI_OPERATOR_SITE_MAX_DISTANCE_METERS,
    );
    const bySiteId = new Map<string, MapSiteEntry>();
    const byMemberId = new Map<string, MapSiteEntry>();
    const iconKeys = new Set<string>();
    const bandCardKeys = new Array<string>(sites.length);

    for (let i = 0; i < sites.length; i++) {
      const site = sites[i];
      bySiteId.set(site.siteId, site);
      for (let m = 0; m < site.memberIds.length; m++) {
        byMemberId.set(site.memberIds[m], site);
      }
      if (site.isMultiOperator) {
        iconKeys.add(site.iconKey);
      }
      bandCardKeys[i] = buildSiteBandCardKey(site);
    }

    return {
      groupedSites: sites,
      siteBandCardKeys: bandCardKeys,
      antenasById: byId,
      sitesById: bySiteId,
      siteByMemberId: byMemberId,
      multiIconKeys: Array.from(iconKeys),
    };
  }, [antenas]);

  // Construcción ligera de geometrías puntuales para el motor WebGL de MapLibre GL JS
  const antenasGeoJson = useMemo<
    FeatureCollection<Point, AntennaFeatureProperties>
  >(() => {
    const features: Feature<Point, AntennaFeatureProperties>[] = [];
    const hasUnicoLookup = Boolean(
      unicoDeclaredById && unicoDeclaredById.size > 0,
    );

    for (let i = 0; i < groupedSites.length; i++) {
      const site = groupedSites[i];

      let isUnicoDeclared = false;
      if (hasUnicoLookup && unicoDeclaredById) {
        for (let m = 0; m < site.members.length; m++) {
          if (unicoDeclaredById.has(site.members[m].id)) {
            isUnicoDeclared = true;
            break;
          }
        }
        if (!isUnicoDeclared) {
          for (let m = 0; m < site.memberIds.length; m++) {
            if (unicoDeclaredById.has(site.memberIds[m])) {
              isUnicoDeclared = true;
              break;
            }
          }
        }
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
          isUnicoDeclared,
          iconKey: site.iconKey,
          bandCardKey: siteBandCardKeys[i],
          operatorsCsv: site.operators.join('|'),
          stationCount: site.members.length,
          memberIdsPipe: `|${site.memberIds.join('|')}|`,
        },
      });
    }

    return {
      type: 'FeatureCollection',
      features,
    };
  }, [groupedSites, siteBandCardKeys, unicoDeclaredById]);

  // Construcción perezosa del GeoJSON puntual con las 9.291 coordenadas oficiales exactas de proyectos UNICO 5G
  const unicoProjectsGeoJson = useMemo<
    FeatureCollection<Point, UnicoProjectFeatureProperties>
  >(() => {
    if (!effectiveShowUnicoProjects || unicoProjects.length === 0) {
      return EMPTY_UNICO_PROJECTS_GEOJSON;
    }
    return buildUnicoProjectsGeoJson(
      unicoProjects,
      unicoDeclaredMasks,
      unicoDeclaredById,
    );
  }, [
    effectiveShowUnicoProjects,
    unicoProjects,
    unicoDeclaredMasks,
    unicoDeclaredById,
  ]);

  // Construcción memorizada de la polilínea de medición (hasta 10 puntos, tramos intermedios y total acumulado)
  const measureGeoJson = useMemo<
    FeatureCollection<Point | LineString, MeasureFeatureProperties>
  >(
    () => buildMeasureGeoJson(effectiveMeasurePoints),
    [effectiveMeasurePoints],
  );

  // Construcción memorizada del punto resaltado durante 10 s tras búsqueda específica por código
  const codeHighlightGeoJson = useMemo<
    FeatureCollection<Point, CodeHighlightFeatureProperties>
  >(() => {
    if (!highlightedAntenna) {
      return EMPTY_CODE_HIGHLIGHT_GEOJSON;
    }
    const matchedSite = siteByMemberId.get(highlightedAntenna.antenna.id);
    return buildCodeHighlightGeoJson(
      highlightedAntenna,
      matchedSite ? { lat: matchedSite.lat, lon: matchedSite.lon } : null,
    );
  }, [highlightedAntenna, siteByMemberId]);

  // Referencias vivas sincronizadas en efectos para acceso estable desde listeners imperativos de MapLibre
  const antenasGeoJsonRef = useRef(antenasGeoJson);
  const unicoProjectsGeoJsonRef = useRef(unicoProjectsGeoJson);
  const codeHighlightGeoJsonRef = useRef(codeHighlightGeoJson);
  const antenasByIdRef = useRef(antenasById);
  const sitesByIdRef = useRef(sitesById);
  const multiIconKeysRef = useRef(multiIconKeys);
  const measureGeoJsonRef = useRef(measureGeoJson);
  const selectedAntennaRef = useRef(selectedAntenna);
  const onSelectAntennaRef = useRef(onSelectAntenna);
  const onFocusUnicoMatchedAntennaRef = useRef(onFocusUnicoMatchedAntenna);
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
    unicoProjectsGeoJsonRef.current = unicoProjectsGeoJson;
  }, [unicoProjectsGeoJson]);

  useEffect(() => {
    codeHighlightGeoJsonRef.current = codeHighlightGeoJson;
  }, [codeHighlightGeoJson]);

  useEffect(() => {
    measureGeoJsonRef.current = measureGeoJson;
  }, [measureGeoJson]);

  useEffect(() => {
    selectedAntennaRef.current = selectedAntenna;
    onSelectAntennaRef.current = onSelectAntenna;
    onFocusUnicoMatchedAntennaRef.current = onFocusUnicoMatchedAntenna;
  }, [selectedAntenna, onSelectAntenna, onFocusUnicoMatchedAntenna]);

  useEffect(() => {
    measureModeActiveRef.current = effectiveMeasureModeActive;
    measurePointsRef.current = effectiveMeasurePoints;
    onMeasurePointsChangeRef.current = handleMeasurePointsChange;
    if (effectiveMeasureModeActive) {
      clearPinnedUnicoPopup();
    }
  }, [
    effectiveMeasureModeActive,
    effectiveMeasurePoints,
    handleMeasurePointsChange,
    clearPinnedUnicoPopup,
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

  // Sincronización inmediata en GPU del resaltado visual de antenas seleccionadas como declaración UNICO 5G
  useEffect(() => {
    highlightUnicoDeclaredRef.current = effectiveHighlightUnicoDeclared;
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const visibility = effectiveHighlightUnicoDeclared ? 'visible' : 'none';
    if (map.getLayer(LAYER_UNICO_DECLARED_HALO)) {
      map.setLayoutProperty(
        LAYER_UNICO_DECLARED_HALO,
        'visibility',
        visibility,
      );
    }
    if (map.getLayer(LAYER_UNICO_DECLARED_RING)) {
      map.setLayoutProperty(
        LAYER_UNICO_DECLARED_RING,
        'visibility',
        visibility,
      );
    }
  }, [effectiveHighlightUnicoDeclared]);

  // Sincronización inmediata en GPU de la capa de puntos con coordenadas oficiales exactas UNICO 5G
  useEffect(() => {
    showUnicoProjectsRef.current = effectiveShowUnicoProjects;
    const map = mapRef.current;
    if (!map) {
      return;
    }
    if (effectiveShowUnicoProjects && map.getStyle()) {
      registerAllUnicoProjectSprites(map);
    }
    if (map.getLayer(LAYER_UNICO_PROJECTS)) {
      map.setLayoutProperty(
        LAYER_UNICO_PROJECTS,
        'visibility',
        effectiveShowUnicoProjects ? 'visible' : 'none',
      );
    }
    if (!effectiveShowUnicoProjects) {
      clearPinnedUnicoPopup();
      if (hoveredIdRef.current?.startsWith(UNICO_COORD_ICON_PREFIX)) {
        hoveredIdRef.current = null;
        popupRef.current?.remove();
      }
    }
  }, [effectiveShowUnicoProjects, clearPinnedUnicoPopup]);

  // Permitir cerrar un popup fijado de coordenada UNICO 5G pulsando la tecla Escape
  useEffect(() => {
    if (!effectiveShowUnicoProjects) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        pinnedUnicoPopupRef.current
      ) {
        clearPinnedUnicoPopup();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [effectiveShowUnicoProjects, clearPinnedUnicoPopup]);

  // Sincronización inmediata en GPU al cambiar el nivel de agrupación en clústeres ('none' | 'normal' | 'high' | 'max')
  useEffect(() => {
    clusteringLevelRef.current = effectiveClusteringLevel;
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const clusterOptions = buildSourceClusterOptions(effectiveClusteringLevel);
    const source = map.getSource(ANTENAS_SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (source && typeof source.setClusterOptions === 'function') {
      void source.setClusterOptions(clusterOptions).catch(() => {
        // Ignorar si el estilo cambia durante la actualización del worker
      });
    }
    syncClusteringVisualLayers(map, !clusterOptions.cluster);
    if (hoveredIdRef.current !== null) {
      hoveredIdRef.current = null;
      popupRef.current?.remove();
    }
  }, [effectiveClusteringLevel]);

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
    const clusterOptions = buildSourceClusterOptions(
      clusteringLevelRef.current,
    );
    const disableClusteringActive = !clusterOptions.cluster;
    const highlightUnicoActive = highlightUnicoDeclaredRef.current;
    const showUnicoProjectsActive = showUnicoProjectsRef.current;

    // Registrar todos los sprites multicolor activos en el atlas WebGL del estilo actual
    const activeIconKeys = multiIconKeysRef.current;
    for (let i = 0; i < activeIconKeys.length; i++) {
      registerMultiOperatorSprite(map, activeIconKeys[i]);
    }
    registerAllUnicoProjectSprites(map);

    // 1. Fuente principal clusterizada con suma exacta de estaciones integradas (`stationSum`)
    if (!map.getSource(ANTENAS_SOURCE_ID)) {
      map.addSource(ANTENAS_SOURCE_ID, {
        type: 'geojson',
        data: antenasGeoJsonRef.current,
        cluster: clusterOptions.cluster,
        clusterMaxZoom: clusterOptions.clusterMaxZoom,
        clusterRadius: clusterOptions.clusterRadius,
        clusterProperties: {
          stationSum: ['+', ['get', 'stationCount']],
        },
      });
      lastAppliedGeoJsonRef.current = antenasGeoJsonRef.current;
    }

    // Resaltado concéntrico esmeralda (halo + collar de contraste y aro verde) bajo el marcador
    // para antenas seleccionadas como declaración del programa UNICO 5G
    if (!map.getLayer(LAYER_UNICO_DECLARED_HALO)) {
      map.addLayer({
        id: LAYER_UNICO_DECLARED_HALO,
        type: 'circle',
        source: ANTENAS_SOURCE_ID,
        filter: UNICO_DECLARED_FILTER,
        layout: {
          visibility: highlightUnicoActive ? 'visible' : 'none',
        },
        paint: {
          'circle-color': isDark ? '#22C55E' : '#10B981',
          'circle-opacity': isDark ? 0.28 : 0.24,
          'circle-radius': buildUnicoHaloRadiusExpr(disableClusteringActive),
          'circle-pitch-scale': 'viewport',
          'circle-stroke-width': buildUnicoHaloStrokeWidthExpr(
            disableClusteringActive,
          ),
          'circle-stroke-color': isDark
            ? 'rgba(74, 222, 128, 0.52)'
            : 'rgba(22, 163, 74, 0.48)',
        },
      });
    }

    if (!map.getLayer(LAYER_UNICO_DECLARED_RING)) {
      map.addLayer({
        id: LAYER_UNICO_DECLARED_RING,
        type: 'circle',
        source: ANTENAS_SOURCE_ID,
        filter: UNICO_DECLARED_FILTER,
        layout: {
          visibility: highlightUnicoActive ? 'visible' : 'none',
        },
        paint: {
          'circle-color': isDark ? '#0B1120' : '#FFFFFF',
          'circle-radius': buildUnicoRingRadiusExpr(disableClusteringActive),
          'circle-pitch-scale': 'viewport',
          'circle-stroke-width': buildUnicoRingStrokeWidthExpr(
            disableClusteringActive,
          ),
          'circle-stroke-color': isDark ? '#4ADE80' : '#16A34A',
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

    // Capa independiente con las 9.291 coordenadas oficiales exactas de los proyectos UNICO 5G
    // (sin clustering, sobre los marcadores de antenas para garantizar visibilidad incluso cuando coinciden a <= 10 m)
    if (!map.getSource(UNICO_PROJECTS_SOURCE_ID)) {
      map.addSource(UNICO_PROJECTS_SOURCE_ID, {
        type: 'geojson',
        data: unicoProjectsGeoJsonRef.current,
        cluster: false,
      });
      lastAppliedUnicoGeoJsonRef.current = unicoProjectsGeoJsonRef.current;
    }

    if (!map.getLayer(LAYER_UNICO_PROJECTS)) {
      map.addLayer({
        id: LAYER_UNICO_PROJECTS,
        type: 'symbol',
        source: UNICO_PROJECTS_SOURCE_ID,
        layout: {
          visibility: showUnicoProjectsActive ? 'visible' : 'none',
          'icon-image': ['get', 'iconKey'],
          'icon-anchor': UNICO_PROJECT_ICON_ANCHOR,
          'icon-offset': [
            UNICO_PROJECT_ICON_OFFSET[0],
            UNICO_PROJECT_ICON_OFFSET[1],
          ],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-size': buildUnicoProjectsIconSizeExpr(),
        },
      });
    }

    // Clústeres de antenas por encima de los puntos sin agrupar para mantener 100% legibles sus contadores al alejar
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

    // 1b. Resaltado temporal (10 s) de antena localizada mediante el buscador por código
    // Fuente independiente sin clustering para mantenerse visible y alineada a cualquier zoom o cambio de estilo
    if (!map.getSource(CODE_HIGHLIGHT_SOURCE_ID)) {
      map.addSource(CODE_HIGHLIGHT_SOURCE_ID, {
        type: 'geojson',
        data: codeHighlightGeoJsonRef.current,
        cluster: false,
      });
    }

    const highlightRingRadiusExpr: maplibregl.ExpressionSpecification = [
      'interpolate',
      ['linear'],
      ['zoom'],
      4,
      10,
      8,
      12.5,
      12,
      15.5,
      16,
      19.5,
      18,
      22,
    ];

    if (!map.getLayer(LAYER_CODE_HIGHLIGHT_PULSE)) {
      map.addLayer({
        id: LAYER_CODE_HIGHLIGHT_PULSE,
        type: 'circle',
        source: CODE_HIGHLIGHT_SOURCE_ID,
        paint: {
          'circle-radius': 22,
          'circle-color': isDark ? '#FDE047' : '#FACC15',
          'circle-opacity': 0.18,
          'circle-stroke-width': 2.6,
          'circle-stroke-color': isDark ? '#FDE047' : '#D97706',
          'circle-stroke-opacity': 0.85,
          'circle-pitch-scale': 'viewport',
        },
      });
    }

    if (!map.getLayer(LAYER_CODE_HIGHLIGHT_PULSE_SECONDARY)) {
      map.addLayer({
        id: LAYER_CODE_HIGHLIGHT_PULSE_SECONDARY,
        type: 'circle',
        source: CODE_HIGHLIGHT_SOURCE_ID,
        paint: {
          'circle-radius': 34,
          'circle-color': isDark ? '#FDE047' : '#FACC15',
          'circle-opacity': 0.1,
          'circle-stroke-width': 2,
          'circle-stroke-color': isDark ? '#FACC15' : '#EA580C',
          'circle-stroke-opacity': 0.55,
          'circle-pitch-scale': 'viewport',
        },
      });
    }

    if (!map.getLayer(LAYER_CODE_HIGHLIGHT_RING_CASING)) {
      map.addLayer({
        id: LAYER_CODE_HIGHLIGHT_RING_CASING,
        type: 'circle',
        source: CODE_HIGHLIGHT_SOURCE_ID,
        paint: {
          'circle-radius': highlightRingRadiusExpr,
          'circle-color': 'rgba(0, 0, 0, 0)',
          'circle-stroke-width': 7,
          'circle-stroke-color': '#0F172A',
          'circle-stroke-opacity': 0.92,
          'circle-pitch-scale': 'viewport',
        },
      });
    }

    if (!map.getLayer(LAYER_CODE_HIGHLIGHT_RING)) {
      map.addLayer({
        id: LAYER_CODE_HIGHLIGHT_RING,
        type: 'circle',
        source: CODE_HIGHLIGHT_SOURCE_ID,
        paint: {
          'circle-radius': highlightRingRadiusExpr,
          'circle-color': isDark ? '#FDE047' : '#FACC15',
          'circle-opacity': 0.14,
          'circle-stroke-width': 3.4,
          'circle-stroke-color': isDark ? '#FDE047' : '#FACC15',
          'circle-stroke-opacity': 1,
          'circle-pitch-scale': 'viewport',
        },
      });
    }

    if (!map.getLayer(LAYER_CODE_HIGHLIGHT_LABEL)) {
      map.addLayer({
        id: LAYER_CODE_HIGHLIGHT_LABEL,
        type: 'symbol',
        source: CODE_HIGHLIGHT_SOURCE_ID,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 12.5,
          'text-anchor': 'bottom',
          'text-offset': [0, -2.35],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': '#FEF08A',
          'text-halo-color': '#0F172A',
          'text-halo-width': 2.6,
          'text-opacity': 1,
        },
      });
    }

    // 2. Capas de la regla de distancia multi-punto (Puntos 1..10, tramos y total), aisladas en try/catch
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

      if (!map.getLayer(LAYER_MEASURE_TOTAL_LABEL)) {
        map.addLayer({
          id: LAYER_MEASURE_TOTAL_LABEL,
          type: 'symbol',
          source: MEASURE_SOURCE_ID,
          filter: ['==', ['get', 'kind'], 'measure-total'],
          layout: {
            'text-field': ['get', 'distanceLabel'],
            'text-font': ['Noto Sans Regular'],
            'text-size': 12.5,
            'text-offset': [0, 1.45],
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': isDark ? '#F3E8FF' : '#4C1D95',
            'text-halo-color': isDark ? '#0F172A' : '#FFFFFF',
            'text-halo-width': 2.5,
          },
        });
      }
    } catch (err) {
      console.warn(
        '[AntenasMap] No se pudieron registrar las capas de medición en el mapa:',
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
    const initialStyle = getMapStyleOption(appliedStyleIdRef.current);

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
      style: resolveMapStyleInput(initialStyle),
      center: initialCenter,
      zoom: initialZoom,
      pitch: 0,
      maxPitch: lock3dPitchRef.current ? 0 : 85,
      pitchWithRotate: true,
      minZoom: 0,
      maxZoom: 22,
      anisotropicFilterPitch: 0,
      pixelRatio: computeHighQualityMapPixelRatio(
        typeof window !== 'undefined' ? window.devicePixelRatio : 1,
      ),
      maxCanvasSize: [8192, 8192],
      canvasContextAttributes: {
        antialias: true,
      },
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
      } else if (id.startsWith(UNICO_COORD_ICON_PREFIX)) {
        registerUnicoProjectSprite(map, id);
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
      const unicoVisibility = highlightUnicoDeclaredRef.current
        ? 'visible'
        : 'none';
      if (map.getLayer(LAYER_UNICO_DECLARED_HALO)) {
        map.setLayoutProperty(
          LAYER_UNICO_DECLARED_HALO,
          'visibility',
          unicoVisibility,
        );
      }
      if (map.getLayer(LAYER_UNICO_DECLARED_RING)) {
        map.setLayoutProperty(
          LAYER_UNICO_DECLARED_RING,
          'visibility',
          unicoVisibility,
        );
      }
      if (map.getLayer(LAYER_UNICO_PROJECTS)) {
        map.setLayoutProperty(
          LAYER_UNICO_PROJECTS,
          'visibility',
          showUnicoProjectsRef.current ? 'visible' : 'none',
        );
      }
      const unicoSource = map.getSource(UNICO_PROJECTS_SOURCE_ID) as
        | maplibregl.GeoJSONSource
        | undefined;
      if (
        unicoSource &&
        lastAppliedUnicoGeoJsonRef.current !== unicoProjectsGeoJsonRef.current
      ) {
        unicoSource.setData(unicoProjectsGeoJsonRef.current);
        lastAppliedUnicoGeoJsonRef.current = unicoProjectsGeoJsonRef.current;
      }
      const antSource = map.getSource(ANTENAS_SOURCE_ID) as
        | maplibregl.GeoJSONSource
        | undefined;
      const targetClusterOptions = buildSourceClusterOptions(
        clusteringLevelRef.current,
      );
      if (antSource && typeof antSource.setClusterOptions === 'function') {
        const currentOptions =
          typeof antSource.getClusterOptions === 'function'
            ? antSource.getClusterOptions()
            : undefined;
        if (!hasMatchingClusterOptions(currentOptions, targetClusterOptions)) {
          void antSource.setClusterOptions(targetClusterOptions).catch(() => {
            // Ignorar si el estilo cambia durante la actualización del worker
          });
        }
      }
      syncClusteringVisualLayers(map, !targetClusterOptions.cluster);
      if (
        antSource &&
        lastAppliedGeoJsonRef.current !== antenasGeoJsonRef.current
      ) {
        antSource.setData(antenasGeoJsonRef.current);
        lastAppliedGeoJsonRef.current = antenasGeoJsonRef.current;
      }
      const highlightSource = map.getSource(CODE_HIGHLIGHT_SOURCE_ID) as
        | maplibregl.GeoJSONSource
        | undefined;
      if (highlightSource) {
        highlightSource.setData(codeHighlightGeoJsonRef.current);
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
      if (
        highlightUnicoDeclaredRef.current &&
        map.getLayer(LAYER_UNICO_DECLARED_RING)
      ) {
        layers.push(LAYER_UNICO_DECLARED_RING);
      }
      return layers;
    };

    const resolveStationFromFeature = (
      feature: maplibregl.MapGeoJSONFeature,
      fallbackLngLat: maplibregl.LngLat,
    ): AntennaRecord | null => {
      const rawProps = feature.properties as Record<string, unknown>;
      const featureId = String(rawProps.id ?? '');
      const matchedSite = sitesByIdRef.current.get(featureId);
      if (matchedSite) {
        return matchedSite.primary;
      }
      const primaryId = String(rawProps.primaryId ?? featureId);
      const matchedRecord = antenasByIdRef.current.get(primaryId);
      if (matchedRecord) {
        return matchedRecord;
      }
      if (!primaryId) {
        return null;
      }
      const fallbackGeometry =
        feature.geometry.type === 'Point'
          ? feature.geometry.coordinates
          : [fallbackLngLat.lng, fallbackLngLat.lat];
      return {
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
    };

    const queryFeaturesWithTouchFallback = (
      point: maplibregl.Point,
      layers: string[],
    ): maplibregl.MapGeoJSONFeature[] => {
      const exact = map.queryRenderedFeatures(point, { layers });
      if (exact.length > 0) {
        return exact;
      }
      if (
        typeof window !== 'undefined' &&
        window.matchMedia?.('(pointer: coarse)').matches
      ) {
        const pad = 10;
        return map.queryRenderedFeatures(
          [
            [point.x - pad, point.y - pad],
            [point.x + pad, point.y + pad],
          ],
          { layers },
        );
      }
      return exact;
    };

    const findPriorityUnicoHit = (
      hits: readonly maplibregl.MapGeoJSONFeature[],
      point: maplibregl.Point,
    ): UnicoProjectFeatureProperties | null => {
      const maxDistSq = 64 * 64;
      for (let i = 0; i < hits.length; i++) {
        const layerId = hits[i].layer.id;
        if (layerId === LAYER_CLUSTERS) {
          return null;
        }
        if (layerId === LAYER_UNICO_PROJECTS) {
          const parsed = parseUnicoProjectFeature(hits[i]);
          if (!parsed) {
            continue;
          }
          const projected = map.project([parsed.lon, parsed.lat]);
          const dx = projected.x - point.x;
          const dy = projected.y - point.y;
          if (dx * dx + dy * dy <= maxDistSq) {
            return parsed;
          }
        }
      }
      return null;
    };

    const openPinnedUnicoPopup = (
      projects: UnicoProjectFeatureProperties[],
      fallbackStation: AntennaRecord | null,
    ) => {
      if (projects.length === 0) {
        return;
      }
      const first = projects[0];
      const coordKey = `${UNICO_COORD_ICON_PREFIX}${projects
        .map((item) => item.id)
        .join('|')}`;

      if (pinnedUnicoCoordKeyRef.current === coordKey) {
        clearPinnedUnicoPopup();
        return;
      }

      let matchedAntennaId: string | null = null;
      let matchedAntenna: AntennaRecord | null = null;
      for (let i = 0; i < projects.length; i++) {
        const candidateId = projects[i].matchedAntennaId;
        if (candidateId) {
          const foundInVisible = antenasByIdRef.current.get(candidateId);
          if (foundInVisible) {
            matchedAntennaId = candidateId;
            matchedAntenna = foundInVisible;
            break;
          }
          if (!matchedAntennaId && onFocusUnicoMatchedAntennaRef.current) {
            matchedAntennaId = candidateId;
          }
        }
      }

      const canFocusMatched = Boolean(
        matchedAntenna ||
          (matchedAntennaId && onFocusUnicoMatchedAntennaRef.current),
      );
      const fallbackLabel =
        !canFocusMatched && fallbackStation
          ? `${OPERATOR_META[fallbackStation.op]?.shortName ?? 'Estación'} #${fallbackStation.gid}`
          : null;

      hoveredIdRef.current = null;
      popup.remove();
      clearPinnedUnicoPopup();

      const pinned = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: false,
        offset: UNICO_PIN_POPUP_OFFSET,
        maxWidth: 'min(330px, calc(100vw - 24px))',
        className: 'antenas-map-popup antenas-map-popup-interactive',
      })
        .setLngLat([first.lon, first.lat])
        .setHTML(
          buildUnicoProjectsPopupHtml(projects, {
            interactive: true,
            hasMatchedAntenna: canFocusMatched,
            fallbackStationLabel: fallbackLabel,
          }),
        )
        .addTo(map);

      pinnedUnicoPopupRef.current = pinned;
      pinnedUnicoCoordKeyRef.current = coordKey;

      let copyResetTimer: number | null = null;
      const clearCopyTimer = () => {
        if (copyResetTimer !== null) {
          window.clearTimeout(copyResetTimer);
          copyResetTimer = null;
        }
      };

      pinned.on('close', () => {
        clearCopyTimer();
        if (pinnedUnicoPopupRef.current === pinned) {
          pinnedUnicoPopupRef.current = null;
          pinnedUnicoCoordKeyRef.current = null;
        }
      });

      const popupEl = pinned.getElement();
      if (popupEl) {
        const closeBtn = popupEl.querySelector<HTMLButtonElement>(
          '.maplibregl-popup-close-button',
        );
        if (closeBtn) {
          closeBtn.setAttribute('aria-label', 'Cerrar ventana de coordenadas');
          closeBtn.setAttribute('title', 'Cerrar');
        }

        const coordsText = `${first.lat.toFixed(6)}, ${first.lon.toFixed(6)}`;
        const copyBtn = popupEl.querySelector<HTMLButtonElement>(
          '[data-unico-action="copy"]',
        );
        copyBtn?.addEventListener('click', (ev) => {
          ev.stopPropagation();
          void (async () => {
            try {
              if (!navigator.clipboard?.writeText) {
                return;
              }
              await navigator.clipboard.writeText(coordsText);
              if (!copyBtn.isConnected) {
                return;
              }
              clearCopyTimer();
              copyBtn.textContent = '¡Copiado!';
              copyBtn.classList.add('is-copied');
              copyResetTimer = window.setTimeout(() => {
                copyResetTimer = null;
                if (copyBtn.isConnected) {
                  copyBtn.textContent = 'Copiar coords';
                  copyBtn.classList.remove('is-copied');
                }
              }, 1800);
            } catch {
              // Ignorar si el portapapeles está restringido
            }
          })();
        });

        const focusMatchedBtn = popupEl.querySelector<HTMLButtonElement>(
          '[data-unico-action="focus-matched"]',
        );
        if (focusMatchedBtn && canFocusMatched) {
          const targetId = matchedAntennaId;
          const targetAnt = matchedAntenna;
          focusMatchedBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            clearPinnedUnicoPopup();
            if (targetId && onFocusUnicoMatchedAntennaRef.current) {
              onFocusUnicoMatchedAntennaRef.current(targetId);
            } else if (targetAnt) {
              onSelectAntennaRef.current(targetAnt);
            }
          });
        }

        const focusFallbackBtn = popupEl.querySelector<HTMLButtonElement>(
          '[data-unico-action="focus-fallback"]',
        );
        if (focusFallbackBtn && fallbackStation) {
          const targetAnt = fallbackStation;
          focusFallbackBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            clearPinnedUnicoPopup();
            onSelectAntennaRef.current(targetAnt);
          });
        }
      }
    };

    const handleMapClick = (event: maplibregl.MapMouseEvent) => {
      const unclusteredLayers = getActiveUnclusteredLayers();
      const hasUnicoProjectsLayer =
        showUnicoProjectsRef.current &&
        Boolean(map.getLayer(LAYER_UNICO_PROJECTS));
      const clickablePointLayers = hasUnicoProjectsLayer
        ? [...unclusteredLayers, LAYER_UNICO_PROJECTS]
        : unclusteredLayers;
      const hasClusterLayer =
        clusteringLevelRef.current !== 'none' &&
        Boolean(map.getLayer(LAYER_CLUSTERS));

      // 0. Modo "Medir en mapa" (hasta 10 puntos: ajusta exactamente a coordenadas UNICO 5G o antenas reales)
      if (measureModeActiveRef.current) {
        const currentPts = measurePointsRef.current;
        if (currentPts.length >= MAX_MEASURE_POINTS) {
          return;
        }

        let targetLat = Number(event.lngLat.lat.toFixed(6));
        let targetLon = Number(event.lngLat.lng.toFixed(6));
        let targetLabel: string | undefined;

        if (clickablePointLayers.length > 0) {
          const snappedFeatures = queryFeaturesWithTouchFallback(
            event.point,
            clickablePointLayers,
          );
          if (snappedFeatures.length > 0) {
            const parsedUnico = findPriorityUnicoHit(
              snappedFeatures,
              event.point,
            );
            if (parsedUnico) {
              targetLat = Number(parsedUnico.lat.toFixed(6));
              targetLon = Number(parsedUnico.lon.toFixed(6));
              targetLabel = `UNICO F${parsedUnico.fase} · ${parsedUnico.mun}`;
            } else {
              const topSnap = snappedFeatures.find(
                (f) => f.layer.id !== LAYER_UNICO_PROJECTS,
              );
              if (topSnap) {
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
          }
        }

        const newPoint: MeasurePoint = {
          lat: targetLat,
          lon: targetLon,
          label: targetLabel,
        };

        const nextPts = appendMeasurePointWithLimit(
          currentPts,
          newPoint,
          MAX_MEASURE_POINTS,
        );
        measurePointsRef.current = nextPts;
        onMeasurePointsChangeRef.current(nextPts);
        return;
      }

      // 1. Orden de interacción al clic: clústeres visibles -> coordenadas UNICO 5G -> antenas reales
      const allClickableLayers = hasClusterLayer
        ? [...clickablePointLayers, LAYER_CLUSTERS]
        : clickablePointLayers;
      if (allClickableLayers.length > 0) {
        const hitFeatures = queryFeaturesWithTouchFallback(
          event.point,
          allClickableLayers,
        );
        if (hitFeatures.length > 0) {
          const topFeature = hitFeatures[0];
          if (topFeature.layer.id === LAYER_CLUSTERS) {
            clearPinnedUnicoPopup();
            const clusterId = Number(topFeature.properties?.cluster_id);
            const source = map.getSource(ANTENAS_SOURCE_ID) as
              | maplibregl.GeoJSONSource
              | undefined;

            if (
              source &&
              Number.isFinite(clusterId) &&
              topFeature.geometry.type === 'Point'
            ) {
              const [lon, lat] = topFeature.geometry.coordinates;
              void source
                .getClusterExpansionZoom(clusterId)
                .then((expansionZoom) => {
                  if (
                    clusteringLevelRef.current === 'none' ||
                    typeof expansionZoom !== 'number' ||
                    !Number.isFinite(expansionZoom)
                  ) {
                    return;
                  }
                  map.easeTo({
                    center: [lon, lat],
                    zoom: Math.min(expansionZoom, 17),
                    duration: 480,
                  });
                })
                .catch(() => {
                  // Ignorar si el estilo o la fuente cambiaron durante la transición
                });
            }
            return;
          }

          const unicoHit = findPriorityUnicoHit(hitFeatures, event.point);
          if (unicoHit) {
            const projectsAtCoord = collectUnicoProjectsAtSameCoord(
              hitFeatures,
              { lat: unicoHit.lat, lon: unicoHit.lon },
            );
            if (projectsAtCoord.length > 0) {
              const underlyingStationFeature = hitFeatures.find(
                (f) =>
                  f.layer.id !== LAYER_UNICO_PROJECTS &&
                  f.layer.id !== LAYER_CLUSTERS,
              );
              const fallbackStation = underlyingStationFeature
                ? resolveStationFromFeature(
                    underlyingStationFeature,
                    event.lngLat,
                  )
                : null;
              openPinnedUnicoPopup(projectsAtCoord, fallbackStation);
              return;
            }
          }

          const stationFeature = hitFeatures.find(
            (f) =>
              f.layer.id !== LAYER_UNICO_PROJECTS &&
              f.layer.id !== LAYER_CLUSTERS,
          );
          if (stationFeature) {
            clearPinnedUnicoPopup();
            const resolvedStation = resolveStationFromFeature(
              stationFeature,
              event.lngLat,
            );
            if (resolvedStation) {
              onSelectAntennaRef.current(resolvedStation);
              return;
            }
          }
        }
      }

      clearPinnedUnicoPopup();

      // 2. Clic en el fondo del mapa: limpiar selección activa
      if (selectedAntennaRef.current) {
        onSelectAntennaRef.current(null);
      }
    };

    const handleMouseMove = (event: maplibregl.MapMouseEvent) => {
      const isCrosshairActive =
        measureModeActiveRef.current &&
        measurePointsRef.current.length < MAX_MEASURE_POINTS;
      const interactiveLayers = getActiveUnclusteredLayers();
      if (
        showUnicoProjectsRef.current &&
        map.getLayer(LAYER_UNICO_PROJECTS)
      ) {
        interactiveLayers.push(LAYER_UNICO_PROJECTS);
      }
      if (
        clusteringLevelRef.current !== 'none' &&
        map.getLayer(LAYER_CLUSTERS)
      ) {
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

      const priorityUnicoHit = findPriorityUnicoHit(hits, event.point);
      const topNonUnicoHit = hits.find(
        (f) => f.layer.id !== LAYER_UNICO_PROJECTS,
      );
      if (!priorityUnicoHit && !topNonUnicoHit) {
        map.getCanvas().style.cursor = isCrosshairActive ? 'crosshair' : '';
        if (hoveredIdRef.current !== null) {
          hoveredIdRef.current = null;
          popup.remove();
        }
        return;
      }

      map.getCanvas().style.cursor = measureModeActiveRef.current
        ? isCrosshairActive
          ? 'crosshair'
          : ''
        : 'pointer';

      // Mientras haya un popup interactivo fijado de UNICO abierto, no abrir tooltips flotantes que lo solapen
      if (pinnedUnicoPopupRef.current !== null) {
        if (hoveredIdRef.current !== null) {
          hoveredIdRef.current = null;
          popup.remove();
        }
        return;
      }

      if (priorityUnicoHit) {
        const projectsAtCoord = collectUnicoProjectsAtSameCoord(hits, {
          lat: priorityUnicoHit.lat,
          lon: priorityUnicoHit.lon,
        });
        if (projectsAtCoord.length > 0) {
          const hoverKey = `${UNICO_COORD_ICON_PREFIX}${projectsAtCoord
            .map((item) => item.id)
            .join('|')}`;
          const firstProj = projectsAtCoord[0];
          if (hoveredIdRef.current !== hoverKey) {
            hoveredIdRef.current = hoverKey;
            const hasMatchedAntenna = projectsAtCoord.some(
              (item) =>
                item.matchedAntennaId !== '' &&
                (Boolean(onFocusUnicoMatchedAntennaRef.current) ||
                  antenasByIdRef.current.has(item.matchedAntennaId)),
            );
            popup.setOffset(UNICO_PIN_POPUP_OFFSET);
            popup.setHTML(
              buildUnicoProjectsPopupHtml(projectsAtCoord, {
                interactive: false,
                hasMatchedAntenna,
              }),
            );
          }
          popup.setLngLat([firstProj.lon, firstProj.lat]).addTo(map);
          return;
        }
      }

      if (hoveredIdRef.current !== null) {
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
      clearPinnedUnicoPopup();
      map.remove();
      mapRef.current = null;
      popupRef.current = null;
      hoveredIdRef.current = null;
      hasLoadedOnceRef.current = false;
      lastAppliedGeoJsonRef.current = null;
      lastAppliedUnicoGeoJsonRef.current = null;
      lastFlyTokenRef.current = null;
    };
  }, [ensureCustomSourcesAndLayers, clearPinnedUnicoPopup]);

  // Cambio resiliente de estilo OpenFreeMap / OSM Retina / Google Maps preservando todas las fuentes y capas
  useEffect(() => {
    isDarkStyleRef.current = currentStyleOption.isDark;
    const map = mapRef.current;
    if (!map || appliedStyleIdRef.current === styleId) {
      return;
    }

    appliedStyleIdRef.current = styleId;
    hoveredIdRef.current = null;
    lastAppliedGeoJsonRef.current = null;
    lastAppliedUnicoGeoJsonRef.current = null;
    popupRef.current?.remove();
    clearPinnedUnicoPopup();

    map.setStyle(resolveMapStyleInput(currentStyleOption), { diff: false });
  }, [styleId, currentStyleOption, clearPinnedUnicoPopup]);

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

  // Sincronización reactiva de las 9.291 coordenadas oficiales exactas de proyectos UNICO 5G hacia WebGL
  useEffect(() => {
    unicoProjectsGeoJsonRef.current = unicoProjectsGeoJson;
    const map = mapRef.current;
    if (!map) {
      return;
    }
    if (effectiveShowUnicoProjects && map.getStyle()) {
      registerAllUnicoProjectSprites(map);
    }
    const source = map.getSource(UNICO_PROJECTS_SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (source && lastAppliedUnicoGeoJsonRef.current !== unicoProjectsGeoJson) {
      source.setData(unicoProjectsGeoJson);
      lastAppliedUnicoGeoJsonRef.current = unicoProjectsGeoJson;
    }
  }, [unicoProjectsGeoJson, effectiveShowUnicoProjects]);

  // Sincronización reactiva aislada de la regla de distancia multi-punto (0..10 puntos)
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

  // Sincronización reactiva del marcador resaltado durante 10 s tras búsqueda por código
  useEffect(() => {
    codeHighlightGeoJsonRef.current = codeHighlightGeoJson;
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const source = map.getSource(CODE_HIGHLIGHT_SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (source) {
      source.setData(codeHighlightGeoJson);
    }
  }, [codeHighlightGeoJson]);

  // Animación WebGL de pulso radar de 10 s (con desvanecimiento suave y soporte prefers-reduced-motion)
  useEffect(() => {
    if (!highlightedAntenna) {
      return;
    }
    const map = mapRef.current;
    if (!map || typeof window === 'undefined') {
      return;
    }

    const reducedMotion = Boolean(
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    );
    const durationMs = Math.max(
      1,
      highlightedAntenna.expiresAt - highlightedAntenna.startedAt,
    );
    let rafId: number | null = null;
    let cancelled = false;

    const applyFrame = () => {
      if (cancelled) {
        return;
      }
      const activeMap = mapRef.current;
      if (!activeMap) {
        return;
      }

      const now = Date.now();
      const elapsedMs = now - highlightedAntenna.startedAt;
      const frame = computeCodeHighlightAnimationFrame(
        elapsedMs,
        durationMs,
        reducedMotion,
      );

      if (activeMap.getStyle()) {
        if (activeMap.getLayer(LAYER_CODE_HIGHLIGHT_PULSE)) {
          activeMap.setPaintProperty(
            LAYER_CODE_HIGHLIGHT_PULSE,
            'circle-radius',
            frame.pulse1Radius,
          );
          activeMap.setPaintProperty(
            LAYER_CODE_HIGHLIGHT_PULSE,
            'circle-opacity',
            frame.pulse1FillOpacity,
          );
          activeMap.setPaintProperty(
            LAYER_CODE_HIGHLIGHT_PULSE,
            'circle-stroke-opacity',
            frame.pulse1StrokeOpacity,
          );
        }
        if (activeMap.getLayer(LAYER_CODE_HIGHLIGHT_PULSE_SECONDARY)) {
          activeMap.setPaintProperty(
            LAYER_CODE_HIGHLIGHT_PULSE_SECONDARY,
            'circle-radius',
            frame.pulse2Radius,
          );
          activeMap.setPaintProperty(
            LAYER_CODE_HIGHLIGHT_PULSE_SECONDARY,
            'circle-opacity',
            frame.pulse2FillOpacity,
          );
          activeMap.setPaintProperty(
            LAYER_CODE_HIGHLIGHT_PULSE_SECONDARY,
            'circle-stroke-opacity',
            frame.pulse2StrokeOpacity,
          );
        }
        if (activeMap.getLayer(LAYER_CODE_HIGHLIGHT_RING_CASING)) {
          activeMap.setPaintProperty(
            LAYER_CODE_HIGHLIGHT_RING_CASING,
            'circle-stroke-opacity',
            frame.casingStrokeOpacity,
          );
        }
        if (activeMap.getLayer(LAYER_CODE_HIGHLIGHT_RING)) {
          activeMap.setPaintProperty(
            LAYER_CODE_HIGHLIGHT_RING,
            'circle-opacity',
            frame.ringFillOpacity,
          );
          activeMap.setPaintProperty(
            LAYER_CODE_HIGHLIGHT_RING,
            'circle-stroke-opacity',
            frame.ringStrokeOpacity,
          );
        }
        if (activeMap.getLayer(LAYER_CODE_HIGHLIGHT_LABEL)) {
          activeMap.setPaintProperty(
            LAYER_CODE_HIGHLIGHT_LABEL,
            'text-opacity',
            frame.labelOpacity,
          );
        }
      }

      if (now < highlightedAntenna.expiresAt) {
        rafId = window.requestAnimationFrame(applyFrame);
      } else {
        rafId = null;
      }
    };

    rafId = window.requestAnimationFrame(applyFrame);
    return () => {
      cancelled = true;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [highlightedAntenna, styleId]);

  const canAddMoreMeasurePoints =
    effectiveMeasureModeActive &&
    effectiveMeasurePoints.length < MAX_MEASURE_POINTS;

  // Cursor de retícula al activar el modo medición mientras queden puntos disponibles (< 10)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    map.getCanvas().style.cursor = canAddMoreMeasurePoints ? 'crosshair' : '';
  }, [canAddMoreMeasurePoints]);

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
    clearPinnedUnicoPopup();

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
  }, [flyToTarget, clearPinnedUnicoPopup]);

  const handleFlyToRegion = useCallback(
    (lon: number, lat: number, zoom: number) => {
      const map = mapRef.current;
      if (!map) {
        return;
      }
      clearPinnedUnicoPopup();
      map.flyTo({
        center: [lon, lat],
        zoom,
        duration: 1200,
        essential: true,
      });
    },
    [clearPinnedUnicoPopup],
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
        clusteringLevel={effectiveClusteringLevel}
        onClusteringLevelChange={handleClusteringLevelChange}
        highlightUnicoDeclared={effectiveHighlightUnicoDeclared}
        onToggleHighlightUnicoDeclared={handleToggleHighlightUnicoDeclared}
        showUnicoProjects={effectiveShowUnicoProjects}
        onToggleShowUnicoProjects={handleToggleShowUnicoProjects}
        unicoProjectsCount={unicoProjects.length}
        onFlyToRegion={handleFlyToRegion}
      />
    </div>
  );
}
