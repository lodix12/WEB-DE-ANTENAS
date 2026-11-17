import { useMemo } from 'react';
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
import {
  useLiveScanDelta,
  type LiveScanMergedDelta,
} from './useScanProgress';

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

  return {
    ...(raw as unknown as NovedadesDataset),
    novedades: orderNovedadesGroupedByNewAntenna(
      (raw as { novedades: NovedadRecord[] }).novedades,
    ),
  };
}

/**
 * Importa exclusivamente el archivo estático con esquema JSON propio (`data/novedades.json`).
 */
export async function importNovedadesJsonDataset(): Promise<NovedadesDataset> {
  const baseUrl = import.meta.env.BASE_URL || './';
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const response = await fetch(`${normalizedBase}data/novedades.json`, {
    headers: { Accept: 'application/json' },
    cache: 'no-cache',
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

export const NOVEDADES_PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export type NovedadesPageSize = (typeof NOVEDADES_PAGE_SIZE_OPTIONS)[number];

export const DEFAULT_NOVEDADES_PAGE_SIZE: NovedadesPageSize = 25;

export type PaginationToken = number | 'ellipsis-start' | 'ellipsis-end';

export interface NovedadesPageSlice<T> {
  items: T[];
  currentPage: number;
  pageSize: NovedadesPageSize;
  totalItems: number;
  totalPages: number;
  startRow: number;
  endRow: number;
}

export function isValidNovedadesPageSize(
  value: number,
): value is NovedadesPageSize {
  return (NOVEDADES_PAGE_SIZE_OPTIONS as readonly number[]).includes(value);
}

/**
 * Construye los elementos de numeración de páginas manteniendo una ventana
 * estable de hasta 7 posiciones cuando existen más de 7 páginas totales.
 */
export function buildPaginationTokens(
  currentPage: number,
  totalPages: number,
): PaginationToken[] {
  const total = Math.max(1, Math.trunc(Number.isFinite(totalPages) ? totalPages : 1));
  const current = Math.min(
    Math.max(1, Math.trunc(Number.isFinite(currentPage) ? currentPage : 1)),
    total,
  );

  if (total <= 7) {
    const all: PaginationToken[] = [];
    for (let p = 1; p <= total; p++) {
      all.push(p);
    }
    return all;
  }

  if (current <= 4) {
    return [1, 2, 3, 4, 5, 'ellipsis-end', total];
  }

  if (current >= total - 3) {
    return [
      1,
      'ellipsis-start',
      total - 4,
      total - 3,
      total - 2,
      total - 1,
      total,
    ];
  }

  return [
    1,
    'ellipsis-start',
    current - 1,
    current,
    current + 1,
    'ellipsis-end',
    total,
  ];
}

/**
 * Calcula el segmento paginado de filas de novedades acotando siempre la página
 * solicitada al rango válido [1, totalPages].
 */
export function paginateNovedades<T>(
  rows: readonly T[],
  requestedPage: number,
  pageSize: NovedadesPageSize,
): NovedadesPageSlice<T> {
  const totalItems = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(
    Math.max(1, Math.trunc(Number.isFinite(requestedPage) ? requestedPage : 1)),
    totalPages,
  );

  if (totalItems === 0) {
    return {
      items: [],
      currentPage: 1,
      pageSize,
      totalItems: 0,
      totalPages: 1,
      startRow: 0,
      endRow: 0,
    };
  }

  const startIdx = (currentPage - 1) * pageSize;
  const endIdx = Math.min(startIdx + pageSize, totalItems);

  return {
    items: rows.slice(startIdx, endIdx),
    currentPage,
    pageSize,
    totalItems,
    totalPages,
    startRow: startIdx + 1,
    endRow: endIdx,
  };
}

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
  const trimmed = freqText.trim();
  if (!trimmed) return null;
  const matches = trimmed.match(/\d+(?:[.,]\d+)?/g);
  if (!matches || matches.length === 0) return null;
  const nums = matches
    .map((n) => Number.parseFloat(n.replace(',', '.')))
    .filter((n) => Number.isFinite(n));
  if (nums.length === 0) return null;

  const first = nums[0];
  const second = nums[1] ?? first;
  const lo = Math.min(first, second);
  const hi = Math.max(first, second);
  const isGhz =
    /^2[67](?:[.,]\d+)?\s*[mg]hz$/i.test(trimmed) ||
    (lo >= 24 && hi <= 29.5) ||
    (/ghz/i.test(trimmed) && first < 100);
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
  if (mid >= 24000 && mid <= 29500) return '26 GHz';
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
      const inferredBandSearch =
        inferredBand === '26 GHz' ? '26 GHz 26GHz' : inferredBand;
      const haystack = normalizeSearchText(
        `${tipoLabel} ${meta.name} ${meta.shortName} ${row.opRaw} ${row.op} ${row.codigo} ${row.codigoBanda} ${row.frecuencia} ${inferredBandSearch} ${row.ubicacion} ${row.prov ?? ''} ${formattedDate}`,
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

function pickLatestNovedadesIso(baseIso: string, deltaIso: string): string {
  if (!deltaIso) return baseIso;
  if (!baseIso) return deltaIso;
  const baseMs = Date.parse(baseIso);
  const deltaMs = Date.parse(deltaIso);
  if (Number.isFinite(baseMs) && Number.isFinite(deltaMs)) {
    return deltaMs >= baseMs ? deltaIso : baseIso;
  }
  return deltaIso >= baseIso ? deltaIso : baseIso;
}

function normalizeFreqUnit(rawUnit: string): 'MHz' | 'GHz' {
  return rawUnit.toLowerCase() === 'ghz' ? 'GHz' : 'MHz';
}

/**
 * Divide un rango de frecuencias en dos líneas compactas (frecuencia inicial arriba
 * y frecuencia final abajo) conservando la unidad en cada extremo para reducir la
 * anchura horizontal de la columna "Frecuencia".
 */
export function splitFrequencyRangeLines(frecuencia: string): {
  start: string;
  end: string | null;
} {
  const trimmed = frecuencia.trim();
  if (!trimmed) {
    return { start: '—', end: null };
  }

  const rangeMatch = trimmed.match(
    /^(.+?)\s*[-–]\s*(.+?)(?:\s+(MHz|GHz))?$/i,
  );
  if (!rangeMatch) {
    return { start: trimmed, end: null };
  }

  const rawStart = rangeMatch[1].trim();
  const rawEnd = rangeMatch[2].trim();
  const trailingUnit = rangeMatch[3];

  const startWithUnit = rawStart.match(
    /^(\d+(?:[.,]\d+)?)(?:\s*(MHz|GHz))?$/i,
  );
  const endWithUnit = rawEnd.match(
    /^(\d+(?:[.,]\d+)?)(?:\s*(MHz|GHz))?$/i,
  );

  if (!startWithUnit || !endWithUnit) {
    return { start: trimmed, end: null };
  }

  const startNum = startWithUnit[1];
  const endNum = endWithUnit[1];
  const detectedUnit = trailingUnit || endWithUnit[2] || startWithUnit[2];
  const endUnit = detectedUnit ? normalizeFreqUnit(detectedUnit) : 'MHz';
  const startUnit = startWithUnit[2]
    ? normalizeFreqUnit(startWithUnit[2])
    : endUnit;

  return {
    start: `${startNum} ${startUnit}`,
    end: `${endNum} ${endUnit}`,
  };
}

/**
 * Divide una fecha formateada ("DD/MM/YYYY HH:MM:SS") en línea de fecha y línea
 * de hora para reducir la anchura horizontal de la columna "Fecha".
 */
export function splitScanDateTimeLines(formattedFecha: string): {
  datePart: string;
  timePart: string | null;
} {
  const trimmed = formattedFecha.trim();
  if (!trimmed) {
    return { datePart: '—', timePart: null };
  }
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx > 0) {
    const datePart = trimmed.slice(0, spaceIdx).trim();
    const timePart = trimmed.slice(spaceIdx + 1).trim();
    return {
      datePart: datePart || '—',
      timePart: timePart || null,
    };
  }
  return { datePart: trimmed, timePart: null };
}

/**
 * Devuelve la clave estable de agrupación por antena de una novedad para vincular
 * cada antena nueva con todas sus frecuencias escaneadas asociadas.
 */
export function getNovedadAntennaGroupKey(
  row: Pick<NovedadRecord, 'antennaId' | 'op' | 'codigo'>,
): string {
  return row.antennaId.trim() || `${row.op}::${row.codigo.trim()}`;
}

function safeScanTimestampMs(scannedAt: string): number {
  const ms = Date.parse(scannedAt);
  return Number.isFinite(ms) ? ms : 0;
}

function parseFreqSortTuple(freqText: string): [number, number] {
  if (!freqText) {
    return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  }
  const trimmed = freqText.trim();
  if (!trimmed) {
    return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  }
  const matches = trimmed.match(/\d+(?:[.,]\d+)?/g);
  if (!matches || matches.length === 0) {
    return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  }
  const nums = matches
    .map((n) => Number.parseFloat(n.replace(',', '.')))
    .filter((n) => Number.isFinite(n));
  if (nums.length === 0) {
    return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  }
  const first = nums[0];
  const second = nums[1] ?? first;
  const lo = Math.min(first, second);
  const hi = Math.max(first, second);
  const isGhz =
    /^2[67](?:[.,]\d+)?\s*[mg]hz$/i.test(trimmed) ||
    (lo >= 24 && hi <= 29.5) ||
    (/ghz/i.test(trimmed) && lo < 100);
  const scale = isGhz ? 1000 : 1;
  return [lo * scale, hi * scale];
}

function compareFrequencyRows(a: NovedadRecord, b: NovedadRecord): number {
  const tupleA = parseFreqSortTuple(a.frecuencia);
  const tupleB = parseFreqSortTuple(b.frecuencia);
  if (tupleA[0] !== tupleB[0]) {
    return tupleA[0] < tupleB[0] ? -1 : 1;
  }
  if (tupleA[1] !== tupleB[1]) {
    return tupleA[1] < tupleB[1] ? -1 : 1;
  }
  const cmpBand = a.codigoBanda.localeCompare(b.codigoBanda, 'es');
  if (cmpBand !== 0) return cmpBand;
  return a.id.localeCompare(b.id, 'es');
}

/**
 * Ordena las novedades agrupando cada antena nueva inmediatamente seguida por todas
 * las frecuencias asociadas a esa antena del operador, y situando después todas las
 * frecuencias nuevas pertenecientes a antenas ya existentes.
 */
export function orderNovedadesGroupedByNewAntenna(
  rows: readonly NovedadRecord[],
): NovedadRecord[] {
  const seenIds = new Set<string>();
  const newAntennas: NovedadRecord[] = [];
  const frequencies: NovedadRecord[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (seenIds.has(row.id)) continue;
    seenIds.add(row.id);
    if (row.tipo === 'antena') {
      newAntennas.push(row);
    } else {
      frequencies.push(row);
    }
  }

  newAntennas.sort((a, b) => {
    const msDiff =
      safeScanTimestampMs(b.scannedAt) - safeScanTimestampMs(a.scannedAt);
    if (msDiff !== 0) return msDiff;
    const cmpCodigo = a.codigo.localeCompare(b.codigo, 'es');
    if (cmpCodigo !== 0) return cmpCodigo;
    const cmpOp = a.op.localeCompare(b.op, 'es');
    if (cmpOp !== 0) return cmpOp;
    const cmpKey = getNovedadAntennaGroupKey(a).localeCompare(
      getNovedadAntennaGroupKey(b),
      'es',
    );
    if (cmpKey !== 0) return cmpKey;
    return a.id.localeCompare(b.id, 'es');
  });

  const newAntennaKeys = new Set<string>();
  for (let i = 0; i < newAntennas.length; i++) {
    newAntennaKeys.add(getNovedadAntennaGroupKey(newAntennas[i]));
  }

  const associatedFreqsByAntKey = new Map<string, NovedadRecord[]>();
  const existingAntFreqsByKey = new Map<string, NovedadRecord[]>();

  for (let i = 0; i < frequencies.length; i++) {
    const freq = frequencies[i];
    const key = getNovedadAntennaGroupKey(freq);
    const targetMap = newAntennaKeys.has(key)
      ? associatedFreqsByAntKey
      : existingAntFreqsByKey;
    const list = targetMap.get(key);
    if (list) {
      list.push(freq);
    } else {
      targetMap.set(key, [freq]);
    }
  }

  const ordered: NovedadRecord[] = [];

  // Bloque 1: cada antena nueva seguida inmediatamente por sus frecuencias asociadas
  for (let i = 0; i < newAntennas.length; i++) {
    const ant = newAntennas[i];
    ordered.push(ant);
    const key = getNovedadAntennaGroupKey(ant);
    const assocFreqs = associatedFreqsByAntKey.get(key);
    if (assocFreqs) {
      associatedFreqsByAntKey.delete(key);
      assocFreqs.sort(compareFrequencyRows);
      for (let j = 0; j < assocFreqs.length; j++) {
        ordered.push(assocFreqs[j]);
      }
    }
  }

  // Bloque 2: frecuencias nuevas de antenas ya existentes agrupadas por antena
  const existingGroups: {
    groupKey: string;
    maxScannedAtMs: number;
    codigo: string;
    op: string;
    items: NovedadRecord[];
  }[] = [];

  for (const [groupKey, items] of existingAntFreqsByKey.entries()) {
    let maxScannedAtMs = 0;
    for (let i = 0; i < items.length; i++) {
      const ms = safeScanTimestampMs(items[i].scannedAt);
      if (ms > maxScannedAtMs) {
        maxScannedAtMs = ms;
      }
    }
    items.sort(compareFrequencyRows);
    existingGroups.push({
      groupKey,
      maxScannedAtMs,
      codigo: items[0].codigo,
      op: items[0].op,
      items,
    });
  }

  existingGroups.sort((a, b) => {
    const msDiff = b.maxScannedAtMs - a.maxScannedAtMs;
    if (msDiff !== 0) return msDiff;
    const cmpCodigo = a.codigo.localeCompare(b.codigo, 'es');
    if (cmpCodigo !== 0) return cmpCodigo;
    const cmpOp = a.op.localeCompare(b.op, 'es');
    if (cmpOp !== 0) return cmpOp;
    return a.groupKey.localeCompare(b.groupKey, 'es');
  });

  for (let i = 0; i < existingGroups.length; i++) {
    const groupItems = existingGroups[i].items;
    for (let j = 0; j < groupItems.length; j++) {
      ordered.push(groupItems[j]);
    }
  }

  return ordered;
}

function deduplicateAndSortNovedades(
  rows: readonly NovedadRecord[],
): NovedadRecord[] {
  return orderNovedadesGroupedByNewAntenna(rows);
}

/**
 * Fusiona en tiempo real las novedades detectadas durante un escaneo activo (`recordNovedades === true`)
 * sobre el dataset estático de `data/novedades.json`.
 */
export function mergeLiveDeltaIntoNovedadesDataset(
  baseDataset: NovedadesDataset,
  delta: LiveScanMergedDelta | null | undefined,
): NovedadesDataset {
  if (!delta || !delta.recordNovedades) {
    return baseDataset;
  }

  if (delta.completedDatasetUpdatedAt) {
    const baseMs = Date.parse(baseDataset.updatedAt);
    const doneMs = Date.parse(delta.completedDatasetUpdatedAt);
    if (Number.isFinite(baseMs) && Number.isFinite(doneMs) && baseMs >= doneMs) {
      return baseDataset;
    }
  }

  let mergedNovedades: NovedadRecord[];
  let scanId: string;
  let previousScanAt: string | null;
  let updatedAt: string;

  if (baseDataset.scanId !== delta.scanId) {
    if (delta.deltaSeq <= 0) {
      return baseDataset;
    }
    mergedNovedades = deduplicateAndSortNovedades(delta.novedades);
    scanId = delta.scanId;
    previousScanAt = delta.previousScanAt ?? (baseDataset.updatedAt || null);
    updatedAt = delta.updatedAt || baseDataset.updatedAt;
  } else {
    if (delta.novedades.length === 0) {
      return baseDataset;
    }
    mergedNovedades = deduplicateAndSortNovedades([
      ...delta.novedades,
      ...baseDataset.novedades,
    ]);
    scanId = baseDataset.scanId;
    previousScanAt = baseDataset.previousScanAt;
    updatedAt = pickLatestNovedadesIso(
      baseDataset.updatedAt,
      delta.updatedAt,
    );
  }

  let antenasNuevas = 0;
  let frecuenciasNuevas = 0;
  for (let i = 0; i < mergedNovedades.length; i++) {
    if (mergedNovedades[i].tipo === 'antena') {
      antenasNuevas += 1;
    } else {
      frecuenciasNuevas += 1;
    }
  }

  return {
    ...baseDataset,
    updatedAt,
    scanId,
    previousScanAt,
    isBaselineScan: false,
    total: mergedNovedades.length,
    antenasNuevas,
    frecuenciasNuevas,
    novedades: mergedNovedades,
  };
}

export function useNovedadesData() {
  const query = useQuery({
    queryKey: ['novedades-dataset'],
    queryFn: importNovedadesJsonDataset,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 2,
  });

  const liveDelta = useLiveScanDelta();

  const mergedData = useMemo(
    () =>
      query.data
        ? mergeLiveDeltaIntoNovedadesDataset(query.data, liveDelta)
        : undefined,
    [query.data, liveDelta],
  );

  return {
    ...query,
    data: mergedData,
  };
}
