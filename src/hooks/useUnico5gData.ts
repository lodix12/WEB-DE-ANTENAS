import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isXferaLegalEntity, type AntennaRecord } from '../types/antena';
import {
  UNICO_OPERATOR_META,
  UNICO_OPERATOR_ORDER,
  type UnicoAntennaRecord,
  type UnicoDataset,
  type UnicoDeclaredBandFilter,
  type UnicoDeclaredMatchedEntry,
  type UnicoDeclaredMatchResult,
  type UnicoDeclaredOperatorSummary,
  type UnicoDeclaredRealAntennaMatch,
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
import { formatDistance, haversineDistanceKm } from '../utils/geo';
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

const EMPTY_DECLARED_REAL_ANTENNAS: ReadonlyMap<
  string,
  UnicoDeclaredRealAntennaMatch
> = new Map();

interface IndexedRealStation {
  stationIdx: number;
  antennaId: string;
  lat: number;
  lon: number;
  declaredBits: number;
}

interface UnicoCandidateStation {
  distKm: number;
  stationIdx: number;
  antennaId: string;
  declaredBits: number;
}

interface UnicoMatchHeapNode {
  distKm: number;
  unicoIdx: number;
  candPos: number;
}

function isUnicoHeapNodeLess(
  a: UnicoMatchHeapNode,
  b: UnicoMatchHeapNode,
): boolean {
  if (a.distKm !== b.distKm) return a.distKm < b.distKm;
  if (a.unicoIdx !== b.unicoIdx) return a.unicoIdx < b.unicoIdx;
  return a.candPos < b.candPos;
}

function pushUnicoMatchHeap(
  heap: UnicoMatchHeapNode[],
  node: UnicoMatchHeapNode,
): void {
  heap.push(node);
  let idx = heap.length - 1;
  while (idx > 0) {
    const parent = (idx - 1) >> 1;
    if (!isUnicoHeapNodeLess(heap[idx], heap[parent])) break;
    const tmp = heap[parent];
    heap[parent] = heap[idx];
    heap[idx] = tmp;
    idx = parent;
  }
}

function popUnicoMatchHeap(
  heap: UnicoMatchHeapNode[],
): UnicoMatchHeapNode | undefined {
  if (heap.length === 0) return undefined;
  const top = heap[0];
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    let idx = 0;
    const len = heap.length;
    while (true) {
      const left = (idx << 1) + 1;
      const right = left + 1;
      let smallest = idx;
      if (left < len && isUnicoHeapNodeLess(heap[left], heap[smallest])) {
        smallest = left;
      }
      if (right < len && isUnicoHeapNodeLess(heap[right], heap[smallest])) {
        smallest = right;
      }
      if (smallest === idx) break;
      const tmp = heap[idx];
      heap[idx] = heap[smallest];
      heap[smallest] = tmp;
      idx = smallest;
    }
  }
  return top;
}

function resolveRealStationUnicoOp(ant: AntennaRecord): UnicoOperatorKey | null {
  if (ant.op === 'movistar') return 'movistar';
  if (ant.op === 'vodafone') return 'vodafone';
  if (
    ant.op === 'orange' ||
    (ant.op as string) === 'masmovil' ||
    (typeof ant.opRaw === 'string' && isXferaLegalEntity(ant.opRaw))
  ) {
    return 'orange';
  }
  if (
    typeof ant.opRaw === 'string' &&
    ant.opRaw.toUpperCase().includes('AVATEL')
  ) {
    return 'orange';
  }
  return null;
}

/**
 * Formatea una distancia en kilómetros entre una estación real y una coordenada UNICO 5G
 * con espacio indivisible (ej. "9 m", "1.000 m", "1,25 km"), sin inconsistencias en [999,5 m, 1.000 m].
 */
export function formatUnicoDistance(km: number): string {
  const safeKm = Number.isFinite(km) && km >= 0 ? km : 0;
  const meters = Math.round(safeKm * 1000);
  if (meters <= 1000) {
    return `${formatUnicoInt(meters)}\u00A0m`;
  }
  return formatDistance(meters / 1000).replace(' ', '\u00A0');
}

/**
 * Formatea la máscara de bits 5G UNICO (`N78`, `N28`, `N28+`) en códigos legibles
 * ordenados de mayor a menor relevancia 5G (`N78`, `N28+`, `N28`).
 */
export function formatUnicoDeclaredBitsList(
  declaredBits: number,
): Array<'N78' | 'N28+' | 'N28'> {
  const list: Array<'N78' | 'N28+' | 'N28'> = [];
  if ((declaredBits & UNICO_BIT_N78) !== 0) {
    list.push('N78');
  }
  if ((declaredBits & UNICO_BIT_N28_PLUS) !== 0) {
    list.push('N28+');
  }
  if ((declaredBits & UNICO_BIT_N28) !== 0) {
    list.push('N28');
  }
  return list;
}

/**
 * Formatea las fases UNICO 5G asociadas a una antena real seleccionada como declaración.
 */
export function formatUnicoFasesLabel(fases: readonly UnicoFase[]): string {
  if (fases.length === 0) return 'UNICO 5G';
  const hasF1 = fases.includes(1);
  const hasF2 = fases.includes(2);
  if (hasF1 && hasF2) return 'Fase 1 y 2';
  return hasF1 ? 'Fase 1' : 'Fase 2';
}

/**
 * Emparejamiento 1-a-1 por operadora entre coordenadas oficiales UNICO 5G y antenas reales:
 * - Cada ubicación UNICO 5G solo puede coincidir con 1 antena real de su misma operadora en <= 1.000 m.
 * - Las asignaciones se resuelven por cercanía global creciente (distancia mínima primero).
 * - Si la antena real más próxima ya ha sido elegida como declarada por otro proyecto del mismo
 *   operador, se busca la siguiente antena real más cercana disponible dentro de <= 1.000 m.
 * - Dos proyectos UNICO de operadoras distintas que coinciden en un emplazamiento real compartido
 *   se resuelven de forma independiente por operadora y ambos pueden quedar declarados.
 *
 * Devuelve simultáneamente:
 * - `declaredMasks`: `Uint16Array` alineado con `unicoAntenas` con las bandas 5G (`N28`, `N28+`, `N78`).
 * - `declaredRealAntennasById`: mapa `antenna.id -> UnicoDeclaredRealAntennaMatch` con todas las
 *   antenas reales seleccionadas como declaración del programa UNICO 5G (1-a-1 por operadora).
 */
export function matchUnicoDeclaredAntennas(
  unicoAntenas: readonly UnicoAntennaRecord[],
  realAntenas: readonly AntennaRecord[],
  realBandMasks?: Uint16Array,
): UnicoDeclaredMatchResult {
  const nUnico = unicoAntenas.length;
  const declaredMasks = new Uint16Array(nUnico);
  const declaredRealAntennasById = new Map<
    string,
    UnicoDeclaredRealAntennaMatch
  >();
  if (nUnico === 0 || realAntenas.length === 0) {
    return {
      declaredMasks,
      declaredRealAntennasById,
    };
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
    if (!Number.isFinite(ant.lat) || !Number.isFinite(ant.lon)) continue;

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
      stationIdx: i,
      antennaId: typeof ant.id === 'string' ? ant.id : '',
      lat: ant.lat,
      lon: ant.lon,
      declaredBits,
    });
  }

  const candidatesByUnico: Array<UnicoCandidateStation[] | null> = new Array(
    nUnico,
  ).fill(null);
  const heap: UnicoMatchHeapNode[] = [];

  for (let i = 0; i < nUnico; i++) {
    const u = unicoAntenas[i];
    if (!Number.isFinite(u.lat) || !Number.isFinite(u.lon)) continue;
    if (!isUnicoOperatorKey(u.op)) continue;
    const mapForOp = spatialBuckets[u.op];

    const gx = Math.floor(u.lat / GRID_CELL_DEG);
    const gy = Math.floor(u.lon / GRID_CELL_DEG);
    const cands: UnicoCandidateStation[] = [];

    for (let dx = -1; dx <= 1; dx++) {
      const rowBase = (gx + dx + 10000) * 100000;
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = mapForOp.get(rowBase + (gy + dy + 20000));
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          const cand = bucket[k];
          const distKm = haversineDistanceKm(u.lat, u.lon, cand.lat, cand.lon);
          if (distKm <= UNICO_MAX_MATCH_DISTANCE_KM) {
            cands.push({
              distKm,
              stationIdx: cand.stationIdx,
              antennaId: cand.antennaId,
              declaredBits: cand.declaredBits,
            });
          }
        }
      }
    }

    if (cands.length > 0) {
      if (cands.length > 1) {
        cands.sort(
          (a, b) => a.distKm - b.distKm || a.stationIdx - b.stationIdx,
        );
      }
      candidatesByUnico[i] = cands;
      pushUnicoMatchHeap(heap, {
        distKm: cands[0].distKm,
        unicoIdx: i,
        candPos: 0,
      });
    }
  }

  const claimedByOp: Record<UnicoOperatorKey, Set<number>> = {
    movistar: new Set(),
    orange: new Set(),
    vodafone: new Set(),
  };
  const claimedIdsByOp: Record<UnicoOperatorKey, Set<string>> = {
    movistar: new Set(),
    orange: new Set(),
    vodafone: new Set(),
  };
  const resolved = new Uint8Array(nUnico);

  while (heap.length > 0) {
    const node = popUnicoMatchHeap(heap);
    if (!node) break;
    const { unicoIdx, candPos } = node;
    if (resolved[unicoIdx] !== 0) continue;

    const u = unicoAntenas[unicoIdx];
    const cands = candidatesByUnico[unicoIdx];
    if (!cands || candPos >= cands.length || !isUnicoOperatorKey(u.op)) {
      resolved[unicoIdx] = 1;
      continue;
    }

    const claimedForOp = claimedByOp[u.op];
    const claimedIdsForOp = claimedIdsByOp[u.op];
    const cand = cands[candPos];
    if (
      claimedForOp.has(cand.stationIdx) ||
      (cand.antennaId !== '' && claimedIdsForOp.has(cand.antennaId))
    ) {
      const nextPos = candPos + 1;
      if (nextPos < cands.length) {
        pushUnicoMatchHeap(heap, {
          distKm: cands[nextPos].distKm,
          unicoIdx,
          candPos: nextPos,
        });
      } else {
        resolved[unicoIdx] = 1;
      }
      continue;
    }

    resolved[unicoIdx] = 1;
    if (cand.declaredBits !== 0) {
      claimedForOp.add(cand.stationIdx);
      if (cand.antennaId !== '') {
        claimedIdsForOp.add(cand.antennaId);
      }
      declaredMasks[unicoIdx] = cand.declaredBits;

      const matchedEntry: UnicoDeclaredMatchedEntry = {
        unicoId: u.id,
        fase: u.fase,
        op: u.op,
        empresa: u.empresa,
        mun: u.mun,
        prov: u.prov,
        lat: u.lat,
        lon: u.lon,
        distanceKm: cand.distKm,
      };

      if (
        cand.antennaId !== '' &&
        !declaredRealAntennasById.has(cand.antennaId)
      ) {
        declaredRealAntennasById.set(cand.antennaId, {
          antennaId: cand.antennaId,
          op: u.op,
          declaredBits: cand.declaredBits,
          fases: [u.fase],
          minDistanceKm: cand.distKm,
          entries: [matchedEntry],
        });
      }
    }
  }

  return {
    declaredMasks,
    declaredRealAntennasById,
  };
}

/**
 * Emparejamiento 1-a-1 por operadora entre coordenadas oficiales UNICO 5G y antenas reales
 * en un radio máximo de 1.000 metros (1,0 km), buscando la siguiente antena más cercana
 * disponible cuando la más próxima ya fue elegida como declarada por otro proyecto del mismo operador.
 * Devuelve un `Uint16Array` con las bandas 5G (`N28`, `N28+`, `N78`) de la antena asignada
 * (o `0` si no hay antena disponible <= 1.000 m o la más cercana disponible no tiene N28/N28+/N78).
 */
export function matchUnicoDeclaredAntennasMasks(
  unicoAntenas: readonly UnicoAntennaRecord[],
  realAntenas: readonly AntennaRecord[],
  realBandMasks?: Uint16Array,
): Uint16Array {
  return matchUnicoDeclaredAntennas(unicoAntenas, realAntenas, realBandMasks)
    .declaredMasks;
}

const CACHED_UNICO_MATCH_BY_DERIVED = new WeakMap<
  DerivedAntenasStructures,
  WeakMap<UnicoDataset, UnicoDeclaredMatchResult>
>();

function getCachedUnicoDeclaredMatch(
  unicoDataset: UnicoDataset,
  antenasDerived: DerivedAntenasStructures,
): UnicoDeclaredMatchResult {
  let byUnico = CACHED_UNICO_MATCH_BY_DERIVED.get(antenasDerived);
  if (byUnico) {
    const cached = byUnico.get(unicoDataset);
    if (cached) {
      return cached;
    }
  } else {
    byUnico = new WeakMap<UnicoDataset, UnicoDeclaredMatchResult>();
    CACHED_UNICO_MATCH_BY_DERIVED.set(antenasDerived, byUnico);
  }

  const computed = matchUnicoDeclaredAntennas(
    unicoDataset.antenas,
    antenasDerived.dataset.antenas,
    antenasDerived.bandCodeMasks,
  );
  byUnico.set(unicoDataset, computed);
  return computed;
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
  precomputedLiveMasks?: Uint16Array | null;
}): Uint16Array | null {
  const {
    unicoDataset,
    persistedMasks,
    antenasDerived,
    isAntenasFetching,
    precomputedLiveMasks,
  } = params;

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

  if (
    precomputedLiveMasks &&
    precomputedLiveMasks.length === unicoDataset.antenas.length
  ) {
    return precomputedLiveMasks;
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

  const liveMatch = useMemo(() => {
    if (!query.data || !antenasDerived) {
      return null;
    }
    return getCachedUnicoDeclaredMatch(query.data, antenasDerived);
  }, [query.data, antenasDerived]);

  const declaredMasks = useMemo(
    () =>
      selectEffectiveUnicoDeclaredMasks({
        unicoDataset: query.data,
        persistedMasks,
        antenasDerived,
        isAntenasFetching,
        precomputedLiveMasks: liveMatch?.declaredMasks ?? null,
      }),
    [query.data, persistedMasks, antenasDerived, isAntenasFetching, liveMatch],
  );

  const declaredRealAntennasById =
    liveMatch?.declaredRealAntennasById ?? EMPTY_DECLARED_REAL_ANTENNAS;

  return {
    dataset: query.data ?? null,
    declaredMasks,
    declaredRealAntennasById,
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
