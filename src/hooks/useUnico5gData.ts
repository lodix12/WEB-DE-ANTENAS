import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  UNICO_OPERATOR_META,
  UNICO_OPERATOR_ORDER,
  type UnicoAntennaRecord,
  type UnicoBounds,
  type UnicoColorMode,
  type UnicoComunidadStat,
  type UnicoDataset,
  type UnicoEntityBreakdown,
  type UnicoFase,
  type UnicoFilterState,
  type UnicoOperatorDatasetSummary,
  type UnicoOperatorKey,
  type UnicoOperatorStat,
  type UnicoProvinceStat,
  type UnicoRouteSearch,
  type UnicoTableSortField,
} from '../types/unico5g';
import { normalizeSearchText, parseCoordinateInput } from '../utils/export';
import { haversineDistanceKm } from '../utils/geo';

const VALID_UNICO_OPERATORS = new Set<string>(UNICO_OPERATOR_ORDER);
export const UNICO_PAGE_SIZE_OPTIONS = [25, 50, 100, 250] as const;

const ES_INT_FORMATTER = new Intl.NumberFormat('es-ES', {
  useGrouping: 'always',
  maximumFractionDigits: 0,
});

export function formatUnicoInt(value: number): string {
  return ES_INT_FORMATTER.format(Math.round(value));
}

export function isUnicoOperatorKey(value: unknown): value is UnicoOperatorKey {
  return typeof value === 'string' && VALID_UNICO_OPERATORS.has(value);
}

/**
 * Agrupa cualquier entidad/proyecto en el que participe Orange dentro de 'orange'.
 */
export function normalizeUnicoOperatorInput(raw: string): UnicoOperatorKey {
  const norm = normalizeSearchText(raw).toUpperCase();
  if (
    norm.includes('ORANGE') ||
    norm.includes('MASORANGE') ||
    norm.includes('XFERA') ||
    norm.includes('MASMOVIL')
  ) {
    return 'orange';
  }
  if (norm.includes('TELEFONICA') || norm.includes('MOVISTAR')) {
    return 'movistar';
  }
  if (norm.includes('VODAFONE')) {
    return 'vodafone';
  }
  return 'avatel';
}

export function formatUnicoPercent(part: number, total: number, decimals = 1): string {
  if (total <= 0) {
    return `${(0).toLocaleString('es-ES', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })} %`;
  }
  return `${((part / total) * 100).toLocaleString('es-ES', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} %`;
}

/**
 * Valida estrictamente el esquema JSON propio de `public/data/unico-5g.json`,
 * rechazando cualquier estructura GeoJSON y verificando que no existan campos
 * de código de emplazamiento ni ID de propietario.
 */
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
    const op: UnicoOperatorKey = isUnicoOperatorKey(rec.op)
      ? rec.op === 'orange' || normalizeUnicoOperatorInput(empresa) === 'orange'
        ? 'orange'
        : rec.op
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

  const rawOperators =
    obj.operators && typeof obj.operators === 'object'
      ? (obj.operators as Record<string, Record<string, unknown>>)
      : {};

  const operators = {} as Record<UnicoOperatorKey, UnicoOperatorDatasetSummary>;
  for (const opKey of UNICO_OPERATOR_ORDER) {
    const src = rawOperators[opKey];
    const opItems = antenas.filter((a) => a.op === opKey);
    const f1 = opItems.filter((a) => a.fase === 1).length;
    const f2 = opItems.filter((a) => a.fase === 2).length;

    let entities: UnicoEntityBreakdown[] = [];
    if (src && Array.isArray(src.entities)) {
      entities = (src.entities as Array<Record<string, unknown>>).map((e) => ({
        empresa: String(e.empresa ?? ''),
        total: Number(e.total ?? 0),
        fase1: Number(e.fase1 ?? 0),
        fase2: Number(e.fase2 ?? 0),
        ...(typeof e.proyectosFase2 === 'number'
          ? { proyectosFase2: e.proyectosFase2 }
          : {}),
      }));
    } else {
      const byEnt = new Map<string, { total: number; fase1: number; fase2: number }>();
      for (const a of opItems) {
        const cur = byEnt.get(a.empresa) ?? { total: 0, fase1: 0, fase2: 0 };
        cur.total += 1;
        if (a.fase === 1) cur.fase1 += 1;
        else cur.fase2 += 1;
        byEnt.set(a.empresa, cur);
      }
      entities = Array.from(byEnt.entries())
        .sort((a, b) => a[0].localeCompare(b[0], 'es'))
        .map(([empresa, counts]) => ({ empresa, ...counts }));
    }

    operators[opKey] = {
      key: opKey,
      label: UNICO_OPERATOR_META[opKey].name,
      total: opItems.length,
      fase1: f1,
      fase2: f2,
      proyectosFase2:
        src && typeof src.proyectosFase2 === 'number' ? src.proyectosFase2 : 0,
      entities,
    };
  }

  return {
    schemaVersion: typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 1,
    program:
      typeof obj.program === 'string' ? obj.program : 'UNICO 5G Redes Activas',
    updatedAt:
      typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
    total: antenas.length,
    fase1Total: fase1Count,
    fase2Total: fase2Count,
    fase2ProjectsTotal:
      typeof obj.fase2ProjectsTotal === 'number' ? obj.fase2ProjectsTotal : 73,
    operators,
    antenas,
  };
}

export function validateUnico5gSearch(
  search: Record<string, unknown>,
): UnicoRouteSearch {
  const result: UnicoRouteSearch = {};

  if (search.fase === '1' || search.fase === 1) {
    result.fase = '1';
  } else if (search.fase === '2' || search.fase === 2) {
    result.fase = '2';
  }

  if (typeof search.op === 'string' && search.op.trim().length > 0) {
    const validOps = search.op
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is UnicoOperatorKey => isUnicoOperatorKey(s));
    if (validOps.length > 0 && validOps.length < UNICO_OPERATOR_ORDER.length) {
      result.op = Array.from(new Set(validOps)).join(',');
    }
  }

  if (typeof search.ccaa === 'string' && search.ccaa.trim().length > 0) {
    result.ccaa = search.ccaa.trim();
  }
  if (typeof search.prov === 'string' && search.prov.trim().length > 0) {
    result.prov = search.prov.trim();
  }
  if (typeof search.mun === 'string' && search.mun.trim().length > 0) {
    result.mun = search.mun.trim();
  }
  if (typeof search.q === 'string' && search.q.trim().length > 0) {
    result.q = search.q.trim();
  }
  if (search.colorMode === 'fase' || search.colorMode === 'operator') {
    result.colorMode = search.colorMode as UnicoColorMode;
  }

  const rawPage = Number(search.page);
  if (Number.isInteger(rawPage) && rawPage > 1) {
    result.page = rawPage;
  }

  const rawPageSize = Number(search.pageSize);
  if (
    UNICO_PAGE_SIZE_OPTIONS.includes(
      rawPageSize as (typeof UNICO_PAGE_SIZE_OPTIONS)[number],
    ) &&
    rawPageSize !== 50
  ) {
    result.pageSize = rawPageSize;
  }

  return result;
}

export function parseOperatorsSearchParam(opParam?: string): UnicoOperatorKey[] {
  if (!opParam) {
    return [...UNICO_OPERATOR_ORDER];
  }
  const parts = opParam
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is UnicoOperatorKey => isUnicoOperatorKey(s));
  return parts.length > 0 ? Array.from(new Set(parts)) : [...UNICO_OPERATOR_ORDER];
}

export function computeBoundsForAntennas(
  antenas: readonly UnicoAntennaRecord[],
): UnicoBounds | null {
  if (antenas.length === 0) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (let i = 0; i < antenas.length; i++) {
    const a = antenas[i];
    if (a.lon < minLon) minLon = a.lon;
    if (a.lat < minLat) minLat = a.lat;
    if (a.lon > maxLon) maxLon = a.lon;
    if (a.lat > maxLat) maxLat = a.lat;
  }
  return { minLon, minLat, maxLon, maxLat };
}

export interface UnicoCascadeOptions {
  comunidades: Array<{ ccaa: string; count: number }>;
  provincias: Array<{ prov: string; ccaa: string; count: number }>;
  municipios: Array<{ mun: string; prov: string; count: number }>;
  provToCcaa: Map<string, string>;
}

/**
 * Calcula los selectores territoriales en cascada ordenados estrictamente A–Z (sin rankings).
 */
export function buildUnicoCascadeOptions(
  dataset: UnicoDataset,
  filters: Pick<UnicoFilterState, 'fase' | 'operators' | 'ccaa' | 'prov'>,
): UnicoCascadeOptions {
  const activeOps = new Set<UnicoOperatorKey>(filters.operators);
  const ccaaCounts = new Map<string, number>();
  const provCounts = new Map<string, { ccaa: string; count: number }>();
  const munCounts = new Map<string, { mun: string; prov: string; count: number }>();
  const provToCcaa = new Map<string, string>();

  for (let i = 0; i < dataset.antenas.length; i++) {
    const a = dataset.antenas[i];
    provToCcaa.set(a.prov, a.ccaa);

    if (filters.fase === '1' && a.fase !== 1) continue;
    if (filters.fase === '2' && a.fase !== 2) continue;
    if (!activeOps.has(a.op)) continue;

    ccaaCounts.set(a.ccaa, (ccaaCounts.get(a.ccaa) ?? 0) + 1);

    if (!filters.ccaa || a.ccaa === filters.ccaa) {
      const prevProv = provCounts.get(a.prov);
      if (prevProv) {
        prevProv.count += 1;
      } else {
        provCounts.set(a.prov, { ccaa: a.ccaa, count: 1 });
      }

      if (!filters.prov || a.prov === filters.prov) {
        const munKey = `${a.prov}::${a.mun}`;
        const prevMun = munCounts.get(munKey);
        if (prevMun) {
          prevMun.count += 1;
        } else {
          munCounts.set(munKey, { mun: a.mun, prov: a.prov, count: 1 });
        }
      }
    }
  }

  // Incluir todas las CCAA y provincias presentes en el dataset (incluso con 0 bajo un filtro de fase/operador) ordenadas A-Z
  const allCcaas = new Set<string>();
  const allProvs = new Map<string, string>();
  for (let i = 0; i < dataset.antenas.length; i++) {
    const a = dataset.antenas[i];
    allCcaas.add(a.ccaa);
    allProvs.set(a.prov, a.ccaa);
  }

  const comunidades = Array.from(allCcaas)
    .sort((a, b) => a.localeCompare(b, 'es'))
    .map((ccaa) => ({
      ccaa,
      count: ccaaCounts.get(ccaa) ?? 0,
    }));

  const provincias = Array.from(allProvs.entries())
    .filter(([, ccaa]) => !filters.ccaa || ccaa === filters.ccaa)
    .sort((a, b) => a[0].localeCompare(b[0], 'es'))
    .map(([prov, ccaa]) => ({
      prov,
      ccaa,
      count: provCounts.get(prov)?.count ?? 0,
    }));

  const municipios = Array.from(munCounts.values()).sort((a, b) =>
    a.mun.localeCompare(b.mun, 'es'),
  );

  return { comunidades, provincias, municipios, provToCcaa };
}

export function filterUnicoAntennas(
  antenas: readonly UnicoAntennaRecord[],
  searchIndex: readonly string[],
  filters: UnicoFilterState,
): UnicoAntennaRecord[] {
  const activeOps = new Set<UnicoOperatorKey>(filters.operators);
  const normQuery = normalizeSearchText(filters.query);
  const coordQuery = filters.query ? parseCoordinateInput(filters.query) : null;

  const matched: UnicoAntennaRecord[] = [];
  for (let i = 0; i < antenas.length; i++) {
    const a = antenas[i];
    if (filters.fase === '1' && a.fase !== 1) continue;
    if (filters.fase === '2' && a.fase !== 2) continue;
    if (!activeOps.has(a.op)) continue;
    if (filters.ccaa && a.ccaa !== filters.ccaa) continue;
    if (filters.prov && a.prov !== filters.prov) continue;
    if (filters.mun && a.mun !== filters.mun) continue;

    if (coordQuery) {
      const distKm = haversineDistanceKm(
        coordQuery.lat,
        coordQuery.lon,
        a.lat,
        a.lon,
      );
      if (distKm > 15) continue;
    } else if (normQuery) {
      if (!searchIndex[i].includes(normQuery)) continue;
    }

    matched.push(a);
  }

  if (coordQuery) {
    matched.sort(
      (a, b) =>
        haversineDistanceKm(coordQuery.lat, coordQuery.lon, a.lat, a.lon) -
        haversineDistanceKm(coordQuery.lat, coordQuery.lon, b.lat, b.lon),
    );
  }

  return matched;
}

export interface UnicoDerivedAnalytics {
  totalSelected: number;
  pctOfNational: number;
  fase1Selected: number;
  fase2Selected: number;
  pctFase1InSelection: number;
  pctFase2InSelection: number;
  uniqueMunicipios: number;
  uniqueMunicipiosFase1: number;
  uniqueMunicipiosFase2: number;
  sharedMunicipiosBothPhases: number;
  uniqueProvincias: number;
  uniqueComunidades: number;
  operatorStats: UnicoOperatorStat[];
  /** Ordenado estrictamente A–Z por Comunidad Autónoma y A–Z por Provincia (sin rankings) */
  comunidadesAlpha: UnicoComunidadStat[];
  selectedBounds: UnicoBounds | null;
}

export function computeUnicoAnalytics(
  dataset: UnicoDataset,
  filtered: readonly UnicoAntennaRecord[],
): UnicoDerivedAnalytics {
  const totalSelected = filtered.length;
  const pctOfNational =
    dataset.total > 0 ? (totalSelected / dataset.total) * 100 : 0;

  let fase1Selected = 0;
  let fase2Selected = 0;
  const munsAll = new Set<string>();
  const munsF1 = new Set<string>();
  const munsF2 = new Set<string>();
  const provsSet = new Set<string>();
  const ccaasSet = new Set<string>();

  const opTotals: Record<UnicoOperatorKey, { total: number; f1: number; f2: number }> = {
    movistar: { total: 0, f1: 0, f2: 0 },
    orange: { total: 0, f1: 0, f2: 0 },
    vodafone: { total: 0, f1: 0, f2: 0 },
    avatel: { total: 0, f1: 0, f2: 0 },
  };

  const opEntitiesMap = new Map<
    UnicoOperatorKey,
    Map<string, { total: number; fase1: number; fase2: number }>
  >();
  for (const opKey of UNICO_OPERATOR_ORDER) {
    opEntitiesMap.set(opKey, new Map());
  }

  interface TempTerritoryAcc {
    ccaa: string;
    total: number;
    fase1: number;
    fase2: number;
    muns: Set<string>;
    byOperator: Record<UnicoOperatorKey, number>;
    bounds: UnicoBounds;
  }

  const ccaaAcc = new Map<string, TempTerritoryAcc>();
  const provAcc = new Map<string, TempTerritoryAcc & { prov: string }>();

  for (let i = 0; i < filtered.length; i++) {
    const a = filtered[i];
    const munId = `${a.prov}::${a.mun}`;
    munsAll.add(munId);
    provsSet.add(a.prov);
    ccaasSet.add(a.ccaa);

    if (a.fase === 1) {
      fase1Selected++;
      munsF1.add(munId);
    } else {
      fase2Selected++;
      munsF2.add(munId);
    }

    const opBucket = opTotals[a.op];
    opBucket.total++;
    if (a.fase === 1) opBucket.f1++;
    else opBucket.f2++;

    const entMap = opEntitiesMap.get(a.op)!;
    const entCur = entMap.get(a.empresa) ?? { total: 0, fase1: 0, fase2: 0 };
    entCur.total++;
    if (a.fase === 1) entCur.fase1++;
    else entCur.fase2++;
    entMap.set(a.empresa, entCur);

    let cEntry = ccaaAcc.get(a.ccaa);
    if (!cEntry) {
      cEntry = {
        ccaa: a.ccaa,
        total: 0,
        fase1: 0,
        fase2: 0,
        muns: new Set(),
        byOperator: { movistar: 0, orange: 0, vodafone: 0, avatel: 0 },
        bounds: { minLon: a.lon, minLat: a.lat, maxLon: a.lon, maxLat: a.lat },
      };
      ccaaAcc.set(a.ccaa, cEntry);
    }
    cEntry.total++;
    if (a.fase === 1) cEntry.fase1++;
    else cEntry.fase2++;
    cEntry.muns.add(munId);
    cEntry.byOperator[a.op]++;
    if (a.lon < cEntry.bounds.minLon) cEntry.bounds.minLon = a.lon;
    if (a.lat < cEntry.bounds.minLat) cEntry.bounds.minLat = a.lat;
    if (a.lon > cEntry.bounds.maxLon) cEntry.bounds.maxLon = a.lon;
    if (a.lat > cEntry.bounds.maxLat) cEntry.bounds.maxLat = a.lat;

    let pEntry = provAcc.get(a.prov);
    if (!pEntry) {
      pEntry = {
        prov: a.prov,
        ccaa: a.ccaa,
        total: 0,
        fase1: 0,
        fase2: 0,
        muns: new Set(),
        byOperator: { movistar: 0, orange: 0, vodafone: 0, avatel: 0 },
        bounds: { minLon: a.lon, minLat: a.lat, maxLon: a.lon, maxLat: a.lat },
      };
      provAcc.set(a.prov, pEntry);
    }
    pEntry.total++;
    if (a.fase === 1) pEntry.fase1++;
    else pEntry.fase2++;
    pEntry.muns.add(munId);
    pEntry.byOperator[a.op]++;
    if (a.lon < pEntry.bounds.minLon) pEntry.bounds.minLon = a.lon;
    if (a.lat < pEntry.bounds.minLat) pEntry.bounds.minLat = a.lat;
    if (a.lon > pEntry.bounds.maxLon) pEntry.bounds.maxLon = a.lon;
    if (a.lat > pEntry.bounds.maxLat) pEntry.bounds.maxLat = a.lat;
  }

  let sharedMunicipiosBothPhases = 0;
  for (const m of munsF1) {
    if (munsF2.has(m)) sharedMunicipiosBothPhases++;
  }

  const operatorStats: UnicoOperatorStat[] = UNICO_OPERATOR_ORDER.map((opKey) => {
    const counts = opTotals[opKey];
    const dsOp = dataset.operators[opKey];
    const entMap = opEntitiesMap.get(opKey)!;

    // Mostrar todas las entidades del operador presentes en el dataset con sus conteos filtrados
    const baseEntities = dsOp?.entities ?? [];
    const entities: UnicoEntityBreakdown[] = baseEntities.map((be) => {
      const cur = entMap.get(be.empresa);
      return {
        empresa: be.empresa,
        total: cur?.total ?? 0,
        fase1: cur?.fase1 ?? 0,
        fase2: cur?.fase2 ?? 0,
        ...(be.proyectosFase2 !== undefined
          ? { proyectosFase2: be.proyectosFase2 }
          : {}),
      };
    });

    return {
      key: opKey,
      meta: UNICO_OPERATOR_META[opKey],
      total: counts.total,
      pctOfSelection: totalSelected > 0 ? (counts.total / totalSelected) * 100 : 0,
      pctOfDataset: dataset.total > 0 ? (counts.total / dataset.total) * 100 : 0,
      fase1: counts.f1,
      fase2: counts.f2,
      pctFase1WithinOp: counts.total > 0 ? (counts.f1 / counts.total) * 100 : 0,
      pctFase2WithinOp: counts.total > 0 ? (counts.f2 / counts.total) * 100 : 0,
      proyectosFase2: dsOp?.proyectosFase2 ?? 0,
      entities,
    };
  });

  const provincesByCcaa = new Map<string, UnicoProvinceStat[]>();
  for (const p of provAcc.values()) {
    const list = provincesByCcaa.get(p.ccaa) ?? [];
    list.push({
      prov: p.prov,
      ccaa: p.ccaa,
      total: p.total,
      pctOfSelection: totalSelected > 0 ? (p.total / totalSelected) * 100 : 0,
      pctOfDataset: dataset.total > 0 ? (p.total / dataset.total) * 100 : 0,
      fase1: p.fase1,
      fase2: p.fase2,
      municipiosCount: p.muns.size,
      byOperator: p.byOperator,
      bounds: p.bounds,
    });
    provincesByCcaa.set(p.ccaa, list);
  }

  for (const list of provincesByCcaa.values()) {
    list.sort((a, b) => a.prov.localeCompare(b.prov, 'es'));
  }

  const comunidadesAlpha: UnicoComunidadStat[] = Array.from(ccaaAcc.values())
    .sort((a, b) => a.ccaa.localeCompare(b.ccaa, 'es'))
    .map((c) => {
      const provList = provincesByCcaa.get(c.ccaa) ?? [];
      return {
        ccaa: c.ccaa,
        total: c.total,
        pctOfSelection: totalSelected > 0 ? (c.total / totalSelected) * 100 : 0,
        pctOfDataset: dataset.total > 0 ? (c.total / dataset.total) * 100 : 0,
        fase1: c.fase1,
        fase2: c.fase2,
        municipiosCount: c.muns.size,
        provincesCount: provList.length,
        byOperator: c.byOperator,
        provinces: provList,
        bounds: c.bounds,
      };
    });

  return {
    totalSelected,
    pctOfNational,
    fase1Selected,
    fase2Selected,
    pctFase1InSelection:
      totalSelected > 0 ? (fase1Selected / totalSelected) * 100 : 0,
    pctFase2InSelection:
      totalSelected > 0 ? (fase2Selected / totalSelected) * 100 : 0,
    uniqueMunicipios: munsAll.size,
    uniqueMunicipiosFase1: munsF1.size,
    uniqueMunicipiosFase2: munsF2.size,
    sharedMunicipiosBothPhases,
    uniqueProvincias: provsSet.size,
    uniqueComunidades: ccaasSet.size,
    operatorStats,
    comunidadesAlpha,
    selectedBounds: computeBoundsForAntennas(filtered),
  };
}

export function sortUnicoAntennasNeutral(
  antenas: readonly UnicoAntennaRecord[],
  sortField: UnicoTableSortField,
  sortAsc: boolean,
): UnicoAntennaRecord[] {
  if (sortField === 'territorio' && sortAsc) {
    return [...antenas];
  }
  const dir = sortAsc ? 1 : -1;
  const copy = [...antenas];
  copy.sort((a, b) => {
    let cmp = 0;
    switch (sortField) {
      case 'mun':
        cmp = a.mun.localeCompare(b.mun, 'es') || a.prov.localeCompare(b.prov, 'es');
        break;
      case 'prov':
        cmp = a.prov.localeCompare(b.prov, 'es') || a.mun.localeCompare(b.mun, 'es');
        break;
      case 'ccaa':
        cmp =
          a.ccaa.localeCompare(b.ccaa, 'es') ||
          a.prov.localeCompare(b.prov, 'es') ||
          a.mun.localeCompare(b.mun, 'es');
        break;
      case 'fase':
        cmp = a.fase - b.fase || a.prov.localeCompare(b.prov, 'es') || a.mun.localeCompare(b.mun, 'es');
        break;
      case 'op':
        cmp =
          UNICO_OPERATOR_META[a.op].shortName.localeCompare(
            UNICO_OPERATOR_META[b.op].shortName,
            'es',
          ) || a.prov.localeCompare(b.prov, 'es');
        break;
      case 'territorio':
      default:
        cmp =
          a.ccaa.localeCompare(b.ccaa, 'es') ||
          a.prov.localeCompare(b.prov, 'es') ||
          a.mun.localeCompare(b.mun, 'es') ||
          a.fase - b.fase;
        break;
    }
    return cmp * dir;
  });
  return copy;
}

function escapeCsvValue(val: string | number): string {
  const s = String(val);
  if (/[",\n\r;]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Construye exportación CSV de antenas UNICO 5G filtradas (sin código de emplazamiento ni ID de propietario).
 */
export function buildUnico5gCsvContent(
  antenas: readonly UnicoAntennaRecord[],
): string {
  const headers = [
    'Proyecto_Fase',
    'Convocatoria',
    'Operador',
    'Entidad_Adjudicataria',
    'Comunidad_Autonoma',
    'Provincia',
    'Municipio',
    'Latitud_WGS84',
    'Longitud_WGS84',
  ];
  const lines = [headers.join(',')];
  for (let i = 0; i < antenas.length; i++) {
    const a = antenas[i];
    lines.push(
      [
        `Fase ${a.fase}`,
        a.fase === 1 ? '2023' : '2024',
        UNICO_OPERATOR_META[a.op].name,
        a.empresa,
        a.ccaa,
        a.prov,
        a.mun,
        a.lat.toFixed(6),
        a.lon.toFixed(6),
      ]
        .map(escapeCsvValue)
        .join(','),
    );
  }
  return lines.join('\r\n');
}

export function downloadUnico5gCsv(
  antenas: readonly UnicoAntennaRecord[],
  filenamePrefix = 'radiomapa-unico-5g',
): void {
  const stamp = new Date().toISOString().slice(0, 10);
  const blob = new Blob([`\uFEFF${buildUnico5gCsvContent(antenas)}`], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${filenamePrefix}-${stamp}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function downloadUnico5gJson(
  antenas: readonly UnicoAntennaRecord[],
  filenamePrefix = 'radiomapa-unico-5g',
): void {
  const stamp = new Date().toISOString().slice(0, 10);
  const payload = {
    program: 'UNICO 5G Redes Activas',
    exportedAt: new Date().toISOString(),
    total: antenas.length,
    fase1: antenas.filter((a) => a.fase === 1).length,
    fase2: antenas.filter((a) => a.fase === 2).length,
    antenas: antenas.map((a) => ({
      fase: a.fase,
      convocatoria: a.fase === 1 ? '2023' : '2024',
      operador: UNICO_OPERATOR_META[a.op].name,
      entidad: a.empresa,
      comunidadAutonoma: a.ccaa,
      provincia: a.prov,
      municipio: a.mun,
      lat: a.lat,
      lon: a.lon,
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${filenamePrefix}-${stamp}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export const UNICO_5G_QUERY_KEY = ['unico-5g-dataset'] as const;

async function fetchUnico5gDataset(): Promise<UnicoDataset> {
  const response = await fetch('./data/unico-5g.json', {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(
      `No se pudo cargar el dataset UNICO 5G (HTTP ${response.status}).`,
    );
  }
  const raw: unknown = await response.json();
  return parseCustomUnico5gJson(raw);
}

export function buildUnicoSearchIndex(
  antenas: readonly UnicoAntennaRecord[],
): string[] {
  const idx = new Array<string>(antenas.length);
  for (let i = 0; i < antenas.length; i++) {
    const a = antenas[i];
    const opMeta = UNICO_OPERATOR_META[a.op];
    idx[i] = normalizeSearchText(
      `${a.mun} ${a.prov} ${a.ccaa} ${opMeta.name} ${opMeta.shortName} ${a.empresa} fase ${a.fase}`,
    );
  }
  return idx;
}

export function useUnico5gData() {
  const query = useQuery({
    queryKey: UNICO_5G_QUERY_KEY,
    queryFn: fetchUnico5gDataset,
  });

  const searchIndex = useMemo(
    () => (query.data ? buildUnicoSearchIndex(query.data.antenas) : []),
    [query.data],
  );

  return {
    dataset: query.data ?? null,
    searchIndex,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  };
}
