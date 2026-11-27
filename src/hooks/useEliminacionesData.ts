import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  OPERATOR_META,
  normalizeOperatorKeyInput,
  type EliminacionRecord,
  type EliminacionTipo,
  type EliminacionesDataset,
  type OperatorKey,
} from '../types/antena';
import { normalizeSearchText } from '../utils/export';
import { getCanonicalSpanishProvince } from './useAntenasData';
import {
  LEGACY_COMMERCIAL_BANDS_MHZ,
  classifyFrequencyBandMhz,
  createTableSearchHelpers,
  extractScanDayDmy,
  formatScanDateTimeDmyHms,
  getNovedadAntennaGroupKey,
  getNovedadScanBatchKey,
  getNovedadesOperatorLabel,
  orderNovedadesGroupedByNewAntenna,
  resolveNovedadComunidad,
  resolveNovedadProvince,
  type NovedadesRouteSearch,
  type NovedadesTableViewState,
} from './useNovedadesData';
import {
  useLiveScanDelta,
  type LiveScanMergedDelta,
} from './useScanProgress';

const VALID_ELIMINACION_TIPOS = new Set<string>(['antena', 'frecuencia']);

export const STANDARD_ELIMINACIONES_BANDS = LEGACY_COMMERCIAL_BANDS_MHZ;

const VALID_STANDARD_ELIMINACIONES_BANDS = new Set<string>(
  STANDARD_ELIMINACIONES_BANDS,
);

const eliminacionesSearchHelpers = createTableSearchHelpers((rawBand) => {
  const trimmed = rawBand.trim();
  return VALID_STANDARD_ELIMINACIONES_BANDS.has(trimmed) ? trimmed : null;
});

export function validateEliminacionesSearch(
  raw: Record<string, unknown>,
): NovedadesRouteSearch {
  return eliminacionesSearchHelpers.validateSearch(raw);
}

export function resolveEliminacionesTableStateFromSearch(
  rawSearch: unknown,
): NovedadesTableViewState {
  return eliminacionesSearchHelpers.resolveTableStateFromSearch(rawSearch);
}

export function serializeEliminacionesTableStateToSearch(
  state: NovedadesTableViewState,
): NovedadesRouteSearch {
  return eliminacionesSearchHelpers.serializeTableStateToSearch(state);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeScanTimestampMs(scannedAt: string): number {
  const ms = Date.parse(scannedAt);
  return Number.isFinite(ms) ? ms : 0;
}

function pickLatestEliminacionesIso(baseIso: string, deltaIso: string): string {
  if (!deltaIso) return baseIso;
  if (!baseIso) return deltaIso;
  const baseMs = Date.parse(baseIso);
  const deltaMs = Date.parse(deltaIso);
  if (Number.isFinite(baseMs) && Number.isFinite(deltaMs)) {
    return deltaMs >= baseMs ? deltaIso : baseIso;
  }
  return deltaIso >= baseIso ? deltaIso : baseIso;
}

function validateEliminacionRecord(
  item: Record<string, unknown>,
): EliminacionRecord | null {
  const normalizedOp =
    typeof item.op === 'string'
      ? normalizeOperatorKeyInput(item.op, item.opRaw)
      : null;

  if (
    typeof item.id !== 'string' ||
    typeof item.tipo !== 'string' ||
    !VALID_ELIMINACION_TIPOS.has(item.tipo) ||
    typeof item.op !== 'string' ||
    normalizedOp === null ||
    typeof item.opRaw !== 'string' ||
    typeof item.codigo !== 'string' ||
    typeof item.antennaId !== 'string' ||
    typeof item.codigoBanda !== 'string' ||
    typeof item.frecuencia !== 'string' ||
    typeof item.ubicacion !== 'string' ||
    (item.prov !== undefined && typeof item.prov !== 'string') ||
    (item.lat !== undefined &&
      (typeof item.lat !== 'number' || !Number.isFinite(item.lat))) ||
    (item.lon !== undefined &&
      (typeof item.lon !== 'number' || !Number.isFinite(item.lon))) ||
    (item.scanId !== undefined && typeof item.scanId !== 'string') ||
    typeof item.scannedAt !== 'string' ||
    typeof item.fecha !== 'string'
  ) {
    return null;
  }

  return {
    id: item.id,
    tipo: item.tipo as EliminacionTipo,
    op: normalizedOp,
    opRaw: item.opRaw,
    codigo: item.codigo,
    antennaId: item.antennaId,
    codigoBanda: item.codigoBanda,
    frecuencia: item.frecuencia,
    ubicacion: item.ubicacion,
    ...(item.prov !== undefined ? { prov: item.prov } : {}),
    ...(typeof item.lat === 'number' && Number.isFinite(item.lat)
      ? { lat: item.lat }
      : {}),
    ...(typeof item.lon === 'number' && Number.isFinite(item.lon)
      ? { lon: item.lon }
      : {}),
    ...(typeof item.scanId === 'string' && item.scanId.trim()
      ? { scanId: item.scanId.trim() }
      : {}),
    scannedAt: item.scannedAt,
    fecha: item.fecha,
  };
}

/**
 * Ordena las eliminaciones por lote de escaneo (del escaneo más reciente al más antiguo)
 * y, dentro de cada lote, agrupa cada antena eliminada seguida inmediatamente por sus
 * frecuencias retiradas y, después, las frecuencias retiradas de antenas aún activas.
 */
export function orderEliminacionesGroupedByRemovedAntenna(
  rows: readonly EliminacionRecord[],
): EliminacionRecord[] {
  return orderNovedadesGroupedByNewAntenna(rows) as EliminacionRecord[];
}

/**
 * Valida que el contenido cargado corresponda exclusivamente al esquema JSON
 * propio de eliminaciones (`EliminacionesDataset` en `data/eliminaciones.json`)
 * y rechaza explícitamente colecciones o entidades GeoJSON (`FeatureCollection`).
 */
export function parseCustomEliminacionesJson(
  raw: unknown,
): EliminacionesDataset {
  if (!isPlainRecord(raw)) {
    throw new Error(
      'Formato inválido: se esperaba un objeto con el esquema JSON propio de eliminaciones (data/eliminaciones.json).',
    );
  }

  if (
    raw.type === 'FeatureCollection' ||
    raw.type === 'Feature' ||
    Array.isArray(raw.features)
  ) {
    throw new Error(
      'Formato GeoJSON (FeatureCollection) no admitido: Redes Moviles España requiere importar exclusivamente su esquema JSON propio (data/eliminaciones.json) y no carga desde GeoJSON.',
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
    typeof raw.antenasEliminadas !== 'number' ||
    !Number.isFinite(raw.antenasEliminadas) ||
    typeof raw.frecuenciasEliminadas !== 'number' ||
    !Number.isFinite(raw.frecuenciasEliminadas) ||
    !Array.isArray(raw.eliminaciones)
  ) {
    throw new Error(
      'Esquema JSON inválido: faltan propiedades obligatorias del formato propio EliminacionesDataset (updatedAt, scanId, previousScanAt, total, antenasEliminadas, frecuenciasEliminadas, eliminaciones).',
    );
  }

  const eliminacionesList = raw.eliminaciones;
  const validatedEliminaciones: EliminacionRecord[] = new Array(
    eliminacionesList.length,
  );
  for (let i = 0; i < eliminacionesList.length; i++) {
    const item: unknown = eliminacionesList[i];
    if (!isPlainRecord(item)) {
      throw new Error(
        `Registro inválido en eliminaciones[${i}]: se esperaba un objeto EliminacionRecord.`,
      );
    }
    if (item.type === 'Feature' || 'geometry' in item) {
      throw new Error(
        `Entidad GeoJSON detectada en eliminaciones[${i}]: Redes Moviles España exige registros compactos del JSON propio y no admite GeoJSON.`,
      );
    }
    const validated = validateEliminacionRecord(item);
    if (!validated) {
      throw new Error(
        `Registro incompleto en eliminaciones[${i}]: debe cumplir el esquema EliminacionRecord { id, tipo, op, opRaw, codigo, antennaId, codigoBanda, frecuencia, ubicacion, scannedAt, fecha }.`,
      );
    }
    validatedEliminaciones[i] = validated;
  }

  return {
    ...(raw as unknown as EliminacionesDataset),
    eliminaciones: orderEliminacionesGroupedByRemovedAntenna(
      validatedEliminaciones,
    ),
  };
}

/**
 * Importa exclusivamente el archivo estático con esquema JSON propio (`data/eliminaciones.json`).
 */
export async function importEliminacionesJsonDataset(): Promise<EliminacionesDataset> {
  const baseUrl = import.meta.env.BASE_URL || './';
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const response = await fetch(`${normalizedBase}data/eliminaciones.json`, {
    headers: { Accept: 'application/json' },
    cache: 'no-cache',
  });
  if (!response.ok) {
    throw new Error(
      `No se pudo importar el registro de eliminaciones en JSON propio (HTTP ${response.status})`,
    );
  }
  const raw: unknown = await response.json();
  return parseCustomEliminacionesJson(raw);
}

export interface EliminacionesFilterInput {
  eliminaciones: EliminacionRecord[];
  tipoFilter: 'all' | EliminacionTipo;
  operatorFilter: 'all' | OperatorKey;
  bandFilter?: string;
  comunidadFilter?: string;
  provinceFilter?: string;
  locationFilter?: string;
  dateFilter?: string;
  searchQuery: string;
}

export function filterEliminaciones({
  eliminaciones,
  tipoFilter,
  operatorFilter,
  bandFilter = 'all',
  comunidadFilter = 'all',
  provinceFilter = 'all',
  locationFilter = 'all',
  dateFilter = 'all',
  searchQuery,
}: EliminacionesFilterInput): EliminacionRecord[] {
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
    return eliminaciones;
  }

  const result: EliminacionRecord[] = [];
  for (let i = 0; i < eliminaciones.length; i++) {
    const row = eliminaciones[i];
    const rowOp = normalizeOperatorKeyInput(row.op, row.opRaw) ?? row.op;
    if (tipoFilter !== 'all' && row.tipo !== tipoFilter) continue;
    if (operatorFilter !== 'all' && rowOp !== operatorFilter) continue;

    if (activeBand) {
      if (row.tipo !== 'frecuencia') continue;
      const inferredBand = classifyFrequencyBandMhz(row.frecuencia);
      if (inferredBand !== activeBand) continue;
    }

    if (activeComunidad) {
      if (
        normalizeSearchText(resolveNovedadComunidad(row)) !== activeComunidad
      ) {
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
        row.tipo === 'antena'
          ? 'antena eliminada retirada baja'
          : 'frecuencia eliminada retirada baja';
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

function deduplicateAndSortEliminaciones(
  rows: readonly EliminacionRecord[],
): EliminacionRecord[] {
  const normalizedRows = rows.map((r) => {
    const normOp = normalizeOperatorKeyInput(r.op, r.opRaw);
    return normOp && normOp !== r.op ? { ...r, op: normOp } : r;
  });
  return orderEliminacionesGroupedByRemovedAntenna(normalizedRows);
}

function stampHistoricalBaseRows(
  baseDataset: EliminacionesDataset,
): EliminacionRecord[] {
  const baseScanId = baseDataset.scanId.trim();
  const canStampBaseScanId =
    baseScanId.length > 0 && baseScanId !== 'baseline-init';
  if (!canStampBaseScanId || baseDataset.eliminaciones.length === 0) {
    return baseDataset.eliminaciones;
  }

  const unstampedDayKeys = new Set<string>();
  for (let i = 0; i < baseDataset.eliminaciones.length; i++) {
    const r = baseDataset.eliminaciones[i];
    if (!r.scanId || !r.scanId.trim()) {
      unstampedDayKeys.add(getNovedadScanBatchKey(r));
    }
  }

  if (unstampedDayKeys.size === 0) {
    return baseDataset.eliminaciones;
  }

  const updatedDayDmy = extractScanDayDmy(baseDataset.updatedAt);
  const updatedDayMatch = updatedDayDmy.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const targetDayKey = updatedDayMatch
    ? `day:${updatedDayMatch[3]}-${updatedDayMatch[2]}-${updatedDayMatch[1]}`
    : '';

  return baseDataset.eliminaciones.map((r) => {
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
 * Fusiona en tiempo real las eliminaciones detectadas durante un escaneo activo (`recordNovedades === true`)
 * sobre el dataset estático `data/eliminaciones.json`, conservando siempre de forma permanente
 * todas las eliminaciones históricas registradas en escaneos anteriores y añadiendo encima las nuevas.
 */
export function mergeLiveDeltaIntoEliminacionesDataset(
  baseDataset: EliminacionesDataset,
  delta: LiveScanMergedDelta | null | undefined,
): EliminacionesDataset {
  if (!delta || !delta.recordNovedades) {
    return baseDataset;
  }

  const incomingDeltaRows = delta.eliminaciones ?? [];

  if (delta.completedDatasetUpdatedAt) {
    const baseMs = Date.parse(baseDataset.updatedAt);
    const doneMs = Date.parse(delta.completedDatasetUpdatedAt);
    if (
      Number.isFinite(baseMs) &&
      Number.isFinite(doneMs) &&
      baseMs >= doneMs &&
      (!baseDataset.isBaselineScan || incomingDeltaRows.length === 0)
    ) {
      return baseDataset;
    }
  }

  let mergedEliminaciones: EliminacionRecord[];
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
    const incomingNewRows: EliminacionRecord[] = [];
    for (let i = 0; i < incomingDeltaRows.length; i++) {
      const row = incomingDeltaRows[i];
      if (historicalIds.has(row.id)) continue;
      incomingNewRows.push(
        !row.scanId && deltaScanId ? { ...row, scanId: deltaScanId } : row,
      );
    }
    mergedEliminaciones = deduplicateAndSortEliminaciones([
      ...incomingNewRows,
      ...historicalRows,
    ]);
    scanId = delta.scanId;
    previousScanAt = delta.previousScanAt ?? (baseDataset.updatedAt || null);
    updatedAt = pickLatestEliminacionesIso(
      baseDataset.updatedAt,
      delta.updatedAt,
    );
  } else {
    if (incomingDeltaRows.length === 0) {
      return baseDataset;
    }
    const prevCutoffMs = delta.previousScanAt
      ? safeScanTimestampMs(delta.previousScanAt)
      : 0;
    const historicalBaseRows: EliminacionRecord[] = [];
    const sameScanBaseRows: EliminacionRecord[] = [];
    const historicalIds = new Set<string>();

    for (let i = 0; i < baseDataset.eliminaciones.length; i++) {
      const r = baseDataset.eliminaciones[i];
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

    const incomingSameScanRows: EliminacionRecord[] = [];
    for (let i = 0; i < incomingDeltaRows.length; i++) {
      const row = incomingDeltaRows[i];
      if (historicalIds.has(row.id)) continue;
      incomingSameScanRows.push(
        !row.scanId && deltaScanId ? { ...row, scanId: deltaScanId } : row,
      );
    }

    mergedEliminaciones = deduplicateAndSortEliminaciones([
      ...incomingSameScanRows,
      ...sameScanBaseRows,
      ...historicalBaseRows,
    ]);
    scanId = baseDataset.scanId;
    previousScanAt = baseDataset.previousScanAt;
    updatedAt = pickLatestEliminacionesIso(
      baseDataset.updatedAt,
      delta.updatedAt,
    );
  }

  let antenasEliminadas = 0;
  let frecuenciasEliminadas = 0;
  for (let i = 0; i < mergedEliminaciones.length; i++) {
    if (mergedEliminaciones[i].tipo === 'antena') {
      antenasEliminadas += 1;
    } else {
      frecuenciasEliminadas += 1;
    }
  }

  return {
    ...baseDataset,
    updatedAt,
    scanId,
    previousScanAt,
    isBaselineScan: false,
    total: mergedEliminaciones.length,
    antenasEliminadas,
    frecuenciasEliminadas,
    eliminaciones: mergedEliminaciones,
  };
}

export interface LatestScanEliminacionesCounts {
  total: number;
  antena: number;
  frecuencia: number;
  byOp: Record<OperatorKey, number>;
}

/**
 * Determina si una fila de eliminación pertenece estrictamente al último escaneo realizado
 * (`dataset.scanId`), excluyendo las filas históricas conservadas de escaneos previos.
 */
export function isLatestScanEliminacion(
  row: EliminacionRecord,
  dataset: Pick<
    EliminacionesDataset,
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
 * Calcula los contadores de eliminaciones contabilizando únicamente las bajas detectadas
 * en el último escaneo realizado (`dataset.scanId`), nunca el acumulado histórico.
 */
export function computeLatestScanEliminacionesCounts(
  dataset: EliminacionesDataset | null | undefined,
): LatestScanEliminacionesCounts {
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

  const rows = Array.isArray(dataset.eliminaciones)
    ? dataset.eliminaciones
    : [];
  if (rows.length === 0) {
    return {
      total: Math.max(0, dataset.total ?? 0),
      antena: Math.max(0, dataset.antenasEliminadas ?? 0),
      frecuencia: Math.max(0, dataset.frecuenciasEliminadas ?? 0),
      byOp,
    };
  }

  let antena = 0;
  let frecuencia = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!isLatestScanEliminacion(row, dataset)) {
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

export function getEliminacionAntennaGroupKey(
  row: Pick<EliminacionRecord, 'antennaId' | 'op' | 'codigo'>,
): string {
  return getNovedadAntennaGroupKey(row);
}

export function getEliminacionScanBatchKey(
  row: Pick<EliminacionRecord, 'scanId' | 'fecha' | 'scannedAt'>,
): string {
  return getNovedadScanBatchKey(row);
}

export function useEliminacionesData() {
  const query = useQuery({
    queryKey: ['eliminaciones-dataset'],
    queryFn: importEliminacionesJsonDataset,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 2,
  });

  const liveDelta = useLiveScanDelta();

  const mergedData = useMemo(
    () =>
      query.data
        ? mergeLiveDeltaIntoEliminacionesDataset(query.data, liveDelta)
        : undefined,
    [query.data, liveDelta],
  );

  return {
    ...query,
    data: mergedData,
  };
}
