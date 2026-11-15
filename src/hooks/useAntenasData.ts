import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  OPERATOR_ORDER,
  type AntenasDataset,
  type AntennaRecord,
  type OperatorKey,
  type ProvinceSummary,
} from '../types/antena';
import {
  normalizeSearchText,
  parseCoordinateInput,
} from '../utils/export';

export interface MunicipalityOption {
  mun: string;
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
  /** Centroide medio aproximado por provincia para navegación rápida */
  provinceCentroids: Map<string, { lat: number; lon: number }>;
  /** Búsqueda O(1) por id o Gis_ID */
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

export function buildDerivedAntenasStructures(
  dataset: AntenasDataset,
): DerivedAntenasStructures {
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

    searchIndex[i] = normalizeSearchText(
      `${ant.gid} ${ant.mun} ${ant.prov} ${ant.dir} ${ant.opRaw} ${ant.op}`,
    );
  }

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
}

export function useFilteredAntenas({
  derived,
  searchQuery,
  selectedProvince,
  selectedMunicipality,
  activeOperators,
}: AntenasFilterInput): AntennaRecord[] {
  return useMemo(() => {
    if (!derived) return [];
    const { antenas } = derived.dataset;
    const { searchIndex } = derived;

    if (activeOperators.length === 0) return [];

    const allOpsSelected = activeOperators.length === OPERATOR_ORDER.length;
    const opSet = allOpsSelected ? null : new Set<OperatorKey>(activeOperators);

    // Si el usuario escribe coordenadas válidas ("40.4168, -3.7038"), no filtramos el texto literal
    // para que pueda ver las antenas alrededor de ese punto en el mapa.
    const isCoordQuery = parseCoordinateInput(searchQuery) !== null;
    const normalizedQuery = isCoordQuery ? '' : normalizeSearchText(searchQuery);
    const tokens = normalizedQuery ? normalizedQuery.split(/\s+/).filter(Boolean) : [];

    if (
      allOpsSelected &&
      !selectedProvince &&
      !selectedMunicipality &&
      tokens.length === 0
    ) {
      return antenas;
    }

    const result: AntennaRecord[] = [];
    for (let i = 0; i < antenas.length; i++) {
      const ant = antenas[i];
      if (opSet && !opSet.has(ant.op)) continue;
      if (selectedProvince && ant.prov !== selectedProvince) continue;
      if (selectedMunicipality && ant.mun !== selectedMunicipality) continue;

      if (tokens.length > 0) {
        const hay = searchIndex[i];
        let matchesAll = true;
        for (let t = 0; t < tokens.length; t++) {
          if (!hay.includes(tokens[t])) {
            matchesAll = false;
            break;
          }
        }
        if (!matchesAll) continue;
      }

      result.push(ant);
    }

    return result;
  }, [
    derived,
    searchQuery,
    selectedProvince,
    selectedMunicipality,
    activeOperators,
  ]);
}
