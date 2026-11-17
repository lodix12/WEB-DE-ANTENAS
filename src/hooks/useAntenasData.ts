import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  OPERATOR_META,
  OPERATOR_ORDER,
  isXferaLegalEntity,
  normalizeOperatorKeyInput,
  type AntenasDataset,
  type AntennaRecord,
  type ConcesionBanda,
  type OperatorKey,
  type OperatorSummary,
  type ProvinceSummary,
} from '../types/antena';
import {
  normalizeSearchText,
  parseCoordinateInput,
} from '../utils/export';
import { haversineDistanceKm } from '../utils/geo';
import {
  useLiveScanDelta,
  type LiveScanMergedDelta,
} from './useScanProgress';

export { isXferaLegalEntity, normalizeOperatorKeyInput };

export interface MunicipalityOption {
  mun: string;
  count: number;
}

export interface BandOption {
  band: string;
  count: number;
}

export interface ComunidadSummary {
  comunidad: string;
  count: number;
  provinces: ProvinceSummary[];
}

export interface DerivedAntenasStructures {
  dataset: AntenasDataset;
  /** Comunidades autónomas ordenadas alfabéticamente con sus provincias y conteo */
  comunidadesByAlpha: ComunidadSummary[];
  /** Provincias ordenadas alfabéticamente agrupadas por comunidad autónoma */
  provincesByComunidad: Map<string, ProvinceSummary[]>;
  /** Centroide medio aproximado por comunidad autónoma para navegación rápida */
  comunidadCentroids: Map<string, { lat: number; lon: number }>;
  /** Provincias ordenadas alfabéticamente para selectores */
  provincesByAlpha: ProvinceSummary[];
  /** Provincias ordenadas por volumen de estaciones para analítica */
  provincesByCount: ProvinceSummary[];
  /** Mapa O(1) de municipios por provincia con conteo */
  municipalitiesByProvince: Map<string, MunicipalityOption[]>;
  /** Total nacional de municipios distintos con cobertura registrada */
  totalUniqueMunicipalities: number;
  /** Conteo total por operador */
  operatorCounts: Record<OperatorKey, number>;
  /** Bandas comerciales MHz disponibles ordenadas numéricamente con conteo de estaciones */
  availableBands: BandOption[];
  /** Número de antenas del dataset con el array bandas ya poblado */
  bandsPopulatedCount: number;
  /** Centroide medio aproximado por provincia para navegación rápida */
  provinceCentroids: Map<string, { lat: number; lon: number }>;
  /** Búsqueda O(1) por id o Gis_ID (incluyendo mergedGids fusionados) */
  byId: Map<string, AntennaRecord>;
  byGid: Map<string, AntennaRecord>;
  /** Índice pre-normalizado sin tildes alineado con dataset.antenas */
  searchIndex: string[];
}

export const CANONICAL_COMUNIDAD_PROVINCES: ReadonlyArray<
  readonly [comunidad: string, canonicalProvinces: readonly string[]]
> = [
  [
    'Andalucía',
    [
      'ALMERÍA',
      'CÁDIZ',
      'CÓRDOBA',
      'GRANADA',
      'HUELVA',
      'JAÉN',
      'MÁLAGA',
      'SEVILLA',
    ],
  ],
  ['Aragón', ['HUESCA', 'TERUEL', 'ZARAGOZA']],
  ['Principado de Asturias', ['ASTURIAS']],
  ['Illes Balears', ['ILLES BALEARS']],
  ['Canarias', ['LAS PALMAS', 'SANTA CRUZ DE TENERIFE']],
  ['Cantabria', ['CANTABRIA']],
  [
    'Castilla-La Mancha',
    ['ALBACETE', 'CIUDAD REAL', 'CUENCA', 'GUADALAJARA', 'TOLEDO'],
  ],
  [
    'Castilla y León',
    [
      'ÁVILA',
      'BURGOS',
      'LEÓN',
      'PALENCIA',
      'SALAMANCA',
      'SEGOVIA',
      'SORIA',
      'VALLADOLID',
      'ZAMORA',
    ],
  ],
  ['Cataluña', ['BARCELONA', 'GIRONA', 'LLEIDA', 'TARRAGONA']],
  ['Comunidad Valenciana', ['ALICANTE', 'CASTELLÓN', 'VALENCIA']],
  ['Extremadura', ['BADAJOZ', 'CÁCERES']],
  ['Galicia', ['A CORUÑA', 'LUGO', 'OURENSE', 'PONTEVEDRA']],
  ['Comunidad de Madrid', ['MADRID']],
  ['Región de Murcia', ['MURCIA']],
  ['Comunidad Foral de Navarra', ['NAVARRA']],
  ['País Vasco', ['ÁLAVA', 'BIZKAIA', 'GIPUZKOA']],
  ['La Rioja', ['LA RIOJA']],
  ['Ceuta', ['CEUTA']],
  ['Melilla', ['MELILLA']],
];

const CANONICAL_PROVINCE_ALIASES: ReadonlyArray<
  readonly [canonicalProvince: string, aliases: readonly string[]]
> = [
  ['ALMERÍA', ['ALMERIA']],
  ['CÁDIZ', ['CADIZ']],
  ['CÓRDOBA', ['CORDOBA']],
  ['JAÉN', ['JAEN']],
  ['MÁLAGA', ['MALAGA']],
  ['ASTURIAS', ['PRINCIPADO DE ASTURIAS', 'OVIEDO']],
  [
    'ILLES BALEARS',
    [
      'ISLAS BALEARES',
      'BALEARES',
      'BALEARS',
      'ILLES BALEARS/ISLAS BALEARES',
      'ISLAS BALEARES/ILLES BALEARS',
    ],
  ],
  [
    'SANTA CRUZ DE TENERIFE',
    ['TENERIFE', 'S.C. DE TENERIFE', 'S/C DE TENERIFE', 'STA. CRUZ DE TENERIFE'],
  ],
  ['CANTABRIA', ['SANTANDER']],
  ['ÁVILA', ['AVILA']],
  ['LEÓN', ['LEON']],
  ['GIRONA', ['GERONA', 'GIRONA/GERONA', 'GERONA/GIRONA']],
  ['LLEIDA', ['LÉRIDA', 'LERIDA', 'LLEIDA/LÉRIDA', 'LÉRIDA/LLEIDA']],
  ['ALICANTE', ['ALACANT', 'ALICANTE/ALACANT', 'ALACANT/ALICANTE']],
  [
    'CASTELLÓN',
    [
      'CASTELLON',
      'CASTELLÓ',
      'CASTELLO',
      'CASTELLÓN/CASTELLÓ',
      'CASTELLÓ/CASTELLÓN',
      'CASTELLÓN DE LA PLANA',
      'CASTELLO DE LA PLANA',
      'CASTELLÓ DE LA PLANA',
    ],
  ],
  ['VALENCIA', ['VALÈNCIA', 'VALENCIA/VALÈNCIA', 'VALÈNCIA/VALENCIA']],
  ['CÁCERES', ['CACERES']],
  [
    'A CORUÑA',
    [
      'A CORUNA',
      'LA CORUÑA',
      'LA CORUNA',
      'CORUÑA',
      'CORUNA',
      'A CORUÑA/LA CORUÑA',
      'LA CORUÑA/A CORUÑA',
    ],
  ],
  ['OURENSE', ['OURENSE/ORENSE', 'ORENSE/OURENSE', 'ORENSE']],
  ['MADRID', ['COMUNIDAD DE MADRID']],
  ['MURCIA', ['REGIÓN DE MURCIA', 'REGION DE MURCIA']],
  [
    'NAVARRA',
    [
      'NAFARROA',
      'NAVARRA/NAFARROA',
      'NAFARROA/NAVARRA',
      'COMUNIDAD FORAL DE NAVARRA',
    ],
  ],
  [
    'ÁLAVA',
    [
      'ALAVA',
      'ARABA',
      'ARABA/ÁLAVA',
      'ÁLAVA/ARABA',
      'ARABA/ALAVA',
      'ALAVA/ARABA',
    ],
  ],
  ['BIZKAIA', ['VIZCAYA', 'BIZKAIA/VIZCAYA', 'VIZCAYA/BIZKAIA']],
  [
    'GIPUZKOA',
    [
      'GUIPÚZCOA',
      'GUIPUZCOA',
      'GIPUZKOA/GUIPÚZCOA',
      'GUIPÚZCOA/GIPUZKOA',
    ],
  ],
  ['LA RIOJA', ['RIOJA', 'LOGROÑO', 'LOGRONO']],
  ['CEUTA', ['CIUDAD AUTÓNOMA DE CEUTA', 'CIUDAD AUTONOMA DE CEUTA']],
  ['MELILLA', ['CIUDAD AUTÓNOMA DE MELILLA', 'CIUDAD AUTONOMA DE MELILLA']],
];

const COMUNIDAD_PROVINCE_VARIANTS: ReadonlyArray<
  readonly [comunidad: string, provinces: readonly string[]]
> = [
  [
    'Andalucía',
    [
      'ALMERÍA',
      'ALMERIA',
      'CÁDIZ',
      'CADIZ',
      'CÓRDOBA',
      'CORDOBA',
      'GRANADA',
      'HUELVA',
      'JAÉN',
      'JAEN',
      'MÁLAGA',
      'MALAGA',
      'SEVILLA',
    ],
  ],
  ['Aragón', ['HUESCA', 'TERUEL', 'ZARAGOZA']],
  ['Principado de Asturias', ['ASTURIAS', 'PRINCIPADO DE ASTURIAS', 'OVIEDO']],
  [
    'Illes Balears',
    ['ILLES BALEARS', 'ISLAS BALEARES', 'BALEARES', 'BALEARS'],
  ],
  ['Canarias', ['LAS PALMAS', 'SANTA CRUZ DE TENERIFE', 'TENERIFE']],
  ['Cantabria', ['CANTABRIA', 'SANTANDER']],
  [
    'Castilla-La Mancha',
    ['ALBACETE', 'CIUDAD REAL', 'CUENCA', 'GUADALAJARA', 'TOLEDO'],
  ],
  [
    'Castilla y León',
    [
      'ÁVILA',
      'AVILA',
      'BURGOS',
      'LEÓN',
      'LEON',
      'PALENCIA',
      'SALAMANCA',
      'SEGOVIA',
      'SORIA',
      'VALLADOLID',
      'ZAMORA',
    ],
  ],
  [
    'Cataluña',
    [
      'BARCELONA',
      'GIRONA',
      'GERONA',
      'LLEIDA',
      'LÉRIDA',
      'LERIDA',
      'TARRAGONA',
    ],
  ],
  [
    'Comunidad Valenciana',
    [
      'ALICANTE',
      'ALACANT',
      'ALICANTE/ALACANT',
      'ALACANT/ALICANTE',
      'CASTELLÓN',
      'CASTELLON',
      'CASTELLÓ',
      'CASTELLO',
      'CASTELLÓN/CASTELLÓ',
      'CASTELLÓ/CASTELLÓN',
      'CASTELLÓN DE LA PLANA',
      'CASTELLO DE LA PLANA',
      'VALENCIA',
      'VALÈNCIA',
      'VALENCIA/VALÈNCIA',
      'VALÈNCIA/VALENCIA',
    ],
  ],
  ['Extremadura', ['BADAJOZ', 'CÁCERES', 'CACERES']],
  [
    'Galicia',
    [
      'A CORUÑA',
      'A CORUNA',
      'LA CORUÑA',
      'LA CORUNA',
      'CORUÑA',
      'CORUNA',
      'LUGO',
      'OURENSE',
      'ORENSE',
      'PONTEVEDRA',
    ],
  ],
  ['Comunidad de Madrid', ['MADRID', 'COMUNIDAD DE MADRID']],
  ['Región de Murcia', ['MURCIA', 'REGIÓN DE MURCIA', 'REGION DE MURCIA']],
  [
    'Comunidad Foral de Navarra',
    ['NAVARRA', 'NAFARROA', 'COMUNIDAD FORAL DE NAVARRA'],
  ],
  [
    'País Vasco',
    [
      'ÁLAVA',
      'ALAVA',
      'ARABA',
      'ARABA/ÁLAVA',
      'ÁLAVA/ARABA',
      'ARABA/ALAVA',
      'ALAVA/ARABA',
      'BIZKAIA',
      'VIZCAYA',
      'BIZKAIA/VIZCAYA',
      'VIZCAYA/BIZKAIA',
      'GIPUZKOA',
      'GUIPÚZCOA',
      'GUIPUZCOA',
      'GIPUZKOA/GUIPÚZCOA',
      'GUIPÚZCOA/GIPUZKOA',
    ],
  ],
  ['La Rioja', ['LA RIOJA', 'RIOJA', 'LOGROÑO', 'LOGRONO']],
  ['Ceuta', ['CEUTA', 'CIUDAD AUTÓNOMA DE CEUTA', 'CIUDAD AUTONOMA DE CEUTA']],
  [
    'Melilla',
    ['MELILLA', 'CIUDAD AUTÓNOMA DE MELILLA', 'CIUDAD AUTONOMA DE MELILLA'],
  ],
];

function normalizeProvinceLookupKey(prov: string): string {
  return normalizeSearchText(prov)
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

const PROVINCE_TO_COMUNIDAD_RAW = new Map<string, string>();
const PROVINCE_TO_COMUNIDAD_NORM = new Map<string, string>();
const PROVINCE_TO_CANONICAL_RAW = new Map<string, string>();
const PROVINCE_TO_CANONICAL_NORM = new Map<string, string>();
const CANONICAL_PROVINCES_BY_COMUNIDAD_RAW = new Map<
  string,
  readonly string[]
>();
const CANONICAL_PROVINCES_BY_COMUNIDAD_NORM = new Map<
  string,
  readonly string[]
>();

for (let i = 0; i < CANONICAL_COMUNIDAD_PROVINCES.length; i++) {
  const [comunidad, canonicalProvinces] = CANONICAL_COMUNIDAD_PROVINCES[i];
  const sortedProvinces = Object.freeze(
    [...canonicalProvinces].sort((a, b) => a.localeCompare(b, 'es')),
  );
  CANONICAL_PROVINCES_BY_COMUNIDAD_RAW.set(comunidad, sortedProvinces);
  const normComunidad = normalizeSearchText(comunidad);
  if (normComunidad) {
    CANONICAL_PROVINCES_BY_COMUNIDAD_NORM.set(normComunidad, sortedProvinces);
  }
  for (let j = 0; j < canonicalProvinces.length; j++) {
    const canonical = canonicalProvinces[j];
    PROVINCE_TO_CANONICAL_RAW.set(canonical, canonical);
    PROVINCE_TO_COMUNIDAD_RAW.set(canonical, comunidad);
    const normCanonical = normalizeProvinceLookupKey(canonical);
    if (normCanonical) {
      PROVINCE_TO_CANONICAL_NORM.set(normCanonical, canonical);
      PROVINCE_TO_COMUNIDAD_NORM.set(normCanonical, comunidad);
    }
  }
}

for (let i = 0; i < CANONICAL_PROVINCE_ALIASES.length; i++) {
  const [canonical, aliases] = CANONICAL_PROVINCE_ALIASES[i];
  const comunidad = PROVINCE_TO_COMUNIDAD_RAW.get(canonical);
  for (let j = 0; j < aliases.length; j++) {
    const alias = aliases[j];
    PROVINCE_TO_CANONICAL_RAW.set(alias, canonical);
    if (comunidad) {
      PROVINCE_TO_COMUNIDAD_RAW.set(alias, comunidad);
    }
    const normAlias = normalizeProvinceLookupKey(alias);
    if (normAlias) {
      PROVINCE_TO_CANONICAL_NORM.set(normAlias, canonical);
      if (comunidad) {
        PROVINCE_TO_COMUNIDAD_NORM.set(normAlias, comunidad);
      }
    }
  }
}

for (let i = 0; i < COMUNIDAD_PROVINCE_VARIANTS.length; i++) {
  const [comunidad, variants] = COMUNIDAD_PROVINCE_VARIANTS[i];
  for (let j = 0; j < variants.length; j++) {
    const rawVariant = variants[j];
    PROVINCE_TO_COMUNIDAD_RAW.set(rawVariant, comunidad);
    const normalized = normalizeProvinceLookupKey(rawVariant);
    if (normalized) {
      PROVINCE_TO_COMUNIDAD_NORM.set(normalized, comunidad);
    }
  }
}

export const ALL_SPANISH_COMUNIDADES: readonly string[] = Object.freeze(
  CANONICAL_COMUNIDAD_PROVINCES.map(([comunidad]) => comunidad).sort((a, b) =>
    a.localeCompare(b, 'es'),
  ),
);

const ALL_CANONICAL_SPANISH_PROVINCES: readonly string[] = Object.freeze(
  CANONICAL_COMUNIDAD_PROVINCES.flatMap(([, provinces]) => provinces).sort(
    (a, b) => a.localeCompare(b, 'es'),
  ),
);

/**
 * Resuelve cualquier variante de provincia española (cooficial, histórica o sin tildes)
 * a su nombre canónico oficial en mayúsculas del censo, o `""` si no corresponde a una provincia española.
 */
export function getCanonicalSpanishProvince(prov: string): string {
  if (!prov) return '';
  const direct = PROVINCE_TO_CANONICAL_RAW.get(prov);
  if (direct !== undefined) return direct;
  const key = normalizeProvinceLookupKey(prov);
  if (!key) return '';
  return PROVINCE_TO_CANONICAL_NORM.get(key) ?? '';
}

/**
 * Devuelve las provincias españolas canónicas ordenadas alfabéticamente (`es`):
 * - Si `!comunidad || comunidad === 'all'`, devuelve las 52 provincias oficiales.
 * - En caso contrario, devuelve las provincias canónicas de esa Comunidad Autónoma.
 */
export function getCanonicalProvincesByComunidad(comunidad?: string): string[] {
  const trimmed = comunidad?.trim() ?? '';
  if (!trimmed || trimmed === 'all') {
    return [...ALL_CANONICAL_SPANISH_PROVINCES];
  }
  const direct = CANONICAL_PROVINCES_BY_COMUNIDAD_RAW.get(trimmed);
  if (direct !== undefined) {
    return [...direct];
  }
  const norm = normalizeSearchText(trimmed);
  const byNorm = norm
    ? CANONICAL_PROVINCES_BY_COMUNIDAD_NORM.get(norm)
    : undefined;
  return byNorm ? [...byNorm] : [];
}

/**
 * Resuelve de forma determinista el nombre oficial de la Comunidad o Ciudad Autónoma
 * española a partir del nombre de provincia (con o sin tildes, mayúsculas o variantes cooficiales).
 */
export function getComunidadAutonomaByProvince(prov: string): string {
  if (!prov) return '';
  const direct = PROVINCE_TO_COMUNIDAD_RAW.get(prov);
  if (direct !== undefined) return direct;
  const key = normalizeProvinceLookupKey(prov);
  if (!key) return '';
  return PROVINCE_TO_COMUNIDAD_NORM.get(key) ?? '';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normaliza cualquier etiqueta comercial de banda móvil a su formato canónico,
 * unificando las etiquetas heredadas de MINETUR "26MHz"/"27MHz" ("26 MHz"/"27 MHz")
 * y variantes GHz ("26GHz"/"27GHz") en la banda única "26 GHz".
 */
export function normalizeCommercialBandLabel(raw: string): string {
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

/**
 * Extrae el valor numérico equivalente en MHz de una etiqueta de banda comercial
 * (ej. "700 MHz" -> 700, "3500 MHz" -> 3500, "26 GHz" -> 26000) para ordenación estricta.
 */
export function parseBandMhzSortValue(label: string): number {
  const normalized = normalizeCommercialBandLabel(label);
  const match = /(\d+(?:[.,]\d+)?)/.exec(normalized);
  if (!match) return Number.POSITIVE_INFINITY;
  const num = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(num)) return Number.POSITIVE_INFINITY;
  return /ghz/i.test(normalized) ? num * 1000 : num;
}

export function compareBandLabels(a: string, b: string): number {
  const diff = parseBandMhzSortValue(a) - parseBandMhzSortValue(b);
  if (diff !== 0) return diff;
  return a.localeCompare(b, 'es', { numeric: true });
}

/**
 * Normaliza, deduplica y ordena numéricamente las bandas comerciales de una estación
 * (situando "26 GHz" justo después de "3500 MHz").
 */
export function normalizeAntennaBandsList(
  bandas: readonly string[] | undefined,
): string[] {
  if (!bandas || bandas.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  for (let i = 0; i < bandas.length; i++) {
    const normalized = normalizeCommercialBandLabel(bandas[i]);
    if (normalized) {
      seen.add(normalized);
    }
  }
  return Array.from(seen).sort(compareBandLabels);
}

function isNormalizedBandsArray(bandas: readonly string[]): boolean {
  for (let i = 0; i < bandas.length; i++) {
    const raw = bandas[i];
    if (!raw || normalizeCommercialBandLabel(raw) !== raw) {
      return false;
    }
    if (i > 0 && compareBandLabels(bandas[i - 1], raw) >= 0) {
      return false;
    }
  }
  return true;
}

function parseFrequencyRangeSortBounds(raw: string): [number, number] {
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

export function compareFrequencyRanges(a: string, b: string): number {
  const [startA, endA] = parseFrequencyRangeSortBounds(a);
  const [startB, endB] = parseFrequencyRangeSortBounds(b);
  if (startA !== startB) return startA - startB;
  if (endA !== endB) return endA - endB;
  return a.localeCompare(b, 'es', { numeric: true });
}

/**
 * Valida que el contenido cargado corresponda exclusivamente al esquema JSON
 * propio compacto de RadioMapa (`AntenasDataset` en `data/antenas.json`) y
 * rechaza explícitamente cualquier colección o entidad GeoJSON (`FeatureCollection`).
 */
export function parseCustomAntenasJson(raw: unknown): AntenasDataset {
  if (!isPlainRecord(raw)) {
    throw new Error(
      'Formato inválido: se esperaba un objeto con el esquema JSON propio de RadioMapa (data/antenas.json).',
    );
  }

  if (
    raw.type === 'FeatureCollection' ||
    raw.type === 'Feature' ||
    Array.isArray(raw.features)
  ) {
    throw new Error(
      'Formato GeoJSON (FeatureCollection) no admitido: RadioMapa requiere importar exclusivamente su esquema JSON propio (data/antenas.json) y no carga desde GeoJSON.',
    );
  }

  if (
    typeof raw.updatedAt !== 'string' ||
    typeof raw.sourceUrl !== 'string' ||
    typeof raw.total !== 'number' ||
    !Number.isFinite(raw.total) ||
    !isPlainRecord(raw.crawlStats) ||
    !isPlainRecord(raw.operators) ||
    !Array.isArray(raw.provinces) ||
    !Array.isArray(raw.antenas)
  ) {
    throw new Error(
      'Esquema JSON inválido: faltan propiedades obligatorias del formato propio AntenasDataset (updatedAt, sourceUrl, total, crawlStats, operators, provinces, antenas).',
    );
  }

  let anyAntennaOpNormalized = false;
  const antenasList = raw.antenas;
  for (let i = 0; i < antenasList.length; i++) {
    const item: unknown = antenasList[i];
    if (!isPlainRecord(item)) {
      throw new Error(
        `Registro inválido en antenas[${i}]: se esperaba un registro compacto del JSON propio de RadioMapa.`,
      );
    }
    if (item.type === 'Feature' || 'geometry' in item) {
      throw new Error(
        `Entidad GeoJSON detectada en antenas[${i}]: RadioMapa exige registros compactos del JSON propio ({ id, gid, op, lat, lon, ... }) y no admite GeoJSON.`,
      );
    }
    const normalizedOp =
      typeof item.op === 'string'
        ? normalizeOperatorKeyInput(item.op, item.opRaw)
        : null;
    if (
      typeof item.id !== 'string' ||
      typeof item.gid !== 'string' ||
      normalizedOp === null ||
      typeof item.opRaw !== 'string' ||
      typeof item.lat !== 'number' ||
      !Number.isFinite(item.lat) ||
      typeof item.lon !== 'number' ||
      !Number.isFinite(item.lon) ||
      typeof item.dir !== 'string' ||
      typeof item.mun !== 'string' ||
      typeof item.prov !== 'string'
    ) {
      throw new Error(
        `Registro incompleto en antenas[${i}]: debe cumplir el esquema compacto propio { id, gid, op, opRaw, lat, lon, dir, mun, prov }.`,
      );
    }
    if (item.op !== normalizedOp) {
      item.op = normalizedOp;
      anyAntennaOpNormalized = true;
    }
    if (
      item.mergedGids !== undefined &&
      (!Array.isArray(item.mergedGids) ||
        !item.mergedGids.every((gid): gid is string => typeof gid === 'string'))
    ) {
      throw new Error(
        `Campo mergedGids inválido en antenas[${i}]: se esperaba un array de strings.`,
      );
    }
    if (item.bandas !== undefined) {
      if (
        !Array.isArray(item.bandas) ||
        !item.bandas.every((band): band is string => typeof band === 'string')
      ) {
        throw new Error(
          `Campo bandas inválido en antenas[${i}]: se esperaba un array de strings.`,
        );
      }
      item.bandas = normalizeAntennaBandsList(item.bandas);
    }
    if (
      item.frecuencias !== undefined &&
      (!Array.isArray(item.frecuencias) ||
        !item.frecuencias.every(
          (freq): freq is string => typeof freq === 'string',
        ))
    ) {
      throw new Error(
        `Campo frecuencias inválido en antenas[${i}]: se esperaba un array de strings.`,
      );
    }
    if (
      item.concesiones !== undefined &&
      (!Array.isArray(item.concesiones) ||
        !item.concesiones.every(
          (c): c is ConcesionBanda =>
            isPlainRecord(c) &&
            typeof c.ref === 'string' &&
            typeof c.freq === 'string',
        ))
    ) {
      throw new Error(
        `Campo concesiones inválido en antenas[${i}]: se esperaba un array de { ref: string, freq: string }.`,
      );
    }
    if (
      item.bandsScannedAt !== undefined &&
      typeof item.bandsScannedAt !== 'string'
    ) {
      throw new Error(
        `Campo bandsScannedAt inválido en antenas[${i}]: se esperaba un string ISO 8601.`,
      );
    }
  }

  const rawOperators = raw.operators;
  const hadLegacyMasmovilOp = 'masmovil' in rawOperators;
  const legacyMasmovilSummary =
    hadLegacyMasmovilOp && isPlainRecord(rawOperators.masmovil)
      ? rawOperators.masmovil
      : null;
  if (hadLegacyMasmovilOp) {
    delete rawOperators.masmovil;
  }

  for (let i = 0; i < OPERATOR_ORDER.length; i++) {
    const opKey = OPERATOR_ORDER[i];
    if (!isPlainRecord(rawOperators[opKey])) {
      rawOperators[opKey] = {
        key: opKey,
        name: OPERATOR_META[opKey].name,
        count: 0,
        legalEntities: [],
      };
    }
  }

  if (legacyMasmovilSummary) {
    const orangeSummary = rawOperators.orange as Record<string, unknown>;
    const prevCount =
      typeof orangeSummary.count === 'number' &&
      Number.isFinite(orangeSummary.count)
        ? orangeSummary.count
        : 0;
    const addCount =
      typeof legacyMasmovilSummary.count === 'number' &&
      Number.isFinite(legacyMasmovilSummary.count)
        ? legacyMasmovilSummary.count
        : 0;
    const mergedEntities = new Set<string>();
    if (Array.isArray(orangeSummary.legalEntities)) {
      for (let i = 0; i < orangeSummary.legalEntities.length; i++) {
        const ent = orangeSummary.legalEntities[i];
        if (typeof ent === 'string' && ent.trim()) {
          mergedEntities.add(ent);
        }
      }
    }
    if (Array.isArray(legacyMasmovilSummary.legalEntities)) {
      for (let i = 0; i < legacyMasmovilSummary.legalEntities.length; i++) {
        const ent = legacyMasmovilSummary.legalEntities[i];
        if (typeof ent === 'string' && ent.trim()) {
          mergedEntities.add(ent);
        }
      }
    }
    orangeSummary.key = 'orange';
    orangeSummary.name = OPERATOR_META.orange.name;
    orangeSummary.count = prevCount + addCount;
    orangeSummary.legalEntities = Array.from(mergedEntities).sort((a, b) =>
      a.localeCompare(b, 'es'),
    );
  }

  const rawProvinces = raw.provinces;
  for (let i = 0; i < rawProvinces.length; i++) {
    const provItem: unknown = rawProvinces[i];
    if (!isPlainRecord(provItem) || !isPlainRecord(provItem.byOperator)) {
      continue;
    }
    const byOp = provItem.byOperator;
    if ('masmovil' in byOp) {
      const legacyCount =
        typeof byOp.masmovil === 'number' && Number.isFinite(byOp.masmovil)
          ? byOp.masmovil
          : 0;
      if (legacyCount > 0) {
        const prevOrange =
          typeof byOp.orange === 'number' && Number.isFinite(byOp.orange)
            ? byOp.orange
            : 0;
        byOp.orange = prevOrange + legacyCount;
      }
      delete byOp.masmovil;
    }
  }

  const parsedDataset = raw as unknown as AntenasDataset;
  const fusedDataset = fuseXferaIntoOrangeInDataset(parsedDataset);
  if (
    anyAntennaOpNormalized &&
    fusedDataset === parsedDataset &&
    parsedDataset.antenas.length > 0
  ) {
    return rebuildDatasetSummariesWithAntenas(
      parsedDataset,
      parsedDataset.antenas,
      parsedDataset.updatedAt,
    );
  }
  return fusedDataset;
}

/**
 * Importa exclusivamente el archivo estático con esquema JSON propio (`data/antenas.json`).
 * El navegador jamás consulta el endpoint GeoJSON externo de MINETUR.
 */
export async function importAntenasJsonDataset(): Promise<AntenasDataset> {
  const baseUrl = import.meta.env.BASE_URL || './';
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const response = await fetch(`${normalizedBase}data/antenas.json`, {
    headers: { Accept: 'application/json' },
    cache: 'no-cache',
  });
  if (!response.ok) {
    throw new Error(
      `No se pudo importar el censo en JSON propio (HTTP ${response.status})`,
    );
  }
  const raw: unknown = await response.json();
  return parseCustomAntenasJson(raw);
}

export const fetchAntenasDataset = importAntenasJsonDataset;

function countRedundantLeadingZeros(gid: string): number {
  if (gid.length <= 1) return 0;
  let zeros = 0;
  while (zeros < gid.length - 1 && gid.charCodeAt(zeros) === 48) {
    zeros++;
  }
  return zeros;
}

function compareVodafoneCanonical(a: AntennaRecord, b: AntennaRecord): number {
  const aGid = a.gid.trim();
  const bGid = b.gid.trim();

  const aEmpty = aGid.length === 0 ? 1 : 0;
  const bEmpty = bGid.length === 0 ? 1 : 0;
  if (aEmpty !== bEmpty) return aEmpty - bEmpty;

  const aZeros = countRedundantLeadingZeros(aGid);
  const bZeros = countRedundantLeadingZeros(bGid);
  if (aZeros !== bZeros) return aZeros - bZeros;

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

function compareOrangeXferaCanonical(
  a: AntennaRecord,
  b: AntennaRecord,
): number {
  const aXfera = isXferaLegalEntity(a.opRaw) ? 1 : 0;
  const bXfera = isXferaLegalEntity(b.opRaw) ? 1 : 0;
  if (aXfera !== bXfera) return aXfera - bXfera;
  return compareVodafoneCanonical(a, b);
}

function mergeAntennaComponentMembers(
  sortedMembers: readonly AntennaRecord[],
  forceMergedGids: boolean,
  overrideOp?: OperatorKey,
): AntennaRecord {
  const merged: AntennaRecord = {
    ...sortedMembers[0],
    ...(overrideOp !== undefined ? { op: overrideOp } : {}),
  };

  for (let m = 1; m < sortedMembers.length; m++) {
    const cand = sortedMembers[m];
    if (!merged.gid.trim() && cand.gid.trim()) {
      merged.gid = cand.gid;
    }
    if (!merged.dir.trim() && cand.dir.trim()) {
      merged.dir = cand.dir;
    }
    if (!merged.mun.trim() && cand.mun.trim()) {
      merged.mun = cand.mun;
    }
    const curProv = merged.prov.trim();
    const candProv = cand.prov.trim();
    if (
      (!curProv || curProv === 'SIN PROVINCIA') &&
      candProv &&
      candProv !== 'SIN PROVINCIA'
    ) {
      merged.prov = cand.prov;
    } else if (!curProv && candProv) {
      merged.prov = cand.prov;
    }
  }

  const seenGids = new Set<string>();
  const mergedGids: string[] = [];
  let anyMemberHadMergedGids = false;
  let anyHasBandas = false;
  const seenBandas = new Set<string>();
  let anyHasFrecuencias = false;
  const seenFrecuencias = new Set<string>();
  let anyHasConcesiones = false;
  const seenConcesionKeys = new Set<string>();
  const mergedConcesiones: ConcesionBanda[] = [];
  let latestScannedAt: string | undefined;
  let latestScannedMs = Number.NEGATIVE_INFINITY;

  for (let m = 0; m < sortedMembers.length; m++) {
    const member = sortedMembers[m];
    const mgid = member.gid.trim();
    if (mgid && !seenGids.has(mgid)) {
      seenGids.add(mgid);
      mergedGids.push(mgid);
    }
    if (member.mergedGids !== undefined) {
      anyMemberHadMergedGids = true;
      for (let g = 0; g < member.mergedGids.length; g++) {
        const eg = member.mergedGids[g].trim();
        if (eg && !seenGids.has(eg)) {
          seenGids.add(eg);
          mergedGids.push(eg);
        }
      }
    }
    if (Array.isArray(member.bandas)) {
      anyHasBandas = true;
      for (let b = 0; b < member.bandas.length; b++) {
        const bLabel = normalizeCommercialBandLabel(member.bandas[b]);
        if (bLabel) {
          seenBandas.add(bLabel);
        }
      }
    }
    if (Array.isArray(member.frecuencias)) {
      anyHasFrecuencias = true;
      for (let f = 0; f < member.frecuencias.length; f++) {
        const fLabel = member.frecuencias[f].trim();
        if (fLabel) {
          seenFrecuencias.add(fLabel);
        }
      }
    }
    if (Array.isArray(member.concesiones)) {
      anyHasConcesiones = true;
      for (let c = 0; c < member.concesiones.length; c++) {
        const item = member.concesiones[c];
        const ref = item.ref.trim();
        const freq = item.freq.trim();
        if (!ref && !freq) continue;
        const key = `${ref}|${freq}`;
        if (!seenConcesionKeys.has(key)) {
          seenConcesionKeys.add(key);
          mergedConcesiones.push({ ref, freq });
        }
      }
    }
    if (typeof member.bandsScannedAt === 'string') {
      const candidate = member.bandsScannedAt.trim();
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

  if (
    forceMergedGids
      ? mergedGids.length > 0
      : mergedGids.length > 1 ||
        (anyMemberHadMergedGids && mergedGids.length > 0)
  ) {
    merged.mergedGids = mergedGids;
  } else {
    delete merged.mergedGids;
  }
  if (anyHasBandas) {
    merged.bandas = normalizeAntennaBandsList(Array.from(seenBandas));
  }
  if (anyHasFrecuencias) {
    merged.frecuencias = Array.from(seenFrecuencias).sort(
      compareFrequencyRanges,
    );
  }
  if (anyHasConcesiones) {
    merged.concesiones = mergedConcesiones.sort(
      (a, b) =>
        compareFrequencyRanges(a.freq, b.freq) ||
        a.ref.localeCompare(b.ref, 'es', { numeric: true }),
    );
  }
  if (latestScannedAt !== undefined) {
    merged.bandsScannedAt = latestScannedAt;
  }
  return merged;
}

/**
 * Unifica de forma pura e idempotente todas las antenas y frecuencias de
 * XFERA MÓVILES, S.A.U. (Yoigo / Grupo MásMóvil) dentro de Orange (`op: 'orange'`):
 * - Normaliza cualquier registro heredado `'masmovil'` o entidad de Xfera a `op: 'orange'`.
 * - Fusiona pares con el mismo `gid` no vacío exacto.
 * - Fusiona emplazamientos colocalizados a `< maxDistanceMeters` (por defecto 30 m)
 *   cuando al menos un extremo procede de Xfera, prohibiendo unir dos estaciones
 *   nativas de `ORANGE ESPAGNE` con distinto `gid` y exigiendo enlace completo (`complete-linkage`).
 */
export function fuseXferaIntoOrangeInDataset(
  dataset: AntenasDataset,
  maxDistanceMeters = 30,
): AntenasDataset {
  const { antenas } = dataset;

  const rawOpsRecord = dataset.operators as unknown as
    | Record<string, unknown>
    | undefined;
  let hasLegacySummaryKeys = Boolean(
    rawOpsRecord && 'masmovil' in rawOpsRecord,
  );
  if (!hasLegacySummaryKeys && rawOpsRecord) {
    for (let i = 0; i < OPERATOR_ORDER.length; i++) {
      if (!(OPERATOR_ORDER[i] in rawOpsRecord)) {
        hasLegacySummaryKeys = true;
        break;
      }
    }
  }
  if (!hasLegacySummaryKeys && Array.isArray(dataset.provinces)) {
    for (let i = 0; i < dataset.provinces.length; i++) {
      const byOp = dataset.provinces[i]?.byOperator as
        | Record<string, unknown>
        | undefined;
      if (byOp && 'masmovil' in byOp) {
        hasLegacySummaryKeys = true;
        break;
      }
    }
  }

  let hasLegacyAntennaOp = false;
  const orangeIndices: number[] = [];
  const orangeRecords: AntennaRecord[] = [];
  const isNativeOrange: boolean[] = [];

  for (let i = 0; i < antenas.length; i++) {
    const rawAnt = antenas[i];
    const rawOp = rawAnt.op as string;
    const xferaEntity = isXferaLegalEntity(rawAnt.opRaw);
    const isLegacyMasmovil = rawOp === 'masmovil';
    if (rawOp === 'orange' || isLegacyMasmovil || xferaEntity) {
      const normalizedAnt =
        rawOp === 'orange' ? rawAnt : { ...rawAnt, op: 'orange' as const };
      if (rawOp !== 'orange') {
        hasLegacyAntennaOp = true;
      }
      orangeIndices.push(i);
      orangeRecords.push(normalizedAnt);
      isNativeOrange.push(!xferaEntity && !isLegacyMasmovil);
    }
  }

  const n = orangeRecords.length;
  const parent = new Int32Array(n);
  const hasNativeOrange = new Uint8Array(n);
  const clusterMembers: number[][] = new Array<number[]>(n);
  for (let k = 0; k < n; k++) {
    parent[k] = k;
    hasNativeOrange[k] = isNativeOrange[k] ? 1 : 0;
    clusterMembers[k] = [k];
  }

  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) {
      root = parent[root];
    }
    let cur = x;
    while (cur !== root) {
      const next = parent[cur];
      parent[cur] = root;
      cur = next;
    }
    return root;
  };

  let fusionsCount = 0;
  const unionClusters = (rootA: number, rootB: number): boolean => {
    if (rootA === rootB) return false;
    const [keep, absorb] =
      clusterMembers[rootA].length >= clusterMembers[rootB].length
        ? [rootA, rootB]
        : [rootB, rootA];
    parent[absorb] = keep;
    if (hasNativeOrange[absorb]) {
      hasNativeOrange[keep] = 1;
    }
    const targetList = clusterMembers[keep];
    const sourceList = clusterMembers[absorb];
    for (let i = 0; i < sourceList.length; i++) {
      targetList.push(sourceList[i]);
    }
    sourceList.length = 0;
    fusionsCount++;
    return true;
  };

  // 1) Unión exacta por mismo Gis_ID no vacío
  if (n > 1) {
    const firstByGid = new Map<string, number>();
    for (let k = 0; k < n; k++) {
      const ant = orangeRecords[k];
      const gid = ant.gid.trim();
      if (gid) {
        const existingK = firstByGid.get(gid);
        if (existingK !== undefined) {
          unionClusters(find(existingK), find(k));
        } else {
          firstByGid.set(gid, k);
        }
      }
      if (ant.mergedGids) {
        for (let g = 0; g < ant.mergedGids.length; g++) {
          const mg = ant.mergedGids[g].trim();
          if (!mg) continue;
          const existingK = firstByGid.get(mg);
          if (existingK !== undefined) {
            unionClusters(find(existingK), find(k));
          } else {
            firstByGid.set(mg, k);
          }
        }
      }
    }
  }

  // 2) Unión espacial a < maxDistanceMeters cuando al menos un extremo es Xfera
  if (maxDistanceMeters > 0 && n > 1) {
    interface CandidateEdge {
      u: number;
      v: number;
      distKm: number;
      minId: string;
      maxId: string;
    }

    const cellDeg = Math.max(0.0006, maxDistanceMeters / 111320 / 0.65);
    const maxDistKm = maxDistanceMeters / 1000;
    const grid = new Map<number, number[]>();
    const candidateEdges: CandidateEdge[] = [];

    for (let k = 0; k < n; k++) {
      const ant = orangeRecords[k];
      const cx = Math.floor(ant.lat / cellDeg);
      const cy = Math.floor(ant.lon / cellDeg);

      for (let dx = -1; dx <= 1; dx++) {
        const rowBase = (cx + dx) * 4_000_000;
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = grid.get(rowBase + (cy + dy));
          if (!bucket) continue;
          for (let b = 0; b < bucket.length; b++) {
            const otherK = bucket[b];
            if (isNativeOrange[otherK] && isNativeOrange[k]) {
              continue;
            }
            if (find(otherK) === find(k)) {
              continue;
            }
            const otherAnt = orangeRecords[otherK];
            const distKm = haversineDistanceKm(
              ant.lat,
              ant.lon,
              otherAnt.lat,
              otherAnt.lon,
            );
            if (distKm < maxDistKm) {
              const idU = otherAnt.id;
              const idV = ant.id;
              const [minId, maxId] = idU <= idV ? [idU, idV] : [idV, idU];
              candidateEdges.push({
                u: otherK,
                v: k,
                distKm,
                minId,
                maxId,
              });
            }
          }
        }
      }

      const cellKey = cx * 4_000_000 + cy;
      const existing = grid.get(cellKey);
      if (existing) {
        existing.push(k);
      } else {
        grid.set(cellKey, [k]);
      }
    }

    if (candidateEdges.length > 1) {
      candidateEdges.sort((a, b) => {
        if (a.distKm !== b.distKm) return a.distKm - b.distKm;
        if (a.minId !== b.minId) return a.minId < b.minId ? -1 : 1;
        if (a.maxId !== b.maxId) return a.maxId < b.maxId ? -1 : 1;
        return a.u - b.u || a.v - b.v;
      });
    }

    for (let e = 0; e < candidateEdges.length; e++) {
      const edge = candidateEdges[e];
      const rootA = find(edge.u);
      const rootB = find(edge.v);
      if (rootA === rootB) continue;
      if (hasNativeOrange[rootA] && hasNativeOrange[rootB]) {
        continue;
      }
      const membersA = clusterMembers[rootA];
      const membersB = clusterMembers[rootB];
      let allWithinMaxDist = true;
      for (let ia = 0; ia < membersA.length && allWithinMaxDist; ia++) {
        const antA = orangeRecords[membersA[ia]];
        for (let ib = 0; ib < membersB.length; ib++) {
          const antB = orangeRecords[membersB[ib]];
          if (
            haversineDistanceKm(antA.lat, antA.lon, antB.lat, antB.lon) >=
            maxDistKm
          ) {
            allWithinMaxDist = false;
            break;
          }
        }
      }
      if (allWithinMaxDist) {
        unionClusters(rootA, rootB);
      }
    }
  }

  if (!hasLegacyAntennaOp && !hasLegacySummaryKeys && fusionsCount === 0) {
    return dataset;
  }

  if (antenas.length === 0) {
    const legacyMasmovil = isPlainRecord(rawOpsRecord?.masmovil)
      ? rawOpsRecord.masmovil
      : null;
    const updatedEmptyOps = {} as Record<OperatorKey, OperatorSummary>;
    for (const opKey of OPERATOR_ORDER) {
      const prev = dataset.operators?.[opKey];
      updatedEmptyOps[opKey] = {
        key: opKey,
        name: prev?.name ?? OPERATOR_META[opKey].name,
        count: prev?.count ?? 0,
        legalEntities: prev?.legalEntities ? [...prev.legalEntities] : [],
      };
    }
    if (legacyMasmovil) {
      const addCount =
        typeof legacyMasmovil.count === 'number' &&
        Number.isFinite(legacyMasmovil.count)
          ? legacyMasmovil.count
          : 0;
      const entitiesSet = new Set<string>(updatedEmptyOps.orange.legalEntities);
      if (Array.isArray(legacyMasmovil.legalEntities)) {
        for (let i = 0; i < legacyMasmovil.legalEntities.length; i++) {
          const ent = legacyMasmovil.legalEntities[i];
          if (typeof ent === 'string' && ent.trim()) {
            entitiesSet.add(ent);
          }
        }
      }
      updatedEmptyOps.orange = {
        key: 'orange',
        name: OPERATOR_META.orange.name,
        count: updatedEmptyOps.orange.count + addCount,
        legalEntities: Array.from(entitiesSet).sort((a, b) =>
          a.localeCompare(b, 'es'),
        ),
      };
    }
    const cleanedProvinces: ProvinceSummary[] = (dataset.provinces ?? []).map(
      (p) => {
        const rawByOp = (p.byOperator ?? {}) as Record<string, number | undefined>;
        const legacyProvCount =
          typeof rawByOp.masmovil === 'number' && Number.isFinite(rawByOp.masmovil)
            ? rawByOp.masmovil
            : 0;
        const orderedByOp: Partial<Record<OperatorKey, number>> = {};
        for (const opKey of OPERATOR_ORDER) {
          const baseCount = rawByOp[opKey] ?? 0;
          const totalCount =
            opKey === 'orange' ? baseCount + legacyProvCount : baseCount;
          if (totalCount > 0) {
            orderedByOp[opKey] = totalCount;
          }
        }
        return {
          provincia: p.provincia,
          count: p.count,
          byOperator: orderedByOp,
        };
      },
    );
    return {
      ...dataset,
      operators: updatedEmptyOps,
      provinces: cleanedProvinces,
    };
  }

  const components = new Map<number, AntennaRecord[]>();
  for (let k = 0; k < n; k++) {
    const root = find(k);
    const ant = orangeRecords[k];
    const list = components.get(root);
    if (list) {
      list.push(ant);
    } else {
      components.set(root, [ant]);
    }
  }

  const mergedByRoot = new Map<number, AntennaRecord>();
  for (const [root, members] of components.entries()) {
    if (members.length === 1) {
      mergedByRoot.set(root, members[0]);
      continue;
    }
    const sortedMembers = [...members].sort(compareOrangeXferaCanonical);
    mergedByRoot.set(
      root,
      mergeAntennaComponentMembers(sortedMembers, false, 'orange'),
    );
  }

  const orangeIndexSet =
    n > 0 ? new Set<number>(orangeIndices) : new Set<number>();
  const emittedRoots = new Set<number>();
  const fusedAntenas: AntennaRecord[] = [];
  let orangeCursor = 0;

  for (let i = 0; i < antenas.length; i++) {
    if (!orangeIndexSet.has(i)) {
      fusedAntenas.push(antenas[i]);
      continue;
    }
    const root = find(orangeCursor++);
    if (!emittedRoots.has(root)) {
      emittedRoots.add(root);
      const mergedRec = mergedByRoot.get(root);
      if (mergedRec) {
        fusedAntenas.push(mergedRec);
      }
    }
  }

  const opCounts: Record<OperatorKey, number> = {
    movistar: 0,
    orange: 0,
    vodafone: 0,
    digi: 0,
    otros: 0,
  };
  const opEntities: Record<OperatorKey, Set<string>> = {
    movistar: new Set<string>(),
    orange: new Set<string>(),
    vodafone: new Set<string>(),
    digi: new Set<string>(),
    otros: new Set<string>(),
  };
  for (let k = 0; k < n; k++) {
    if (orangeRecords[k].opRaw) {
      opEntities.orange.add(orangeRecords[k].opRaw);
    }
  }

  const provMap = new Map<
    string,
    { count: number; byOperator: Partial<Record<OperatorKey, number>> }
  >();
  let fusedBandsPopulated = 0;

  for (let i = 0; i < fusedAntenas.length; i++) {
    const ant = fusedAntenas[i];
    opCounts[ant.op] = (opCounts[ant.op] ?? 0) + 1;
    if (ant.opRaw) {
      opEntities[ant.op].add(ant.opRaw);
    }
    if (Array.isArray(ant.bandas)) {
      fusedBandsPopulated += 1;
    }
    if (ant.prov) {
      let provEntry = provMap.get(ant.prov);
      if (!provEntry) {
        provEntry = { count: 0, byOperator: {} };
        provMap.set(ant.prov, provEntry);
      }
      provEntry.count += 1;
      provEntry.byOperator[ant.op] = (provEntry.byOperator[ant.op] ?? 0) + 1;
    }
  }

  const updatedOperators = {} as Record<OperatorKey, OperatorSummary>;
  for (const opKey of OPERATOR_ORDER) {
    const prev = dataset.operators?.[opKey];
    const entities = Array.from(opEntities[opKey]).sort((a, b) =>
      a.localeCompare(b, 'es'),
    );
    const resolvedName =
      opKey === 'orange' &&
      (!prev?.name || prev.name === 'Orange España')
        ? OPERATOR_META.orange.name
        : prev?.name ?? OPERATOR_META[opKey].name;
    updatedOperators[opKey] = {
      key: opKey,
      name: resolvedName,
      count: opCounts[opKey],
      legalEntities:
        entities.length > 0
          ? entities
          : opCounts[opKey] > 0 && prev?.legalEntities
            ? prev.legalEntities
            : [],
    };
  }

  const updatedProvinces: ProvinceSummary[] = Array.from(provMap.entries())
    .map(([provincia, stats]) => {
      const orderedByOp: Partial<Record<OperatorKey, number>> = {};
      for (const opKey of OPERATOR_ORDER) {
        const count = stats.byOperator[opKey] ?? 0;
        if (count > 0) {
          orderedByOp[opKey] = count;
        }
      }
      return {
        provincia,
        count: stats.count,
        byOperator: orderedByOp,
      };
    })
    .sort(
      (a, b) =>
        b.count - a.count || a.provincia.localeCompare(b.provincia, 'es'),
    );

  return {
    ...dataset,
    total: fusedAntenas.length,
    crawlStats: {
      ...dataset.crawlStats,
      ...(fusionsCount > 0 ||
      dataset.crawlStats.xferaFusedIntoOrange !== undefined
        ? {
            xferaFusedIntoOrange:
              (dataset.crawlStats.xferaFusedIntoOrange ?? 0) + fusionsCount,
          }
        : {}),
      ...(dataset.crawlStats.bandsPopulatedCount !== undefined ||
      fusedBandsPopulated > 0
        ? { bandsPopulatedCount: fusedBandsPopulated }
        : {}),
    },
    operators: updatedOperators,
    provinces: updatedProvinces,
    antenas: fusedAntenas,
  };
}

/**
 * Fusiona de forma pura e idempotente declaraciones duplicadas de Vodafone a
 * estrictamente `< maxDistanceMeters` metros (por defecto 35 m) usando malla
 * espacial + Union-Find y recalcula totales por operador y provincia si hubo fusiones.
 * Las estaciones de Telefónica (`movistar`) y demás operadores jamás se fusionan consigo mismas.
 */
export function fuseVodafoneAntennasInDataset(
  dataset: AntenasDataset,
  maxDistanceMeters = 35,
): AntenasDataset {
  const { antenas } = dataset;
  if (maxDistanceMeters <= 0 || antenas.length <= 1) {
    return dataset;
  }

  const vodaIndices: number[] = [];
  for (let i = 0; i < antenas.length; i++) {
    if (antenas[i].op === 'vodafone') {
      vodaIndices.push(i);
    }
  }

  const n = vodaIndices.length;
  if (n <= 1) {
    return dataset;
  }

  const parent = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    parent[k] = k;
  }

  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) {
      root = parent[root];
    }
    let cur = x;
    while (cur !== root) {
      const next = parent[cur];
      parent[cur] = root;
      cur = next;
    }
    return root;
  };

  const cellDeg = Math.max(0.0006, maxDistanceMeters / 111320 / 0.65);
  const maxDistKm = maxDistanceMeters / 1000;
  const grid = new Map<number, number[]>();
  let fusionsCount = 0;

  for (let k = 0; k < n; k++) {
    const ant = antenas[vodaIndices[k]];
    const cx = Math.floor(ant.lat / cellDeg);
    const cy = Math.floor(ant.lon / cellDeg);

    for (let dx = -1; dx <= 1; dx++) {
      const rowBase = (cx + dx) * 4_000_000;
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(rowBase + (cy + dy));
        if (!bucket) continue;
        for (let b = 0; b < bucket.length; b++) {
          const otherK = bucket[b];
          const rootA = find(k);
          const rootB = find(otherK);
          if (rootA === rootB) continue;
          const otherAnt = antenas[vodaIndices[otherK]];
          if (
            haversineDistanceKm(ant.lat, ant.lon, otherAnt.lat, otherAnt.lon) <
            maxDistKm
          ) {
            parent[rootB] = rootA;
            fusionsCount++;
          }
        }
      }
    }

    const cellKey = cx * 4_000_000 + cy;
    const existing = grid.get(cellKey);
    if (existing) {
      existing.push(k);
    } else {
      grid.set(cellKey, [k]);
    }
  }

  if (fusionsCount === 0) {
    return dataset;
  }

  const components = new Map<number, AntennaRecord[]>();
  for (let k = 0; k < n; k++) {
    const root = find(k);
    const ant = antenas[vodaIndices[k]];
    const list = components.get(root);
    if (list) {
      list.push(ant);
    } else {
      components.set(root, [ant]);
    }
  }

  const mergedByRoot = new Map<number, AntennaRecord>();
  for (const [root, members] of components.entries()) {
    if (members.length === 1) {
      mergedByRoot.set(root, members[0]);
      continue;
    }

    const sortedMembers = [...members].sort(compareVodafoneCanonical);
    mergedByRoot.set(root, mergeAntennaComponentMembers(sortedMembers, true));
  }

  const emittedRoots = new Set<number>();
  const fusedAntenas: AntennaRecord[] = [];
  let vodaCursor = 0;

  for (let i = 0; i < antenas.length; i++) {
    const ant = antenas[i];
    if (ant.op !== 'vodafone') {
      fusedAntenas.push(ant);
      continue;
    }
    const root = find(vodaCursor++);
    if (!emittedRoots.has(root)) {
      emittedRoots.add(root);
      const mergedRec = mergedByRoot.get(root);
      if (mergedRec) {
        fusedAntenas.push(mergedRec);
      }
    }
  }

  const opCounts: Record<OperatorKey, number> = {
    movistar: 0,
    orange: 0,
    vodafone: 0,
    digi: 0,
    otros: 0,
  };
  const opEntities: Record<OperatorKey, Set<string>> = {
    movistar: new Set<string>(),
    orange: new Set<string>(),
    vodafone: new Set<string>(),
    digi: new Set<string>(),
    otros: new Set<string>(),
  };
  const provMap = new Map<
    string,
    { count: number; byOperator: Partial<Record<OperatorKey, number>> }
  >();
  let fusedBandsPopulated = 0;

  for (let i = 0; i < fusedAntenas.length; i++) {
    const ant = fusedAntenas[i];
    opCounts[ant.op] = (opCounts[ant.op] ?? 0) + 1;
    if (ant.opRaw) {
      opEntities[ant.op].add(ant.opRaw);
    }
    if (Array.isArray(ant.bandas)) {
      fusedBandsPopulated += 1;
    }
    if (ant.prov) {
      let provEntry = provMap.get(ant.prov);
      if (!provEntry) {
        provEntry = { count: 0, byOperator: {} };
        provMap.set(ant.prov, provEntry);
      }
      provEntry.count += 1;
      provEntry.byOperator[ant.op] = (provEntry.byOperator[ant.op] ?? 0) + 1;
    }
  }

  const updatedOperators = {} as Record<OperatorKey, OperatorSummary>;
  for (const opKey of OPERATOR_ORDER) {
    const prev = dataset.operators?.[opKey];
    const entities = Array.from(opEntities[opKey]).sort((a, b) =>
      a.localeCompare(b, 'es'),
    );
    updatedOperators[opKey] = {
      key: opKey,
      name: prev?.name ?? OPERATOR_META[opKey].name,
      count: opCounts[opKey],
      legalEntities:
        entities.length > 0
          ? entities
          : opCounts[opKey] > 0 && prev?.legalEntities
            ? prev.legalEntities
            : [],
    };
  }

  const updatedProvinces: ProvinceSummary[] = Array.from(provMap.entries())
    .map(([provincia, stats]) => {
      const orderedByOp: Partial<Record<OperatorKey, number>> = {};
      for (const opKey of OPERATOR_ORDER) {
        const count = stats.byOperator[opKey] ?? 0;
        if (count > 0) {
          orderedByOp[opKey] = count;
        }
      }
      return {
        provincia,
        count: stats.count,
        byOperator: orderedByOp,
      };
    })
    .sort(
      (a, b) =>
        b.count - a.count || a.provincia.localeCompare(b.provincia, 'es'),
    );

  return {
    ...dataset,
    total: fusedAntenas.length,
    crawlStats: {
      ...dataset.crawlStats,
      vodafoneFusedDuplicates:
        (dataset.crawlStats.vodafoneFusedDuplicates ?? 0) + fusionsCount,
      ...(dataset.crawlStats.bandsPopulatedCount !== undefined ||
      fusedBandsPopulated > 0
        ? { bandsPopulatedCount: fusedBandsPopulated }
        : {}),
    },
    operators: updatedOperators,
    provinces: updatedProvinces,
    antenas: fusedAntenas,
  };
}

const BIT_N258 = 1 << 0;
const BIT_N78 = 1 << 1;
const BIT_B7 = 1 << 2;
const BIT_B38 = 1 << 3;
const BIT_B1 = 1 << 4;
const BIT_B3 = 1 << 5;
const BIT_G9 = 1 << 6;
const BIT_B20 = 1 << 7;
const BIT_N28 = 1 << 8;
const BIT_SAW_2600_RANGE = 1 << 9;

const BAND_CODE_ENTRIES: ReadonlyArray<readonly [bit: number, code: string]> = [
  [BIT_N258, 'n258'],
  [BIT_N78, 'n78'],
  [BIT_B7, 'b7'],
  [BIT_B38, 'b38'],
  [BIT_B1, 'b1'],
  [BIT_B3, 'b3'],
  [BIT_G9, 'g9'],
  [BIT_B20, 'b20'],
  [BIT_N28, 'n28'],
];

const BAND_MASK_TEXT_CACHE = new Array<string | undefined>(512);
BAND_MASK_TEXT_CACHE[0] = '';

const FREQ_NUM_TOKEN_RE = /\d+(?:[.,]\d+)?/g;
const GHZ_UNIT_RE = /ghz/i;
const DIRECT_BAND_CODE_BITS: Readonly<Record<string, number>> = {
  n258: BIT_N258,
  n78: BIT_N78,
  b7: BIT_B7,
  b38: BIT_B38,
  b1: BIT_B1,
  b3: BIT_B3,
  g9: BIT_G9,
  b20: BIT_B20,
  n28: BIT_N28,
};

function parseDecimalToken(token: string): number {
  return token.includes(',') ? Number(token.replace(',', '.')) : Number(token);
}

function classifyFrequencyRangeBits(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  const directBit = DIRECT_BAND_CODE_BITS[trimmed.toLowerCase()];
  if (directBit !== undefined) {
    return directBit;
  }

  FREQ_NUM_TOKEN_RE.lastIndex = 0;
  const m1 = FREQ_NUM_TOKEN_RE.exec(trimmed);
  if (!m1) return 0;
  const m2 = FREQ_NUM_TOKEN_RE.exec(trimmed);
  const a = parseDecimalToken(m1[0]);
  const b = m2 ? parseDecimalToken(m2[0]) : a;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;

  let lo = a <= b ? a : b;
  let hi = a <= b ? b : a;
  if (GHZ_UNIT_RE.test(trimmed) && hi < 1000) {
    lo *= 1000;
    hi *= 1000;
  }

  if ((lo >= 24 && hi <= 29.5) || (lo >= 24000 && hi <= 29500)) {
    return BIT_N258;
  }
  if (lo >= 3300 && hi <= 3900) {
    return BIT_N78;
  }
  if (lo >= 2490 && hi <= 2700) {
    if (m2 !== null && lo >= 2570 && hi <= 2620) {
      return BIT_B38 | BIT_SAW_2600_RANGE;
    }
    if (m2 === null && lo > 2570 && hi < 2620 && lo !== 2600) {
      return BIT_B38 | BIT_SAW_2600_RANGE;
    }
    return BIT_B7 | BIT_SAW_2600_RANGE;
  }
  if (lo >= 1920 && hi <= 2170) {
    return BIT_B1;
  }
  if (lo >= 1710 && hi <= 1880) {
    return BIT_B3;
  }
  if (lo >= 880 && hi <= 960) {
    return BIT_G9;
  }
  if (lo >= 791 && hi <= 862) {
    return BIT_B20;
  }
  if (lo >= 703 && hi <= 788) {
    return BIT_N28;
  }
  return 0;
}

function classifyCommercialBandLabelBits(
  rawLabel: string,
  saw2600Range: boolean,
): number {
  const trimmed = rawLabel.trim();
  if (!trimmed) return 0;
  const directBit = DIRECT_BAND_CODE_BITS[trimmed.toLowerCase()];
  if (directBit !== undefined) {
    return directBit;
  }

  FREQ_NUM_TOKEN_RE.lastIndex = 0;
  const m = FREQ_NUM_TOKEN_RE.exec(trimmed);
  if (!m) return 0;
  let val = parseDecimalToken(m[0]);
  if (!Number.isFinite(val)) return 0;
  if (GHZ_UNIT_RE.test(trimmed) && val < 1000) {
    val *= 1000;
  }

  if ((val >= 24 && val <= 29.5) || (val >= 24000 && val <= 29500)) {
    return BIT_N258;
  }
  if (val >= 3300 && val <= 3900) {
    return BIT_N78;
  }
  if (val >= 2490 && val <= 2700) {
    return saw2600Range ? 0 : BIT_B7;
  }
  if (val >= 1920 && val <= 2170) {
    return BIT_B1;
  }
  if (val >= 1710 && val <= 1880) {
    return BIT_B3;
  }
  if (val >= 880 && val <= 960) {
    return BIT_G9;
  }
  if (val >= 791 && val <= 862) {
    return BIT_B20;
  }
  if (val >= 703 && val <= 788) {
    return BIT_N28;
  }
  return 0;
}

function deriveAntennaBandCodesText(ant: AntennaRecord): string {
  const { frecuencias, concesiones, bandas } = ant;
  if (
    (!frecuencias || frecuencias.length === 0) &&
    (!concesiones || concesiones.length === 0) &&
    (!bandas || bandas.length === 0)
  ) {
    return '';
  }

  let mask = 0;
  if (frecuencias) {
    for (let i = 0; i < frecuencias.length; i++) {
      mask |= classifyFrequencyRangeBits(frecuencias[i]);
    }
  }
  if (concesiones) {
    for (let i = 0; i < concesiones.length; i++) {
      mask |= classifyFrequencyRangeBits(concesiones[i].freq);
    }
  }
  if (bandas) {
    const saw2600Range = (mask & BIT_SAW_2600_RANGE) !== 0;
    for (let i = 0; i < bandas.length; i++) {
      mask |= classifyCommercialBandLabelBits(bandas[i], saw2600Range);
    }
  }

  const codeMask = mask & 0x1ff;
  const cached = BAND_MASK_TEXT_CACHE[codeMask];
  if (cached !== undefined) {
    return cached;
  }

  const parts: string[] = [];
  for (let i = 0; i < BAND_CODE_ENTRIES.length; i++) {
    const [bit, code] = BAND_CODE_ENTRIES[i];
    if ((codeMask & bit) !== 0) {
      parts.push(code);
    }
  }
  const joined = parts.join(' ');
  BAND_MASK_TEXT_CACHE[codeMask] = joined;
  return joined;
}

export function buildDerivedAntenasStructures(
  inputDataset: AntenasDataset,
): DerivedAntenasStructures {
  const fusedDataset = fuseVodafoneAntennasInDataset(
    fuseXferaIntoOrangeInDataset(inputDataset),
  );
  let normalizedAntenas: AntennaRecord[] | null = null;
  for (let i = 0; i < fusedDataset.antenas.length; i++) {
    const candidate = fusedDataset.antenas[i];
    if (
      Array.isArray(candidate.bandas) &&
      !isNormalizedBandsArray(candidate.bandas)
    ) {
      if (normalizedAntenas === null) {
        normalizedAntenas = fusedDataset.antenas.slice();
      }
      normalizedAntenas[i] = {
        ...candidate,
        bandas: normalizeAntennaBandsList(candidate.bandas),
      };
    }
  }
  const dataset: AntenasDataset =
    normalizedAntenas !== null
      ? { ...fusedDataset, antenas: normalizedAntenas }
      : fusedDataset;
  const { antenas } = dataset;

  const operatorCounts: Record<OperatorKey, number> = {
    movistar: 0,
    orange: 0,
    vodafone: 0,
    digi: 0,
    otros: 0,
  };

  const munMapByProv = new Map<string, Map<string, number>>();
  const uniqueMunSet = new Set<string>();
  const provAccum = new Map<
    string,
    { sumLat: number; sumLon: number; count: number; byOp: Partial<Record<OperatorKey, number>> }
  >();
  const bandCountsMap = new Map<string, number>();
  let bandsPopulatedCount = 0;
  const byId = new Map<string, AntennaRecord>();
  const byGid = new Map<string, AntennaRecord>();
  const searchIndex = new Array<string>(antenas.length);

  for (let i = 0; i < antenas.length; i++) {
    const ant = antenas[i];
    operatorCounts[ant.op] = (operatorCounts[ant.op] ?? 0) + 1;

    byId.set(ant.id, ant);
    if (!byGid.has(ant.gid)) {
      byGid.set(ant.gid, ant);
    }

    const normalizedAntBands = Array.isArray(ant.bandas)
      ? normalizeAntennaBandsList(ant.bandas)
      : undefined;

    if (normalizedAntBands !== undefined) {
      bandsPopulatedCount += 1;
      for (let b = 0; b < normalizedAntBands.length; b++) {
        const bandLabel = normalizedAntBands[b];
        bandCountsMap.set(bandLabel, (bandCountsMap.get(bandLabel) ?? 0) + 1);
      }
    }

    if (ant.prov) {
      let provEntry = provAccum.get(ant.prov);
      if (!provEntry) {
        provEntry = { sumLat: 0, sumLon: 0, count: 0, byOp: {} };
        provAccum.set(ant.prov, provEntry);
      }
      provEntry.sumLat += ant.lat;
      provEntry.sumLon += ant.lon;
      provEntry.count += 1;
      provEntry.byOp[ant.op] = (provEntry.byOp[ant.op] ?? 0) + 1;

      if (ant.mun) {
        uniqueMunSet.add(`${ant.prov}::${ant.mun}`);
        let munsInProv = munMapByProv.get(ant.prov);
        if (!munsInProv) {
          munsInProv = new Map<string, number>();
          munMapByProv.set(ant.prov, munsInProv);
        }
        munsInProv.set(ant.mun, (munsInProv.get(ant.mun) ?? 0) + 1);
      }
    }

    const extraGids =
      ant.mergedGids && ant.mergedGids.length > 0
        ? ant.mergedGids.join(' ')
        : '';
    const bandCodesText = deriveAntennaBandCodesText(ant);
    const antBandsArr = normalizedAntBands ?? [];
    const has26GhzBand = antBandsArr.includes('26 GHz');
    const hasN258Code = /\bn258\b/.test(bandCodesText);
    const bandsText = has26GhzBand
      ? `${antBandsArr.join(' ')} 26ghz`
      : hasN258Code
        ? `${antBandsArr.join(' ')} 26 ghz 26ghz`.trim()
        : antBandsArr.join(' ');
    const freqsText = (ant.frecuencias ?? []).join(' ');
    const concesionesText =
      ant.concesiones && ant.concesiones.length > 0
        ? ant.concesiones.map((c) => `${c.ref} ${c.freq}`).join(' ')
        : '';
    searchIndex[i] = normalizeSearchText(
      bandCodesText
        ? `${ant.gid} ${extraGids} ${ant.mun} ${ant.prov} ${ant.dir} ${ant.opRaw} ${ant.op} ${bandsText} ${freqsText} ${concesionesText} ${bandCodesText}`
        : `${ant.gid} ${extraGids} ${ant.mun} ${ant.prov} ${ant.dir} ${ant.opRaw} ${ant.op} ${bandsText} ${freqsText} ${concesionesText}`,
    );
  }

  for (let i = 0; i < antenas.length; i++) {
    const ant = antenas[i];
    if (!ant.mergedGids) continue;
    for (let g = 0; g < ant.mergedGids.length; g++) {
      const mgid = ant.mergedGids[g];
      if (mgid && !byGid.has(mgid)) {
        byGid.set(mgid, ant);
      }
    }
  }

  const availableBands: BandOption[] = Array.from(bandCountsMap.entries())
    .map(([band, count]) => ({ band, count }))
    .sort((a, b) => compareBandLabels(a.band, b.band));

  // Usar dataset.provinces si viene poblado, o construir desde provAccum como respaldo
  const rawProvinces: ProvinceSummary[] =
    dataset.provinces && dataset.provinces.length > 0
      ? dataset.provinces
      : Array.from(provAccum.entries()).map(([provincia, stats]) => ({
          provincia,
          count: stats.count,
          byOperator: stats.byOp,
        }));

  const provincesByCount = [...rawProvinces].sort((a, b) => b.count - a.count);
  const provincesByAlpha = [...rawProvinces].sort((a, b) =>
    a.provincia.localeCompare(b.provincia, 'es'),
  );

  const provincesByComunidad = new Map<string, ProvinceSummary[]>();
  for (let i = 0; i < provincesByAlpha.length; i++) {
    const provSummary = provincesByAlpha[i];
    const ccaa = getComunidadAutonomaByProvince(provSummary.provincia);
    if (!ccaa) continue;
    let group = provincesByComunidad.get(ccaa);
    if (!group) {
      group = [];
      provincesByComunidad.set(ccaa, group);
    }
    group.push(provSummary);
  }

  const comunidadesByAlpha: ComunidadSummary[] = Array.from(
    provincesByComunidad.entries(),
  )
    .map(([comunidad, provinces]) => ({
      comunidad,
      count: provinces.reduce((sum, p) => sum + p.count, 0),
      provinces,
    }))
    .sort((a, b) => a.comunidad.localeCompare(b.comunidad, 'es'));

  const municipalitiesByProvince = new Map<string, MunicipalityOption[]>();
  for (const [prov, muns] of munMapByProv.entries()) {
    const sortedMuns: MunicipalityOption[] = Array.from(muns.entries())
      .map(([mun, count]) => ({ mun, count }))
      .sort((a, b) => a.mun.localeCompare(b.mun, 'es'));
    municipalitiesByProvince.set(prov, sortedMuns);
  }

  const provinceCentroids = new Map<string, { lat: number; lon: number }>();
  const comunidadAccum = new Map<
    string,
    { sumLat: number; sumLon: number; count: number }
  >();
  for (const [prov, acc] of provAccum.entries()) {
    if (acc.count > 0) {
      provinceCentroids.set(prov, {
        lat: acc.sumLat / acc.count,
        lon: acc.sumLon / acc.count,
      });
      const ccaa = getComunidadAutonomaByProvince(prov);
      if (ccaa) {
        let ccaaAcc = comunidadAccum.get(ccaa);
        if (!ccaaAcc) {
          ccaaAcc = { sumLat: 0, sumLon: 0, count: 0 };
          comunidadAccum.set(ccaa, ccaaAcc);
        }
        ccaaAcc.sumLat += acc.sumLat;
        ccaaAcc.sumLon += acc.sumLon;
        ccaaAcc.count += acc.count;
      }
    }
  }

  const comunidadCentroids = new Map<string, { lat: number; lon: number }>();
  for (const [ccaa, acc] of comunidadAccum.entries()) {
    if (acc.count > 0) {
      comunidadCentroids.set(ccaa, {
        lat: acc.sumLat / acc.count,
        lon: acc.sumLon / acc.count,
      });
    }
  }

  // Respetar conteos del resumen si están presentes
  for (const opKey of OPERATOR_ORDER) {
    if (dataset.operators?.[opKey]?.count !== undefined && operatorCounts[opKey] === 0) {
      operatorCounts[opKey] = dataset.operators[opKey].count;
    }
  }

  return {
    dataset,
    comunidadesByAlpha,
    provincesByComunidad,
    comunidadCentroids,
    provincesByAlpha,
    provincesByCount,
    municipalitiesByProvince,
    totalUniqueMunicipalities: uniqueMunSet.size,
    operatorCounts,
    availableBands,
    bandsPopulatedCount,
    provinceCentroids,
    byId,
    byGid,
    searchIndex,
  };
}

function isPatchNewerOrEqual(
  patchScannedAt: string | undefined,
  existingScannedAt: string | undefined,
): boolean {
  if (!existingScannedAt || !patchScannedAt) {
    return true;
  }
  const patchMs = Date.parse(patchScannedAt);
  const existingMs = Date.parse(existingScannedAt);
  if (Number.isFinite(patchMs) && Number.isFinite(existingMs)) {
    return patchMs >= existingMs;
  }
  return patchScannedAt >= existingScannedAt;
}

function pickLatestDatasetIso(baseIso: string, deltaIso: string): string {
  if (!deltaIso) return baseIso;
  if (!baseIso) return deltaIso;
  const baseMs = Date.parse(baseIso);
  const deltaMs = Date.parse(deltaIso);
  if (Number.isFinite(baseMs) && Number.isFinite(deltaMs)) {
    return deltaMs >= baseMs ? deltaIso : baseIso;
  }
  return deltaIso >= baseIso ? deltaIso : baseIso;
}

function rebuildDatasetSummariesWithAntenas(
  baseDataset: AntenasDataset,
  antenas: AntennaRecord[],
  updatedAt: string,
): AntenasDataset {
  const opCounts: Record<OperatorKey, number> = {
    movistar: 0,
    orange: 0,
    vodafone: 0,
    digi: 0,
    otros: 0,
  };
  const opEntities: Record<OperatorKey, Set<string>> = {
    movistar: new Set<string>(),
    orange: new Set<string>(),
    vodafone: new Set<string>(),
    digi: new Set<string>(),
    otros: new Set<string>(),
  };
  const provMap = new Map<
    string,
    { count: number; byOperator: Partial<Record<OperatorKey, number>> }
  >();
  let bandsPopulatedCount = 0;

  for (let i = 0; i < antenas.length; i++) {
    const ant = antenas[i];
    opCounts[ant.op] = (opCounts[ant.op] ?? 0) + 1;
    if (ant.opRaw) {
      opEntities[ant.op].add(ant.opRaw);
    }
    if (Array.isArray(ant.bandas)) {
      bandsPopulatedCount += 1;
    }
    if (ant.prov) {
      let provEntry = provMap.get(ant.prov);
      if (!provEntry) {
        provEntry = { count: 0, byOperator: {} };
        provMap.set(ant.prov, provEntry);
      }
      provEntry.count += 1;
      provEntry.byOperator[ant.op] = (provEntry.byOperator[ant.op] ?? 0) + 1;
    }
  }

  const updatedOperators = {} as Record<OperatorKey, OperatorSummary>;
  for (const opKey of OPERATOR_ORDER) {
    const prev = baseDataset.operators?.[opKey];
    const entities = Array.from(opEntities[opKey]).sort((a, b) =>
      a.localeCompare(b, 'es'),
    );
    updatedOperators[opKey] = {
      key: opKey,
      name: prev?.name ?? OPERATOR_META[opKey].name,
      count: opCounts[opKey],
      legalEntities:
        entities.length > 0
          ? entities
          : opCounts[opKey] > 0 && prev?.legalEntities
            ? prev.legalEntities
            : [],
    };
  }

  const updatedProvinces: ProvinceSummary[] = Array.from(provMap.entries())
    .map(([provincia, stats]) => {
      const orderedByOp: Partial<Record<OperatorKey, number>> = {};
      for (const opKey of OPERATOR_ORDER) {
        const count = stats.byOperator[opKey] ?? 0;
        if (count > 0) {
          orderedByOp[opKey] = count;
        }
      }
      return {
        provincia,
        count: stats.count,
        byOperator: orderedByOp,
      };
    })
    .sort(
      (a, b) =>
        b.count - a.count || a.provincia.localeCompare(b.provincia, 'es'),
    );

  return {
    ...baseDataset,
    updatedAt,
    total: antenas.length,
    crawlStats: {
      ...baseDataset.crawlStats,
      bandsPopulatedCount,
    },
    operators: updatedOperators,
    provinces: updatedProvinces,
    antenas,
  };
}

/**
 * Fusiona en tiempo real los deltas publicados durante un escaneo activo (`newAntennas` + `bandPatches`)
 * sobre el censo base sin duplicar estaciones existentes y manteniendo intacta la separación de operadores.
 */
export function mergeLiveDeltaIntoAntenasDataset(
  baseDataset: AntenasDataset,
  delta: LiveScanMergedDelta | null | undefined,
): AntenasDataset {
  if (!delta) {
    return baseDataset;
  }

  if (delta.completedDatasetUpdatedAt) {
    const baseMs = Date.parse(baseDataset.updatedAt);
    const doneMs = Date.parse(delta.completedDatasetUpdatedAt);
    if (Number.isFinite(baseMs) && Number.isFinite(doneMs) && baseMs >= doneMs) {
      return baseDataset;
    }
  }

  if (
    delta.newAntennas.length === 0 &&
    delta.bandPatchesById.size === 0 &&
    delta.bandPatchesByGid.size === 0
  ) {
    return baseDataset;
  }

  const baseAntenas = baseDataset.antenas;
  const mergedAntenas: AntennaRecord[] = new Array(baseAntenas.length);
  const existingIndexById = new Map<string, number>();
  const existingIndexByOpGid = new Map<string, number>();
  let anyChanged = false;
  let normalizedBaseLegacyOp = false;

  for (let i = 0; i < baseAntenas.length; i++) {
    const rawBaseAnt = baseAntenas[i];
    const normBaseOp =
      normalizeOperatorKeyInput(rawBaseAnt.op, rawBaseAnt.opRaw) ??
      rawBaseAnt.op;
    const ant =
      normBaseOp !== rawBaseAnt.op
        ? { ...rawBaseAnt, op: normBaseOp }
        : rawBaseAnt;
    if (ant !== rawBaseAnt) {
      anyChanged = true;
      normalizedBaseLegacyOp = true;
    }

    existingIndexById.set(ant.id, i);
    if (ant.gid) {
      existingIndexByOpGid.set(`${ant.op}::${ant.gid}`, i);
    }
    if (ant.mergedGids) {
      for (let g = 0; g < ant.mergedGids.length; g++) {
        const mgid = ant.mergedGids[g];
        if (mgid) {
          existingIndexByOpGid.set(`${ant.op}::${mgid}`, i);
        }
      }
    }

    let patch = delta.bandPatchesById.get(ant.id);
    if (
      !patch &&
      (ant.op === 'vodafone' || ant.op === 'orange') &&
      ant.mergedGids
    ) {
      for (let g = 0; g < ant.mergedGids.length; g++) {
        const candidatePatch = delta.bandPatchesByGid.get(ant.mergedGids[g]);
        if (candidatePatch) {
          patch = candidatePatch;
          break;
        }
      }
    }

    if (patch && isPatchNewerOrEqual(patch.bandsScannedAt, ant.bandsScannedAt)) {
      const nextMergedGids = patch.mergedGids ?? ant.mergedGids;
      mergedAntenas[i] = {
        ...ant,
        ...(nextMergedGids !== undefined ? { mergedGids: nextMergedGids } : {}),
        bandas: normalizeAntennaBandsList(patch.bandas),
        frecuencias: patch.frecuencias,
        concesiones: patch.concesiones,
        bandsScannedAt: patch.bandsScannedAt,
      };
      anyChanged = true;
    } else {
      mergedAntenas[i] = ant;
    }
  }

  let addedCount = 0;
  let addedOrange = false;
  let addedVodafone = false;

  for (let i = 0; i < delta.newAntennas.length; i++) {
    const rawNew = delta.newAntennas[i];
    const normalizedNewOp =
      normalizeOperatorKeyInput(rawNew.op, rawNew.opRaw) ?? rawNew.op;
    const newPatch = delta.bandPatchesById.get(rawNew.id);
    const nextNewMergedGids = newPatch?.mergedGids ?? rawNew.mergedGids;
    const candidate: AntennaRecord =
      newPatch &&
      isPatchNewerOrEqual(newPatch.bandsScannedAt, rawNew.bandsScannedAt)
        ? {
            ...rawNew,
            op: normalizedNewOp,
            ...(nextNewMergedGids !== undefined
              ? { mergedGids: nextNewMergedGids }
              : {}),
            bandas: normalizeAntennaBandsList(newPatch.bandas),
            frecuencias: newPatch.frecuencias,
            concesiones: newPatch.concesiones,
            bandsScannedAt: newPatch.bandsScannedAt,
          }
        : rawNew.bandas !== undefined
          ? {
              ...rawNew,
              op: normalizedNewOp,
              bandas: normalizeAntennaBandsList(rawNew.bandas),
            }
          : { ...rawNew, op: normalizedNewOp };

    let existingIdx = existingIndexById.get(candidate.id);
    const canReuseOpGidIndex = (idx: number | undefined): boolean => {
      if (idx === undefined) return false;
      if (candidate.op !== 'orange') return true;
      const existing = mergedAntenas[idx];
      return (
        isXferaLegalEntity(existing.opRaw) ===
        isXferaLegalEntity(candidate.opRaw)
      );
    };

    if (existingIdx === undefined && candidate.gid) {
      const foundByGid = existingIndexByOpGid.get(
        `${candidate.op}::${candidate.gid}`,
      );
      if (canReuseOpGidIndex(foundByGid)) {
        existingIdx = foundByGid;
      }
    }
    if (existingIdx === undefined && candidate.mergedGids) {
      for (let g = 0; g < candidate.mergedGids.length; g++) {
        const mgid = candidate.mergedGids[g];
        if (mgid) {
          const foundIdx = existingIndexByOpGid.get(
            `${candidate.op}::${mgid}`,
          );
          if (canReuseOpGidIndex(foundIdx)) {
            existingIdx = foundIdx;
            break;
          }
        }
      }
    }

    if (existingIdx !== undefined) {
      const current = mergedAntenas[existingIdx];
      if (
        candidate.bandas !== undefined &&
        isPatchNewerOrEqual(candidate.bandsScannedAt, current.bandsScannedAt)
      ) {
        const mergedGids = candidate.mergedGids ?? current.mergedGids;
        mergedAntenas[existingIdx] = {
          ...current,
          ...(mergedGids !== undefined ? { mergedGids } : {}),
          bandas: candidate.bandas,
          ...(candidate.frecuencias !== undefined
            ? { frecuencias: candidate.frecuencias }
            : {}),
          ...(candidate.concesiones !== undefined
            ? { concesiones: candidate.concesiones }
            : {}),
          ...(candidate.bandsScannedAt !== undefined
            ? { bandsScannedAt: candidate.bandsScannedAt }
            : {}),
        };
        anyChanged = true;
      }
      continue;
    }

    const insertedIdx = mergedAntenas.length;
    mergedAntenas.push(candidate);
    existingIndexById.set(candidate.id, insertedIdx);
    if (candidate.gid) {
      existingIndexByOpGid.set(
        `${candidate.op}::${candidate.gid}`,
        insertedIdx,
      );
    }
    if (candidate.mergedGids) {
      for (let g = 0; g < candidate.mergedGids.length; g++) {
        const mgid = candidate.mergedGids[g];
        if (mgid) {
          existingIndexByOpGid.set(`${candidate.op}::${mgid}`, insertedIdx);
        }
      }
    }
    addedCount += 1;
    if (candidate.op === 'orange') {
      addedOrange = true;
    } else if (candidate.op === 'vodafone') {
      addedVodafone = true;
    }
    anyChanged = true;
  }

  if (!anyChanged) {
    return baseDataset;
  }

  const nextUpdatedAt = pickLatestDatasetIso(
    baseDataset.updatedAt,
    delta.updatedAt,
  );

  if (addedCount === 0 && !normalizedBaseLegacyOp) {
    let bandsPopulatedCount = 0;
    for (let i = 0; i < mergedAntenas.length; i++) {
      if (Array.isArray(mergedAntenas[i].bandas)) {
        bandsPopulatedCount += 1;
      }
    }
    return {
      ...baseDataset,
      updatedAt: nextUpdatedAt,
      total: mergedAntenas.length,
      crawlStats: {
        ...baseDataset.crawlStats,
        bandsPopulatedCount,
      },
      antenas: mergedAntenas,
    };
  }

  let result = rebuildDatasetSummariesWithAntenas(
    baseDataset,
    mergedAntenas,
    nextUpdatedAt,
  );
  if (addedOrange || normalizedBaseLegacyOp) {
    result = fuseXferaIntoOrangeInDataset(result, 30);
  }
  if (addedVodafone) {
    result = fuseVodafoneAntennasInDataset(result, 35);
  }
  return result;
}

export function useAntenasData() {
  const query = useQuery({
    queryKey: ['antenas-dataset'],
    queryFn: importAntenasJsonDataset,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 2,
  });

  const liveDelta = useLiveScanDelta();

  const mergedData = useMemo(
    () =>
      query.data
        ? mergeLiveDeltaIntoAntenasDataset(
            fuseVodafoneAntennasInDataset(
              fuseXferaIntoOrangeInDataset(query.data),
            ),
            liveDelta,
          )
        : undefined,
    [query.data, liveDelta],
  );

  const derived = useMemo(
    () => (mergedData ? buildDerivedAntenasStructures(mergedData) : null),
    [mergedData],
  );

  return {
    ...query,
    data: mergedData,
    derived,
  };
}

function buildNormalizedBandsSet(bands: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < bands.length; i++) {
    const normalized = normalizeCommercialBandLabel(bands[i]);
    if (normalized) {
      set.add(normalized);
    }
  }
  return set;
}

function matchesNormalizedBandsSet(
  antBands: readonly string[] | undefined,
  selectedSet: ReadonlySet<string>,
  exclusiveBands: boolean,
): boolean {
  if (selectedSet.size === 0) {
    return true;
  }
  if (!antBands || antBands.length === 0) {
    return false;
  }
  if (!exclusiveBands) {
    for (let i = 0; i < antBands.length; i++) {
      const b = normalizeCommercialBandLabel(antBands[i]);
      if (b && selectedSet.has(b)) {
        return true;
      }
    }
    return false;
  }

  if (antBands.length < selectedSet.size) {
    return false;
  }

  if (selectedSet.size === 1) {
    let matchedSingle = false;
    for (let i = 0; i < antBands.length; i++) {
      const b = normalizeCommercialBandLabel(antBands[i]);
      if (!b) continue;
      if (!selectedSet.has(b)) {
        return false;
      }
      matchedSingle = true;
    }
    return matchedSingle;
  }

  const seen = new Set<string>();
  for (let i = 0; i < antBands.length; i++) {
    const b = normalizeCommercialBandLabel(antBands[i]);
    if (!b) continue;
    if (!selectedSet.has(b)) {
      return false;
    }
    seen.add(b);
  }
  return seen.size === selectedSet.size;
}

/**
 * Evalúa si las bandas de una antena cumplen el filtro multifrecuencia:
 * - Modo por defecto (`exclusiveBands = false`): unión (OR), basta con tener al menos 1 de las bandas seleccionadas.
 * - Modo `"Exclusivamente"` (`exclusiveBands = true`): coincidencia exacta de conjunto ("ni más ni menos").
 */
export function matchesAntennaBandsFilter(
  antBands: readonly string[] | undefined,
  selectedBands: readonly string[],
  exclusiveBands: boolean,
): boolean {
  const selectedSet = buildNormalizedBandsSet(selectedBands);
  return matchesNormalizedBandsSet(antBands, selectedSet, exclusiveBands);
}

export interface AntenasFilterInput {
  derived: DerivedAntenasStructures | null;
  searchQuery: string;
  selectedComunidad?: string;
  selectedProvince: string;
  selectedMunicipality?: string;
  activeOperators: OperatorKey[];
  selectedBand?: string;
  selectedBands?: string[];
  exclusiveBands?: boolean;
}

interface SearchMatcher {
  token: string;
  exactWord: boolean;
}

const RF_BAND_CODE_TOKEN_RE = /^(n258|n78|n28|b38|b20|b7|b3|b1|g9)$/;

function buildSearchMatchers(normalizedQuery: string): SearchMatcher[] {
  if (!normalizedQuery) return [];
  const matchers: SearchMatcher[] = [];
  const bandRegex = /\b(\d+(?:[.,]\d+)?)\s*(mhz|ghz)\b/g;
  const remainder = normalizedQuery.replace(
    bandRegex,
    (_full, num: string, unit: string) => {
      const parsedNum = Number(num.replace(',', '.'));
      if (
        (num === '26' || num === '27') &&
        (unit === 'mhz' || unit === 'ghz')
      ) {
        matchers.push({ token: '26 ghz', exactWord: true });
      } else if (
        Number.isFinite(parsedNum) &&
        parsedNum >= 24 &&
        parsedNum <= 29.5
      ) {
        matchers.push({ token: '26 ghz', exactWord: true });
      } else {
        matchers.push({ token: `${num} ${unit}`, exactWord: true });
      }
      return ' ';
    },
  );
  const plainTokens = remainder.split(/\s+/).filter(Boolean);
  for (let i = 0; i < plainTokens.length; i++) {
    const rawTok = plainTokens[i];
    const strippedTok = rawTok.replace(/^[,;]+|[,;]+$/g, '');
    if (RF_BAND_CODE_TOKEN_RE.test(strippedTok)) {
      matchers.push({ token: strippedTok, exactWord: true });
    } else {
      matchers.push({ token: rawTok, exactWord: false });
    }
  }
  return matchers;
}

export function filterAntenas({
  derived,
  searchQuery,
  selectedComunidad = '',
  selectedProvince,
  selectedMunicipality = '',
  activeOperators,
  selectedBand = '',
  selectedBands,
  exclusiveBands = false,
}: AntenasFilterInput): AntennaRecord[] {
  if (!derived) return [];
  const { antenas } = derived.dataset;
  const { searchIndex } = derived;

  if (activeOperators.length === 0) return [];

  const allOpsSelected = activeOperators.length === OPERATOR_ORDER.length;
  const opSet = allOpsSelected ? null : new Set<OperatorKey>(activeOperators);
  const targetComunidad = selectedComunidad.trim();

  const rawBands =
    selectedBands !== undefined
      ? selectedBands
      : selectedBand && selectedBand.trim()
        ? [selectedBand.trim()]
        : [];
  const selectedBandsSet = buildNormalizedBandsSet(rawBands);

  // Si el usuario escribe coordenadas válidas ("40.4168, -3.7038"), no filtramos el texto literal
  // para que pueda ver las antenas alrededor de ese punto en el mapa.
  const isCoordQuery = parseCoordinateInput(searchQuery) !== null;
  const normalizedQuery = isCoordQuery ? '' : normalizeSearchText(searchQuery);
  const matchers = buildSearchMatchers(normalizedQuery);

  if (
    allOpsSelected &&
    !targetComunidad &&
    !selectedProvince &&
    !selectedMunicipality &&
    selectedBandsSet.size === 0 &&
    matchers.length === 0
  ) {
    return antenas;
  }

  const result: AntennaRecord[] = [];
  for (let i = 0; i < antenas.length; i++) {
    const ant = antenas[i];
    if (opSet && !opSet.has(ant.op)) continue;
    if (selectedProvince && ant.prov !== selectedProvince) continue;
    if (
      targetComunidad &&
      getComunidadAutonomaByProvince(ant.prov) !== targetComunidad
    ) {
      continue;
    }
    if (selectedMunicipality && ant.mun !== selectedMunicipality) continue;
    if (
      selectedBandsSet.size > 0 &&
      !matchesNormalizedBandsSet(ant.bandas, selectedBandsSet, exclusiveBands)
    ) {
      continue;
    }

    if (matchers.length > 0) {
      const hay = searchIndex[i];
      let paddedHay: string | null = null;
      let matchesAll = true;
      for (let t = 0; t < matchers.length; t++) {
        const m = matchers[t];
        if (m.exactWord) {
          if (paddedHay === null) paddedHay = ` ${hay} `;
          if (!paddedHay.includes(` ${m.token} `)) {
            matchesAll = false;
            break;
          }
        } else if (!hay.includes(m.token)) {
          matchesAll = false;
          break;
        }
      }
      if (!matchesAll) continue;
    }

    result.push(ant);
  }

  return result;
}

export function useFilteredAntenas({
  derived,
  searchQuery,
  selectedComunidad = '',
  selectedProvince,
  selectedMunicipality = '',
  activeOperators,
  selectedBand = '',
  selectedBands,
  exclusiveBands = false,
}: AntenasFilterInput): AntennaRecord[] {
  return useMemo(
    () =>
      filterAntenas({
        derived,
        searchQuery,
        selectedComunidad,
        selectedProvince,
        selectedMunicipality,
        activeOperators,
        selectedBand,
        selectedBands,
        exclusiveBands,
      }),
    [
      derived,
      searchQuery,
      selectedComunidad,
      selectedProvince,
      selectedMunicipality,
      activeOperators,
      selectedBand,
      selectedBands,
      exclusiveBands,
    ],
  );
}
