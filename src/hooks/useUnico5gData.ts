import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AntennaRecord } from '../types/antena';
import {
  UNICO_OPERATOR_META,
  UNICO_OPERATOR_ORDER,
  type UnicoAntennaRecord,
  type UnicoDataset,
  type UnicoDeclaredBandFilter,
  type UnicoDeclaredOperatorSummary,
  type UnicoDeclaredSummary,
  type UnicoEntityBreakdown,
  type UnicoFase,
  type UnicoFaseFilter,
  type UnicoOperatorDatasetSummary,
  type UnicoOperatorKey,
  type UnicoRouteSearch,
  type UnicoSimpleSummary,
  type UnicoTerritoryTab,
} from '../types/unico5g';
import { normalizeSearchText } from '../utils/export';
import { haversineDistanceKm } from '../utils/geo';
import {
  computeAntennaRfBandMask,
  useAntenasData,
  type DerivedAntenasStructures,
} from './useAntenasData';

const VALID_UNICO_OPERATORS = new Set<string>(UNICO_OPERATOR_ORDER);

/** Radio máximo en kilómetros (1000 metros) para considerar una antena real como correspondiente a la coordenada oficial UNICO 5G */
export const UNICO_MAX_MATCH_DISTANCE_KM = 1.0;

/** Bits RF alineados con computeAntennaRfBandMask en useAntenasData.ts */
export const UNICO_BIT_N28 = 1 << 0;
export const UNICO_BIT_N28_PLUS = 1 << 1;
export const UNICO_BIT_N78 = 1 << 9;
export const UNICO_DECLARED_ANY_MASK =
  UNICO_BIT_N28 | UNICO_BIT_N28_PLUS | UNICO_BIT_N78;

const ES_INT_FORMATTER = new Intl.NumberFormat('es-ES', {
  useGrouping: 'always',
  maximumFractionDigits: 0,
});

export function formatUnicoInt(value: number): string {
  return ES_INT_FORMATTER.format(Math.round(value));
}

export function formatUnicoPercent(
  part: number,
  total: number,
  decimals = 1,
): string {
  const pct = total > 0 ? (part / total) * 100 : 0;
  return `${pct.toLocaleString('es-ES', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}%`;
}

/**
 * Etiquetas legibles de las 50 provincias de concurrencia (idénticas a las de los Excel oficiales y la vista de referencia).
 */
export const UNICO_PROVINCE_LABELS: ReadonlyArray<{
  prov: string;
  label: string;
}> = [
  { prov: 'ALBACETE', label: 'Albacete' },
  { prov: 'ALICANTE', label: 'Alicante/Alacant' },
  { prov: 'ALMERÍA', label: 'Almería' },
  { prov: 'ÁLAVA', label: 'Araba/Álava' },
  { prov: 'ASTURIAS', label: 'Asturias' },
  { prov: 'ÁVILA', label: 'Ávila' },
  { prov: 'BADAJOZ', label: 'Badajoz' },
  { prov: 'ILLES BALEARS', label: 'Balears, Illes' },
  { prov: 'BARCELONA', label: 'Barcelona' },
  { prov: 'BIZKAIA', label: 'Bizkaia' },
  { prov: 'BURGOS', label: 'Burgos' },
  { prov: 'CÁCERES', label: 'Cáceres' },
  { prov: 'CÁDIZ', label: 'Cádiz' },
  { prov: 'CANTABRIA', label: 'Cantabria' },
  { prov: 'CASTELLÓN', label: 'Castellón/Castelló' },
  { prov: 'CIUDAD REAL', label: 'Ciudad Real' },
  { prov: 'CÓRDOBA', label: 'Córdoba' },
  { prov: 'A CORUÑA', label: 'Coruña, A' },
  { prov: 'CUENCA', label: 'Cuenca' },
  { prov: 'GIPUZKOA', label: 'Gipuzkoa' },
  { prov: 'GIRONA', label: 'Girona' },
  { prov: 'GRANADA', label: 'Granada' },
  { prov: 'GUADALAJARA', label: 'Guadalajara' },
  { prov: 'HUELVA', label: 'Huelva' },
  { prov: 'HUESCA', label: 'Huesca' },
  { prov: 'JAÉN', label: 'Jaén' },
  { prov: 'LEÓN', label: 'León' },
  { prov: 'LLEIDA', label: 'Lleida' },
  { prov: 'LUGO', label: 'Lugo' },
  { prov: 'MADRID', label: 'Madrid' },
  { prov: 'MÁLAGA', label: 'Málaga' },
  { prov: 'MURCIA', label: 'Murcia' },
  { prov: 'NAVARRA', label: 'Navarra' },
  { prov: 'OURENSE', label: 'Ourense' },
  { prov: 'PALENCIA', label: 'Palencia' },
  { prov: 'LAS PALMAS', label: 'Palmas, Las' },
  { prov: 'PONTEVEDRA', label: 'Pontevedra' },
  { prov: 'LA RIOJA', label: 'Rioja, La' },
  { prov: 'SALAMANCA', label: 'Salamanca' },
  { prov: 'SANTA CRUZ DE TENERIFE', label: 'Santa Cruz de Tenerife' },
  { prov: 'SEGOVIA', label: 'Segovia' },
  { prov: 'SEVILLA', label: 'Sevilla' },
  { prov: 'SORIA', label: 'Soria' },
  { prov: 'TARRAGONA', label: 'Tarragona' },
  { prov: 'TERUEL', label: 'Teruel' },
  { prov: 'TOLEDO', label: 'Toledo' },
  { prov: 'VALENCIA', label: 'Valencia/València' },
  { prov: 'VALLADOLID', label: 'Valladolid' },
  { prov: 'ZAMORA', label: 'Zamora' },
  { prov: 'ZARAGOZA', label: 'Zaragoza' },
] as const;

export const UNICO_COMUNIDAD_LIST: readonly string[] = [
  'Andalucía',
  'Aragón',
  'Canarias',
  'Cantabria',
  'Castilla-La Mancha',
  'Castilla y León',
  'Cataluña',
  'Comunidad de Madrid',
  'Comunidad Foral de Navarra',
  'Comunidad Valenciana',
  'Extremadura',
  'Galicia',
  'Illes Balears',
  'La Rioja',
  'País Vasco',
  'Principado de Asturias',
  'Región de Murcia',
] as const;

export function isUnicoOperatorKey(value: unknown): value is UnicoOperatorKey {
  return typeof value === 'string' && VALID_UNICO_OPERATORS.has(value);
}

/**
 * Agrupa cualquier proyecto de Orange, UTE Orange, Xfera/MasOrange y Avatel en el único operador 'orange'.
 */
export function normalizeUnicoOperatorInput(raw: string): UnicoOperatorKey {
  const norm = normalizeSearchText(raw).toUpperCase();
  if (
    norm.includes('ORANGE') ||
    norm.includes('MASORANGE') ||
    norm.includes('XFERA') ||
    norm.includes('MASMOVIL') ||
    norm.includes('AVATEL')
  ) {
    return 'orange';
  }
  if (norm.includes('TELEFONICA') || norm.includes('MOVISTAR')) {
    return 'movistar';
  }
  if (norm.includes('VODAFONE')) {
    return 'vodafone';
  }
  return 'orange';
}

function isValidNonNegativeInt(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function parseOptionalDeclaredSummary(
  raw: unknown,
): UnicoDeclaredSummary | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  if (
    !isValidNonNegativeInt(obj.total) ||
    !isValidNonNegativeInt(obj.declared) ||
    !obj.byBand ||
    typeof obj.byBand !== 'object' ||
    Array.isArray(obj.byBand) ||
    !obj.byOperator ||
    typeof obj.byOperator !== 'object' ||
    Array.isArray(obj.byOperator)
  ) {
    return undefined;
  }

  const rawByBand = obj.byBand as Record<string, unknown>;
  if (
    !isValidNonNegativeInt(rawByBand.all) ||
    !isValidNonNegativeInt(rawByBand.N78) ||
    !isValidNonNegativeInt(rawByBand.N28) ||
    !isValidNonNegativeInt(rawByBand['N28+'])
  ) {
    return undefined;
  }

  const rawByOp = obj.byOperator as Record<string, unknown>;
  const byOperator = {} as Record<
    UnicoOperatorKey,
    UnicoDeclaredOperatorSummary
  >;
  for (const opKey of UNICO_OPERATOR_ORDER) {
    const opRaw = rawByOp[opKey];
    if (!opRaw || typeof opRaw !== 'object' || Array.isArray(opRaw)) {
      return undefined;
    }
    const opObj = opRaw as Record<string, unknown>;
    if (
      !isValidNonNegativeInt(opObj.total) ||
      !isValidNonNegativeInt(opObj.declared) ||
      !isValidNonNegativeInt(opObj.N78) ||
      !isValidNonNegativeInt(opObj.N28) ||
      !isValidNonNegativeInt(opObj['N28+'])
    ) {
      return undefined;
    }
    byOperator[opKey] = {
      total: opObj.total,
      declared: opObj.declared,
      N78: opObj.N78,
      N28: opObj.N28,
      'N28+': opObj['N28+'],
    };
  }

  return {
    total: obj.total,
    declared: obj.declared,
    byBand: {
      all: rawByBand.all,
      N78: rawByBand.N78,
      N28: rawByBand.N28,
      'N28+': rawByBand['N28+'],
    },
    byOperator,
  };
}

export function parseCustomUnico5gJson(raw: unknown): UnicoDataset {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('El dataset UNICO 5G no es un objeto JSON válido.');
  }

  const obj = raw as Record<string, unknown>;
  if (obj.type === 'FeatureCollection' || Array.isArray(obj.features)) {
    throw new Error('Formato GeoJSON no permitido en unico-5g.json.');
  }

  if (!Array.isArray(obj.antenas)) {
    throw new Error('El campo "antenas" debe ser un array en unico-5g.json.');
  }

  const rawAntenas = obj.antenas as unknown[];
  const antenas: UnicoAntennaRecord[] = new Array(rawAntenas.length);
  let fase1Count = 0;
  let fase2Count = 0;

  for (let i = 0; i < rawAntenas.length; i++) {
    const item = rawAntenas[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Registro UNICO 5G inválido en posición ${i}.`);
    }
    const rec = item as Record<string, unknown>;
    if (rec.type === 'Feature' || rec.geometry !== undefined) {
      throw new Error(`Fila GeoJSON no permitida en posición ${i}.`);
    }
    if (
      'emplazamiento' in rec ||
      'codigoEmplazamiento' in rec ||
      'idPropietario' in rec
    ) {
      throw new Error(
        `Campos prohibidos (código de emplazamiento / id de propietario) detectados en fila ${i}.`,
      );
    }

    const faseRaw = rec.fase;
    if (faseRaw !== 1 && faseRaw !== 2) {
      throw new Error(`Fase inválida (${String(faseRaw)}) en posición ${i}.`);
    }
    const fase: UnicoFase = faseRaw;
    if (fase === 1) fase1Count++;
    else fase2Count++;

    const empresa = typeof rec.empresa === 'string' ? rec.empresa.trim() : '';
    const op: UnicoOperatorKey =
      rec.op === 'avatel' || normalizeUnicoOperatorInput(empresa) === 'orange'
        ? 'orange'
        : isUnicoOperatorKey(rec.op)
          ? rec.op
          : normalizeUnicoOperatorInput(empresa);

    const lat = Number(rec.lat);
    const lon = Number(rec.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error(`Coordenadas inválidas en posición ${i}.`);
    }

    const ccaa = typeof rec.ccaa === 'string' ? rec.ccaa.trim() : '';
    const prov = typeof rec.prov === 'string' ? rec.prov.trim() : '';
    const mun = typeof rec.mun === 'string' ? rec.mun.trim() : '';
    if (!ccaa || !prov || !mun) {
      throw new Error(`Territorio incompleto en posición ${i}.`);
    }

    antenas[i] = {
      id: typeof rec.id === 'string' && rec.id ? rec.id : `u5g-${i + 1}`,
      fase,
      op,
      empresa,
      ccaa,
      prov,
      mun,
      lat,
      lon,
    };
  }

  const operators = {} as Record<UnicoOperatorKey, UnicoOperatorDatasetSummary>;
  for (const opKey of UNICO_OPERATOR_ORDER) {
    const opItems = antenas.filter((a) => a.op === opKey);
    const f1 = opItems.filter((a) => a.fase === 1).length;
    const f2 = opItems.filter((a) => a.fase === 2).length;
    const byEnt = new Map<string, { total: number; fase1: number; fase2: number }>();
    for (const a of opItems) {
      const cur = byEnt.get(a.empresa) ?? { total: 0, fase1: 0, fase2: 0 };
      cur.total += 1;
      if (a.fase === 1) cur.fase1 += 1;
      else cur.fase2 += 1;
      byEnt.set(a.empresa, cur);
    }
    const entities: UnicoEntityBreakdown[] = Array.from(byEnt.entries())
      .sort((a, b) => a[0].localeCompare(b[0], 'es'))
      .map(([empresa, counts]) => ({ empresa, ...counts }));

    operators[opKey] = {
      key: opKey,
      label: UNICO_OPERATOR_META[opKey].name,
      total: opItems.length,
      fase1: f1,
      fase2: f2,
      proyectosFase2: 0,
      entities,
    };
  }

  const declaredUpdatedAt =
    typeof obj.declaredUpdatedAt === 'string' &&
    obj.declaredUpdatedAt.trim().length > 0
      ? obj.declaredUpdatedAt.trim()
      : undefined;

  let declaredMasks: number[] | undefined;
  if (
    Array.isArray(obj.declaredMasks) &&
    obj.declaredMasks.length === antenas.length
  ) {
    const rawMasks = obj.declaredMasks as unknown[];
    const parsedMasks: number[] = new Array(rawMasks.length);
    let masksValid = true;
    for (let i = 0; i < rawMasks.length; i++) {
      const value = rawMasks[i];
      if (!isValidNonNegativeInt(value)) {
        masksValid = false;
        break;
      }
      parsedMasks[i] = value & UNICO_DECLARED_ANY_MASK;
    }
    if (masksValid) {
      declaredMasks = parsedMasks;
    }
  }

  const declaredSummary = parseOptionalDeclaredSummary(obj.declaredSummary);

  return {
    schemaVersion: typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 1,
    program:
      typeof obj.program === 'string' ? obj.program : 'UNICO 5G Redes Activas',
    updatedAt:
      typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
    ...(declaredUpdatedAt !== undefined ? { declaredUpdatedAt } : {}),
    total: antenas.length,
    fase1Total: fase1Count,
    fase2Total: fase2Count,
    fase2ProjectsTotal:
      typeof obj.fase2ProjectsTotal === 'number' ? obj.fase2ProjectsTotal : 73,
    operators,
    antenas,
    ...(declaredMasks !== undefined ? { declaredMasks } : {}),
    ...(declaredSummary !== undefined ? { declaredSummary } : {}),
  };
}

export function validateUnico5gSearch(
  search: Record<string, unknown>,
): UnicoRouteSearch {
  const result: UnicoRouteSearch = {};

  if (search.tab === 'comunidad' || search.tab === 'provincia') {
    if (search.tab === 'comunidad') {
      result.tab = 'comunidad' as UnicoTerritoryTab;
    }
  }

  if (search.fase === '1' || search.fase === 1) {
    result.fase = '1';
  } else if (search.fase === '2' || search.fase === 2) {
    result.fase = '2';
  }

  if (
    search.band === 'N78' ||
    search.band === 'N28' ||
    search.band === 'N28+'
  ) {
    result.band = search.band;
  }

  if (typeof search.provs === 'string' && search.provs.trim().length > 0) {
    result.provs = search.provs.trim();
  }
  if (typeof search.ccaas === 'string' && search.ccaas.trim().length > 0) {
    result.ccaas = search.ccaas.trim();
  }

  return result;
}

const GRID_CELL_DEG = 0.02; // ~2.22 km lat, ~1.61 km lon a 44°N (> 1.0 km en toda España)

interface IndexedRealStation {
  lat: number;
  lon: number;
  declaredBits: number;
}

function resolveRealStationUnicoOp(ant: AntennaRecord): UnicoOperatorKey | null {
  if (ant.op === 'movistar') return 'movistar';
  if (ant.op === 'vodafone') return 'vodafone';
  if (ant.op === 'orange') return 'orange';
  if (ant.opRaw && ant.opRaw.toUpperCase().includes('AVATEL')) {
    return 'orange';
  }
  return null;
}

/**
 * Para cada coordenada oficial UNICO 5G de cada operadora, busca la antena real
 * de esa misma operadora más próxima en un radio máximo de 1.000 metros (1,0 km).
 * Devuelve un `Uint16Array` con las bandas 5G (`N28`, `N28+`, `N78`) presentes
 * en esa antena más cercana (o `0` si no hay antena real <= 1.000 m o no tiene N28/N28+/N78).
 */
export function matchUnicoDeclaredAntennasMasks(
  unicoAntenas: readonly UnicoAntennaRecord[],
  realAntenas: readonly AntennaRecord[],
  realBandMasks?: Uint16Array,
): Uint16Array {
  const result = new Uint16Array(unicoAntenas.length);
  if (unicoAntenas.length === 0 || realAntenas.length === 0) {
    return result;
  }

  const spatialBuckets: Record<
    UnicoOperatorKey,
    Map<number, IndexedRealStation[]>
  > = {
    movistar: new Map(),
    orange: new Map(),
    vodafone: new Map(),
  };

  for (let i = 0; i < realAntenas.length; i++) {
    const ant = realAntenas[i];
    const targetOp = resolveRealStationUnicoOp(ant);
    if (!targetOp) continue;

    const rawMask =
      realBandMasks && i < realBandMasks.length
        ? realBandMasks[i]
        : computeAntennaRfBandMask(ant);
    const declaredBits = rawMask & UNICO_DECLARED_ANY_MASK;

    const gx = Math.floor(ant.lat / GRID_CELL_DEG);
    const gy = Math.floor(ant.lon / GRID_CELL_DEG);
    // Empaquetado entero determinista de celda (gx, gy)
    const cellKey = (gx + 10000) * 100000 + (gy + 20000);
    const mapForOp = spatialBuckets[targetOp];
    let list = mapForOp.get(cellKey);
    if (!list) {
      list = [];
      mapForOp.set(cellKey, list);
    }
    list.push({
      lat: ant.lat,
      lon: ant.lon,
      declaredBits,
    });
  }

  for (let i = 0; i < unicoAntenas.length; i++) {
    const u = unicoAntenas[i];
    const mapForOp = spatialBuckets[u.op];
    const gx = Math.floor(u.lat / GRID_CELL_DEG);
    const gy = Math.floor(u.lon / GRID_CELL_DEG);

    let bestDistKm = UNICO_MAX_MATCH_DISTANCE_KM + 1e-9;
    let bestStation: IndexedRealStation | null = null;

    for (let dx = -1; dx <= 1; dx++) {
      const rowBase = (gx + dx + 10000) * 100000;
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = mapForOp.get(rowBase + (gy + dy + 20000));
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          const cand = bucket[k];
          const distKm = haversineDistanceKm(u.lat, u.lon, cand.lat, cand.lon);
          if (distKm <= UNICO_MAX_MATCH_DISTANCE_KM && distKm < bestDistKm) {
            bestDistKm = distKm;
            bestStation = cand;
          }
        }
      }
    }

    if (bestStation !== null && bestStation.declaredBits !== 0) {
      result[i] = bestStation.declaredBits;
    }
  }

  return result;
}

export function bandFilterToMask(bandFilter: UnicoDeclaredBandFilter): number {
  switch (bandFilter) {
    case 'N78':
      return UNICO_BIT_N78;
    case 'N28':
      return UNICO_BIT_N28;
    case 'N28+':
      return UNICO_BIT_N28_PLUS;
    case 'all':
    default:
      return UNICO_DECLARED_ANY_MASK;
  }
}

export interface UnicoSimpleFilterOptions {
  fase: UnicoFaseFilter;
  selectedProvinces: ReadonlySet<string>;
  selectedComunidades: ReadonlySet<string>;
  bandFilter: UnicoDeclaredBandFilter;
}

export function computeUnicoSimpleSummary(
  unicoAntenas: readonly UnicoAntennaRecord[],
  declaredMasks: Uint16Array | null,
  filters: UnicoSimpleFilterOptions,
): UnicoSimpleSummary {
  const restrictProvs = filters.selectedProvinces.size > 0;
  const restrictCcaas = filters.selectedComunidades.size > 0;
  const targetBandMask = bandFilterToMask(filters.bandFilter);

  const totalsByOp: Record<UnicoOperatorKey, number> = {
    movistar: 0,
    orange: 0,
    vodafone: 0,
  };
  const declaredByOp: Record<UnicoOperatorKey, number> = {
    movistar: 0,
    orange: 0,
    vodafone: 0,
  };

  let totalAntennas = 0;
  let totalDeclared = 0;

  for (let i = 0; i < unicoAntenas.length; i++) {
    const a = unicoAntenas[i];
    if (filters.fase === '1' && a.fase !== 1) continue;
    if (filters.fase === '2' && a.fase !== 2) continue;
    if (restrictProvs && !filters.selectedProvinces.has(a.prov)) continue;
    if (restrictCcaas && !filters.selectedComunidades.has(a.ccaa)) continue;

    totalAntennas += 1;
    totalsByOp[a.op] += 1;

    if (declaredMasks && (declaredMasks[i] & targetBandMask) !== 0) {
      totalDeclared += 1;
      declaredByOp[a.op] += 1;
    }
  }

  const byOperator = UNICO_OPERATOR_ORDER.map((opKey) => {
    const total = totalsByOp[opKey];
    const declared = declaredByOp[opKey];
    return {
      key: opKey,
      meta: UNICO_OPERATOR_META[opKey],
      total,
      pctOfTotal: totalAntennas > 0 ? (total / totalAntennas) * 100 : 0,
      declared,
      pctDeclared: total > 0 ? (declared / total) * 100 : 0,
    };
  });

  return {
    totalAntennas,
    totalDeclared,
    pctDeclaredGlobal:
      totalAntennas > 0 ? (totalDeclared / totalAntennas) * 100 : 0,
    byOperator,
  };
}

export const UNICO_5G_QUERY_KEY = ['unico-5g-dataset'] as const;

export async function importUnico5gJsonDataset(): Promise<UnicoDataset> {
  const baseUrl = import.meta.env.BASE_URL || './';
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const response = await fetch(`${normalizedBase}data/unico-5g.json`, {
    headers: { Accept: 'application/json' },
    cache: 'no-cache',
  });
  if (!response.ok) {
    throw new Error(
      `No se pudo cargar el dataset UNICO 5G (HTTP ${response.status}).`,
    );
  }
  const raw: unknown = await response.json();
  return parseCustomUnico5gJson(raw);
}

export function selectEffectiveUnicoDeclaredMasks(params: {
  unicoDataset: UnicoDataset | null | undefined;
  persistedMasks: Uint16Array | null;
  antenasDerived: Pick<
    DerivedAntenasStructures,
    'dataset' | 'bandCodeMasks'
  > | null;
  isAntenasFetching: boolean;
}): Uint16Array | null {
  const { unicoDataset, persistedMasks, antenasDerived, isAntenasFetching } =
    params;

  if (!unicoDataset) {
    return null;
  }

  const validPersistedMasks =
    persistedMasks && persistedMasks.length === unicoDataset.antenas.length
      ? persistedMasks
      : null;

  if (!antenasDerived) {
    return validPersistedMasks;
  }

  if (
    isAntenasFetching &&
    validPersistedMasks &&
    unicoDataset.declaredUpdatedAt
  ) {
    const persistedMs = Date.parse(unicoDataset.declaredUpdatedAt);
    const antenasMs = Date.parse(antenasDerived.dataset.updatedAt);
    if (
      Number.isFinite(persistedMs) &&
      (!Number.isFinite(antenasMs) || persistedMs > antenasMs)
    ) {
      return validPersistedMasks;
    }
  }

  return matchUnicoDeclaredAntennasMasks(
    unicoDataset.antenas,
    antenasDerived.dataset.antenas,
    antenasDerived.bandCodeMasks,
  );
}

export function useUnico5gData() {
  const query = useQuery({
    queryKey: UNICO_5G_QUERY_KEY,
    queryFn: importUnico5gJsonDataset,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 2,
  });

  const {
    derived: antenasDerived,
    isLoading: isAntenasLoading,
    isFetching: isAntenasFetching,
  } = useAntenasData();

  const persistedMasks = useMemo(() => {
    const data = query.data;
    if (
      !data?.declaredMasks ||
      data.declaredMasks.length !== data.antenas.length
    ) {
      return null;
    }
    const masks = new Uint16Array(data.declaredMasks.length);
    for (let i = 0; i < data.declaredMasks.length; i++) {
      masks[i] = data.declaredMasks[i] & UNICO_DECLARED_ANY_MASK;
    }
    return masks;
  }, [query.data]);

  const declaredMasks = useMemo(
    () =>
      selectEffectiveUnicoDeclaredMasks({
        unicoDataset: query.data,
        persistedMasks,
        antenasDerived,
        isAntenasFetching,
      }),
    [query.data, persistedMasks, antenasDerived, isAntenasFetching],
  );

  return {
    dataset: query.data ?? null,
    declaredMasks,
    declaredUpdatedAt:
      antenasDerived?.dataset.updatedAt ??
      query.data?.declaredUpdatedAt ??
      null,
    isDeclaredReady: declaredMasks !== null,
    isAntenasLoading,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  };
}
