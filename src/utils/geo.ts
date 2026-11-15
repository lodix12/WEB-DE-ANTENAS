import type { Feature, Polygon } from 'geojson';
import {
  OPERATOR_ORDER,
  type AntennaRecord,
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

export interface MapSiteEntry {
  /** Identificador único determinista del marcador en el mapa */
  siteId: string;
  /** Latitud WGS84 del marcador (centroide en emplazamientos agrupados) */
  lat: number;
  /** Longitud WGS84 del marcador (centroide en emplazamientos agrupados) */
  lon: number;
  /** `true` cuando agrupa antenas de >= 2 operadores distintos a < 5 m */
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

function clusterConnectedIndicesByDistance(
  records: AntennaRecord[],
  maxDistanceMeters: number,
): number[][] {
  const n = records.length;
  if (n === 0) return [];
  if (n === 1 || maxDistanceMeters <= 0) {
    return records.map((_, idx) => [idx]);
  }

  // `cellDeg = 0.0001` (~11.1 m en latitud, ~8.0 m en longitud a 44°N) para < 5 m,
  // escalando automáticamente si se solicita un umbral mayor (ej. 10 m en Vodafone).
  const cellDeg = Math.max(0.0001, maxDistanceMeters / 55_000);
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
    const gids = item.mergedGids && item.mergedGids.length > 0 ? item.mergedGids : [item.gid];
    for (let g = 0; g < gids.length; g++) {
      if (!seenGids.has(gids[g])) {
        seenGids.add(gids[g]);
        mergedGids.push(gids[g]);
      }
    }
  }

  return {
    ...sorted[0],
    lat: sumLat / sorted.length,
    lon: sumLon / sorted.length,
    mergedGids: mergedGids.length > 1 ? mergedGids : sorted[0].mergedGids,
  };
}

/**
 * Agrupa en tiempo lineal O(N) las antenas colocalizadas para su representación en MapLibre:
 * - Fusiona de forma defensiva registros residuales de Vodafone a `< 10 m` en una sola antena.
 * - Agrupa en 1 único `MapSiteEntry` multicolor todas las antenas situadas a `< maxDistanceMeters`
 *   (`< 5 m` por defecto) cuando pertenecen a `>= 2` operadores distintos.
 * - Si en una componente `< 5 m` solo figura 1 operador, mantiene cada estación individual.
 */
export function groupColocatedAntennasForMap(
  antenas: AntennaRecord[],
  maxDistanceMeters = 5,
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

  // 1. Pase defensivo O(N) para garantizar que registros residuales de Vodafone a < 10 m
  //    representen siempre una única antena antes de evaluar la agrupación multi-operador.
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

  if (vodafoneRecords.length >= 2) {
    const vodafoneComponents = clusterConnectedIndicesByDistance(
      vodafoneRecords,
      10,
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

  // 2. Malla espacial (`cellDeg = 0.0001`, ~11.1 m) + Union-Find para conectar estaciones a `< 5 m`.
  const components = clusterConnectedIndicesByDistance(
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

