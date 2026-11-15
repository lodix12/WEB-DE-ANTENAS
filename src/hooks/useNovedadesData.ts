import { useQuery } from '@tanstack/react-query';
import {
  OPERATOR_META,
  OPERATOR_ORDER,
  type NovedadRecord,
  type NovedadTipo,
  type NovedadesDataset,
  type OperatorKey,
} from '../types/antena';
import { normalizeSearchText } from '../utils/export';

const VALID_OPERATORS = new Set<string>(OPERATOR_ORDER);
const VALID_NOVEDAD_TIPOS = new Set<string>(['antena', 'frecuencia']);
const DMY_HMS_REGEX = /^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}$/;

const MADRID_DMY_HMS_FORMATTER = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Formatea la marca temporal de escaneo en huso horario español (Europe/Madrid)
 * con el formato exacto "DD/MM/YYYY HH:MM:SS" (Día/Mes/Año y hora exacta 24h).
 */
export function formatScanDateTimeDmyHms(
  scannedAtIso: string,
  preformattedFecha?: string,
): string {
  if (typeof preformattedFecha === 'string') {
    const trimmed = preformattedFecha.trim();
    if (DMY_HMS_REGEX.test(trimmed)) {
      return trimmed.replace(/\s+/, ' ');
    }
  }

  const trimmedIso = scannedAtIso.trim();
  if (!trimmedIso) {
    return preformattedFecha?.trim() || '—';
  }

  const date = new Date(trimmedIso);
  if (Number.isNaN(date.getTime())) {
    return preformattedFecha?.trim() || trimmedIso;
  }

  const parts = MADRID_DMY_HMS_FORMATTER.formatToParts(date);
  let day = '';
  let month = '';
  let year = '';
  let hour = '';
  let minute = '';
  let second = '';

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    switch (part.type) {
      case 'day':
        day = part.value;
        break;
      case 'month':
        month = part.value;
        break;
      case 'year':
        year = part.value;
        break;
      case 'hour':
        hour = part.value === '24' ? '00' : part.value;
        break;
      case 'minute':
        minute = part.value;
        break;
      case 'second':
        second = part.value;
        break;
      default:
        break;
    }
  }

  if (!day || !month || !year || !hour || !minute || !second) {
    return preformattedFecha?.trim() || trimmedIso;
  }

  return `${day.padStart(2, '0')}/${month.padStart(2, '0')}/${year} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}`;
}

/**
 * Valida que el contenido cargado corresponda exclusivamente al esquema JSON
 * propio de novedades (`NovedadesDataset` en `data/novedades.json`) y rechaza
 * explícitamente colecciones o entidades GeoJSON (`FeatureCollection`).
 */
export function parseCustomNovedadesJson(raw: unknown): NovedadesDataset {
  if (!isPlainRecord(raw)) {
    throw new Error(
      'Formato inválido: se esperaba un objeto con el esquema JSON propio de novedades (data/novedades.json).',
    );
  }

  if (
    raw.type === 'FeatureCollection' ||
    raw.type === 'Feature' ||
    Array.isArray(raw.features)
  ) {
    throw new Error(
      'Formato GeoJSON (FeatureCollection) no admitido: RadioMapa requiere importar exclusivamente su esquema JSON propio (data/novedades.json) y no carga desde GeoJSON.',
    );
  }

  if (
    typeof raw.updatedAt !== 'string' ||
    typeof raw.scanId !== 'string' ||
    (raw.previousScanAt !== null && typeof raw.previousScanAt !== 'string') ||
    (raw.isBaselineScan !== undefined &&
      typeof raw.isBaselineScan !== 'boolean') ||
    typeof raw.total !== 'number' ||
    !Number.isFinite(raw.total) ||
    typeof raw.antenasNuevas !== 'number' ||
    !Number.isFinite(raw.antenasNuevas) ||
    typeof raw.frecuenciasNuevas !== 'number' ||
    !Number.isFinite(raw.frecuenciasNuevas) ||
    !Array.isArray(raw.novedades)
  ) {
    throw new Error(
      'Esquema JSON inválido: faltan propiedades obligatorias del formato propio NovedadesDataset (updatedAt, scanId, previousScanAt, total, antenasNuevas, frecuenciasNuevas, novedades).',
    );
  }

  const novedadesList = raw.novedades;
  for (let i = 0; i < novedadesList.length; i++) {
    const item: unknown = novedadesList[i];
    if (!isPlainRecord(item)) {
      throw new Error(
        `Registro inválido en novedades[${i}]: se esperaba un objeto NovedadRecord.`,
      );
    }
    if (item.type === 'Feature' || 'geometry' in item) {
      throw new Error(
        `Entidad GeoJSON detectada en novedades[${i}]: RadioMapa exige registros compactos del JSON propio y no admite GeoJSON.`,
      );
    }
    if (
      typeof item.id !== 'string' ||
      typeof item.tipo !== 'string' ||
      !VALID_NOVEDAD_TIPOS.has(item.tipo) ||
      typeof item.op !== 'string' ||
      !VALID_OPERATORS.has(item.op) ||
      typeof item.opRaw !== 'string' ||
      typeof item.codigo !== 'string' ||
      typeof item.antennaId !== 'string' ||
      typeof item.codigoBanda !== 'string' ||
      typeof item.frecuencia !== 'string' ||
      typeof item.ubicacion !== 'string' ||
      (item.prov !== undefined && typeof item.prov !== 'string') ||
      typeof item.scannedAt !== 'string' ||
      typeof item.fecha !== 'string'
    ) {
      throw new Error(
        `Registro incompleto en novedades[${i}]: debe cumplir el esquema NovedadRecord { id, tipo, op, opRaw, codigo, antennaId, codigoBanda, frecuencia, ubicacion, scannedAt, fecha }.`,
      );
    }
  }

  return raw as unknown as NovedadesDataset;
}

/**
 * Importa exclusivamente el archivo estático con esquema JSON propio (`data/novedades.json`).
 */
export async function importNovedadesJsonDataset(): Promise<NovedadesDataset> {
  const baseUrl = import.meta.env.BASE_URL || './';
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const response = await fetch(`${normalizedBase}data/novedades.json`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(
      `No se pudo importar el registro de novedades en JSON propio (HTTP ${response.status})`,
    );
  }
  const raw: unknown = await response.json();
  return parseCustomNovedadesJson(raw);
}

export const STANDARD_NOVEDADES_BANDS = [
  '700 MHz',
  '800 MHz',
  '900 MHz',
  '1800 MHz',
  '2100 MHz',
  '2600 MHz',
  '3500 MHz',
  '26 GHz',
] as const;

/**
 * Devuelve el color de fondo de la fila con el color oficial de la operadora
 * asociada y un 50% de transparencia exacta (alpha = 0.5).
 */
export function getOperatorRowBackground(op: OperatorKey, alpha = 0.5): string {
  const hex = (OPERATOR_META[op]?.color ?? OPERATOR_META.otros.color).replace(
    /^#/,
    '',
  );
  const normalized =
    hex.length === 3
      ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
      : hex;
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    return `rgba(100, 116, 139, ${alpha})`;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Clasifica un rango de frecuencias declarado en MINETUR (ej. "3460.00 - 3600.00 MHz")
 * en su banda comercial estándar en MHz/GHz para filtrado rápido.
 */
export function classifyFrequencyBandMhz(freqText: string): string | null {
  if (!freqText) return null;
  const matches = freqText.match(/\d+(?:[.,]\d+)?/g);
  if (!matches || matches.length === 0) return null;
  const nums = matches
    .map((n) => Number.parseFloat(n.replace(',', '.')))
    .filter((n) => Number.isFinite(n));
  if (nums.length === 0) return null;

  const isGhz = /ghz/i.test(freqText) && nums[0] < 100;
  const mhzValues = isGhz ? nums.map((n) => n * 1000) : nums;
  const mid =
    mhzValues.length >= 2
      ? (mhzValues[0] + mhzValues[1]) / 2
      : mhzValues[0];

  if (mid >= 690 && mid <= 790) return '700 MHz';
  if (mid > 790 && mid <= 865) return '800 MHz';
  if (mid >= 875 && mid <= 965) return '900 MHz';
  if (mid >= 1425 && mid <= 1520) return '1500 MHz';
  if (mid >= 1705 && mid <= 1885) return '1800 MHz';
  if (mid >= 1895 && mid <= 2205) return '2100 MHz';
  if (mid >= 2495 && mid <= 2695) return '2600 MHz';
  if (mid >= 3300 && mid <= 3850) return '3500 MHz';
  if (mid >= 24250 && mid <= 27500) return '26 GHz';
  return null;
}

/**
 * Extrae la parte de fecha "DD/MM/YYYY" de una fila de novedad.
 */
export function extractScanDayDmy(
  scannedAtIso: string,
  preformattedFecha?: string,
): string {
  const formatted = formatScanDateTimeDmyHms(scannedAtIso, preformattedFecha);
  const spaceIdx = formatted.indexOf(' ');
  return spaceIdx > 0 ? formatted.slice(0, spaceIdx) : formatted;
}

export interface NovedadesFilterInput {
  novedades: NovedadRecord[];
  tipoFilter: 'all' | NovedadTipo;
  operatorFilter: 'all' | OperatorKey;
  bandFilter?: string;
  locationFilter?: string;
  dateFilter?: string;
  searchQuery: string;
}

export function filterNovedades({
  novedades,
  tipoFilter,
  operatorFilter,
  bandFilter = 'all',
  locationFilter = 'all',
  dateFilter = 'all',
  searchQuery,
}: NovedadesFilterInput): NovedadRecord[] {
  const normalizedQuery = normalizeSearchText(searchQuery);
  const tokens = normalizedQuery
    ? normalizedQuery.split(/\s+/).filter(Boolean)
    : [];
  const activeBand = bandFilter && bandFilter !== 'all' ? bandFilter : '';
  const activeLocation =
    locationFilter && locationFilter !== 'all'
      ? normalizeSearchText(locationFilter)
      : '';
  const activeDate = dateFilter && dateFilter !== 'all' ? dateFilter : '';

  if (
    tipoFilter === 'all' &&
    operatorFilter === 'all' &&
    !activeBand &&
    !activeLocation &&
    !activeDate &&
    tokens.length === 0
  ) {
    return novedades;
  }

  const result: NovedadRecord[] = [];
  for (let i = 0; i < novedades.length; i++) {
    const row = novedades[i];
    if (tipoFilter !== 'all' && row.tipo !== tipoFilter) continue;
    if (operatorFilter !== 'all' && row.op !== operatorFilter) continue;

    if (activeBand) {
      if (row.tipo !== 'frecuencia') continue;
      const inferredBand = classifyFrequencyBandMhz(row.frecuencia);
      if (inferredBand !== activeBand) continue;
    }

    if (activeLocation) {
      const rowCity = normalizeSearchText(row.ubicacion);
      const rowProv = normalizeSearchText(row.prov ?? '');
      if (rowCity !== activeLocation && rowProv !== activeLocation) {
        continue;
      }
    }

    const formattedDate = formatScanDateTimeDmyHms(row.scannedAt, row.fecha);
    if (activeDate) {
      const dayPart = formattedDate.split(' ')[0] ?? '';
      if (dayPart !== activeDate) continue;
    }

    if (tokens.length > 0) {
      const meta = OPERATOR_META[row.op];
      const tipoLabel =
        row.tipo === 'antena' ? 'antena nueva' : 'frecuencia nueva';
      const inferredBand = classifyFrequencyBandMhz(row.frecuencia) ?? '';
      const haystack = normalizeSearchText(
        `${tipoLabel} ${meta.name} ${meta.shortName} ${row.opRaw} ${row.op} ${row.codigo} ${row.codigoBanda} ${row.frecuencia} ${inferredBand} ${row.ubicacion} ${row.prov ?? ''} ${formattedDate}`,
      );
      let matchesAll = true;
      for (let t = 0; t < tokens.length; t++) {
        if (!haystack.includes(tokens[t])) {
          matchesAll = false;
          break;
        }
      }
      if (!matchesAll) continue;
    }

    result.push(row);
  }

  return result;
}

export function useNovedadesData() {
  return useQuery({
    queryKey: ['novedades-dataset'],
    queryFn: importNovedadesJsonDataset,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 2,
  });
}
