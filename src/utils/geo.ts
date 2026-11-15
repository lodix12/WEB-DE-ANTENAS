import type { Feature, Polygon } from 'geojson';
import type { AntennaRecord } from '../types/antena';
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
