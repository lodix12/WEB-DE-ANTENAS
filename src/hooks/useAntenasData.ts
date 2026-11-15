import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  OPERATOR_META,
  OPERATOR_ORDER,
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

export interface MunicipalityOption {
  mun: string;
  count: number;
}

export interface BandOption {
  band: string;
  count: number;
}

export interface DerivedAntenasStructures {
  dataset: AntenasDataset;
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

const VALID_OPERATORS = new Set<string>(OPERATOR_ORDER);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extrae el valor numérico equivalente en MHz de una etiqueta de banda comercial
 * (ej. "700 MHz" -> 700, "3500 MHz" -> 3500, "26 GHz" -> 26000) para ordenación estricta.
 */
export function parseBandMhzSortValue(label: string): number {
  const match = /(\d+(?:[.,]\d+)?)/.exec(label);
  if (!match) return Number.POSITIVE_INFINITY;
  const num = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(num)) return Number.POSITIVE_INFINITY;
  return /ghz/i.test(label) ? num * 1000 : num;
}

export function compareBandLabels(a: string, b: string): number {
  const diff = parseBandMhzSortValue(a) - parseBandMhzSortValue(b);
  if (diff !== 0) return diff;
  return a.localeCompare(b, 'es', { numeric: true });
}

export function compareFrequencyRanges(a: string, b: string): number {
  const numsA =
    a.match(/\d+(?:[.,]\d+)?/g)?.map((n) => Number(n.replace(',', '.'))) ?? [];
  const numsB =
    b.match(/\d+(?:[.,]\d+)?/g)?.map((n) => Number(n.replace(',', '.'))) ?? [];
  const startA = numsA[0] ?? Number.POSITIVE_INFINITY;
  const startB = numsB[0] ?? Number.POSITIVE_INFINITY;
  if (startA !== startB) return startA - startB;
  const endA = numsA[1] ?? startA;
  const endB = numsB[1] ?? startB;
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
    if (
      typeof item.id !== 'string' ||
      typeof item.gid !== 'string' ||
      typeof item.op !== 'string' ||
      !VALID_OPERATORS.has(item.op) ||
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
    if (
      item.mergedGids !== undefined &&
      (!Array.isArray(item.mergedGids) ||
        !item.mergedGids.every((gid): gid is string => typeof gid === 'string'))
    ) {
      throw new Error(
        `Campo mergedGids inválido en antenas[${i}]: se esperaba un array de strings.`,
      );
    }
    if (
      item.bandas !== undefined &&
      (!Array.isArray(item.bandas) ||
        !item.bandas.every((band): band is string => typeof band === 'string'))
    ) {
      throw new Error(
        `Campo bandas inválido en antenas[${i}]: se esperaba un array de strings.`,
      );
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

  return raw as unknown as AntenasDataset;
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
    const merged: AntennaRecord = { ...sortedMembers[0] };

    for (let m = 1; m < sortedMembers.length; m++) {
      const cand = sortedMembers[m];
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
      if (member.mergedGids) {
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
          const bLabel = member.bandas[b].trim();
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

    if (mergedGids.length > 0) {
      merged.mergedGids = mergedGids;
    }
    if (anyHasBandas) {
      merged.bandas = Array.from(seenBandas).sort(compareBandLabels);
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
    mergedByRoot.set(root, merged);
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
    masmovil: 0,
    digi: 0,
    otros: 0,
  };
  const opEntities: Record<OperatorKey, Set<string>> = {
    movistar: new Set<string>(),
    orange: new Set<string>(),
    vodafone: new Set<string>(),
    masmovil: new Set<string>(),
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

export function buildDerivedAntenasStructures(
  inputDataset: AntenasDataset,
): DerivedAntenasStructures {
  const dataset = fuseVodafoneAntennasInDataset(inputDataset);
  const { antenas } = dataset;

  const operatorCounts: Record<OperatorKey, number> = {
    movistar: 0,
    orange: 0,
    vodafone: 0,
    masmovil: 0,
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

    if (Array.isArray(ant.bandas)) {
      bandsPopulatedCount += 1;
      if (ant.bandas.length > 0) {
        const seenAntBands = new Set<string>();
        for (let b = 0; b < ant.bandas.length; b++) {
          const bandLabel = ant.bandas[b].trim();
          if (bandLabel && !seenAntBands.has(bandLabel)) {
            seenAntBands.add(bandLabel);
            bandCountsMap.set(
              bandLabel,
              (bandCountsMap.get(bandLabel) ?? 0) + 1,
            );
          }
        }
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
    const bandsText = (ant.bandas ?? []).join(' ');
    const freqsText = (ant.frecuencias ?? []).join(' ');
    const concesionesText =
      ant.concesiones && ant.concesiones.length > 0
        ? ant.concesiones.map((c) => `${c.ref} ${c.freq}`).join(' ')
        : '';
    searchIndex[i] = normalizeSearchText(
      `${ant.gid} ${extraGids} ${ant.mun} ${ant.prov} ${ant.dir} ${ant.opRaw} ${ant.op} ${bandsText} ${freqsText} ${concesionesText}`,
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

  const municipalitiesByProvince = new Map<string, MunicipalityOption[]>();
  for (const [prov, muns] of munMapByProv.entries()) {
    const sortedMuns: MunicipalityOption[] = Array.from(muns.entries())
      .map(([mun, count]) => ({ mun, count }))
      .sort((a, b) => a.mun.localeCompare(b.mun, 'es'));
    municipalitiesByProvince.set(prov, sortedMuns);
  }

  const provinceCentroids = new Map<string, { lat: number; lon: number }>();
  for (const [prov, acc] of provAccum.entries()) {
    if (acc.count > 0) {
      provinceCentroids.set(prov, {
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

export function useAntenasData() {
  const query = useQuery({
    queryKey: ['antenas-dataset'],
    queryFn: importAntenasJsonDataset,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 2,
  });

  const derived = useMemo(
    () => (query.data ? buildDerivedAntenasStructures(query.data) : null),
    [query.data],
  );

  return {
    ...query,
    derived,
  };
}

export interface AntenasFilterInput {
  derived: DerivedAntenasStructures | null;
  searchQuery: string;
  selectedProvince: string;
  selectedMunicipality: string;
  activeOperators: OperatorKey[];
  selectedBand?: string;
}

interface SearchMatcher {
  token: string;
  exactWord: boolean;
}

function buildSearchMatchers(normalizedQuery: string): SearchMatcher[] {
  if (!normalizedQuery) return [];
  const matchers: SearchMatcher[] = [];
  const bandRegex = /\b(\d+(?:[.,]\d+)?)\s*(mhz|ghz)\b/g;
  const remainder = normalizedQuery.replace(
    bandRegex,
    (_full, num: string, unit: string) => {
      matchers.push({ token: `${num} ${unit}`, exactWord: true });
      return ' ';
    },
  );
  const plainTokens = remainder.split(/\s+/).filter(Boolean);
  for (let i = 0; i < plainTokens.length; i++) {
    matchers.push({ token: plainTokens[i], exactWord: false });
  }
  return matchers;
}

export function filterAntenas({
  derived,
  searchQuery,
  selectedProvince,
  selectedMunicipality,
  activeOperators,
  selectedBand = '',
}: AntenasFilterInput): AntennaRecord[] {
  if (!derived) return [];
  const { antenas } = derived.dataset;
  const { searchIndex } = derived;

  if (activeOperators.length === 0) return [];

  const allOpsSelected = activeOperators.length === OPERATOR_ORDER.length;
  const opSet = allOpsSelected ? null : new Set<OperatorKey>(activeOperators);
  const targetBand = selectedBand.trim();

  // Si el usuario escribe coordenadas válidas ("40.4168, -3.7038"), no filtramos el texto literal
  // para que pueda ver las antenas alrededor de ese punto en el mapa.
  const isCoordQuery = parseCoordinateInput(searchQuery) !== null;
  const normalizedQuery = isCoordQuery ? '' : normalizeSearchText(searchQuery);
  const matchers = buildSearchMatchers(normalizedQuery);

  if (
    allOpsSelected &&
    !selectedProvince &&
    !selectedMunicipality &&
    !targetBand &&
    matchers.length === 0
  ) {
    return antenas;
  }

  const result: AntennaRecord[] = [];
  for (let i = 0; i < antenas.length; i++) {
    const ant = antenas[i];
    if (opSet && !opSet.has(ant.op)) continue;
    if (selectedProvince && ant.prov !== selectedProvince) continue;
    if (selectedMunicipality && ant.mun !== selectedMunicipality) continue;
    if (targetBand && !ant.bandas?.includes(targetBand)) continue;

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
  selectedProvince,
  selectedMunicipality,
  activeOperators,
  selectedBand = '',
}: AntenasFilterInput): AntennaRecord[] {
  return useMemo(
    () =>
      filterAntenas({
        derived,
        searchQuery,
        selectedProvince,
        selectedMunicipality,
        activeOperators,
        selectedBand,
      }),
    [
      derived,
      searchQuery,
      selectedProvince,
      selectedMunicipality,
      activeOperators,
      selectedBand,
    ],
  );
}
