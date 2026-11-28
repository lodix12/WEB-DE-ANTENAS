import {
  CNMC_METRIC_ORDER,
  CNMC_NA_SERIES_KEY,
  type CnmcCatalogMetadata,
  type CnmcCompactRecord,
  type CnmcDatasetPayload,
  type CnmcFallbackFilePayload,
  type CnmcMetricKey,
  type CnmcNormalizedRecord,
  type CnmcRawRecord,
} from '../types/cnmc';

export const CNMC_CKAN_BASE_URL = 'https://catalogodatos.cnmc.es/api/3/action';
export const CNMC_PORTAL_URL =
  'https://data.cnmc.es/telecomunicaciones-y-sector-audiovisual/datos-anuales/datos-generales/telecomunicaciones-anual';
export const CNMC_DATASET_TYPE_ID = '203';
export const CNMC_DATASET_TITLE = 'Telecomunicaciones Anual Datos Generales';
export const CNMC_FALLBACK_DATASET_NAME = 'ds_24233_1';
export const CNMC_DATASTORE_PAGE_LIMIT = 5000;
export const CNMC_LOCAL_CACHE_KEY = 'redes-moviles-espana:cnmc-anual:v1';
export const CNMC_FALLBACK_JSON_URL = './data/cnmc-anual.json';

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'statusText' | 'json'>>;

interface CkanExtraEntry {
  key?: unknown;
  value?: unknown;
}

interface CkanResourceEntry {
  id?: unknown;
  format?: unknown;
  datastore_active?: unknown;
  url?: unknown;
  name?: unknown;
}

interface CkanPackageEntry {
  name?: unknown;
  title?: unknown;
  version?: unknown;
  metadata_modified?: unknown;
  license_title?: unknown;
  license_url?: unknown;
  extras?: unknown;
  resources?: unknown;
}

function asTrimmedString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function extractExtrasMap(rawExtras: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  if (!Array.isArray(rawExtras)) return map;
  for (let i = 0; i < rawExtras.length; i++) {
    const entry = rawExtras[i] as CkanExtraEntry;
    if (entry && typeof entry === 'object' && typeof entry.key === 'string') {
      map[entry.key] = asTrimmedString(entry.value);
    }
  }
  return map;
}

function selectBestCkanPackage(candidates: unknown[]): CkanPackageEntry | null {
  const valid = candidates.filter(
    (item): item is CkanPackageEntry =>
      Boolean(item) &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      Array.isArray((item as CkanPackageEntry).resources),
  );
  if (valid.length === 0) return null;

  valid.sort((a, b) => {
    const exA = extractExtrasMap(a.extras);
    const exB = extractExtrasMap(b.extras);
    const pubA = exA.estado?.toLowerCase() === 'publicado' ? 1 : 0;
    const pubB = exB.estado?.toLowerCase() === 'publicado' ? 1 : 0;
    if (pubA !== pubB) return pubB - pubA;

    const typeA = exA.idTipoDataSetBD === CNMC_DATASET_TYPE_ID ? 1 : 0;
    const typeB = exB.idTipoDataSetBD === CNMC_DATASET_TYPE_ID ? 1 : 0;
    if (typeA !== typeB) return typeB - typeA;

    const modA = asTrimmedString(a.metadata_modified) || exA.modified || '';
    const modB = asTrimmedString(b.metadata_modified) || exB.modified || '';
    return modB.localeCompare(modA);
  });

  return valid[0];
}

function selectActiveDatastoreResource(
  pkg: CkanPackageEntry,
): CkanResourceEntry {
  const rawList = Array.isArray(pkg.resources) ? pkg.resources : [];
  const valid = rawList.filter(
    (item): item is CkanResourceEntry =>
      Boolean(item) &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      asTrimmedString((item as CkanResourceEntry).id).length > 0,
  );

  if (valid.length === 0) {
    throw new Error('El paquete CNMC no contiene recursos consultables.');
  }

  const active = valid.find((res) => res.datastore_active === true);
  if (active) return active;

  const csv = valid.find(
    (res) => asTrimmedString(res.format).toUpperCase() === 'CSV',
  );
  return csv ?? valid[0];
}

function buildStep1CandidateUrls(): string[] {
  return [
    `${CNMC_CKAN_BASE_URL}/package_search?fq=${encodeURIComponent(
      `idTipoDataSetBD:${CNMC_DATASET_TYPE_ID}`,
    )}&rows=10`,
    `${CNMC_CKAN_BASE_URL}/package_search?q=${encodeURIComponent(
      `"${CNMC_DATASET_TITLE}"`,
    )}&rows=10`,
    `${CNMC_CKAN_BASE_URL}/package_show?id=${encodeURIComponent(
      CNMC_FALLBACK_DATASET_NAME,
    )}`,
  ];
}

export function buildCnmcStep2Url(
  resourceId: string,
  limit = CNMC_DATASTORE_PAGE_LIMIT,
  offset = 0,
): string {
  return `${CNMC_CKAN_BASE_URL}/datastore_search?resource_id=${encodeURIComponent(
    resourceId,
  )}&limit=${limit}&offset=${offset}`;
}

function parseOptionalMetricNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || typeof raw === 'boolean') {
    return null;
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === 'string') {
    const cleaned = raw.trim().replace(',', '.');
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeDimensionText(raw: unknown): string {
  const cleaned = asTrimmedString(raw);
  if (!cleaned || cleaned.toUpperCase() === CNMC_NA_SERIES_KEY) {
    return CNMC_NA_SERIES_KEY;
  }
  return cleaned;
}

export function normalizeCnmcRawRecord(
  raw: CnmcRawRecord,
): CnmcNormalizedRecord | null {
  const annoRaw = asTrimmedString(raw.anno);
  if (!/^\d{4}$/.test(annoRaw)) return null;
  const anno = Number.parseInt(annoRaw, 10);

  const ingresos = parseOptionalMetricNumber(raw.ingresos);
  const ingresos_por_operador = parseOptionalMetricNumber(
    raw.ingresos_por_operador,
  );
  const empleados_por_operador = parseOptionalMetricNumber(
    raw.empleados_por_operador,
  );
  const paquetes = parseOptionalMetricNumber(raw.paquetes);
  const inversiones_por_operador = parseOptionalMetricNumber(
    raw.inversiones_por_operador,
  );
  const gastos_por_operador = parseOptionalMetricNumber(
    raw.gastos_por_operador,
  );

  if (
    ingresos === null &&
    ingresos_por_operador === null &&
    empleados_por_operador === null &&
    paquetes === null &&
    inversiones_por_operador === null &&
    gastos_por_operador === null
  ) {
    return null;
  }

  return {
    anno,
    tipoDeMercado: normalizeDimensionText(raw.tipo_de_mercado),
    concepto: normalizeDimensionText(raw.concepto),
    operador: normalizeDimensionText(raw.operador),
    tipoDeIngreso: normalizeDimensionText(raw.tipo_de_ingreso),
    tipoDePaquete: normalizeDimensionText(raw.tipo_de_paquete),
    unidades: normalizeDimensionText(raw.unidades),
    ingresos,
    ingresos_por_operador,
    empleados_por_operador,
    paquetes,
    inversiones_por_operador,
    gastos_por_operador,
  };
}

export function expandCnmcCompactRecord(
  compact: CnmcCompactRecord,
): CnmcNormalizedRecord | null {
  if (
    !compact ||
    typeof compact !== 'object' ||
    typeof compact.a !== 'number' ||
    !Number.isInteger(compact.a)
  ) {
    return null;
  }

  const ingresos = parseOptionalMetricNumber(compact.ingresos);
  const ingresos_por_operador = parseOptionalMetricNumber(
    compact.ingresos_por_operador,
  );
  const empleados_por_operador = parseOptionalMetricNumber(
    compact.empleados_por_operador,
  );
  const paquetes = parseOptionalMetricNumber(compact.paquetes);
  const inversiones_por_operador = parseOptionalMetricNumber(
    compact.inversiones_por_operador,
  );
  const gastos_por_operador = parseOptionalMetricNumber(
    compact.gastos_por_operador,
  );

  if (
    ingresos === null &&
    ingresos_por_operador === null &&
    empleados_por_operador === null &&
    paquetes === null &&
    inversiones_por_operador === null &&
    gastos_por_operador === null
  ) {
    return null;
  }

  return {
    anno: compact.a,
    tipoDeMercado: normalizeDimensionText(compact.m),
    concepto: normalizeDimensionText(compact.c),
    operador: normalizeDimensionText(compact.o),
    tipoDeIngreso: normalizeDimensionText(compact.ti),
    tipoDePaquete: normalizeDimensionText(compact.tp),
    unidades: normalizeDimensionText(compact.u),
    ingresos,
    ingresos_por_operador,
    empleados_por_operador,
    paquetes,
    inversiones_por_operador,
    gastos_por_operador,
  };
}

export function compactCnmcNormalizedRecord(
  rec: CnmcNormalizedRecord,
): CnmcCompactRecord {
  const out: CnmcCompactRecord = { a: rec.anno };
  if (rec.tipoDeMercado !== CNMC_NA_SERIES_KEY) out.m = rec.tipoDeMercado;
  if (rec.concepto !== CNMC_NA_SERIES_KEY) out.c = rec.concepto;
  if (rec.operador !== CNMC_NA_SERIES_KEY) out.o = rec.operador;
  if (rec.tipoDeIngreso !== CNMC_NA_SERIES_KEY) out.ti = rec.tipoDeIngreso;
  if (rec.tipoDePaquete !== CNMC_NA_SERIES_KEY) out.tp = rec.tipoDePaquete;
  if (rec.unidades !== CNMC_NA_SERIES_KEY) out.u = rec.unidades;

  for (let i = 0; i < CNMC_METRIC_ORDER.length; i++) {
    const key: CnmcMetricKey = CNMC_METRIC_ORDER[i];
    const value = rec[key];
    if (value !== null) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Paso 1 de la API CKAN de CNMC|Data:
 * Localiza el paquete publicado más reciente de "Telecomunicaciones Anual Datos Generales"
 * y devuelve su `resource_id` activo en el Datastore junto a los metadatos oficiales.
 */
export async function resolveCnmcAnnualResource(
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  signal?: AbortSignal,
): Promise<CnmcCatalogMetadata> {
  const urls = buildStep1CandidateUrls();
  let lastError: Error | null = null;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const response = await fetchImpl(url, { signal });
      if (!response.ok) {
        lastError = new Error(
          `HTTP ${response.status} al consultar catálogo CNMC (${response.statusText || 'error'})`,
        );
        continue;
      }

      const body = (await response.json()) as {
        success?: unknown;
        result?: { results?: unknown[]; resources?: unknown[] } & CkanPackageEntry;
      };

      if (body?.success !== true || !body.result || typeof body.result !== 'object') {
        lastError = new Error('Respuesta CKAN inválida en el Paso 1.');
        continue;
      }

      const pkg = Array.isArray(body.result.results)
        ? selectBestCkanPackage(body.result.results)
        : Array.isArray(body.result.resources)
          ? body.result
          : null;

      if (!pkg) {
        lastError = new Error('No se encontró ningún paquete publicado en CNMC.');
        continue;
      }

      const resource = selectActiveDatastoreResource(pkg);
      const resourceId = asTrimmedString(resource.id);
      const extras = extractExtrasMap(pkg.extras);

      return {
        datasetName: asTrimmedString(pkg.name) || CNMC_FALLBACK_DATASET_NAME,
        datasetTitle: asTrimmedString(pkg.title) || CNMC_DATASET_TITLE,
        version: asTrimmedString(pkg.version),
        resourceId,
        resourceUrl: asTrimmedString(resource.url),
        periodo: extras.periodo ?? '',
        modified: extras.modified ?? '',
        issued: extras.issued ?? '',
        metadataModified: asTrimmedString(pkg.metadata_modified),
        novedad: extras.novedad ?? '',
        frecuencia: extras.frecuenciaActualizacion || 'Anual',
        licenseTitle: asTrimmedString(pkg.license_title) || 'CC-BY-SA-4.0',
        licenseUrl:
          asTrimmedString(pkg.license_url) ||
          extras.license ||
          'https://data.cnmc.es/condiciones-de-uso',
        portalUrl: CNMC_PORTAL_URL,
        step1Url: url,
        step2Url: buildCnmcStep2Url(resourceId, CNMC_DATASTORE_PAGE_LIMIT, 0),
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      lastError =
        err instanceof Error
          ? err
          : new Error('Error de red al consultar el catálogo CNMC.');
    }
  }

  throw (
    lastError ??
    new Error('No se pudo conectar con el catálogo CKAN de CNMC|Data.')
  );
}

/**
 * Paso 2 de la API CKAN de CNMC|Data:
 * Descarga todos los registros del `resource_id` desde el Datastore, paginando
 * automáticamente si el dataset supera el límite por página.
 */
export async function fetchCnmcDatastoreRecords(
  resourceId: string,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  options?: { signal?: AbortSignal; pageLimit?: number },
): Promise<{ records: CnmcNormalizedRecord[]; totalRecords: number }> {
  const pageLimit = options?.pageLimit ?? CNMC_DATASTORE_PAGE_LIMIT;
  const normalized: CnmcNormalizedRecord[] = [];
  let offset = 0;
  let totalReported: number | null = null;
  let rawCollected = 0;

  while (true) {
    const url = buildCnmcStep2Url(resourceId, pageLimit, offset);
    const response = await fetchImpl(url, { signal: options?.signal });
    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} al consultar datastore CNMC (${response.statusText || 'error'})`,
      );
    }

    const body = (await response.json()) as {
      success?: unknown;
      result?: { total?: unknown; records?: unknown };
    };

    if (
      body?.success !== true ||
      !body.result ||
      !Array.isArray(body.result.records)
    ) {
      throw new Error('Respuesta CKAN inválida en datastore_search.');
    }

    const batch = body.result.records as CnmcRawRecord[];
    if (totalReported === null) {
      totalReported =
        typeof body.result.total === 'number' &&
        Number.isFinite(body.result.total)
          ? body.result.total
          : batch.length;
    }

    rawCollected += batch.length;
    for (let i = 0; i < batch.length; i++) {
      const rec = normalizeCnmcRawRecord(batch[i]);
      if (rec) {
        normalized.push(rec);
      }
    }

    if (
      batch.length === 0 ||
      rawCollected >= totalReported ||
      batch.length < pageLimit
    ) {
      break;
    }
    offset += batch.length;
  }

  return {
    records: normalized,
    totalRecords: totalReported ?? normalized.length,
  };
}

function isValidMetadataObject(raw: unknown): raw is CnmcCatalogMetadata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const m = raw as Record<string, unknown>;
  return (
    typeof m.datasetName === 'string' &&
    typeof m.datasetTitle === 'string' &&
    typeof m.resourceId === 'string' &&
    m.resourceId.trim().length > 0
  );
}

export function parseCnmcStoredPayload(
  raw: unknown,
  source: 'cache' | 'fallback',
): CnmcDatasetPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Payload CNMC almacenado inválido.');
  }
  const obj = raw as Partial<CnmcFallbackFilePayload>;
  if (!isValidMetadataObject(obj.metadata) || !Array.isArray(obj.records)) {
    throw new Error('Estructura CNMC incompleta.');
  }

  const records: CnmcNormalizedRecord[] = [];
  for (let i = 0; i < obj.records.length; i++) {
    const rec = expandCnmcCompactRecord(obj.records[i]);
    if (rec) {
      records.push(rec);
    }
  }

  if (records.length === 0) {
    throw new Error('El respaldo CNMC no contiene registros válidos.');
  }

  return {
    schemaVersion:
      typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 1,
    fetchedAt:
      typeof obj.fetchedAt === 'string' && obj.fetchedAt
        ? obj.fetchedAt
        : new Date().toISOString(),
    metadata: {
      datasetName: obj.metadata.datasetName,
      datasetTitle: obj.metadata.datasetTitle,
      version: obj.metadata.version ?? '',
      resourceId: obj.metadata.resourceId,
      resourceUrl: obj.metadata.resourceUrl ?? '',
      periodo: obj.metadata.periodo ?? '',
      modified: obj.metadata.modified ?? '',
      issued: obj.metadata.issued ?? '',
      metadataModified: obj.metadata.metadataModified ?? '',
      novedad: obj.metadata.novedad ?? '',
      frecuencia: obj.metadata.frecuencia || 'Anual',
      licenseTitle: obj.metadata.licenseTitle || 'CC-BY-SA-4.0',
      licenseUrl:
        obj.metadata.licenseUrl || 'https://data.cnmc.es/condiciones-de-uso',
      portalUrl: obj.metadata.portalUrl || CNMC_PORTAL_URL,
      step1Url: obj.metadata.step1Url || buildStep1CandidateUrls()[0],
      step2Url:
        obj.metadata.step2Url || buildCnmcStep2Url(obj.metadata.resourceId),
    },
    totalRecords:
      typeof obj.totalRecords === 'number' ? obj.totalRecords : records.length,
    records,
    source,
  };
}

function getStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    return null;
  }
  return null;
}

export function saveCnmcDatasetToCache(
  payload: CnmcDatasetPayload,
  storage: Storage | null = getStorage(),
): void {
  if (!storage) return;
  try {
    const compactPayload: CnmcFallbackFilePayload = {
      schemaVersion: payload.schemaVersion,
      fetchedAt: payload.fetchedAt,
      metadata: payload.metadata,
      totalRecords: payload.totalRecords,
      records: payload.records.map(compactCnmcNormalizedRecord),
    };
    storage.setItem(CNMC_LOCAL_CACHE_KEY, JSON.stringify(compactPayload));
  } catch {
    // Silenciar errores de cuota o modo privado
  }
}

export function readCnmcDatasetFromCache(
  storage: Storage | null = getStorage(),
): CnmcDatasetPayload | null {
  if (!storage) return null;
  try {
    const rawText = storage.getItem(CNMC_LOCAL_CACHE_KEY);
    if (!rawText) return null;
    const parsed = JSON.parse(rawText) as unknown;
    return parseCnmcStoredPayload(parsed, 'cache');
  } catch {
    return null;
  }
}

export function readCnmcCachedPeriodSummary(
  storage: Storage | null = getStorage(),
): { periodo: string; maxYear: number | null } | null {
  const cached = readCnmcDatasetFromCache(storage);
  if (!cached) return null;
  let maxYear: number | null = null;
  for (let i = 0; i < cached.records.length; i++) {
    const y = cached.records[i].anno;
    if (maxYear === null || y > maxYear) {
      maxYear = y;
    }
  }
  return {
    periodo: cached.metadata.periodo,
    maxYear,
  };
}

function payloadRecencyScore(payload: CnmcDatasetPayload): string {
  return (
    payload.metadata.metadataModified ||
    payload.metadata.modified ||
    payload.fetchedAt ||
    ''
  );
}

export interface FetchCnmcDatasetOptions {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  storage?: Storage | null;
  fallbackUrl?: string;
}

/**
 * Orquesta la carga de datos de CNMC:
 * 1) Intenta siempre primero la API oficial CKAN en 2 pasos (datos en directo).
 * 2) Si CNMC no responde o está en mantenimiento, selecciona automáticamente el
 *    respaldo más reciente disponible entre caché local (`localStorage`) y el
 *    archivo estático `./data/cnmc-anual.json`.
 */
export async function fetchCnmcAnnualDataset(
  options?: FetchCnmcDatasetOptions,
): Promise<CnmcDatasetPayload> {
  const fetchImpl: FetchLike =
    options?.fetchImpl ?? ((input, init) => fetch(input, init));
  const storage = options?.storage !== undefined ? options.storage : getStorage();
  const fallbackUrl = options?.fallbackUrl ?? CNMC_FALLBACK_JSON_URL;

  let liveErrorMessage = '';

  try {
    const metadata = await resolveCnmcAnnualResource(fetchImpl, options?.signal);
    const { records, totalRecords } = await fetchCnmcDatastoreRecords(
      metadata.resourceId,
      fetchImpl,
      { signal: options?.signal },
    );

    if (records.length === 0) {
      throw new Error('La API de la CNMC devolvió 0 registros.');
    }

    const livePayload: CnmcDatasetPayload = {
      schemaVersion: 1,
      fetchedAt: new Date().toISOString(),
      metadata,
      totalRecords,
      records,
      source: 'live',
    };

    saveCnmcDatasetToCache(livePayload, storage);
    return livePayload;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw err;
    }
    liveErrorMessage =
      err instanceof Error
        ? err.message
        : 'No se pudo conectar con la API de CNMC|Data.';
  }

  const cachedPayload = readCnmcDatasetFromCache(storage);
  let staticPayload: CnmcDatasetPayload | null = null;

  try {
    const resp = await fetchImpl(fallbackUrl, { signal: options?.signal });
    if (resp.ok) {
      const json = (await resp.json()) as unknown;
      staticPayload = parseCnmcStoredPayload(json, 'fallback');
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw err;
    }
  }

  let bestBackup: CnmcDatasetPayload | null = null;
  if (cachedPayload && staticPayload) {
    bestBackup =
      payloadRecencyScore(cachedPayload) >= payloadRecencyScore(staticPayload)
        ? cachedPayload
        : staticPayload;
  } else {
    bestBackup = cachedPayload ?? staticPayload;
  }

  if (bestBackup) {
    return {
      ...bestBackup,
      liveError: liveErrorMessage,
    };
  }

  throw new Error(
    `No se pudieron cargar los datos de la CNMC ni desde la API ni desde el respaldo local (${liveErrorMessage}).`,
  );
}
