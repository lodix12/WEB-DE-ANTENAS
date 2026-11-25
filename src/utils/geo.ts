import type { Feature, Polygon } from 'geojson';
import {
  OPERATOR_ORDER,
  buildSameOperatorExactCoordKey,
  isXferaLegalEntity,
  normalizeOperatorKeyInput,
  shouldSkipExactCoordSameOperatorFusion,
  type AntennaRecord,
  type ConcesionBanda,
  type OperatorKey,
} from '../types/antena';
import type { NearestAntennaResult } from '../types/map';

const EARTH_RADIUS_KM = 6371.0088;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export function haversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * DEG_TO_RAD) *
      Math.cos(lat2 * DEG_TO_RAD) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

export function calculateBearingDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const phi1 = lat1 * DEG_TO_RAD;
  const phi2 = lat2 * DEG_TO_RAD;
  const deltaLambda = (lon2 - lon1) * DEG_TO_RAD;
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  const theta = Math.atan2(y, x) * RAD_TO_DEG;
  return (theta + 360) % 360;
}

const CARDINAL_DIRS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSO',
  'SO',
  'OSO',
  'O',
  'ONO',
  'NO',
  'NNO',
] as const;

export function bearingToCardinal(deg: number): string {
  const normalized = ((deg % 360) + 360) % 360;
  const index = Math.round(normalized / 22.5) % 16;
  return `${CARDINAL_DIRS[index]} (${Math.round(normalized)}°)`;
}

export function formatDistance(km: number): string {
  if (km < 1) {
    return `${Math.round(km * 1000)} m`;
  }
  return `${km.toLocaleString('es-ES', {
    minimumFractionDigits: km < 10 ? 2 : 1,
    maximumFractionDigits: km < 10 ? 2 : 1,
  })} km`;
}

export function findNearestAntennas(
  antenas: AntennaRecord[],
  lat: number,
  lon: number,
  limit = 10,
  maxRadiusKm?: number,
): NearestAntennaResult[] {
  const candidates: NearestAntennaResult[] = [];
  const latDegBuffer = maxRadiusKm ? maxRadiusKm / 110.5 : Infinity;

  for (let i = 0; i < antenas.length; i++) {
    const ant = antenas[i];
    if (maxRadiusKm && Math.abs(ant.lat - lat) > latDegBuffer) {
      continue;
    }
    const distanceKm = haversineDistanceKm(lat, lon, ant.lat, ant.lon);
    if (maxRadiusKm !== undefined && distanceKm > maxRadiusKm) {
      continue;
    }
    const bearingDeg = calculateBearingDeg(lat, lon, ant.lat, ant.lon);
    candidates.push({
      ...ant,
      distanceKm,
      bearingDeg,
      cardinal: bearingToCardinal(bearingDeg),
    });
  }

  candidates.sort((a, b) => a.distanceKm - b.distanceKm);
  return candidates.slice(0, limit);
}

export function createCirclePolygonGeoJSON(
  centerLon: number,
  centerLat: number,
  radiusKm: number,
  steps = 64,
): Feature<Polygon> {
  const coords: [number, number][] = [];
  const distRadians = radiusKm / EARTH_RADIUS_KM;
  const lat1 = centerLat * DEG_TO_RAD;
  const lon1 = centerLon * DEG_TO_RAD;

  for (let i = 0; i <= steps; i++) {
    const bearing = (i / steps) * 2 * Math.PI;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(distRadians) +
        Math.cos(lat1) * Math.sin(distRadians) * Math.cos(bearing),
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(distRadians) * Math.cos(lat1),
        Math.cos(distRadians) - Math.sin(lat1) * Math.sin(lat2),
      );
    coords.push([lon2 * RAD_TO_DEG, lat2 * RAD_TO_DEG]);
  }

  return {
    type: 'Feature',
    properties: { radiusKm },
    geometry: {
      type: 'Polygon',
      coordinates: [coords],
    },
  };
}

export interface RegionPreset {
  id: string;
  label: string;
  lon: number;
  lat: number;
  zoom: number;
}

export const SPAIN_REGION_PRESETS: RegionPreset[] = [
  { id: 'peninsula', label: 'Península', lon: -3.7038, lat: 40.2, zoom: 5.5 },
  { id: 'canarias', label: 'Canarias', lon: -15.65, lat: 28.32, zoom: 7.1 },
  { id: 'baleares', label: 'Baleares', lon: 2.95, lat: 39.62, zoom: 7.7 },
  { id: 'ceuta-melilla', label: 'Ceuta y Melilla', lon: -4.15, lat: 35.58, zoom: 7.2 },
  { id: 'madrid', label: 'Madrid', lon: -3.7038, lat: 40.4168, zoom: 11.5 },
  { id: 'barcelona', label: 'Barcelona', lon: 2.1734, lat: 41.3851, zoom: 11.8 },
  { id: 'valencia', label: 'Valencia', lon: -0.3763, lat: 39.4699, zoom: 11.8 },
  { id: 'sevilla', label: 'Sevilla', lon: -5.9845, lat: 37.3891, zoom: 11.8 },
];

export const MULTI_OPERATOR_SITE_MAX_DISTANCE_METERS = 15;
const VODAFONE_DEFENSIVE_FUSION_METERS = 35;

export interface MapSiteEntry {
  /** Identificador único determinista del marcador en el mapa */
  siteId: string;
  /** Latitud WGS84 del marcador (centroide en emplazamientos agrupados) */
  lat: number;
  /** Longitud WGS84 del marcador (centroide en emplazamientos agrupados) */
  lon: number;
  /** `true` cuando agrupa antenas de >= 2 operadores distintos a < 15 m */
  isMultiOperator: boolean;
  /** Operadores integrados ordenados canónicamente según `OPERATOR_ORDER` */
  operators: OperatorKey[];
  /** Estaciones representadas por este marcador ordenadas según `OPERATOR_ORDER` */
  members: AntennaRecord[];
  /** Todos los `id` originales cubiertos por este marcador */
  memberIds: string[];
  /** Estación principal representativa (`members[0]`) */
  primary: AntennaRecord;
  /** Clave de icono para MapLibre (`"multi:movistar|orange"` o `"single:movistar"`) */
  iconKey: string;
}

const OPERATOR_RANK: Record<OperatorKey, number> = (() => {
  const rankMap = {} as Record<OperatorKey, number>;
  for (let i = 0; i < OPERATOR_ORDER.length; i++) {
    rankMap[OPERATOR_ORDER[i]] = i;
  }
  return rankMap;
})();

const GRID_COL_STRIDE = 4_000_000;

function computeSafeSpatialCellDeg(maxDistanceMeters: number): number {
  // Cubre holgadamente `maxDistanceMeters` en longitud incluso a >= 44° N (`cos(44°) ≈ 0.719 > 0.65`).
  return Math.max(0.0006, maxDistanceMeters / 111320 / 0.65);
}

function clusterConnectedIndicesByDistance(
  records: AntennaRecord[],
  maxDistanceMeters: number,
): number[][] {
  const n = records.length;
  if (n === 0) return [];
  if (n === 1 || maxDistanceMeters <= 0) {
    return records.map((_, idx) => [idx]);
  }

  const cellDeg = computeSafeSpatialCellDeg(maxDistanceMeters);
  const maxDistanceKm = maxDistanceMeters / 1000;
  const maxLatDiffDeg = (maxDistanceMeters / 110_500) * 1.05;

  const parent = new Int32Array(n);
  const ufRank = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    parent[i] = i;
  }

  const find = (x: number): number => {
    let curr = x;
    while (parent[curr] !== curr) {
      parent[curr] = parent[parent[curr]];
      curr = parent[curr];
    }
    return curr;
  };

  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    if (ufRank[rootA] < ufRank[rootB]) {
      parent[rootA] = rootB;
    } else if (ufRank[rootA] > ufRank[rootB]) {
      parent[rootB] = rootA;
    } else {
      parent[rootB] = rootA;
      ufRank[rootA]++;
    }
  };

  const grid = new Map<number, number[]>();

  for (let i = 0; i < n; i++) {
    const rec = records[i];
    const row = Math.floor((rec.lat + 90) / cellDeg);
    const col = Math.floor((rec.lon + 180) / cellDeg);

    for (let dRow = -1; dRow <= 1; dRow++) {
      const neighborRowBase = (row + dRow) * GRID_COL_STRIDE;
      for (let dCol = -1; dCol <= 1; dCol++) {
        const bucket = grid.get(neighborRowBase + (col + dCol));
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          const j = bucket[k];
          const candidate = records[j];
          if (Math.abs(rec.lat - candidate.lat) > maxLatDiffDeg) {
            continue;
          }
          if (
            haversineDistanceKm(rec.lat, rec.lon, candidate.lat, candidate.lon) <
            maxDistanceKm
          ) {
            union(i, j);
          }
        }
      }
    }

    const ownKey = row * GRID_COL_STRIDE + col;
    const ownBucket = grid.get(ownKey);
    if (ownBucket) {
      ownBucket.push(i);
    } else {
      grid.set(ownKey, [i]);
    }
  }

  const groupsByRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = groupsByRoot.get(root);
    if (list) {
      list.push(i);
    } else {
      groupsByRoot.set(root, [i]);
    }
  }

  return Array.from(groupsByRoot.values());
}

interface CandidateMultiOpEdge {
  u: number;
  v: number;
  distKm: number;
}

/**
 * Agrupa antenas de distintos operadores a `< maxDistanceMeters` (`15 m` por defecto) mediante
 * enlace completo (`complete-linkage`) recorriendo las aristas en orden de distancia ascendente:
 * - Las antenas de Telefónica (`movistar`) NUNCA se unen entre sí ni directa ni transitivamente
 *   (`!(hasMovistarA && hasMovistarB)`): ningún icono compartido puede contener más de 1 `movistar`.
 * - Para unir dos grupos A y B, todos los miembros de A deben distar `< maxDistanceMeters`
 *   de todos los miembros de B, evitando cadenas transitivas artificiales.
 */
function clusterMultiOperatorSitesByCompleteLinkage(
  records: AntennaRecord[],
  maxDistanceMeters: number,
): number[][] {
  const n = records.length;
  if (n === 0) return [];
  if (n === 1 || maxDistanceMeters <= 0) {
    return records.map((_, idx) => [idx]);
  }

  const cellDeg = computeSafeSpatialCellDeg(maxDistanceMeters);
  const maxDistanceKm = maxDistanceMeters / 1000;
  const maxLatDiffDeg = (maxDistanceMeters / 110_500) * 1.05;

  const edges: CandidateMultiOpEdge[] = [];
  const grid = new Map<number, number[]>();

  for (let i = 0; i < n; i++) {
    const rec = records[i];
    const row = Math.floor((rec.lat + 90) / cellDeg);
    const col = Math.floor((rec.lon + 180) / cellDeg);

    for (let dRow = -1; dRow <= 1; dRow++) {
      const neighborRowBase = (row + dRow) * GRID_COL_STRIDE;
      for (let dCol = -1; dCol <= 1; dCol++) {
        const bucket = grid.get(neighborRowBase + (col + dCol));
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          const j = bucket[k];
          const candidate = records[j];
          // Solo generamos aristas entre operadores distintos; dos antenas del mismo operador
          // (en particular Telefónica/Movistar) jamás se auto-fusionan en esta fase.
          if (rec.op === candidate.op) {
            continue;
          }
          if (Math.abs(rec.lat - candidate.lat) > maxLatDiffDeg) {
            continue;
          }
          const distKm = haversineDistanceKm(
            rec.lat,
            rec.lon,
            candidate.lat,
            candidate.lon,
          );
          if (distKm < maxDistanceKm) {
            edges.push({ u: j, v: i, distKm });
          }
        }
      }
    }

    const ownKey = row * GRID_COL_STRIDE + col;
    const ownBucket = grid.get(ownKey);
    if (ownBucket) {
      ownBucket.push(i);
    } else {
      grid.set(ownKey, [i]);
    }
  }

  if (edges.length === 0) {
    return records.map((_, idx) => [idx]);
  }

  edges.sort((a, b) => {
    const distDiff = a.distKm - b.distKm;
    if (distDiff !== 0) return distDiff;

    const aIdU = records[a.u].id;
    const aIdV = records[a.v].id;
    const aMinId = aIdU < aIdV ? aIdU : aIdV;
    const aMaxId = aIdU < aIdV ? aIdV : aIdU;

    const bIdU = records[b.u].id;
    const bIdV = records[b.v].id;
    const bMinId = bIdU < bIdV ? bIdU : bIdV;
    const bMaxId = bIdU < bIdV ? bIdV : bIdU;

    if (aMinId !== bMinId) return aMinId < bMinId ? -1 : 1;
    if (aMaxId !== bMaxId) return aMaxId < bMaxId ? -1 : 1;
    if (a.u !== b.u) return a.u - b.u;
    return a.v - b.v;
  });

  const parent = new Int32Array(n);
  const hasMovistar = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    parent[i] = i;
    hasMovistar[i] = records[i].op === 'movistar' ? 1 : 0;
  }

  const groupMembers = new Map<number, number[]>();

  const find = (x: number): number => {
    let curr = x;
    while (parent[curr] !== curr) {
      parent[curr] = parent[parent[curr]];
      curr = parent[curr];
    }
    return curr;
  };

  for (let e = 0; e < edges.length; e++) {
    const edge = edges[e];
    const rootA = find(edge.u);
    const rootB = find(edge.v);
    if (rootA === rootB) continue;

    // Regla estricta de Telefónica: nunca unir dos grupos que ya contengan `movistar`
    if (hasMovistar[rootA] === 1 && hasMovistar[rootB] === 1) {
      continue;
    }

    const membersA = groupMembers.get(rootA);
    const membersB = groupMembers.get(rootB);

    // Enlace completo `< maxDistanceMeters` entre todos los miembros de A y todos los de B
    let allWithinThreshold = true;
    if (membersA !== undefined || membersB !== undefined) {
      const listA = membersA ?? [rootA];
      const listB = membersB ?? [rootB];

      for (let ia = 0; ia < listA.length && allWithinThreshold; ia++) {
        const idxA = listA[ia];
        const recA = records[idxA];
        for (let ib = 0; ib < listB.length; ib++) {
          const idxB = listB[ib];
          if (
            (idxA === edge.u && idxB === edge.v) ||
            (idxA === edge.v && idxB === edge.u)
          ) {
            continue;
          }
          const recB = records[idxB];
          if (Math.abs(recA.lat - recB.lat) > maxLatDiffDeg) {
            allWithinThreshold = false;
            break;
          }
          if (
            haversineDistanceKm(recA.lat, recA.lon, recB.lat, recB.lon) >=
            maxDistanceKm
          ) {
            allWithinThreshold = false;
            break;
          }
        }
      }
    }

    if (!allWithinThreshold) {
      continue;
    }

    const lenA = membersA ? membersA.length : 1;
    const lenB = membersB ? membersB.length : 1;

    let targetRoot = rootA;
    let sourceRoot = rootB;
    if (lenA < lenB || (lenA === lenB && rootB < rootA)) {
      targetRoot = rootB;
      sourceRoot = rootA;
    }

    parent[sourceRoot] = targetRoot;
    if (hasMovistar[sourceRoot] === 1) {
      hasMovistar[targetRoot] = 1;
    }

    let targetList = groupMembers.get(targetRoot);
    if (!targetList) {
      targetList = [targetRoot];
      groupMembers.set(targetRoot, targetList);
    }
    const sourceList = groupMembers.get(sourceRoot);
    if (sourceList) {
      for (let s = 0; s < sourceList.length; s++) {
        targetList.push(sourceList[s]);
      }
      groupMembers.delete(sourceRoot);
    } else {
      targetList.push(sourceRoot);
    }
  }

  const emittedRoots = new Uint8Array(n);
  const result: number[][] = [];
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (emittedRoots[root] === 1) continue;
    emittedRoots[root] = 1;
    const list = groupMembers.get(root);
    if (list) {
      list.sort((a, b) => a - b);
      result.push(list);
    } else {
      result.push([root]);
    }
  }

  return result;
}

function normalizeMapBandLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^2[67](?:[.,]\d+)?\s*[mg]hz$/i.test(trimmed)) {
    return '26 GHz';
  }
  const mhzMatch = /^(\d+(?:[.,]\d+)?)\s*mhz$/i.exec(trimmed);
  if (mhzMatch) {
    return `${mhzMatch[1]} MHz`;
  }
  const ghzMatch = /^(\d+(?:[.,]\d+)?)\s*ghz$/i.exec(trimmed);
  if (ghzMatch) {
    return `${ghzMatch[1]} GHz`;
  }
  return trimmed;
}

function parseMapBandMhzWeight(label: string): number {
  const normalized = normalizeMapBandLabel(label);
  const match = /(\d+(?:[.,]\d+)?)/.exec(normalized);
  if (!match) return Number.POSITIVE_INFINITY;
  const num = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(num)) return Number.POSITIVE_INFINITY;
  return /ghz/i.test(normalized) ? num * 1000 : num;
}

function compareMapBandLabels(a: string, b: string): number {
  const diff = parseMapBandMhzWeight(a) - parseMapBandMhzWeight(b);
  if (diff !== 0) return diff;
  return a.localeCompare(b, 'es', { numeric: true });
}

function parseMapFreqBounds(raw: string): [number, number] {
  const nums =
    raw.match(/\d+(?:[.,]\d+)?/g)?.map((n) => Number(n.replace(',', '.'))) ?? [];
  const rawStart = nums[0];
  if (rawStart === undefined || !Number.isFinite(rawStart)) {
    return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  }
  const rawEnd =
    nums[1] !== undefined && Number.isFinite(nums[1]) ? nums[1] : rawStart;
  const lo = Math.min(rawStart, rawEnd);
  const hi = Math.max(rawStart, rawEnd);
  const scaleToMhz =
    (lo >= 24 && hi <= 29.5) || (/ghz/i.test(raw) && hi < 100);
  return scaleToMhz ? [rawStart * 1000, rawEnd * 1000] : [rawStart, rawEnd];
}

function compareMapFreqRanges(a: string, b: string): number {
  const [startA, endA] = parseMapFreqBounds(a);
  const [startB, endB] = parseMapFreqBounds(b);
  if (startA !== startB) return startA - startB;
  if (endA !== endB) return endA - endB;
  return a.localeCompare(b, 'es', { numeric: true });
}

function countMapRedundantLeadingZeros(gid: string): number {
  if (gid.length <= 1) return 0;
  let zeros = 0;
  while (zeros < gid.length - 1 && gid.charCodeAt(zeros) === 48) {
    zeros++;
  }
  return zeros;
}

function compareMapExactCoordCanonical(
  a: AntennaRecord,
  b: AntennaRecord,
): number {
  const effOp = normalizeOperatorKeyInput(a.op, a.opRaw) ?? a.op;
  if (effOp === 'orange') {
    const aXfera =
      (a.op as string) === 'masmovil' || isXferaLegalEntity(a.opRaw) ? 1 : 0;
    const bXfera =
      (b.op as string) === 'masmovil' || isXferaLegalEntity(b.opRaw) ? 1 : 0;
    if (aXfera !== bXfera) return aXfera - bXfera;
  }

  const aGid = a.gid.trim();
  const bGid = b.gid.trim();
  const aEmpty = aGid.length === 0 ? 1 : 0;
  const bEmpty = bGid.length === 0 ? 1 : 0;
  if (aEmpty !== bEmpty) return aEmpty - bEmpty;

  if (effOp === 'vodafone') {
    const aZeros = countMapRedundantLeadingZeros(aGid);
    const bZeros = countMapRedundantLeadingZeros(bGid);
    if (aZeros !== bZeros) return aZeros - bZeros;
  }

  const aHasDir = a.dir.trim().length > 0 ? 1 : 0;
  const bHasDir = b.dir.trim().length > 0 ? 1 : 0;
  const aHasMun = a.mun.trim().length > 0 ? 1 : 0;
  const bHasMun = b.mun.trim().length > 0 ? 1 : 0;
  const aProv = a.prov.trim();
  const bProv = b.prov.trim();
  const aHasProv = aProv.length > 0 && aProv !== 'SIN PROVINCIA' ? 1 : 0;
  const bHasProv = bProv.length > 0 && bProv !== 'SIN PROVINCIA' ? 1 : 0;

  const aComp = aHasDir + aHasMun + aHasProv;
  const bComp = bHasDir + bHasMun + bHasProv;
  if (aComp !== bComp) return bComp - aComp;

  if (aHasDir !== bHasDir) return bHasDir - aHasDir;
  if (aHasMun !== bHasMun) return bHasMun - aHasMun;
  if (aHasProv !== bHasProv) return bHasProv - aHasProv;

  if (aGid !== bGid) return aGid < bGid ? -1 : 1;
  const aId = a.id.trim();
  const bId = b.id.trim();
  if (aId !== bId) return aId < bId ? -1 : 1;
  return 0;
}

function mergeRfFieldsFromMembers(
  sorted: readonly AntennaRecord[],
  target: AntennaRecord,
): void {
  let anyHasBandas = false;
  const seenBandas = new Set<string>();
  let anyHasFrecuencias = false;
  const seenFrecuencias = new Set<string>();
  let anyHasConcesiones = false;
  const seenConcesionKeys = new Set<string>();
  const mergedConcesiones: ConcesionBanda[] = [];
  let latestScannedAt: string | undefined;
  let latestScannedMs = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i];
    if (Array.isArray(item.bandas)) {
      anyHasBandas = true;
      for (let b = 0; b < item.bandas.length; b++) {
        const norm = normalizeMapBandLabel(item.bandas[b]);
        if (norm) seenBandas.add(norm);
      }
    }
    if (Array.isArray(item.frecuencias)) {
      anyHasFrecuencias = true;
      for (let f = 0; f < item.frecuencias.length; f++) {
        const trimmed = item.frecuencias[f].trim();
        if (trimmed) seenFrecuencias.add(trimmed);
      }
    }
    if (Array.isArray(item.concesiones)) {
      anyHasConcesiones = true;
      for (let c = 0; c < item.concesiones.length; c++) {
        const conc = item.concesiones[c];
        const ref = conc.ref.trim();
        const freq = conc.freq.trim();
        if (!ref && !freq) continue;
        const key = `${ref}|${freq}`;
        if (!seenConcesionKeys.has(key)) {
          seenConcesionKeys.add(key);
          mergedConcesiones.push({ ref, freq });
        }
      }
    }
    if (typeof item.bandsScannedAt === 'string') {
      const candidate = item.bandsScannedAt.trim();
      if (candidate) {
        const ms = Date.parse(candidate);
        if (Number.isFinite(ms)) {
          if (ms > latestScannedMs) {
            latestScannedMs = ms;
            latestScannedAt = candidate;
          }
        } else if (
          latestScannedAt === undefined ||
          (latestScannedMs === Number.NEGATIVE_INFINITY &&
            candidate > latestScannedAt)
        ) {
          latestScannedAt = candidate;
        }
      }
    }
  }

  if (anyHasBandas) {
    target.bandas = Array.from(seenBandas).sort(compareMapBandLabels);
  }
  if (anyHasFrecuencias) {
    target.frecuencias = Array.from(seenFrecuencias).sort(compareMapFreqRanges);
  }
  if (anyHasConcesiones) {
    target.concesiones = mergedConcesiones.sort(
      (a, b) =>
        compareMapFreqRanges(a.freq, b.freq) ||
        a.ref.localeCompare(b.ref, 'es', { numeric: true }),
    );
  }
  if (latestScannedAt !== undefined) {
    target.bandsScannedAt = latestScannedAt;
  }
}

function fuseVodafoneGroup(group: AntennaRecord[]): AntennaRecord {
  const sorted = [...group].sort((a, b) => {
    const gidCmp = a.gid.localeCompare(b.gid, 'es');
    return gidCmp !== 0 ? gidCmp : a.id.localeCompare(b.id, 'es');
  });

  let sumLat = 0;
  let sumLon = 0;
  const seenGids = new Set<string>();
  const mergedGids: string[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i];
    sumLat += item.lat;
    sumLon += item.lon;
    const gids =
      item.mergedGids && item.mergedGids.length > 0
        ? item.mergedGids
        : [item.gid];
    for (let g = 0; g < gids.length; g++) {
      if (!seenGids.has(gids[g])) {
        seenGids.add(gids[g]);
        mergedGids.push(gids[g]);
      }
    }
  }

  const fused: AntennaRecord = {
    ...sorted[0],
    lat: sumLat / sorted.length,
    lon: sumLon / sorted.length,
    mergedGids: mergedGids.length > 1 ? mergedGids : sorted[0].mergedGids,
  };
  mergeRfFieldsFromMembers(sorted, fused);
  return fused;
}

function fuseExactCoordSameOperatorGroup(group: AntennaRecord[]): AntennaRecord {
  const sorted = [...group].sort(compareMapExactCoordCanonical);
  const normalizedOp =
    normalizeOperatorKeyInput(sorted[0].op, sorted[0].opRaw) ?? sorted[0].op;
  const fused: AntennaRecord = {
    ...sorted[0],
    op: normalizedOp,
  };

  for (let i = 1; i < sorted.length; i++) {
    const cand = sorted[i];
    if (!fused.gid.trim() && cand.gid.trim()) {
      fused.gid = cand.gid;
    }
    if (!fused.dir.trim() && cand.dir.trim()) {
      fused.dir = cand.dir;
    }
    if (!fused.mun.trim() && cand.mun.trim()) {
      fused.mun = cand.mun;
    }
    const curProv = fused.prov.trim();
    const candProv = cand.prov.trim();
    if (
      (!curProv || curProv === 'SIN PROVINCIA') &&
      candProv &&
      candProv !== 'SIN PROVINCIA'
    ) {
      fused.prov = cand.prov;
    } else if (!curProv && candProv) {
      fused.prov = cand.prov;
    }
  }

  const seenGids = new Set<string>();
  const mergedGids: string[] = [];
  let anyMemberHadMergedGids = false;

  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i];
    const mgid = item.gid.trim();
    if (mgid && !seenGids.has(mgid)) {
      seenGids.add(mgid);
      mergedGids.push(mgid);
    }
    if (item.mergedGids !== undefined) {
      anyMemberHadMergedGids = true;
      for (let g = 0; g < item.mergedGids.length; g++) {
        const eg = item.mergedGids[g].trim();
        if (eg && !seenGids.has(eg)) {
          seenGids.add(eg);
          mergedGids.push(eg);
        }
      }
    }
  }

  if (mergedGids.length > 1 || (anyMemberHadMergedGids && mergedGids.length > 0)) {
    fused.mergedGids = mergedGids;
  } else {
    delete fused.mergedGids;
  }

  mergeRfFieldsFromMembers(sorted, fused);
  return fused;
}

/**
 * Agrupa las antenas colocalizadas para su representación en MapLibre:
 * - Fusiona de forma defensiva registros residuales de Vodafone a `< 35 m`
 *   (`Math.max(maxDistanceMeters, VODAFONE_DEFENSIVE_FUSION_METERS)` cuando `maxDistanceMeters > 0`).
 * - Fusiona de forma defensiva declaraciones duplicadas de cualquier misma operadora
 *   (incluyendo Orange y Telefónica/Movistar) situadas en la MISMA coordenada exacta `(lat, lon)`,
 *   EXCEPTO cuando 2 o más antenas de Telefónica disponen cada una de banda N78 (3500 MHz).
 * - Agrupa en 1 único `MapSiteEntry` multicolor antenas de `>= 2` operadores distintos situadas
 *   a `< maxDistanceMeters` (`15 m` por defecto, `MULTI_OPERATOR_SITE_MAX_DISTANCE_METERS`) mediante
 *   enlace completo en orden de distancia creciente.
 * - Las antenas de Telefónica (`movistar`) en coordenadas distintas (`> 0 m`), o en la misma
 *   coordenada cuando cada una dispone de banda N78, NUNCA se fusionan entre sí, ni directamente
 *   ni de forma transitiva a través de otro operador.
 */
export function groupColocatedAntennasForMap(
  antenas: AntennaRecord[],
  maxDistanceMeters = MULTI_OPERATOR_SITE_MAX_DISTANCE_METERS,
): MapSiteEntry[] {
  const valid: AntennaRecord[] = [];
  for (let i = 0; i < antenas.length; i++) {
    const ant = antenas[i];
    if (Number.isFinite(ant.lat) && Number.isFinite(ant.lon)) {
      valid.push(ant);
    }
  }

  if (valid.length === 0) {
    return [];
  }

  // 1. Pase defensivo para garantizar que registros residuales de Vodafone a < 35 m
  //    (Math.max(maxDistanceMeters, VODAFONE_DEFENSIVE_FUSION_METERS)) representen siempre
  //    una única antena antes de agrupar entre operadores.
  const vodafoneRecords: AntennaRecord[] = [];
  const vodafoneOriginalIndices: number[] = [];
  for (let i = 0; i < valid.length; i++) {
    if (valid[i].op === 'vodafone') {
      vodafoneRecords.push(valid[i]);
      vodafoneOriginalIndices.push(i);
    }
  }

  let normalizedRecords = valid;
  let extraMergedIdsByPrimaryId: Map<string, string[]> | null = null;

  if (vodafoneRecords.length >= 2 && maxDistanceMeters > 0) {
    const vodafoneComponents = clusterConnectedIndicesByDistance(
      vodafoneRecords,
      Math.max(maxDistanceMeters, VODAFONE_DEFENSIVE_FUSION_METERS),
    );
    const hasResidualDuplicates = vodafoneComponents.some(
      (comp) => comp.length >= 2,
    );

    if (hasResidualDuplicates) {
      const replacementAtValidIdx = new Map<number, AntennaRecord>();
      const skipValidIdx = new Set<number>();
      extraMergedIdsByPrimaryId = new Map<string, string[]>();

      for (let c = 0; c < vodafoneComponents.length; c++) {
        const comp = vodafoneComponents[c];
        if (comp.length < 2) continue;

        const group = comp.map((vIdx) => vodafoneRecords[vIdx]);
        const fused = fuseVodafoneGroup(group);
        const firstValidIdx = vodafoneOriginalIndices[comp[0]];
        replacementAtValidIdx.set(firstValidIdx, fused);
        extraMergedIdsByPrimaryId.set(
          fused.id,
          group.map((item) => item.id),
        );

        for (let k = 1; k < comp.length; k++) {
          skipValidIdx.add(vodafoneOriginalIndices[comp[k]]);
        }
      }

      normalizedRecords = [];
      for (let i = 0; i < valid.length; i++) {
        if (skipValidIdx.has(i)) continue;
        normalizedRecords.push(replacementAtValidIdx.get(i) ?? valid[i]);
      }
    }
  }

  // 1b. Pase defensivo de misma coordenada exacta para cualquier operadora (incluido Orange y Telefónica, salvo parejas Telefónica con N78 en cada una).
  if (normalizedRecords.length >= 2) {
    const firstIdxByKey = new Map<string, number>();
    let duplicateGroups: Map<string, number[]> | null = null;
    for (let i = 0; i < normalizedRecords.length; i++) {
      const key = buildSameOperatorExactCoordKey(normalizedRecords[i]);
      if (key === null) continue;
      const firstIdx = firstIdxByKey.get(key);
      if (firstIdx !== undefined) {
        if (duplicateGroups === null) {
          duplicateGroups = new Map<string, number[]>();
        }
        let bucket = duplicateGroups.get(key);
        if (!bucket) {
          bucket = [firstIdx, i];
          duplicateGroups.set(key, bucket);
        } else {
          bucket.push(i);
        }
      } else {
        firstIdxByKey.set(key, i);
      }
    }

    if (duplicateGroups !== null) {
      const replacementAtNormIdx = new Map<number, AntennaRecord>();
      const skipNormIdx = new Set<number>();

      for (const indices of duplicateGroups.values()) {
        const group = indices.map((idx) => normalizedRecords[idx]);
        if (shouldSkipExactCoordSameOperatorFusion(group)) {
          continue;
        }
        if (!extraMergedIdsByPrimaryId) {
          extraMergedIdsByPrimaryId = new Map<string, string[]>();
        }
        const fused = fuseExactCoordSameOperatorGroup(group);
        replacementAtNormIdx.set(indices[0], fused);

        const coveredIds: string[] = [];
        for (let g = 0; g < group.length; g++) {
          const prevExpanded = extraMergedIdsByPrimaryId.get(group[g].id);
          if (prevExpanded) {
            coveredIds.push(...prevExpanded);
          } else {
            coveredIds.push(group[g].id);
          }
        }
        extraMergedIdsByPrimaryId.set(fused.id, coveredIds);

        for (let k = 1; k < indices.length; k++) {
          skipNormIdx.add(indices[k]);
        }
      }

      if (skipNormIdx.size > 0) {
        const dedupedRecords: AntennaRecord[] = [];
        for (let i = 0; i < normalizedRecords.length; i++) {
          if (skipNormIdx.has(i)) continue;
          dedupedRecords.push(
            replacementAtNormIdx.get(i) ?? normalizedRecords[i],
          );
        }
        normalizedRecords = dedupedRecords;
      }
    }
  }

  // 2. Agrupación multi-operador a < maxDistanceMeters (15 m por defecto) con enlace completo y restricción estricta de Telefónica.
  const components = clusterMultiOperatorSitesByCompleteLinkage(
    normalizedRecords,
    maxDistanceMeters,
  );
  const sites: MapSiteEntry[] = [];

  for (let c = 0; c < components.length; c++) {
    const compIndices = components[c];

    if (compIndices.length === 1) {
      const ant = normalizedRecords[compIndices[0]];
      const memberIds = extraMergedIdsByPrimaryId?.get(ant.id) ?? [ant.id];
      sites.push({
        siteId: ant.id,
        lat: ant.lat,
        lon: ant.lon,
        isMultiOperator: false,
        operators: [ant.op],
        members: [ant],
        memberIds,
        primary: ant,
        iconKey: `single:${ant.op}`,
      });
      continue;
    }

    const members = compIndices.map((idx) => normalizedRecords[idx]);
    members.sort((a, b) => {
      const opDiff = OPERATOR_RANK[a.op] - OPERATOR_RANK[b.op];
      if (opDiff !== 0) return opDiff;
      const gidDiff = a.gid.localeCompare(b.gid, 'es');
      if (gidDiff !== 0) return gidDiff;
      return a.id.localeCompare(b.id, 'es');
    });

    const operators: OperatorKey[] = [];
    for (let k = 0; k < members.length; k++) {
      const op = members[k].op;
      if (operators.length === 0 || operators[operators.length - 1] !== op) {
        operators.push(op);
      }
    }

    if (operators.length >= 2) {
      let sumLat = 0;
      let sumLon = 0;
      const memberIds: string[] = [];

      for (let k = 0; k < members.length; k++) {
        const m = members[k];
        sumLat += m.lat;
        sumLon += m.lon;
        const expanded = extraMergedIdsByPrimaryId?.get(m.id);
        if (expanded) {
          for (let e = 0; e < expanded.length; e++) {
            memberIds.push(expanded[e]);
          }
        } else {
          memberIds.push(m.id);
        }
      }

      const primary = members[0];
      sites.push({
        siteId: `site:${members.map((m) => m.id).join('||')}`,
        lat: sumLat / members.length,
        lon: sumLon / members.length,
        isMultiOperator: true,
        operators,
        members,
        memberIds,
        primary,
        iconKey: `multi:${operators.join('|')}`,
      });
    } else if (operators[0] === 'vodafone') {
      const fused = fuseVodafoneGroup(members);
      const memberIds: string[] = [];
      for (let k = 0; k < members.length; k++) {
        const expanded = extraMergedIdsByPrimaryId?.get(members[k].id);
        if (expanded) {
          memberIds.push(...expanded);
        } else {
          memberIds.push(members[k].id);
        }
      }
      sites.push({
        siteId: fused.id,
        lat: fused.lat,
        lon: fused.lon,
        isMultiOperator: false,
        operators: ['vodafone'],
        members: [fused],
        memberIds,
        primary: fused,
        iconKey: 'single:vodafone',
      });
    } else {
      for (let k = 0; k < compIndices.length; k++) {
        const ant = normalizedRecords[compIndices[k]];
        sites.push({
          siteId: ant.id,
          lat: ant.lat,
          lon: ant.lon,
          isMultiOperator: false,
          operators: [ant.op],
          members: [ant],
          memberIds: [ant.id],
          primary: ant,
          iconKey: `single:${ant.op}`,
        });
      }
    }
  }

  return sites;
}

