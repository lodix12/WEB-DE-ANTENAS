import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  OPERATOR_META,
  normalizeOperatorKeyInput,
  type NovedadRecord,
  type NovedadTipo,
  type NovedadesDataset,
  type OperatorKey,
} from '../types/antena';
import { normalizeSearchText } from '../utils/export';
import {
  ALL_SPANISH_COMUNIDADES,
  getCanonicalProvincesByComunidad,
  getCanonicalSpanishProvince,
  getComunidadAutonomaByProvince,
} from './useAntenasData';
import {
  useLiveScanDelta,
  type LiveScanMergedDelta,
} from './useScanProgress';

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
  const validatedNovedades: NovedadRecord[] = new Array(novedadesList.length);
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
    const validated = validateNovedadRecord(item);
    if (!validated) {
      throw new Error(
        `Registro incompleto en novedades[${i}]: debe cumplir el esquema NovedadRecord { id, tipo, op, opRaw, codigo, antennaId, codigoBanda, frecuencia, ubicacion, scannedAt, fecha }.`,
      );
    }
    validatedNovedades[i] = validated;
  }

  return {
    ...(raw as unknown as NovedadesDataset),
    novedades: orderNovedadesGroupedByNewAntenna(validatedNovedades),
  };
}

function validateNovedadRecord(
  item: Record<string, unknown>,
): NovedadRecord | null {
  const normalizedOp =
    typeof item.op === 'string'
      ? normalizeOperatorKeyInput(item.op, item.opRaw)
      : null;

  if (
    typeof item.id !== 'string' ||
    typeof item.tipo !== 'string' ||
    !VALID_NOVEDAD_TIPOS.has(item.tipo) ||
    typeof item.op !== 'string' ||
    normalizedOp === null ||
    typeof item.opRaw !== 'string' ||
    typeof item.codigo !== 'string' ||
    typeof item.antennaId !== 'string' ||
    typeof item.codigoBanda !== 'string' ||
    typeof item.frecuencia !== 'string' ||
    typeof item.ubicacion !== 'string' ||
    (item.prov !== undefined && typeof item.prov !== 'string') ||
    (item.scanId !== undefined && typeof item.scanId !== 'string') ||
    typeof item.scannedAt !== 'string' ||
    typeof item.fecha !== 'string'
  ) {
    return null;
  }

  return {
    id: item.id,
    tipo: item.tipo as NovedadTipo,
    op: normalizedOp,
    opRaw: item.opRaw,
    codigo: item.codigo,
    antennaId: item.antennaId,
    codigoBanda: item.codigoBanda,
    frecuencia: item.frecuencia,
    ubicacion: item.ubicacion,
    ...(item.prov !== undefined ? { prov: item.prov } : {}),
    ...(typeof item.scanId === 'string' && item.scanId.trim()
      ? { scanId: item.scanId.trim() }
      : {}),
    scannedAt: item.scannedAt,
    fecha: item.fecha,
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
 * Paleta de tonos exclusivos para las filas de la tabla de Novedades,
 * manteniendo la identidad cromática de cada operador con alta legibilidad
 * (tonos desaturados para Movistar/DIGI, #F28430 para Orange y #FF5959 para Vodafone).
 */
export const NOVEDADES_OPERATOR_ROW_COLORS: Record<OperatorKey, string> = {
  movistar: '#537AA2',
  orange: '#F28430',
  vodafone: '#FF5959',
  digi: '#8169AB',
  otros: '#717D8E',
};

/**
 * Devuelve el color de fondo de la fila en la tabla de Novedades
 * según la operadora asociada (con alpha = 0.5 por defecto).
 */
export function getOperatorRowBackground(op: OperatorKey, alpha = 0.5): string {
  const hex = (
    NOVEDADES_OPERATOR_ROW_COLORS[op] ?? NOVEDADES_OPERATOR_ROW_COLORS.otros
  ).replace(/^#/, '');
  const normalized =
    hex.length === 3
      ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
      : hex;
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    return `rgba(113, 125, 142, ${alpha})`;
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

export const NOVEDADES_SPANISH_COMUNIDADES: readonly string[] =
  ALL_SPANISH_COMUNIDADES;

export function getNovedadesProvincesForComunidad(
  comunidad?: string,
): string[] {
  return getCanonicalProvincesByComunidad(comunidad);
}

export function getNovedadesOperatorLabel(
  op: OperatorKey,
  opRaw?: string,
): string {
  switch (op) {
    case 'movistar':
      return 'Telefonica';
    case 'vodafone':
      return 'Vodafone';
    case 'orange':
      return 'Orange';
    case 'digi':
      return 'DIGI';
    case 'otros':
    default:
      return opRaw?.trim() || 'Otros';
  }
}

export function resolveNovedadProvince(
  row: Pick<NovedadRecord, 'prov' | 'ubicacion'>,
): string {
  const rawProv = row.prov?.trim() ?? '';
  if (rawProv) {
    return getCanonicalSpanishProvince(rawProv) || rawProv;
  }
  const rawUbicacion = row.ubicacion?.trim() ?? '';
  if (rawUbicacion) {
    return getCanonicalSpanishProvince(rawUbicacion);
  }
  return '';
}

export function resolveNovedadComunidad(
  row: Pick<NovedadRecord, 'prov' | 'ubicacion'>,
): string {
  const resolvedProv = resolveNovedadProvince(row) || (row.prov ?? '');
  return getComunidadAutonomaByProvince(resolvedProv);
}

export interface NovedadesFilterInput {
  novedades: NovedadRecord[];
  tipoFilter: 'all' | NovedadTipo;
  operatorFilter: 'all' | OperatorKey;
  bandFilter?: string;
  comunidadFilter?: string;
  provinceFilter?: string;
  locationFilter?: string;
  dateFilter?: string;
  searchQuery: string;
}

export function filterNovedades({
  novedades,
  tipoFilter,
  operatorFilter,
  bandFilter = 'all',
  comunidadFilter = 'all',
  provinceFilter = 'all',
  locationFilter = 'all',
  dateFilter = 'all',
  searchQuery,
}: NovedadesFilterInput): NovedadRecord[] {
  const normalizedQuery = normalizeSearchText(searchQuery);
  const tokens = normalizedQuery
    ? normalizedQuery.split(/\s+/).filter(Boolean)
    : [];
  const activeBand = bandFilter && bandFilter !== 'all' ? bandFilter : '';
  const activeComunidad =
    comunidadFilter && comunidadFilter !== 'all'
      ? normalizeSearchText(comunidadFilter)
      : '';
  const targetProv =
    provinceFilter && provinceFilter !== 'all'
      ? normalizeSearchText(
          getCanonicalSpanishProvince(provinceFilter) || provinceFilter,
        )
      : '';
  const activeLocation =
    locationFilter && locationFilter !== 'all'
      ? normalizeSearchText(locationFilter)
      : '';
  const activeDate = dateFilter && dateFilter !== 'all' ? dateFilter : '';

  if (
    tipoFilter === 'all' &&
    operatorFilter === 'all' &&
    !activeBand &&
    !activeComunidad &&
    !targetProv &&
    !activeLocation &&
    !activeDate &&
    tokens.length === 0
  ) {
    return novedades;
  }

  const result: NovedadRecord[] = [];
  for (let i = 0; i < novedades.length; i++) {
    const row = novedades[i];
    const rowOp = normalizeOperatorKeyInput(row.op, row.opRaw) ?? row.op;
    if (tipoFilter !== 'all' && row.tipo !== tipoFilter) continue;
    if (operatorFilter !== 'all' && rowOp !== operatorFilter) continue;

    if (activeBand) {
      if (row.tipo !== 'frecuencia') continue;
      const inferredBand = classifyFrequencyBandMhz(row.frecuencia);
      if (inferredBand !== activeBand) continue;
    }

    if (activeComunidad) {
      if (normalizeSearchText(resolveNovedadComunidad(row)) !== activeComunidad) {
        continue;
      }
    }

    if (targetProv) {
      const resolvedProvNorm = normalizeSearchText(resolveNovedadProvince(row));
      const fallbackProvNorm = normalizeSearchText(row.prov ?? '');
      if (resolvedProvNorm !== targetProv && fallbackProvNorm !== targetProv) {
        continue;
      }
    }

    if (activeLocation) {
      const rowCity = normalizeSearchText(row.ubicacion);
      const rowProv = normalizeSearchText(row.prov ?? '');
      const rowResolvedProv = normalizeSearchText(resolveNovedadProvince(row));
      if (
        rowCity !== activeLocation &&
        rowProv !== activeLocation &&
        rowResolvedProv !== activeLocation
      ) {
        continue;
      }
    }

    const formattedDate = formatScanDateTimeDmyHms(row.scannedAt, row.fecha);
    if (activeDate) {
      const dayPart = formattedDate.split(' ')[0] ?? '';
      if (dayPart !== activeDate) continue;
    }

    if (tokens.length > 0) {
      const meta = OPERATOR_META[rowOp] ?? OPERATOR_META.otros;
      const opLabel = getNovedadesOperatorLabel(rowOp, row.opRaw);
      const tipoLabel =
        row.tipo === 'antena' ? 'antena nueva' : 'frecuencia nueva';
      const inferredBand = classifyFrequencyBandMhz(row.frecuencia) ?? '';
      const inferredBandSearch =
        inferredBand === '26 GHz' ? '26 GHz 26GHz' : inferredBand;
      const resolvedProv = resolveNovedadProvince(row);
      const resolvedComunidad = resolveNovedadComunidad(row);
      const haystack = normalizeSearchText(
        `${tipoLabel} ${opLabel} ${meta.name} ${meta.shortName} ${row.opRaw} ${rowOp} ${row.codigo} ${row.codigoBanda} ${row.frecuencia} ${inferredBandSearch} ${row.ubicacion} ${row.prov ?? ''} ${resolvedProv} ${resolvedComunidad} ${formattedDate}`,
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

/**
 * Devuelve la clave estable del lote de escaneo al que pertenece una novedad
 * (`scan:<scanId>` cuando existe `scanId`, o `day:YYYY-MM-DD` como respaldo por día).
 */
export function getNovedadScanBatchKey(
  row: Pick<NovedadRecord, 'scanId' | 'fecha' | 'scannedAt'>,
): string {
  if (row.scanId && row.scanId.trim().length > 0) {
    return `scan:${row.scanId.trim()}`;
  }
  const fechaMatch = row.fecha.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (fechaMatch) {
    return `day:${fechaMatch[3]}-${fechaMatch[2]}-${fechaMatch[1]}`;
  }
  const isoMatch = row.scannedAt.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) {
    return `day:${isoMatch[1]}`;
  }
  return 'day:unknown';
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

function orderSingleBatchNovedades(
  batchRows: readonly NovedadRecord[],
): NovedadRecord[] {
  const newAntennas: NovedadRecord[] = [];
  const frequencies: NovedadRecord[] = [];

  for (let i = 0; i < batchRows.length; i++) {
    const row = batchRows[i];
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

  // Bloque 1 del lote: cada antena nueva seguida inmediatamente por sus frecuencias asociadas en este lote
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

  // Bloque 2 del lote: frecuencias nuevas de antenas ya existentes en este lote agrupadas por antena
  const existingGroups: {
    groupKey: string;
    maxScannedAtMs: number;
    codigo: string;
    op: string;
    items: NovedadRecord[];
  }[] = [];

  for (const [groupKey, items] of existingAntFreqsByKey.entries()) {
    let maxScannedAtMs = safeScanTimestampMs(items[0].scannedAt);
    for (let i = 1; i < items.length; i++) {
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

/**
 * Ordena las novedades por lote de escaneo (del escaneo más reciente en la parte superior
 * al más antiguo debajo de forma permanente) y, dentro de cada lote de escaneo, agrupa cada
 * antena nueva inmediatamente seguida por sus frecuencias asociadas y después las frecuencias
 * nuevas pertenecientes a antenas ya existentes en ese lote.
 */
export function orderNovedadesGroupedByNewAntenna(
  rows: readonly NovedadRecord[],
): NovedadRecord[] {
  if (rows.length === 0) {
    return [];
  }

  const dedupedById = new Map<string, NovedadRecord>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const existing = dedupedById.get(row.id);
    if (!existing) {
      dedupedById.set(row.id, row);
      continue;
    }
    const existingBatch = getNovedadScanBatchKey(existing);
    const rowBatch = getNovedadScanBatchKey(row);
    if (existingBatch !== rowBatch) {
      const existingMs = safeScanTimestampMs(existing.scannedAt);
      const rowMs = safeScanTimestampMs(row.scannedAt);
      if (existingMs > 0 && rowMs > 0 && rowMs < existingMs) {
        dedupedById.set(row.id, row);
      }
    }
  }

  const batchesMap = new Map<string, NovedadRecord[]>();
  for (const row of dedupedById.values()) {
    const batchKey = getNovedadScanBatchKey(row);
    const list = batchesMap.get(batchKey);
    if (list) {
      list.push(row);
    } else {
      batchesMap.set(batchKey, [row]);
    }
  }

  if (batchesMap.size === 1) {
    const singleBatch = batchesMap.values().next().value;
    return singleBatch ? orderSingleBatchNovedades(singleBatch) : [];
  }

  const batchEntries: {
    batchKey: string;
    maxScannedAtMs: number;
    rows: NovedadRecord[];
  }[] = [];

  for (const [batchKey, batchRows] of batchesMap.entries()) {
    let maxScannedAtMs = safeScanTimestampMs(batchRows[0].scannedAt);
    for (let i = 1; i < batchRows.length; i++) {
      const ms = safeScanTimestampMs(batchRows[i].scannedAt);
      if (ms > maxScannedAtMs) {
        maxScannedAtMs = ms;
      }
    }
    batchEntries.push({ batchKey, maxScannedAtMs, rows: batchRows });
  }

  batchEntries.sort((a, b) => {
    const msDiff = b.maxScannedAtMs - a.maxScannedAtMs;
    if (msDiff !== 0) return msDiff;
    if (a.batchKey !== b.batchKey) {
      return b.batchKey.localeCompare(a.batchKey, 'es');
    }
    return 0;
  });

  const ordered: NovedadRecord[] = [];
  for (let i = 0; i < batchEntries.length; i++) {
    const orderedBatch = orderSingleBatchNovedades(batchEntries[i].rows);
    for (let j = 0; j < orderedBatch.length; j++) {
      ordered.push(orderedBatch[j]);
    }
  }

  return ordered;
}

function deduplicateAndSortNovedades(
  rows: readonly NovedadRecord[],
): NovedadRecord[] {
  const normalizedRows = rows.map((r) => {
    const normOp = normalizeOperatorKeyInput(r.op, r.opRaw);
    return normOp && normOp !== r.op ? { ...r, op: normOp } : r;
  });
  return orderNovedadesGroupedByNewAntenna(normalizedRows);
}

function stampHistoricalBaseRows(
  baseDataset: NovedadesDataset,
): NovedadRecord[] {
  const baseScanId = baseDataset.scanId.trim();
  const canStampBaseScanId =
    baseScanId.length > 0 && baseScanId !== 'baseline-init';
  if (!canStampBaseScanId || baseDataset.novedades.length === 0) {
    return baseDataset.novedades;
  }

  const unstampedDayKeys = new Set<string>();
  for (let i = 0; i < baseDataset.novedades.length; i++) {
    const r = baseDataset.novedades[i];
    if (!r.scanId || !r.scanId.trim()) {
      unstampedDayKeys.add(getNovedadScanBatchKey(r));
    }
  }

  if (unstampedDayKeys.size === 0) {
    return baseDataset.novedades;
  }

  const updatedDayDmy = extractScanDayDmy(baseDataset.updatedAt);
  const updatedDayMatch = updatedDayDmy.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const targetDayKey = updatedDayMatch
    ? `day:${updatedDayMatch[3]}-${updatedDayMatch[2]}-${updatedDayMatch[1]}`
    : '';

  return baseDataset.novedades.map((r) => {
    if (r.scanId && r.scanId.trim()) {
      return r;
    }
    if (
      unstampedDayKeys.size === 1 ||
      (targetDayKey && getNovedadScanBatchKey(r) === targetDayKey)
    ) {
      return { ...r, scanId: baseScanId };
    }
    return r;
  });
}

/**
 * Fusiona en tiempo real las novedades detectadas durante un escaneo activo (`recordNovedades === true`)
 * sobre el dataset estático de `data/novedades.json`, conservando siempre de forma permanente
 * todas las novedades históricas registradas en escaneos anteriores y añadiendo encima las nuevas.
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
    if (
      Number.isFinite(baseMs) &&
      Number.isFinite(doneMs) &&
      baseMs >= doneMs &&
      (!baseDataset.isBaselineScan || delta.novedades.length === 0)
    ) {
      return baseDataset;
    }
  }

  let mergedNovedades: NovedadRecord[];
  let scanId: string;
  let previousScanAt: string | null;
  let updatedAt: string;
  const deltaScanId = delta.scanId.trim();

  if (baseDataset.scanId !== delta.scanId) {
    if (delta.deltaSeq <= 0) {
      return baseDataset;
    }
    const historicalRows = stampHistoricalBaseRows(baseDataset);
    const historicalIds = new Set<string>();
    for (let i = 0; i < historicalRows.length; i++) {
      historicalIds.add(historicalRows[i].id);
    }
    const incomingNewRows: NovedadRecord[] = [];
    for (let i = 0; i < delta.novedades.length; i++) {
      const row = delta.novedades[i];
      if (historicalIds.has(row.id)) continue;
      incomingNewRows.push(
        !row.scanId && deltaScanId ? { ...row, scanId: deltaScanId } : row,
      );
    }
    mergedNovedades = deduplicateAndSortNovedades([
      ...incomingNewRows,
      ...historicalRows,
    ]);
    scanId = delta.scanId;
    previousScanAt = delta.previousScanAt ?? (baseDataset.updatedAt || null);
    updatedAt = pickLatestNovedadesIso(
      baseDataset.updatedAt,
      delta.updatedAt,
    );
  } else {
    if (delta.novedades.length === 0) {
      return baseDataset;
    }
    const prevCutoffMs = delta.previousScanAt
      ? safeScanTimestampMs(delta.previousScanAt)
      : 0;
    const historicalBaseRows: NovedadRecord[] = [];
    const sameScanBaseRows: NovedadRecord[] = [];
    const historicalIds = new Set<string>();

    for (let i = 0; i < baseDataset.novedades.length; i++) {
      const r = baseDataset.novedades[i];
      const rowScanId = r.scanId?.trim() ?? '';
      const isOlderScanById =
        rowScanId.length > 0 && rowScanId !== deltaScanId;
      const rowMs = safeScanTimestampMs(r.scannedAt);
      const isOlderScanByTime =
        rowScanId.length === 0 &&
        prevCutoffMs > 0 &&
        rowMs > 0 &&
        rowMs <= prevCutoffMs;

      if (isOlderScanById || isOlderScanByTime) {
        historicalBaseRows.push(r);
        historicalIds.add(r.id);
      } else {
        sameScanBaseRows.push(
          !rowScanId && deltaScanId ? { ...r, scanId: deltaScanId } : r,
        );
      }
    }

    const incomingSameScanRows: NovedadRecord[] = [];
    for (let i = 0; i < delta.novedades.length; i++) {
      const row = delta.novedades[i];
      if (historicalIds.has(row.id)) continue;
      incomingSameScanRows.push(
        !row.scanId && deltaScanId ? { ...row, scanId: deltaScanId } : row,
      );
    }

    mergedNovedades = deduplicateAndSortNovedades([
      ...incomingSameScanRows,
      ...sameScanBaseRows,
      ...historicalBaseRows,
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

export interface LatestScanNovedadesCounts {
  total: number;
  antena: number;
  frecuencia: number;
  byOp: Record<OperatorKey, number>;
}

/**
 * Determina si una fila de novedad pertenece estrictamente al último escaneo realizado
 * (`dataset.scanId`), excluyendo las filas históricas conservadas de escaneos previos.
 */
export function isLatestScanNovedad(
  row: NovedadRecord,
  dataset: Pick<
    NovedadesDataset,
    'scanId' | 'previousScanAt' | 'isBaselineScan'
  >,
): boolean {
  if (dataset.isBaselineScan) {
    return false;
  }
  const targetScanId = dataset.scanId?.trim() ?? '';
  const rowScanId = row.scanId?.trim() ?? '';
  if (rowScanId.length > 0 && targetScanId.length > 0) {
    return rowScanId === targetScanId;
  }
  const prevCutoffMs = dataset.previousScanAt
    ? safeScanTimestampMs(dataset.previousScanAt)
    : 0;
  const rowMs = row.scannedAt ? safeScanTimestampMs(row.scannedAt) : 0;
  if (prevCutoffMs > 0 && rowMs > 0) {
    return rowMs > prevCutoffMs;
  }
  return true;
}

/**
 * Calcula los contadores de novedades contabilizando únicamente las novedades detectadas
 * en el último escaneo realizado (`dataset.scanId`), nunca el acumulado histórico.
 */
export function computeLatestScanNovedadesCounts(
  dataset: NovedadesDataset | null | undefined,
): LatestScanNovedadesCounts {
  const byOp: Record<OperatorKey, number> = {
    movistar: 0,
    orange: 0,
    vodafone: 0,
    digi: 0,
    otros: 0,
  };

  if (!dataset || dataset.isBaselineScan) {
    return {
      total: 0,
      antena: 0,
      frecuencia: 0,
      byOp,
    };
  }

  const rows = Array.isArray(dataset.novedades) ? dataset.novedades : [];
  if (rows.length === 0) {
    return {
      total: Math.max(0, dataset.total ?? 0),
      antena: Math.max(0, dataset.antenasNuevas ?? 0),
      frecuencia: Math.max(0, dataset.frecuenciasNuevas ?? 0),
      byOp,
    };
  }

  let antena = 0;
  let frecuencia = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!isLatestScanNovedad(row, dataset)) {
      continue;
    }
    if (row.tipo === 'antena') {
      antena += 1;
    } else if (row.tipo === 'frecuencia') {
      frecuencia += 1;
    }
    const rowOp = normalizeOperatorKeyInput(row.op, row.opRaw) ?? row.op;
    if (rowOp in byOp) {
      byOp[rowOp] += 1;
    }
  }

  return {
    total: antena + frecuencia,
    antena,
    frecuencia,
    byOp,
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
