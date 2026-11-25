import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  inferOperatorKeyFromAntennaId,
  normalizeOperatorKeyInput,
  type AntennaRecord,
  type ConcesionBanda,
  type EliminacionRecord,
  type EliminacionTipo,
  type LiveBandPatch,
  type LiveScanDeltaChunk,
  type NovedadRecord,
  type NovedadTipo,
  type ScanLifecycleState,
  type ScanPhase,
  type ScanStatusPayload,
} from '../types/antena';

const GITHUB_GIT_REF_STATUS_URL =
  'https://api.github.com/repos/lodix12/WEB-DE-ANTENAS/git/ref/heads/scan-status';

const GITHUB_CONTENTS_STATUS_URL =
  'https://api.github.com/repos/lodix12/WEB-DE-ANTENAS/contents/scan-status.json?ref=scan-status';

const GITHUB_RAW_REPO_BASE_URL =
  'https://raw.githubusercontent.com/lodix12/WEB-DE-ANTENAS';

const GITHUB_RAW_STATUS_URL =
  'https://raw.githubusercontent.com/lodix12/WEB-DE-ANTENAS/scan-status/scan-status.json';

const DEFAULT_LIVE_DELTA_BASE_URL =
  'https://raw.githubusercontent.com/lodix12/WEB-DE-ANTENAS/scan-status';

const GITHUB_WORKFLOW_RUNS_URL =
  'https://api.github.com/repos/lodix12/WEB-DE-ANTENAS/actions/workflows/update-and-deploy.yml/runs?per_page=4';

const GITHUB_WORKFLOW_DISPATCH_URL =
  'https://api.github.com/repos/lodix12/WEB-DE-ANTENAS/actions/workflows/update-and-deploy.yml/dispatches';

const SCAN_DISPATCH_TOKEN_STORAGE_KEY = 'radiomapa-gh-dispatch-token';

/** Ventana optimista tras un disparo forzado mientras arranca el runner de GitHub Actions */
const OPTIMISTIC_DISPATCH_WINDOW_MS = 150_000;
const OPTIMISTIC_ACTIONS_CHECK_INTERVAL_MS = 15_000;
const MAX_QUEUED_RUN_AGE_MS = 10 * 60 * 1000;

/** Intervalos adaptativos: con token (5.000 req/h) sondeo rápido de 8 s; sin token (60 req/h) sondeo conservador */
const AUTH_ACTIVE_POLL_INTERVAL_MS = 8_000;
const AUTH_IDLE_POLL_INTERVAL_MS = 20_000;
const ACTIVE_POLL_INTERVAL_MS = 15_000;
const CONSERVATIVE_ACTIVE_POLL_INTERVAL_MS = 25_000;
const IDLE_POLL_INTERVAL_MS = 45_000;

/** Si un estado "running"/"handoff" supera 6 minutos sin latido, verificar si el job sigue vivo */
const STALE_HEARTBEAT_MS = 6 * 60 * 1000;

/** Evitar consultar /actions/runs más de una vez cada 2 minutos en reposo */
const ACTIONS_CHECK_COOLDOWN_MS = 120_000;

const LIVE_CHUNK_FETCH_CONCURRENCY = 6;

const GEOJSON_LIVE_ERROR_MSG =
  'Formato GeoJSON no admitido en el flujo en vivo: Redes Moviles España utiliza exclusivamente su esquema JSON propio.';

const VALID_STATES = new Set<string>([
  'running',
  'handoff',
  'completed',
  'stopped',
  'idle',
]);

const VALID_PHASES = new Set<string>(['censo', 'frecuencias']);
const VALID_NOVEDAD_TIPOS = new Set<string>(['antena', 'frecuencia']);

const PERCENT_FORMATTER_ES = new Intl.NumberFormat('es-ES', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export type ForceScanDispatchStatus =
  | 'dispatched'
  | 'already_scanning'
  | 'needs_token'
  | 'unauthorized'
  | 'error';

export interface ForceScanDispatchResult {
  status: ForceScanDispatchStatus;
  httpStatus?: number;
}

interface ActiveWorkflowRunInfo {
  hasActiveScanRun: boolean;
  runId: string;
  event: string;
  startedAt: string;
}

interface EtagCache {
  refEtag: string | null;
  commitSha: string | null;
  rateLimitRemaining: number;
  rateLimitResetMs: number;
  etag: string | null;
  runsEtag: string | null;
  lastRunsData: ActiveWorkflowRunInfo | null;
  payload: ScanStatusPayload | null;
  lastActionsCheckMs: number;
}

const etagCache: EtagCache = {
  refEtag: null,
  commitSha: null,
  rateLimitRemaining: 60,
  rateLimitResetMs: 0,
  etag: null,
  runsEtag: null,
  lastRunsData: null,
  payload: null,
  lastActionsCheckMs: 0,
};

const rejectedAuthReadUrls = new Set<string>();

interface OptimisticDispatchState {
  dispatchedAtMs: number;
  untilMs: number;
  baselineScanId: string;
  adoptedRunId: string;
  payload: ScanStatusPayload;
}

let optimisticDispatchState: OptimisticDispatchState | null = null;
let memoryFallbackDispatchToken = '';

function normalizeDispatchToken(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:Bearer|token)\s+/i, '')
    .trim();
}

export function getStoredScanDispatchToken(): string {
  if (typeof window === 'undefined') {
    return memoryFallbackDispatchToken;
  }
  try {
    const storage = window.localStorage;
    if (!storage || typeof storage.getItem !== 'function') {
      return memoryFallbackDispatchToken;
    }
    const raw = storage.getItem(SCAN_DISPATCH_TOKEN_STORAGE_KEY);
    return typeof raw === 'string' ? normalizeDispatchToken(raw) : '';
  } catch {
    return '';
  }
}

export function setStoredScanDispatchToken(token: string): void {
  const trimmed = normalizeDispatchToken(token);
  memoryFallbackDispatchToken = trimmed;
  rejectedAuthReadUrls.clear();
  etagCache.rateLimitRemaining = trimmed.length > 0 ? 5000 : 60;
  etagCache.rateLimitResetMs = 0;
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const storage = window.localStorage;
    if (
      !storage ||
      typeof storage.setItem !== 'function' ||
      typeof storage.removeItem !== 'function'
    ) {
      return;
    }
    if (trimmed.length > 0) {
      storage.setItem(SCAN_DISPATCH_TOKEN_STORAGE_KEY, trimmed);
    } else {
      storage.removeItem(SCAN_DISPATCH_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignorar errores de almacenamiento restringido o cuota excedida
  }
}

export function clearStoredScanDispatchToken(): void {
  memoryFallbackDispatchToken = '';
  rejectedAuthReadUrls.clear();
  etagCache.rateLimitRemaining = 60;
  etagCache.rateLimitResetMs = 0;
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const storage = window.localStorage;
    if (storage && typeof storage.removeItem === 'function') {
      storage.removeItem(SCAN_DISPATCH_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignorar errores de acceso a localStorage
  }
}

export function resetScanProgressInternalCacheForTests(): void {
  etagCache.refEtag = null;
  etagCache.commitSha = null;
  etagCache.rateLimitRemaining = 60;
  etagCache.rateLimitResetMs = 0;
  etagCache.etag = null;
  etagCache.runsEtag = null;
  etagCache.lastRunsData = null;
  etagCache.payload = null;
  etagCache.lastActionsCheckMs = 0;
  rejectedAuthReadUrls.clear();
  optimisticDispatchState = null;
  memoryFallbackDispatchToken = '';
}

interface LiveDeltaScanCache {
  scanId: string;
  customBaseUrl: string;
  sealedChunks: Map<number, LiveScanDeltaChunk>;
  tailSeq: number;
  tailChunk: LiveScanDeltaChunk | null;
}

const liveDeltaCacheByClient = new WeakMap<object, LiveDeltaScanCache>();
const invalidatedCompletedScanByClient = new WeakMap<object, string>();

export interface LiveScanMergedDelta {
  scanId: string;
  deltaSeq: number;
  recordNovedades: boolean;
  previousScanAt: string | null;
  updatedAt: string;
  completedDatasetUpdatedAt: string;
  newAntennas: AntennaRecord[];
  bandPatchesById: Map<string, LiveBandPatch>;
  bandPatchesByGid: Map<string, LiveBandPatch>;
  novedades: NovedadRecord[];
  removedAntennaIds: Set<string>;
  eliminaciones: EliminacionRecord[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNotGeoJson(obj: Record<string, unknown>): void {
  if (
    obj.type === 'FeatureCollection' ||
    obj.type === 'Feature' ||
    Array.isArray(obj.features) ||
    'geometry' in obj
  ) {
    throw new Error(GEOJSON_LIVE_ERROR_MSG);
  }
}

function decodeBase64Utf8(b64: string): string {
  const cleaned = b64.replace(/\s+/g, '');
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function pickLatestIsoTimestamp(currentIso: string, nextIso: string): string {
  if (!nextIso) return currentIso;
  if (!currentIso) return nextIso;
  const curMs = Date.parse(currentIso);
  const nextMs = Date.parse(nextIso);
  if (Number.isFinite(curMs) && Number.isFinite(nextMs)) {
    return nextMs >= curMs ? nextIso : currentIso;
  }
  return nextIso >= currentIso ? nextIso : currentIso;
}

/**
 * Formatea un porcentaje numérico entre 0 y 100 en convención española ("34,76 %").
 */
export function formatScanPercentEs(percent: number): string {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  return `${PERCENT_FORMATTER_ES.format(clamped)} %`;
}

/**
 * Valida y normaliza un documento `scan-status.json` (o su envoltorio Base64 de GitHub Contents API).
 */
export function parseScanStatusPayload(raw: unknown): ScanStatusPayload | null {
  if (!isPlainObject(raw)) {
    return null;
  }

  // Envoltorio GitHub Contents API: { content: "...base64...", encoding: "base64" }
  if (typeof raw.content === 'string' && raw.encoding === 'base64') {
    try {
      const decodedText = decodeBase64Utf8(raw.content);
      const inner: unknown = JSON.parse(decodedText);
      return parseScanStatusPayload(inner);
    } catch {
      return null;
    }
  }

  const rawState = typeof raw.state === 'string' ? raw.state.trim() : '';
  if (!VALID_STATES.has(rawState)) {
    return null;
  }

  const rawPhase = typeof raw.phase === 'string' ? raw.phase.trim() : 'frecuencias';
  const phase: ScanPhase = VALID_PHASES.has(rawPhase)
    ? (rawPhase as ScanPhase)
    : 'frecuencias';

  const totalAntennas =
    typeof raw.totalAntennas === 'number' && Number.isFinite(raw.totalAntennas)
      ? Math.max(0, Math.round(raw.totalAntennas))
      : 62230;
  const scannedAntennas =
    typeof raw.scannedAntennas === 'number' && Number.isFinite(raw.scannedAntennas)
      ? Math.max(0, Math.min(totalAntennas || Infinity, Math.round(raw.scannedAntennas)))
      : 0;
  const percent =
    typeof raw.percent === 'number' && Number.isFinite(raw.percent)
      ? Math.max(0, Math.min(100, raw.percent))
      : totalAntennas > 0
        ? Math.min(100, (scannedAntennas / totalAntennas) * 100)
        : 0;

  const deltaSeq =
    typeof raw.deltaSeq === 'number' && Number.isFinite(raw.deltaSeq)
      ? Math.max(0, Math.round(raw.deltaSeq))
      : undefined;
  const chunkCount =
    typeof raw.chunkCount === 'number' && Number.isFinite(raw.chunkCount)
      ? Math.max(0, Math.round(raw.chunkCount))
      : undefined;
  const liveNewAntennasCount =
    typeof raw.liveNewAntennasCount === 'number' &&
    Number.isFinite(raw.liveNewAntennasCount)
      ? Math.max(0, Math.round(raw.liveNewAntennasCount))
      : undefined;
  const liveUpdatedAntennasCount =
    typeof raw.liveUpdatedAntennasCount === 'number' &&
    Number.isFinite(raw.liveUpdatedAntennasCount)
      ? Math.max(0, Math.round(raw.liveUpdatedAntennasCount))
      : undefined;
  const liveNovedadesCount =
    typeof raw.liveNovedadesCount === 'number' &&
    Number.isFinite(raw.liveNovedadesCount)
      ? Math.max(0, Math.round(raw.liveNovedadesCount))
      : undefined;
  const liveEliminacionesCount =
    typeof raw.liveEliminacionesCount === 'number' &&
    Number.isFinite(raw.liveEliminacionesCount)
      ? Math.max(0, Math.round(raw.liveEliminacionesCount))
      : undefined;
  const requestsPerSecond =
    typeof raw.requestsPerSecond === 'number' &&
    Number.isFinite(raw.requestsPerSecond) &&
    raw.requestsPerSecond >= 0
      ? raw.requestsPerSecond
      : undefined;
  const completedDatasetUpdatedAt =
    typeof raw.completedDatasetUpdatedAt === 'string' &&
    raw.completedDatasetUpdatedAt.trim().length > 0
      ? raw.completedDatasetUpdatedAt.trim()
      : undefined;

  return {
    schemaVersion:
      typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1,
    state: rawState as ScanLifecycleState,
    scanId: typeof raw.scanId === 'string' ? raw.scanId : '',
    trigger:
      typeof raw.trigger === 'string' && raw.trigger.trim()
        ? raw.trigger.trim()
        : 'workflow_dispatch',
    recordNovedades:
      typeof raw.recordNovedades === 'boolean' ? raw.recordNovedades : true,
    part: typeof raw.part === 'string' ? raw.part.trim() : '',
    phase,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    censusBoxesVisited:
      typeof raw.censusBoxesVisited === 'number' &&
      Number.isFinite(raw.censusBoxesVisited)
        ? Math.max(0, Math.round(raw.censusBoxesVisited))
        : 0,
    estimatedCensusBoxes:
      typeof raw.estimatedCensusBoxes === 'number' &&
      Number.isFinite(raw.estimatedCensusBoxes) &&
      raw.estimatedCensusBoxes > 0
        ? Math.round(raw.estimatedCensusBoxes)
        : 239,
    discoveredAntennas:
      typeof raw.discoveredAntennas === 'number' &&
      Number.isFinite(raw.discoveredAntennas)
        ? Math.max(0, Math.round(raw.discoveredAntennas))
        : 0,
    scannedAntennas,
    totalAntennas,
    percent,
    ...(deltaSeq !== undefined ? { deltaSeq } : {}),
    ...(chunkCount !== undefined ? { chunkCount } : {}),
    ...(liveNewAntennasCount !== undefined ? { liveNewAntennasCount } : {}),
    ...(liveUpdatedAntennasCount !== undefined
      ? { liveUpdatedAntennasCount }
      : {}),
    ...(liveNovedadesCount !== undefined ? { liveNovedadesCount } : {}),
    ...(liveEliminacionesCount !== undefined ? { liveEliminacionesCount } : {}),
    ...(requestsPerSecond !== undefined ? { requestsPerSecond } : {}),
    ...(completedDatasetUpdatedAt !== undefined
      ? { completedDatasetUpdatedAt }
      : {}),
  };
}

function validateLiveAntennaRecord(item: unknown): AntennaRecord | null {
  if (!isPlainObject(item)) {
    return null;
  }
  assertNotGeoJson(item);

  const normalizedOp =
    typeof item.op === 'string'
      ? normalizeOperatorKeyInput(item.op, item.opRaw)
      : null;

  if (
    typeof item.id !== 'string' ||
    typeof item.gid !== 'string' ||
    typeof item.op !== 'string' ||
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
    return null;
  }

  if (
    item.mergedGids !== undefined &&
    (!Array.isArray(item.mergedGids) ||
      !item.mergedGids.every((gid): gid is string => typeof gid === 'string'))
  ) {
    return null;
  }
  if (
    item.bandas !== undefined &&
    (!Array.isArray(item.bandas) ||
      !item.bandas.every((band): band is string => typeof band === 'string'))
  ) {
    return null;
  }
  if (
    item.frecuencias !== undefined &&
    (!Array.isArray(item.frecuencias) ||
      !item.frecuencias.every(
        (freq): freq is string => typeof freq === 'string',
      ))
  ) {
    return null;
  }
  if (
    item.concesiones !== undefined &&
    (!Array.isArray(item.concesiones) ||
      !item.concesiones.every(
        (c): c is ConcesionBanda =>
          isPlainObject(c) &&
          typeof c.ref === 'string' &&
          typeof c.freq === 'string',
      ))
  ) {
    return null;
  }
  if (
    item.bandsScannedAt !== undefined &&
    typeof item.bandsScannedAt !== 'string'
  ) {
    return null;
  }

  return {
    id: item.id,
    gid: item.gid,
    op: normalizedOp,
    opRaw: item.opRaw,
    lat: item.lat,
    lon: item.lon,
    dir: item.dir,
    mun: item.mun,
    prov: item.prov,
    ...(item.mergedGids !== undefined ? { mergedGids: item.mergedGids } : {}),
    ...(item.bandas !== undefined ? { bandas: item.bandas } : {}),
    ...(item.frecuencias !== undefined
      ? { frecuencias: item.frecuencias }
      : {}),
    ...(item.concesiones !== undefined
      ? { concesiones: item.concesiones }
      : {}),
    ...(item.bandsScannedAt !== undefined
      ? { bandsScannedAt: item.bandsScannedAt }
      : {}),
  };
}

function validateLiveBandPatch(item: unknown): LiveBandPatch | null {
  if (!isPlainObject(item)) {
    return null;
  }
  assertNotGeoJson(item);

  if (
    typeof item.id !== 'string' ||
    item.id.length === 0 ||
    typeof item.gid !== 'string' ||
    !Array.isArray(item.bandas) ||
    !item.bandas.every((band): band is string => typeof band === 'string')
  ) {
    return null;
  }

  if (
    item.mergedGids !== undefined &&
    (!Array.isArray(item.mergedGids) ||
      !item.mergedGids.every((gid): gid is string => typeof gid === 'string'))
  ) {
    return null;
  }
  if (
    item.frecuencias !== undefined &&
    (!Array.isArray(item.frecuencias) ||
      !item.frecuencias.every(
        (freq): freq is string => typeof freq === 'string',
      ))
  ) {
    return null;
  }
  if (
    item.concesiones !== undefined &&
    (!Array.isArray(item.concesiones) ||
      !item.concesiones.every(
        (c): c is ConcesionBanda =>
          isPlainObject(c) &&
          typeof c.ref === 'string' &&
          typeof c.freq === 'string',
      ))
  ) {
    return null;
  }
  if (
    item.bandsScannedAt !== undefined &&
    typeof item.bandsScannedAt !== 'string'
  ) {
    return null;
  }

  return {
    id: item.id,
    gid: item.gid,
    ...(item.mergedGids !== undefined ? { mergedGids: item.mergedGids } : {}),
    bandas: item.bandas,
    frecuencias: item.frecuencias ?? [],
    concesiones: item.concesiones ?? [],
    bandsScannedAt: item.bandsScannedAt ?? '',
  };
}

function validateLiveNovedadRecord(item: unknown): NovedadRecord | null {
  if (!isPlainObject(item)) {
    return null;
  }
  assertNotGeoJson(item);

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
    ...(item.scanId !== undefined && item.scanId.trim()
      ? { scanId: item.scanId.trim() }
      : {}),
    scannedAt: item.scannedAt,
    fecha: item.fecha,
  };
}

function validateLiveEliminacionRecord(
  item: unknown,
): EliminacionRecord | null {
  if (!isPlainObject(item)) {
    return null;
  }
  assertNotGeoJson(item);

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
    ...(item.scanId !== undefined && item.scanId.trim()
      ? { scanId: item.scanId.trim() }
      : {}),
    scannedAt: item.scannedAt,
    fecha: item.fecha,
  };
}

/**
 * Valida y normaliza un bloque de delta en vivo (`live-chunk-*.json` o `live-tail.json`)
 * exigiendo estrictamente el esquema JSON propio y rechazando cualquier entidad GeoJSON.
 */
export function parseLiveScanDeltaChunk(raw: unknown): LiveScanDeltaChunk | null {
  if (!isPlainObject(raw)) {
    return null;
  }

  assertNotGeoJson(raw);

  // Soporte de envoltorio Base64 de GitHub Contents API
  if (typeof raw.content === 'string' && raw.encoding === 'base64') {
    let inner: unknown;
    try {
      const decodedText = decodeBase64Utf8(raw.content);
      inner = JSON.parse(decodedText);
    } catch {
      return null;
    }
    return parseLiveScanDeltaChunk(inner);
  }

  if (typeof raw.scanId !== 'string' || raw.scanId.trim().length === 0) {
    return null;
  }

  if (typeof raw.state === 'string' && VALID_STATES.has(raw.state.trim())) {
    return null;
  }

  if (raw.newAntennas !== undefined && !Array.isArray(raw.newAntennas)) {
    return null;
  }
  if (raw.bandPatches !== undefined && !Array.isArray(raw.bandPatches)) {
    return null;
  }
  if (raw.novedades !== undefined && !Array.isArray(raw.novedades)) {
    return null;
  }
  if (
    raw.removedAntennaIds !== undefined &&
    (!Array.isArray(raw.removedAntennaIds) ||
      !raw.removedAntennaIds.every((rid): rid is string => typeof rid === 'string'))
  ) {
    return null;
  }
  if (raw.eliminaciones !== undefined && !Array.isArray(raw.eliminaciones)) {
    return null;
  }
  if (
    raw.previousScanAt !== undefined &&
    raw.previousScanAt !== null &&
    typeof raw.previousScanAt !== 'string'
  ) {
    return null;
  }

  const rawNewAntennas = raw.newAntennas ?? [];
  const newAntennas: AntennaRecord[] = new Array(rawNewAntennas.length);
  for (let i = 0; i < rawNewAntennas.length; i++) {
    const validated = validateLiveAntennaRecord(rawNewAntennas[i]);
    if (!validated) return null;
    newAntennas[i] = validated;
  }

  const rawBandPatches = raw.bandPatches ?? [];
  const bandPatches: LiveBandPatch[] = new Array(rawBandPatches.length);
  for (let i = 0; i < rawBandPatches.length; i++) {
    const validated = validateLiveBandPatch(rawBandPatches[i]);
    if (!validated) return null;
    bandPatches[i] = validated;
  }

  const rawNovedades = raw.novedades ?? [];
  const novedades: NovedadRecord[] = new Array(rawNovedades.length);
  for (let i = 0; i < rawNovedades.length; i++) {
    const validated = validateLiveNovedadRecord(rawNovedades[i]);
    if (!validated) return null;
    novedades[i] = validated;
  }

  let eliminaciones: EliminacionRecord[] | undefined;
  if (raw.eliminaciones !== undefined) {
    const rawElims = raw.eliminaciones;
    eliminaciones = new Array(rawElims.length);
    for (let i = 0; i < rawElims.length; i++) {
      const validated = validateLiveEliminacionRecord(rawElims[i]);
      if (!validated) return null;
      eliminaciones[i] = validated;
    }
  }

  const removedAntennaIds: string[] | undefined =
    raw.removedAntennaIds !== undefined ? raw.removedAntennaIds : undefined;

  return {
    schemaVersion:
      typeof raw.schemaVersion === 'number' && Number.isFinite(raw.schemaVersion)
        ? raw.schemaVersion
        : 2,
    scanId: raw.scanId,
    seq:
      typeof raw.seq === 'number' && Number.isFinite(raw.seq)
        ? Math.max(0, Math.round(raw.seq))
        : 0,
    chunkIndex:
      typeof raw.chunkIndex === 'number' && Number.isFinite(raw.chunkIndex)
        ? Math.max(0, Math.round(raw.chunkIndex))
        : 0,
    isTail: typeof raw.isTail === 'boolean' ? raw.isTail : false,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    recordNovedades:
      typeof raw.recordNovedades === 'boolean' ? raw.recordNovedades : true,
    previousScanAt:
      typeof raw.previousScanAt === 'string' ? raw.previousScanAt : null,
    ...(typeof raw.replacesNewAntennas === 'boolean'
      ? { replacesNewAntennas: raw.replacesNewAntennas }
      : {}),
    newAntennas,
    bandPatches,
    novedades,
    ...(removedAntennaIds !== undefined ? { removedAntennaIds } : {}),
    ...(eliminaciones !== undefined ? { eliminaciones } : {}),
  };
}

/**
 * Acumula de forma pura y determinista la secuencia ordenada de bloques de delta en vivo
 * aplicando fusiones canónicas (`replacesNewAntennas`), enriquecimiento instantáneo de bandas
 * sobre antenas recién descubiertas y ordenación cronológica inversa de novedades y eliminaciones.
 */
export function accumulateLiveDeltaChunks(
  chunks: readonly LiveScanDeltaChunk[],
  scanId: string,
  completedDatasetUpdatedAt = '',
): LiveScanMergedDelta {
  const targetScanId = scanId.trim();
  const newAntennasMap = new Map<string, AntennaRecord>();
  const bandPatchesById = new Map<string, LiveBandPatch>();
  const bandPatchesByGid = new Map<string, LiveBandPatch>();
  const novedadesMap = new Map<string, NovedadRecord>();
  const removedAntennaIds = new Set<string>();
  const eliminacionesMap = new Map<string, EliminacionRecord>();

  let resolvedScanId = targetScanId;
  let deltaSeq = 0;
  let recordNovedades = false;
  let hasMatchingChunk = false;
  let previousScanAt: string | null = null;
  let updatedAt = '';

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (targetScanId && chunk.scanId !== targetScanId) {
      continue;
    }

    if (!resolvedScanId && chunk.scanId) {
      resolvedScanId = chunk.scanId;
    }
    hasMatchingChunk = true;
    deltaSeq = Math.max(deltaSeq, chunk.seq);
    recordNovedades = chunk.recordNovedades;
    if (chunk.previousScanAt !== null) {
      previousScanAt = chunk.previousScanAt;
    }
    updatedAt = pickLatestIsoTimestamp(updatedAt, chunk.updatedAt);

    if (chunk.replacesNewAntennas === true) {
      newAntennasMap.clear();
      if (chunk.recordNovedades) {
        for (const [novId, nov] of novedadesMap.entries()) {
          if (nov.tipo === 'antena') {
            novedadesMap.delete(novId);
          }
        }
      }
    }

    for (let a = 0; a < chunk.newAntennas.length; a++) {
      const rawAnt = chunk.newAntennas[a];
      const normOp = normalizeOperatorKeyInput(rawAnt.op, rawAnt.opRaw);
      const ant =
        normOp && normOp !== rawAnt.op ? { ...rawAnt, op: normOp } : rawAnt;
      newAntennasMap.set(ant.id, ant);
      removedAntennaIds.delete(ant.id);
    }

    if (chunk.removedAntennaIds) {
      for (let r = 0; r < chunk.removedAntennaIds.length; r++) {
        const rid = chunk.removedAntennaIds[r].trim();
        if (rid) {
          removedAntennaIds.add(rid);
          newAntennasMap.delete(rid);
        }
      }
    }

    for (let p = 0; p < chunk.bandPatches.length; p++) {
      const patch = chunk.bandPatches[p];
      bandPatchesById.set(patch.id, patch);
      if (patch.gid) {
        bandPatchesByGid.set(patch.gid, patch);
      }
      if (patch.mergedGids) {
        for (let g = 0; g < patch.mergedGids.length; g++) {
          const mgid = patch.mergedGids[g];
          if (mgid) {
            bandPatchesByGid.set(mgid, patch);
          }
        }
      }
    }

    for (let n = 0; n < chunk.novedades.length; n++) {
      const rawNov = chunk.novedades[n];
      const normNovOp = normalizeOperatorKeyInput(rawNov.op, rawNov.opRaw);
      const nov =
        normNovOp && normNovOp !== rawNov.op
          ? { ...rawNov, op: normNovOp }
          : rawNov;
      const stampedNov =
        !nov.scanId && chunk.scanId ? { ...nov, scanId: chunk.scanId } : nov;
      novedadesMap.set(stampedNov.id, stampedNov);
    }

    if (chunk.eliminaciones) {
      for (let e = 0; e < chunk.eliminaciones.length; e++) {
        const rawElim = chunk.eliminaciones[e];
        const normElimOp = normalizeOperatorKeyInput(rawElim.op, rawElim.opRaw);
        const elim =
          normElimOp && normElimOp !== rawElim.op
            ? { ...rawElim, op: normElimOp }
            : rawElim;
        const stampedElim =
          !elim.scanId && chunk.scanId
            ? { ...elim, scanId: chunk.scanId }
            : elim;
        eliminacionesMap.set(stampedElim.id, stampedElim);
      }
    }
  }

  const newAntennas: AntennaRecord[] = [];
  for (const ant of newAntennasMap.values()) {
    let patch = bandPatchesById.get(ant.id);
    if (!patch && ant.mergedGids) {
      for (let g = 0; g < ant.mergedGids.length; g++) {
        const candidatePatch = bandPatchesByGid.get(ant.mergedGids[g]);
        if (candidatePatch) {
          const patchOp = inferOperatorKeyFromAntennaId(candidatePatch.id);
          if (!patchOp || patchOp === ant.op) {
            patch = candidatePatch;
            break;
          }
        }
      }
    }
    const isNewer =
      patch !== undefined &&
      (!ant.bandsScannedAt ||
        !patch.bandsScannedAt ||
        pickLatestIsoTimestamp(ant.bandsScannedAt, patch.bandsScannedAt) ===
          patch.bandsScannedAt);
    if (patch && isNewer) {
      const nextMergedGids = patch.mergedGids ?? ant.mergedGids;
      newAntennas.push({
        ...ant,
        ...(nextMergedGids !== undefined ? { mergedGids: nextMergedGids } : {}),
        bandas: patch.bandas,
        frecuencias: patch.frecuencias,
        concesiones: patch.concesiones,
        bandsScannedAt: patch.bandsScannedAt,
      });
    } else {
      newAntennas.push(ant);
    }
  }

  const novedades = Array.from(novedadesMap.values()).sort((a, b) => {
    const msA = Date.parse(a.scannedAt);
    const msB = Date.parse(b.scannedAt);
    const safeA = Number.isFinite(msA) ? msA : 0;
    const safeB = Number.isFinite(msB) ? msB : 0;
    return safeB - safeA;
  });

  const eliminaciones = Array.from(eliminacionesMap.values()).sort((a, b) => {
    const msA = Date.parse(a.scannedAt);
    const msB = Date.parse(b.scannedAt);
    const safeA = Number.isFinite(msA) ? msA : 0;
    const safeB = Number.isFinite(msB) ? msB : 0;
    return safeB - safeA;
  });

  return {
    scanId: resolvedScanId,
    deltaSeq,
    recordNovedades: hasMatchingChunk ? recordNovedades : false,
    previousScanAt,
    updatedAt,
    completedDatasetUpdatedAt,
    newAntennas,
    bandPatchesById,
    bandPatchesByGid,
    novedades,
    removedAntennaIds,
    eliminaciones,
  };
}

export interface InterpolatedScanMetrics {
  isScanning: boolean;
  percent: number;
  scannedAntennas: number;
  totalAntennas: number;
  censusBoxesVisited: number;
  estimatedCensusBoxes: number;
  phase: ScanPhase;
  trigger: string;
  recordNovedades: boolean;
  part: string;
}

/**
 * Calcula de forma pura las métricas instantáneas interpoladas entre latidos del servidor
 * soportando tanto escáneres paralelos de alta velocidad (schemaVersion >= 2 / requestsPerSecond)
 * como el esquema histórico secuencial (schemaVersion === 1).
 */
export function computeInterpolatedScanMetrics(
  status: ScanStatusPayload | null | undefined,
  nowMs: number,
  fallbackTotalAntennas = 62230,
): InterpolatedScanMetrics {
  if (!status) {
    return {
      isScanning: false,
      percent: 0,
      scannedAntennas: 0,
      totalAntennas: fallbackTotalAntennas,
      censusBoxesVisited: 0,
      estimatedCensusBoxes: 239,
      phase: 'frecuencias',
      trigger: 'schedule',
      recordNovedades: true,
      part: '',
    };
  }

  const isScanning = status.state === 'running' || status.state === 'handoff';
  const totalAntennas = status.totalAntennas > 0 ? status.totalAntennas : fallbackTotalAntennas;

  if (!isScanning) {
    return {
      isScanning: false,
      percent: status.state === 'completed' ? 100 : status.percent,
      scannedAntennas:
        status.state === 'completed' ? totalAntennas : status.scannedAntennas,
      totalAntennas,
      censusBoxesVisited: status.censusBoxesVisited,
      estimatedCensusBoxes: status.estimatedCensusBoxes,
      phase: status.phase,
      trigger: status.trigger,
      recordNovedades: status.recordNovedades,
      part: status.part,
    };
  }

  const updatedMs = Date.parse(status.updatedAt);
  const rawElapsedSec = Number.isFinite(updatedMs)
    ? Math.max(0, (nowMs - updatedMs) / 1000)
    : 0;

  if (status.phase === 'censo') {
    const maxCensoElapsed = status.schemaVersion >= 2 ? 8 : 55;
    const boundedElapsedSec =
      status.state === 'running' ? Math.min(maxCensoElapsed, rawElapsedSec) : 0;
    const rate =
      typeof status.requestsPerSecond === 'number' &&
      status.requestsPerSecond > 0
        ? Math.min(40, status.requestsPerSecond)
        : status.schemaVersion >= 2
          ? 8
          : 0.85;
    const estBoxes = Math.max(239, status.estimatedCensusBoxes);
    const liveBoxes = Math.min(
      estBoxes,
      status.censusBoxesVisited + Math.floor(boundedElapsedSec * rate),
    );
    const livePct = Math.min(
      0.39,
      Math.max(status.percent, (liveBoxes / estBoxes) * 0.39),
    );
    return {
      isScanning: true,
      percent: Math.round(livePct * 100) / 100,
      scannedAntennas: 0,
      totalAntennas,
      censusBoxesVisited: liveBoxes,
      estimatedCensusBoxes: estBoxes,
      phase: 'censo',
      trigger: status.trigger,
      recordNovedades: status.recordNovedades,
      part: status.part,
    };
  }

  // Fase de frecuencias: alta velocidad con requestsPerSecond o modo conservador ~0.90 antenas/s
  const hasFastRate =
    typeof status.requestsPerSecond === 'number' &&
    status.requestsPerSecond > 0;
  const boundedElapsedSec =
    status.state === 'running'
      ? Math.min(hasFastRate ? 18 : 55, rawElapsedSec)
      : 0;
  const extraAntennas = hasFastRate
    ? Math.floor(
        boundedElapsedSec *
          Math.min(150, (status.requestsPerSecond ?? 0) * 0.9),
      )
    : Math.floor(boundedElapsedSec * 0.9);
  const maxAllowed = Math.max(status.scannedAntennas, totalAntennas - 1);
  const liveScanned = Math.min(
    maxAllowed,
    status.scannedAntennas + extraAntennas,
  );
  const rawPct = totalAntennas > 0 ? (liveScanned / totalAntennas) * 100 : 0;
  const minFloor =
    status.part === '' || status.part.startsWith('1/')
      ? Math.max(0.4, status.percent)
      : status.percent;
  const livePct = Math.min(99.99, Math.max(minFloor, rawPct));

  return {
    isScanning: true,
    percent: Math.round(livePct * 100) / 100,
    scannedAntennas: liveScanned,
    totalAntennas,
    censusBoxesVisited: status.censusBoxesVisited,
    estimatedCensusBoxes: status.estimatedCensusBoxes,
    phase: 'frecuencias',
    trigger: status.trigger,
    recordNovedades: status.recordNovedades,
    part: status.part,
  };
}

function updateRateLimitFromHeaders(resp: Response): void {
  const remHeader = resp.headers.get('X-RateLimit-Remaining');
  if (remHeader !== null) {
    const parsedRem = Number.parseInt(remHeader, 10);
    if (Number.isFinite(parsedRem)) {
      etagCache.rateLimitRemaining = parsedRem;
    }
  }
  const resetHeader = resp.headers.get('X-RateLimit-Reset');
  if (resetHeader !== null) {
    const parsedReset = Number.parseInt(resetHeader, 10);
    if (Number.isFinite(parsedReset) && parsedReset > 0) {
      etagCache.rateLimitResetMs = parsedReset * 1000;
    }
  }
  if (
    (resp.status === 403 || resp.status === 429) &&
    (remHeader === '0' || etagCache.rateLimitRemaining <= 0)
  ) {
    etagCache.rateLimitRemaining = 0;
    etagCache.rateLimitResetMs = Math.max(
      etagCache.rateLimitResetMs,
      Date.now() + 60_000,
    );
  }
}

function canUseGitHubApiNow(minRemaining: number): boolean {
  if (etagCache.rateLimitRemaining > minRemaining) {
    return true;
  }
  if (
    etagCache.rateLimitResetMs > 0 &&
    Date.now() >= etagCache.rateLimitResetMs
  ) {
    etagCache.rateLimitRemaining =
      getStoredScanDispatchToken().length > 0 ? 5000 : 60;
    etagCache.rateLimitResetMs = 0;
    return true;
  }
  return false;
}

async function fetchGitHubApiRead(
  url: string,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const baseHeaders: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    ...extraHeaders,
  };
  const token = !rejectedAuthReadUrls.has(url)
    ? getStoredScanDispatchToken()
    : '';
  if (token) {
    const authHeaders: Record<string, string> = {
      ...baseHeaders,
      Authorization: `Bearer ${token}`,
    };
    const resp = await fetch(url, {
      headers: authHeaders,
      cache: 'no-store',
    });
    const isRateLimit =
      resp.status === 403 && resp.headers.get('X-RateLimit-Remaining') === '0';
    if (resp.status === 401 || (resp.status === 403 && !isRateLimit)) {
      rejectedAuthReadUrls.add(url);
      const retryResp = await fetch(url, {
        headers: baseHeaders,
        cache: 'no-store',
      });
      updateRateLimitFromHeaders(retryResp);
      return retryResp;
    }
    updateRateLimitFromHeaders(resp);
    return resp;
  }

  const resp = await fetch(url, {
    headers: baseHeaders,
    cache: 'no-store',
  });
  updateRateLimitFromHeaders(resp);
  return resp;
}

/**
 * Evita que una respuesta de respaldo cacheada por CDN (Fastly ~5 min)
 * retroceda el porcentaje o reemplace un escaneo en curso con uno anterior ya completado.
 */
function pickFresherScanPayload(
  cached: ScanStatusPayload | null,
  incoming: ScanStatusPayload,
): ScanStatusPayload {
  if (!cached) {
    return incoming;
  }
  const cachedMs = Date.parse(cached.updatedAt);
  const incomingMs = Date.parse(incoming.updatedAt);
  if (
    Number.isFinite(cachedMs) &&
    Number.isFinite(incomingMs) &&
    incomingMs < cachedMs
  ) {
    return cached;
  }
  return incoming;
}

async function fetchRawBranchPrimary(): Promise<ScanStatusPayload | null> {
  // Usar siempre la cabecera de rama `scan-status` (nunca un commitSha congelado)
  const resp = await fetch(`${GITHUB_RAW_STATUS_URL}?t=${Date.now()}`, {
    cache: 'no-store',
  });
  if (!resp.ok) {
    return null;
  }
  const json: unknown = await resp.json();
  const parsed = parseScanStatusPayload(json);
  if (!parsed) {
    return null;
  }
  return pickFresherScanPayload(etagCache.payload, parsed);
}

async function fetchCommitPinnedRawStatus(): Promise<ScanStatusPayload | null> {
  if (!canUseGitHubApiNow(3)) {
    etagCache.commitSha = null;
    return null;
  }
  const extraHeaders: Record<string, string> = {};
  if (etagCache.refEtag) {
    extraHeaders['If-None-Match'] = etagCache.refEtag;
  }
  const refResp = await fetchGitHubApiRead(
    GITHUB_GIT_REF_STATUS_URL,
    extraHeaders,
  );

  if (refResp.status === 304 && etagCache.payload) {
    return etagCache.payload;
  }
  if (!refResp.ok) {
    if (refResp.status === 403 || refResp.status === 429) {
      etagCache.commitSha = null;
    }
    return null;
  }

  const nextRefEtag = refResp.headers.get('ETag');
  const refJson: unknown = await refResp.json();
  const sha =
    isPlainObject(refJson) &&
    isPlainObject(refJson.object) &&
    typeof refJson.object.sha === 'string' &&
    refJson.object.sha.trim().length > 0
      ? refJson.object.sha.trim()
      : '';
  if (!sha) {
    return null;
  }

  if (sha === etagCache.commitSha && etagCache.payload) {
    if (nextRefEtag) {
      etagCache.refEtag = nextRefEtag;
    }
    return etagCache.payload;
  }

  const rawResp = await fetch(
    `${GITHUB_RAW_REPO_BASE_URL}/${sha}/scan-status.json`,
    { cache: 'no-store' },
  );
  if (!rawResp.ok) {
    return null;
  }
  const parsed = parseScanStatusPayload(await rawResp.json());
  if (parsed) {
    etagCache.commitSha = sha;
    if (nextRefEtag) {
      etagCache.refEtag = nextRefEtag;
    }
    etagCache.payload = parsed;
  }
  return parsed;
}

const MADRID_PARTS_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const DAILY_SCAN_MADRID_HOUR = 0;
const DAILY_SCAN_MADRID_MINUTE = 5;

function getMadridDateAndTime(
  epochMs: number,
): { dateKey: string; hour: number; minute: number } | null {
  if (!Number.isFinite(epochMs)) return null;
  const parts = MADRID_PARTS_FORMATTER.formatToParts(new Date(epochMs));
  let year = '';
  let month = '';
  let day = '';
  let hourStr = '';
  let minuteStr = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.type === 'year') year = p.value;
    else if (p.type === 'month') month = p.value;
    else if (p.type === 'day') day = p.value;
    else if (p.type === 'hour') hourStr = p.value;
    else if (p.type === 'minute') minuteStr = p.value;
  }
  const hour = Number.parseInt(hourStr, 10);
  const minute = Number.parseInt(minuteStr, 10);
  if (!year || !month || !day || !Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }
  return {
    dateKey: `${year}-${month}-${day}`,
    hour: hour === 24 ? 0 : hour,
    minute,
  };
}

function isInDailyScanWindow(dt: { hour: number; minute: number }): boolean {
  if (dt.hour === 23) return false;
  if (
    dt.hour === DAILY_SCAN_MADRID_HOUR &&
    dt.minute < DAILY_SCAN_MADRID_MINUTE
  ) {
    return false;
  }
  return true;
}

/**
 * Determina si un disparo `schedule` fugaz de GitHub Actions corresponde a una
 * comprobación de puerta horaria que se autodescartará (`check-trigger` -> `should_scan=false`),
 * evitando parpadeos sintéticos en el monitor de Novedades:
 * 1) Fuera de la ventana diaria `00:05–22:59` en `Europe/Madrid` (turnos `22:xx UTC` en horario
 *    de invierno CET = `23:xx`, o disparos entre `00:00` y `00:04`).
 * 2) Cuando `scan-status.json` ya acredita un escaneo válido hoy a partir de las 00:05 `Europe/Madrid`
 *    (turnos de respaldo posteriores del mismo día).
 */
export function shouldIgnoreScheduleWorkflowRun(
  nowMs: number,
  knownPayload: ScanStatusPayload | null,
): boolean {
  const nowMadrid = getMadridDateAndTime(nowMs);
  if (!nowMadrid) return false;
  if (!isInDailyScanWindow(nowMadrid)) {
    return true;
  }
  if (
    knownPayload &&
    knownPayload.recordNovedades !== false &&
    (knownPayload.state === 'completed' ||
      knownPayload.state === 'running' ||
      knownPayload.state === 'handoff') &&
    knownPayload.startedAt
  ) {
    const startedMadrid = getMadridDateAndTime(
      Date.parse(knownPayload.startedAt),
    );
    if (
      startedMadrid &&
      startedMadrid.dateKey === nowMadrid.dateKey &&
      isInDailyScanWindow(startedMadrid)
    ) {
      return true;
    }
  }
  return false;
}

async function checkActiveWorkflowRun(): Promise<ActiveWorkflowRunInfo | null> {
  if (!canUseGitHubApiNow(1)) {
    return null;
  }
  try {
    const extraHeaders: Record<string, string> = {};
    if (etagCache.runsEtag) {
      extraHeaders['If-None-Match'] = etagCache.runsEtag;
    }
    const resp = await fetchGitHubApiRead(
      GITHUB_WORKFLOW_RUNS_URL,
      extraHeaders,
    );
    if (resp.status === 304 && etagCache.lastRunsData) {
      return etagCache.lastRunsData;
    }
    if (!resp.ok) {
      return null;
    }
    const nextRunsEtag = resp.headers.get('ETag');
    const data: unknown = await resp.json();
    if (!isPlainObject(data) || !Array.isArray(data.workflow_runs)) {
      return null;
    }

    const nowMs = Date.now();
    const ignoreScheduleGateNow = shouldIgnoreScheduleWorkflowRun(
      nowMs,
      etagCache.payload,
    );
    let seenCompletedRealScan = false;
    let result: ActiveWorkflowRunInfo = {
      hasActiveScanRun: false,
      runId: '',
      event: '',
      startedAt: '',
    };

    for (let i = 0; i < data.workflow_runs.length; i++) {
      const run = data.workflow_runs[i];
      if (!isPlainObject(run)) continue;
      const event = typeof run.event === 'string' ? run.event : '';
      if (event !== 'schedule' && event !== 'workflow_dispatch') {
        continue;
      }

      const status = typeof run.status === 'string' ? run.status : '';
      const conclusion =
        typeof run.conclusion === 'string' ? run.conclusion : '';

      if (status === 'in_progress') {
        if (event === 'schedule' && ignoreScheduleGateNow) {
          continue;
        }
        result = {
          hasActiveScanRun: true,
          runId: String(run.id ?? ''),
          event,
          startedAt:
            typeof run.run_started_at === 'string'
              ? run.run_started_at
              : typeof run.created_at === 'string'
                ? run.created_at
                : new Date(nowMs).toISOString(),
        };
        break;
      }

      if (
        status === 'queued' ||
        status === 'waiting' ||
        status === 'pending'
      ) {
        if (
          seenCompletedRealScan ||
          (event === 'schedule' && ignoreScheduleGateNow)
        ) {
          continue;
        }
        const createdRaw =
          typeof run.created_at === 'string'
            ? run.created_at
            : typeof run.run_started_at === 'string'
              ? run.run_started_at
              : '';
        const createdMs = createdRaw ? Date.parse(createdRaw) : NaN;
        const isZombieQueued =
          Number.isFinite(createdMs) &&
          nowMs - createdMs > MAX_QUEUED_RUN_AGE_MS;
        if (!isZombieQueued) {
          result = {
            hasActiveScanRun: true,
            runId: String(run.id ?? ''),
            event,
            startedAt: createdRaw || new Date(nowMs).toISOString(),
          };
          break;
        }
        continue;
      }

      // `workflow_runs` viene ordenado del más reciente al más antiguo:
      // si ya hubo un escaneo real completado con éxito (no un check-trigger `schedule` omitido en <60s),
      // ignorar runs `queued` más antiguos sin dejar de detectar nunca un run `in_progress` activo.
      if (status === 'completed' && conclusion === 'success') {
        const cMs =
          typeof run.created_at === 'string'
            ? Date.parse(run.created_at)
            : NaN;
        const uMs =
          typeof run.updated_at === 'string'
            ? Date.parse(run.updated_at)
            : NaN;
        const isQuickSkippedScheduleGate =
          event === 'schedule' &&
          Number.isFinite(cMs) &&
          Number.isFinite(uMs) &&
          uMs - cMs < 60_000;
        if (!isQuickSkippedScheduleGate) {
          seenCompletedRealScan = true;
        }
      }
    }

    if (nextRunsEtag) {
      etagCache.runsEtag = nextRunsEtag;
    }
    etagCache.lastRunsData = result;
    return result;
  } catch {
    return null;
  }
}

function getCustomOverrideUrl(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const win = window as unknown as Record<string, unknown>;
  if (
    typeof win.__RADIOMAPA_SCAN_STATUS_URL__ === 'string' &&
    win.__RADIOMAPA_SCAN_STATUS_URL__.trim()
  ) {
    return win.__RADIOMAPA_SCAN_STATUS_URL__.trim();
  }
  return null;
}

function getCustomDispatchOverrideUrl(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const win = window as unknown as Record<string, unknown>;
  if (
    typeof win.__RADIOMAPA_SCAN_DISPATCH_URL__ === 'string' &&
    win.__RADIOMAPA_SCAN_DISPATCH_URL__.trim()
  ) {
    return win.__RADIOMAPA_SCAN_DISPATCH_URL__.trim();
  }
  return null;
}

function getCustomLiveDeltaBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const win = window as unknown as Record<string, unknown>;
    if (
      typeof win.__RADIOMAPA_LIVE_DELTA_BASE_URL__ === 'string' &&
      win.__RADIOMAPA_LIVE_DELTA_BASE_URL__.trim()
    ) {
      return win.__RADIOMAPA_LIVE_DELTA_BASE_URL__.trim().replace(/\/+$/, '');
    }
  }
  return '';
}

function getLiveDeltaBaseUrl(): string {
  const custom = getCustomLiveDeltaBaseUrl();
  if (custom) {
    return custom;
  }
  if (etagCache.commitSha) {
    return `${GITHUB_RAW_REPO_BASE_URL}/${etagCache.commitSha}`;
  }
  return DEFAULT_LIVE_DELTA_BASE_URL;
}

function buildActiveWorkflowScanPayload(
  runCheck: ActiveWorkflowRunInfo,
  nowMs: number,
  fallbackTotalAntennas: number,
): ScanStatusPayload {
  return {
    schemaVersion: 2,
    state: 'running',
    scanId: runCheck.runId,
    trigger: runCheck.event || 'workflow_dispatch',
    recordNovedades: true,
    part: '1/2',
    phase: 'censo',
    startedAt: runCheck.startedAt,
    updatedAt: new Date(nowMs).toISOString(),
    censusBoxesVisited: 0,
    estimatedCensusBoxes: 239,
    discoveredAntennas: 0,
    scannedAntennas: 0,
    totalAntennas: fallbackTotalAntennas > 0 ? fallbackTotalAntennas : 62230,
    percent: 0,
  };
}

export async function triggerForcedAntennasScan(options?: {
  token?: string;
  totalAntennas?: number;
  queryClient?: QueryClient;
  isCurrentlyScanning?: boolean;
}): Promise<ForceScanDispatchResult> {
  if (optimisticDispatchState && Date.now() >= optimisticDispatchState.untilMs) {
    optimisticDispatchState = null;
  }

  const cachedQueryPayload = options?.queryClient
    ? (options.queryClient.getQueryData<ScanStatusPayload | null>([
        'scan-status',
      ]) ?? null)
    : null;

  if (
    options?.isCurrentlyScanning === true ||
    optimisticDispatchState !== null ||
    (etagCache.payload !== null &&
      (etagCache.payload.state === 'running' ||
        etagCache.payload.state === 'handoff')) ||
    (cachedQueryPayload !== null &&
      (cachedQueryPayload.state === 'running' ||
        cachedQueryPayload.state === 'handoff'))
  ) {
    return { status: 'already_scanning' };
  }

  const effectiveToken = normalizeDispatchToken(
    options?.token ?? getStoredScanDispatchToken(),
  );
  if (!effectiveToken) {
    return { status: 'needs_token' };
  }

  const dispatchUrl =
    getCustomDispatchOverrideUrl() ?? GITHUB_WORKFLOW_DISPATCH_URL;

  let resp: Response;
  try {
    resp = await fetch(dispatchUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${effectiveToken}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
  } catch {
    return { status: 'error' };
  }

  if (resp.status === 401 || resp.status === 403) {
    if (!options?.token) {
      clearStoredScanDispatchToken();
    }
    return { status: 'unauthorized', httpStatus: resp.status };
  }

  if (!resp.ok) {
    return { status: 'error', httpStatus: resp.status };
  }

  setStoredScanDispatchToken(effectiveToken);
  updateRateLimitFromHeaders(resp);

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const resolvedTotal =
    options?.totalAntennas && options.totalAntennas > 0
      ? options.totalAntennas
      : etagCache.payload?.totalAntennas ||
        cachedQueryPayload?.totalAntennas ||
        62230;

  const optimisticPayload: ScanStatusPayload = {
    schemaVersion: 2,
    state: 'running',
    scanId: `forced-${nowMs}`,
    trigger: 'workflow_dispatch',
    recordNovedades: true,
    part: '1/2',
    phase: 'censo',
    startedAt: nowIso,
    updatedAt: nowIso,
    censusBoxesVisited: 0,
    estimatedCensusBoxes: 239,
    discoveredAntennas: 0,
    scannedAntennas: 0,
    totalAntennas: resolvedTotal,
    percent: 0,
  };

  optimisticDispatchState = {
    dispatchedAtMs: nowMs,
    untilMs: nowMs + OPTIMISTIC_DISPATCH_WINDOW_MS,
    baselineScanId:
      etagCache.payload?.scanId ?? cachedQueryPayload?.scanId ?? '',
    adoptedRunId: '',
    payload: optimisticPayload,
  };
  etagCache.runsEtag = null;
  etagCache.lastRunsData = null;
  etagCache.lastActionsCheckMs = 0;

  if (options?.queryClient) {
    options.queryClient.setQueryData(['scan-status'], optimisticPayload);
  }

  return { status: 'dispatched', httpStatus: resp.status };
}

export async function fetchLiveScanStatus(): Promise<ScanStatusPayload | null> {
  if (optimisticDispatchState && Date.now() >= optimisticDispatchState.untilMs) {
    optimisticDispatchState = null;
  }

  const customUrl = getCustomOverrideUrl();
  if (customUrl) {
    let customPayload: ScanStatusPayload | null = null;
    try {
      const resp = await fetch(customUrl, { cache: 'no-store' });
      if (resp.ok) {
        customPayload = parseScanStatusPayload(await resp.json());
        if (customPayload) {
          etagCache.payload = customPayload;
        }
      }
    } catch (err) {
      if (
        !optimisticDispatchState ||
        Date.now() >= optimisticDispatchState.untilMs
      ) {
        optimisticDispatchState = null;
        throw err;
      }
    }

    if (
      optimisticDispatchState &&
      Date.now() < optimisticDispatchState.untilMs
    ) {
      if (
        customPayload &&
        (customPayload.state === 'running' ||
          customPayload.state === 'handoff') &&
        customPayload.scanId !== optimisticDispatchState.baselineScanId
      ) {
        optimisticDispatchState = null;
        return customPayload;
      }
      return {
        ...optimisticDispatchState.payload,
        updatedAt: optimisticDispatchState.payload.updatedAt,
      };
    }

    optimisticDispatchState = null;
    return customPayload;
  }

  let payload: ScanStatusPayload | null = null;

  // 1) Fuente en tiempo real sin caché CDN de 5 min: git/ref + ETag -> raw fijado por commit SHA
  try {
    const pinnedParsed = await fetchCommitPinnedRawStatus();
    if (pinnedParsed) {
      payload = pinnedParsed;
    }
  } catch {
    // Continuar hacia respaldo raw/contents
  }

  // 2) Respaldo mediante raw.githubusercontent.com (con protección monotónica anti-CDN)
  if (!payload) {
    try {
      const rawParsed = await fetchRawBranchPrimary();
      if (rawParsed) {
        etagCache.payload = rawParsed;
        payload = rawParsed;
      }
    } catch {
      // Respaldo mediante GitHub Contents API + ETag
    }
  }

  // 3) Último respaldo mediante GitHub Contents API con ETag (If-None-Match)
  if (!payload && canUseGitHubApiNow(1)) {
    try {
      const extraHeaders: Record<string, string> = {};
      if (etagCache.etag) {
        extraHeaders['If-None-Match'] = etagCache.etag;
      }
      const resp = await fetchGitHubApiRead(
        GITHUB_CONTENTS_STATUS_URL,
        extraHeaders,
      );

      if (resp.status === 304 && etagCache.payload) {
        payload = etagCache.payload;
      } else if (resp.ok) {
        const nextEtag = resp.headers.get('ETag');
        const json: unknown = await resp.json();
        const parsed = parseScanStatusPayload(json);
        if (parsed) {
          if (nextEtag) {
            etagCache.etag = nextEtag;
          }
          const fresher = pickFresherScanPayload(etagCache.payload, parsed);
          etagCache.payload = fresher;
          payload = fresher;
        }
      } else {
        payload = etagCache.payload;
      }
    } catch {
      payload = etagCache.payload;
    }
  } else if (!payload) {
    payload = etagCache.payload;
  }

  const now = Date.now();
  if (optimisticDispatchState && now >= optimisticDispatchState.untilMs) {
    optimisticDispatchState = null;
  }

  const canCheckActions =
    optimisticDispatchState !== null
      ? canUseGitHubApiNow(5) &&
        now - etagCache.lastActionsCheckMs >=
          OPTIMISTIC_ACTIONS_CHECK_INTERVAL_MS
      : canUseGitHubApiNow(5) &&
        now - etagCache.lastActionsCheckMs >= ACTIONS_CHECK_COOLDOWN_MS;

  if (optimisticDispatchState !== null) {
    // Relevo definitivo SOLO cuando `scan-status.json` ya publica el nuevo scanId en la rama `scan-status`
    if (
      payload &&
      payload.scanId &&
      payload.scanId !== optimisticDispatchState.baselineScanId
    ) {
      if (payload.state === 'running' || payload.state === 'handoff') {
        const updatedMs = Date.parse(payload.updatedAt);
        const isStale =
          Number.isFinite(updatedMs) && now - updatedMs > STALE_HEARTBEAT_MS;
        if (!isStale) {
          optimisticDispatchState = null;
          return payload;
        }
      } else if (
        optimisticDispatchState.adoptedRunId &&
        payload.scanId === optimisticDispatchState.adoptedRunId &&
        (payload.state === 'completed' || payload.state === 'stopped')
      ) {
        optimisticDispatchState = null;
        return payload;
      }
    }

    // Mientras el runner de GitHub Actions arranca (`queued`/`pending`/`in_progress` antes del primer push),
    // mantener `optimisticDispatchState` vivo sin vaciarlo prematuramente.
    if (canCheckActions) {
      etagCache.lastActionsCheckMs = now;
      const runCheck = await checkActiveWorkflowRun();
      if (
        runCheck &&
        runCheck.hasActiveScanRun &&
        runCheck.runId &&
        runCheck.runId !== optimisticDispatchState.baselineScanId
      ) {
        const fallbackTotal =
          optimisticDispatchState.payload.totalAntennas ||
          payload?.totalAntennas ||
          62230;
        const adoptedPayload = buildActiveWorkflowScanPayload(
          runCheck,
          now,
          fallbackTotal,
        );
        optimisticDispatchState = {
          ...optimisticDispatchState,
          adoptedRunId: runCheck.runId,
          untilMs: Math.max(optimisticDispatchState.untilMs, now + 90_000),
          payload: adoptedPayload,
        };
        return adoptedPayload;
      }
      if (
        runCheck &&
        !runCheck.hasActiveScanRun &&
        now - optimisticDispatchState.dispatchedAtMs > 35_000
      ) {
        optimisticDispatchState = null;
        return payload;
      }
    }

    return {
      ...optimisticDispatchState.payload,
      updatedAt: optimisticDispatchState.payload.updatedAt,
    };
  }

  // 4) Si el documento indica "running"/"handoff" pero el latido lleva > 6 min congelado,
  // comprobar si la ejecución de GitHub Actions fue cancelada abruptamente.
  if (
    payload &&
    (payload.state === 'running' || payload.state === 'handoff')
  ) {
    const updatedMs = Date.parse(payload.updatedAt);
    const isStale =
      Number.isFinite(updatedMs) && now - updatedMs > STALE_HEARTBEAT_MS;
    if (isStale && canCheckActions) {
      etagCache.lastActionsCheckMs = now;
      const runCheck = await checkActiveWorkflowRun();
      if (runCheck && !runCheck.hasActiveScanRun) {
        const stoppedPayload: ScanStatusPayload = {
          ...payload,
          state: 'stopped',
        };
        etagCache.payload = stoppedPayload;
        return stoppedPayload;
      }
    }
    return payload;
  }

  // 5) Si el estado aparece inactivo/completado, verificar de forma ligera si acaba de arrancar
  // un escaneo diario o forzado en los primeros segundos antes del primer push a `scan-status`,
  // y protegerlo con `optimisticDispatchState` para no parpadear a "En espera" en el siguiente ciclo.
  if (canCheckActions) {
    etagCache.lastActionsCheckMs = now;
    const runCheck = await checkActiveWorkflowRun();
    if (
      runCheck &&
      runCheck.hasActiveScanRun &&
      runCheck.runId &&
      (!payload || payload.scanId !== runCheck.runId)
    ) {
      const synthPayload = buildActiveWorkflowScanPayload(
        runCheck,
        now,
        payload?.totalAntennas || 62230,
      );
      optimisticDispatchState = {
        dispatchedAtMs: now,
        untilMs: now + 90_000,
        baselineScanId: payload?.scanId ?? '',
        adoptedRunId: runCheck.runId,
        payload: synthPayload,
      };
      return synthPayload;
    }
  }

  return payload;
}

async function runTasksWithConcurrency<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  if (tasks.length === 0) return [];
  const results = new Array<T>(tasks.length);
  let nextIdx = 0;
  const workerCount = Math.min(Math.max(1, concurrency), tasks.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (nextIdx < tasks.length) {
          const idx = nextIdx++;
          results[idx] = await tasks[idx]();
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

async function fetchLiveScanMergedDelta(
  cacheOwner: object,
  scanId: string,
  deltaSeq: number,
  chunkCount: number,
  completedDatasetUpdatedAt: string,
): Promise<LiveScanMergedDelta> {
  const customBaseUrl = getCustomLiveDeltaBaseUrl();
  const baseUrl = getLiveDeltaBaseUrl();
  let cache = liveDeltaCacheByClient.get(cacheOwner);
  if (
    !cache ||
    cache.scanId !== scanId ||
    cache.customBaseUrl !== customBaseUrl
  ) {
    cache = {
      scanId,
      customBaseUrl,
      sealedChunks: new Map<number, LiveScanDeltaChunk>(),
      tailSeq: 0,
      tailChunk: null,
    };
    liveDeltaCacheByClient.set(cacheOwner, cache);
  }

  const activeCache = cache;
  const missingIndices: number[] = [];
  for (let i = 0; i < chunkCount; i++) {
    if (!activeCache.sealedChunks.has(i)) {
      missingIndices.push(i);
    }
  }

  const chunkTasks = missingIndices.map((idx) => async () => {
    try {
      const resp = await fetch(
        `${baseUrl}/live-chunk-${idx}.json?scan=${encodeURIComponent(scanId)}`,
        { cache: 'no-store' },
      );
      if (!resp.ok) return;
      const json: unknown = await resp.json();
      const parsed = parseLiveScanDeltaChunk(json);
      if (parsed && parsed.scanId === scanId) {
        activeCache.sealedChunks.set(idx, parsed);
      }
    } catch (err) {
      if (err instanceof Error && err.message === GEOJSON_LIVE_ERROR_MSG) {
        throw err;
      }
    }
  });

  const tailPromise = (async () => {
    if (activeCache.tailSeq === deltaSeq) {
      return;
    }
    try {
      const resp = await fetch(
        `${baseUrl}/live-tail.json?scan=${encodeURIComponent(scanId)}&seq=${deltaSeq}`,
        { cache: 'no-store' },
      );
      if (!resp.ok) return;
      const json: unknown = await resp.json();
      const parsed = parseLiveScanDeltaChunk(json);
      if (parsed && parsed.scanId === scanId) {
        activeCache.tailChunk = parsed;
        activeCache.tailSeq = deltaSeq;
      }
    } catch (err) {
      if (err instanceof Error && err.message === GEOJSON_LIVE_ERROR_MSG) {
        throw err;
      }
    }
  })();

  await Promise.all([
    runTasksWithConcurrency(chunkTasks, LIVE_CHUNK_FETCH_CONCURRENCY),
    tailPromise,
  ]);

  const orderedChunks: LiveScanDeltaChunk[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const sealed = activeCache.sealedChunks.get(i);
    if (sealed) {
      orderedChunks.push(sealed);
    }
  }

  const tail = activeCache.tailChunk;
  if (
    tail &&
    (tail.chunkIndex >= chunkCount ||
      !activeCache.sealedChunks.has(tail.chunkIndex))
  ) {
    orderedChunks.push(tail);
  }

  return accumulateLiveDeltaChunks(
    orderedChunks,
    scanId,
    completedDatasetUpdatedAt,
  );
}

function useSharedScanStatusQuery() {
  return useQuery<ScanStatusPayload | null>({
    queryKey: ['scan-status'],
    queryFn: fetchLiveScanStatus,
    staleTime: 3_000,
    refetchInterval: (query) => {
      const hasToken = getStoredScanDispatchToken().length > 0;
      const s = query.state.data?.state;
      if (s === 'running' || s === 'handoff') {
        if (hasToken && etagCache.rateLimitRemaining > 30) {
          return AUTH_ACTIVE_POLL_INTERVAL_MS;
        }
        return etagCache.rateLimitRemaining <= 25
          ? CONSERVATIVE_ACTIVE_POLL_INTERVAL_MS
          : ACTIVE_POLL_INTERVAL_MS;
      }
      return hasToken ? AUTH_IDLE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}

function useInvalidateDatasetsOnScanCompletion(
  status: ScanStatusPayload | null,
): void {
  const queryClient = useQueryClient();
  const prevActiveScanIdRef = useRef<string | null>(null);
  const isActive =
    status?.state === 'running' || status?.state === 'handoff';

  useEffect(() => {
    if (isActive && status?.scanId) {
      prevActiveScanIdRef.current = status.scanId;
    } else if (
      status?.state === 'completed' &&
      prevActiveScanIdRef.current &&
      prevActiveScanIdRef.current === status.scanId
    ) {
      prevActiveScanIdRef.current = null;
      if (invalidatedCompletedScanByClient.get(queryClient) !== status.scanId) {
        invalidatedCompletedScanByClient.set(queryClient, status.scanId);
        void queryClient.invalidateQueries({ queryKey: ['novedades-dataset'] });
        void queryClient.invalidateQueries({
          queryKey: ['eliminaciones-dataset'],
        });
        void queryClient.invalidateQueries({ queryKey: ['antenas-dataset'] });
        void queryClient.invalidateQueries({ queryKey: ['unico-5g-dataset'] });
      }
    }
  }, [isActive, status?.scanId, status?.state, queryClient]);
}

/**
 * Suscribe a los bloques de delta en vivo (`live-chunk-*.json` + `live-tail.json`)
 * compartiendo la caché de `['scan-status']` sin duplicar peticiones de red.
 */
export function useLiveScanDelta(): LiveScanMergedDelta | null {
  const queryClient = useQueryClient();
  const statusQuery = useSharedScanStatusQuery();
  const status = statusQuery.data ?? null;

  useInvalidateDatasetsOnScanCompletion(status);

  const scanId = status?.scanId ?? '';
  const deltaSeq = status?.deltaSeq ?? 0;
  const chunkCount = status?.chunkCount ?? 0;
  const completedDatasetUpdatedAt = status?.completedDatasetUpdatedAt ?? '';
  const hasLiveStream = Boolean(scanId && deltaSeq > 0);

  const deltaQuery = useQuery<LiveScanMergedDelta>({
    queryKey: [
      'live-scan-delta',
      scanId,
      deltaSeq,
      chunkCount,
      completedDatasetUpdatedAt,
    ],
    queryFn: () =>
      fetchLiveScanMergedDelta(
        queryClient,
        scanId,
        deltaSeq,
        chunkCount,
        completedDatasetUpdatedAt,
      ),
    enabled: hasLiveStream,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
    placeholderData: (previousData) =>
      previousData?.scanId === scanId ? previousData : undefined,
    retry: 1,
  });

  if (!hasLiveStream) {
    return null;
  }

  return deltaQuery.data ?? null;
}

export interface UseScanProgressResult extends InterpolatedScanMetrics {
  status: ScanStatusPayload | null;
  isLoadingInitial: boolean;
  formattedPercent: string;
  forceScan: (tokenOverride?: string) => Promise<ForceScanDispatchResult>;
  hasDispatchToken: () => boolean;
}

export function useScanProgress(
  fallbackTotalAntennas = 62230,
): UseScanProgressResult {
  const queryClient = useQueryClient();
  const query = useSharedScanStatusQuery();
  const status = query.data ?? null;
  const isActive =
    status?.state === 'running' || status?.state === 'handoff';

  const hasDispatchToken = useCallback(
    () => getStoredScanDispatchToken().length > 0,
    [],
  );

  const forceScan = useCallback(
    (tokenOverride?: string) =>
      triggerForcedAntennasScan({
        token: tokenOverride,
        totalAntennas: fallbackTotalAntennas,
        queryClient,
        isCurrentlyScanning: isActive,
      }),
    [fallbackTotalAntennas, queryClient, isActive],
  );

  const [tickState, setTickState] = useState<{
    nowMs: number;
    scanId: string;
    highScanned: number;
    highPercent: number;
  }>(() => ({
    nowMs: Date.now(),
    scanId: status?.scanId ?? '',
    highScanned: status?.scannedAntennas ?? 0,
    highPercent: status?.percent ?? 0,
  }));

  useInvalidateDatasetsOnScanCompletion(status);

  // Reloj de interpolación en tiempo real (1 Hz) activo únicamente mientras hay escaneo en marcha
  useEffect(() => {
    if (!isActive || !status) {
      return;
    }

    const updateTick = () => {
      const now = Date.now();
      const m = computeInterpolatedScanMetrics(
        status,
        now,
        fallbackTotalAntennas,
      );
      setTickState((prev) => {
        const sameScan = prev.scanId === status.scanId;
        return {
          nowMs: now,
          scanId: status.scanId,
          highScanned: sameScan
            ? Math.max(prev.highScanned, m.scannedAntennas)
            : m.scannedAntennas,
          highPercent: sameScan
            ? Math.max(prev.highPercent, m.percent)
            : m.percent,
        };
      });
    };

    updateTick();
    const timer = window.setInterval(updateTick, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [isActive, status, fallbackTotalAntennas]);

  return useMemo(() => {
    const baseMetrics = computeInterpolatedScanMetrics(
      status,
      tickState.nowMs,
      fallbackTotalAntennas,
    );

    const sameActiveScan =
      baseMetrics.isScanning &&
      Boolean(status?.scanId) &&
      tickState.scanId === status?.scanId;

    const monotonicScanned = sameActiveScan
      ? Math.max(baseMetrics.scannedAntennas, tickState.highScanned)
      : baseMetrics.scannedAntennas;
    const monotonicPercent = sameActiveScan
      ? Math.max(baseMetrics.percent, tickState.highPercent)
      : baseMetrics.percent;

    return {
      ...baseMetrics,
      scannedAntennas: monotonicScanned,
      percent: monotonicPercent,
      status,
      isLoadingInitial: query.isLoading && status === null,
      formattedPercent: formatScanPercentEs(monotonicPercent),
      forceScan,
      hasDispatchToken,
    };
  }, [
    status,
    tickState,
    fallbackTotalAntennas,
    query.isLoading,
    forceScan,
    hasDispatchToken,
  ]);
}
