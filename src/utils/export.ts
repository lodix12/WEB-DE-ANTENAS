import type { FeatureCollection, Point } from 'geojson';
import {
  getDetalleEstacionUrl,
  OPERATOR_META,
  type AntennaRecord,
} from '../types/antena';
import type { RadarPoint } from '../types/map';
import {
  bearingToCardinal,
  calculateBearingDeg,
  haversineDistanceKm,
} from './geo';

/**
 * Normaliza cadenas para búsqueda instantánea sin tildes ni distinción de mayúsculas.
 */
export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Detecta si el texto introducido corresponde a coordenadas WGS84 (ej. "40.4168, -3.7038").
 */
export function parseCoordinateInput(
  raw: string,
): { lat: number; lon: number } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Formato estándar: "40.4168, -3.7038" o "40.4168 -3.7038" o "40,4168; -3,7038"
  const match =
    /^([+-]?\d{1,2}(?:\.\d+))\s*[,;\s]\s*([+-]?\d{1,3}(?:\.\d+))$/.exec(
      trimmed,
    ) ??
    /^([+-]?\d{1,2}(?:,\d+))\s*[;\s]\s*([+-]?\d{1,3}(?:,\d+))$/.exec(trimmed);

  if (!match) return null;

  const lat = Number(match[1].replace(',', '.'));
  const lon = Number(match[2].replace(',', '.'));

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  return { lat, lon };
}

/**
 * Formatea una fecha ISO 8601 en español legible.
 */
export function formatDateTimeEs(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  return new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * Devuelve una marca relativa en español ("hace 2 h", "hoy", "hace 1 día").
 */
export function formatRelativeDateEs(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';

  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  const rtf = new Intl.RelativeTimeFormat('es-ES', { numeric: 'auto' });

  if (absSeconds < 60) return 'hace instantes';
  if (absSeconds < 3600) {
    return rtf.format(Math.round(diffSeconds / 60), 'minute');
  }
  if (absSeconds < 86400) {
    return rtf.format(Math.round(diffSeconds / 3600), 'hour');
  }
  return rtf.format(Math.round(diffSeconds / 86400), 'day');
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function escapeCsvCell(value: string | number): string {
  const str = String(value);
  if (/[",\n\r;]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildDateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface ExportedAntennaJsonItem extends AntennaRecord {
  operador: string;
  fichaMinetur: string;
  distanciaMetros?: number;
  acimutGrados?: number;
  rumboCardinal?: string;
}

export interface CustomAntenasJsonExport {
  updatedAt: string;
  source: 'RadioMapa España';
  total: number;
  radarPoint?: {
    lat: number;
    lon: number;
    label?: string;
    radiusKm?: number;
  };
  antenas: ExportedAntennaJsonItem[];
}

/**
 * Construye el objeto de exportación en el esquema JSON propio limpio de RadioMapa.
 */
export function buildCustomJsonExportPayload(
  antenas: AntennaRecord[],
  radarPoint?: RadarPoint | null,
): CustomAntenasJsonExport {
  const items: ExportedAntennaJsonItem[] = antenas.map((ant) => {
    const baseItem: ExportedAntennaJsonItem = {
      ...ant,
      operador: OPERATOR_META[ant.op].shortName,
      fichaMinetur: getDetalleEstacionUrl(ant),
    };

    if (radarPoint) {
      const distKm = haversineDistanceKm(
        radarPoint.lat,
        radarPoint.lon,
        ant.lat,
        ant.lon,
      );
      const bearing = calculateBearingDeg(
        radarPoint.lat,
        radarPoint.lon,
        ant.lat,
        ant.lon,
      );
      baseItem.distanciaMetros = Math.round(distKm * 1000);
      baseItem.acimutGrados = Math.round(bearing);
      baseItem.rumboCardinal = bearingToCardinal(bearing);
    }

    return baseItem;
  });

  const payload: CustomAntenasJsonExport = {
    updatedAt: new Date().toISOString(),
    source: 'RadioMapa España',
    total: items.length,
    ...(radarPoint
      ? {
          radarPoint: {
            lat: radarPoint.lat,
            lon: radarPoint.lon,
            ...(radarPoint.label !== undefined ? { label: radarPoint.label } : {}),
            ...(radarPoint.radiusKm !== undefined
              ? { radiusKm: radarPoint.radiusKm }
              : {}),
          },
        }
      : {}),
    antenas: items,
  };

  return payload;
}

/**
 * Descarga las antenas filtradas en el esquema JSON propio de RadioMapa (.json).
 */
export function exportAntenasToJSON(
  antenas: AntennaRecord[],
  radarPoint?: RadarPoint | null,
  filenamePrefix = 'radiomapa-antenas-espana',
): void {
  const payload = buildCustomJsonExportPayload(antenas, radarPoint);
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  triggerBlobDownload(blob, `${filenamePrefix}-${buildDateStamp()}.json`);
}

/**
 * Descarga las antenas filtradas en formato GeoJSON (.geojson) como opción
 * secundaria de compatibilidad para software SIG externo (QGIS / ArcGIS).
 */
export function exportAntenasToGeoJSON(
  antenas: AntennaRecord[],
  filenamePrefix = 'radiomapa-antenas-espana',
): void {
  const collection: FeatureCollection<Point> = {
    type: 'FeatureCollection',
    features: antenas.map((ant) => ({
      type: 'Feature',
      id: ant.gid,
      geometry: {
        type: 'Point',
        coordinates: [ant.lon, ant.lat],
      },
      properties: {
        id: ant.id,
        gid: ant.gid,
        operadorClave: ant.op,
        operador: OPERATOR_META[ant.op].shortName,
        razonSocial: ant.opRaw,
        direccion: ant.dir,
        municipio: ant.mun,
        provincia: ant.prov,
        fichaMinetur: getDetalleEstacionUrl(ant),
      },
    })),
  };

  const blob = new Blob([JSON.stringify(collection, null, 2)], {
    type: 'application/geo+json;charset=utf-8',
  });
  triggerBlobDownload(blob, `${filenamePrefix}-${buildDateStamp()}.geojson`);
}

/**
 * Descarga las antenas filtradas como archivo CSV compatible con Excel (UTF-8 con BOM).
 */
export function exportAntenasToCSV(
  antenas: AntennaRecord[],
  radarPoint?: RadarPoint | null,
  filenamePrefix = 'radiomapa-antenas-espana',
): void {
  const headers = [
    'Gis_ID',
    'Identificador_Oficial',
    'Operador',
    'Razon_Social',
    'Provincia',
    'Municipio',
    'Direccion',
    'Latitud_WGS84',
    'Longitud_WGS84',
    ...(radarPoint
      ? ['Distancia_Metros', 'Acimut_Grados', 'Rumbo_Cardinal']
      : []),
    'URL_Ficha_MINETUR',
  ];

  const lines: string[] = [headers.join(',')];

  for (let i = 0; i < antenas.length; i++) {
    const ant = antenas[i];
    const row: Array<string | number> = [
      ant.gid,
      ant.id,
      OPERATOR_META[ant.op].shortName,
      ant.opRaw,
      ant.prov,
      ant.mun,
      ant.dir,
      ant.lat.toFixed(6),
      ant.lon.toFixed(6),
    ];

    if (radarPoint) {
      const distKm = haversineDistanceKm(
        radarPoint.lat,
        radarPoint.lon,
        ant.lat,
        ant.lon,
      );
      const bearing = calculateBearingDeg(
        radarPoint.lat,
        radarPoint.lon,
        ant.lat,
        ant.lon,
      );
      row.push(
        Math.round(distKm * 1000),
        Math.round(bearing),
        bearingToCardinal(bearing),
      );
    }

    row.push(getDetalleEstacionUrl(ant));
    lines.push(row.map(escapeCsvCell).join(','));
  }

  // Incluir BOM UTF-8 (\uFEFF) para correcta visualización de acentos y 'ñ' en Excel
  const csvContent = `\uFEFF${lines.join('\r\n')}`;
  const blob = new Blob([csvContent], {
    type: 'text/csv;charset=utf-8',
  });
  triggerBlobDownload(blob, `${filenamePrefix}-${buildDateStamp()}.csv`);
}
