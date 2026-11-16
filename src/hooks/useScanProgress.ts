import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  OPERATOR_ORDER,
  type AntennaRecord,
  type ConcesionBanda,
  type LiveBandPatch,
  type LiveScanDeltaChunk,
  type NovedadRecord,
  type NovedadTipo,
  type OperatorKey,
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

/** Intervalo de sondeo en vivo fijado por SHA de commit (~12 min de escaneo completo = < 55 reqs < límite 60 req/h) */
const ACTIVE_POLL_INTERVAL_MS = 10_000;
const CONSERVATIVE_ACTIVE_POLL_INTERVAL_MS = 18_000;
const IDLE_POLL_INTERVAL_MS = 20_000;

/** Si un estado "running"/"handoff" supera 6 minutos sin latido, verificar si el job sigue vivo */
const STALE_HEARTBEAT_MS = 6 * 60 * 1000;

/** Evitar consultar /actions/runs más de una vez cada 2 minutos */
const ACTIONS_CHECK_COOLDOWN_MS = 120_000;

const LIVE_CHUNK_FETCH_CONCURRENCY = 6;

const GEOJSON_LIVE_ERROR_MSG =
  'Formato GeoJSON no admitido en el flujo en vivo: RadioMapa utiliza exclusivamente su esquema JSON propio.';

const VALID_STATES = new Set<string>([
  'running',
  'handoff',
  'completed',
  'stopped',
  'idle',
]);

const VALID_PHASES = new Set<string>(['censo', 'frecuencias']);
const VALID_OPERATORS = new Set<string>(OPERATOR_ORDER);
const VALID_NOVEDAD_TIPOS = new Set<string>(['antena', 'frecuencia']);

const PERCENT_FORMATTER_ES = new Intl.NumberFormat('es-ES', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

interface EtagCache {
  refEtag: string | null;
  commitSha: string | null;
  rateLimitRemaining: number;
  etag: string | null;
  payload: ScanStatusPayload | null;
  lastActionsCheckMs: number;
}

const etagCache: EtagCache = {
  refEtag: null,
  commitSha: null,
  rateLimitRemaining: 60,
  etag: null,
  payload: null,
  lastActionsCheckMs: 0,
};

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
    op: item.op as OperatorKey,
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

  if (
    typeof item.id !== 'string' ||
    typeof item.tipo !== 'string' ||
    !VALID_NOVEDAD_TIPOS.has(item.tipo) ||
    typeof item.op !== 'string' ||
    !VALID_OPERATORS.has(item.op) ||
    typeof item.opRaw !== 'string' ||
    typeof item.codigo !== 'string' ||
    typeof item.antennaId !== 'string' ||
    typeof item.codigoBanda !== 'string' ||
    typeof item.frecuencia !== 'string' ||
    typeof item.ubicacion !== 'string' ||
    (item.prov !== undefined && typeof item.prov !== 'string') ||
    typeof item.scannedAt !== 'string' ||
    typeof item.fecha !== 'string'
  ) {
    return null;
  }

  return {
    id: item.id,
    tipo: item.tipo as NovedadTipo,
    op: item.op as OperatorKey,
    opRaw: item.opRaw,
    codigo: item.codigo,
    antennaId: item.antennaId,
    codigoBanda: item.codigoBanda,
    frecuencia: item.frecuencia,
    ubicacion: item.ubicacion,
    ...(item.prov !== undefined ? { prov: item.prov } : {}),
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
  };
}

/**
 * Acumula de forma pura y determinista la secuencia ordenada de bloques de delta en vivo
 * aplicando fusiones canónicas (`replacesNewAntennas`), enriquecimiento instantáneo de bandas
 * sobre antenas recién descubiertas y ordenación cronológica inversa de novedades.
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
      const ant = chunk.newAntennas[a];
      newAntennasMap.set(ant.id, ant);
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
      const nov = chunk.novedades[n];
      novedadesMap.set(nov.id, nov);
    }
  }

  const newAntennas: AntennaRecord[] = [];
  for (const ant of newAntennasMap.values()) {
    let patch = bandPatchesById.get(ant.id);
    if (!patch && ant.op === 'vodafone' && ant.mergedGids) {
      for (let g = 0; g < ant.mergedGids.length; g++) {
        const candidatePatch = bandPatchesByGid.get(ant.mergedGids[g]);
        if (candidatePatch) {
          patch = candidatePatch;
          break;
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
          Math.min(85, (status.requestsPerSecond ?? 0) * 0.9),
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

async function fetchRawBranchPrimary(): Promise<ScanStatusPayload | null> {
  const url = etagCache.commitSha
    ? `${GITHUB_RAW_REPO_BASE_URL}/${etagCache.commitSha}/scan-status.json`
    : `${GITHUB_RAW_STATUS_URL}?t=${Date.now()}`;
  const resp = await fetch(url, {
    cache: 'no-store',
  });
  if (!resp.ok) {
    return null;
  }
  const json: unknown = await resp.json();
  return parseScanStatusPayload(json);
}

async function fetchCommitPinnedRawStatus(): Promise<ScanStatusPayload | null> {
  if (etagCache.rateLimitRemaining <= 3) {
    return null;
  }
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  };
  if (etagCache.refEtag) {
    headers['If-None-Match'] = etagCache.refEtag;
  }
  const refResp = await fetch(
    `${GITHUB_GIT_REF_STATUS_URL}?t=${Date.now()}`,
    {
      headers,
      cache: 'no-store',
    },
  );
  const remHeader = refResp.headers.get('X-RateLimit-Remaining');
  if (remHeader !== null) {
    const parsedRem = Number.parseInt(remHeader, 10);
    if (Number.isFinite(parsedRem)) {
      etagCache.rateLimitRemaining = parsedRem;
    }
  }

  if (refResp.status === 304 && etagCache.payload) {
    return etagCache.payload;
  }
  if (!refResp.ok) {
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

interface ActiveWorkflowRunInfo {
  hasActiveScanRun: boolean;
  runId: string;
  event: string;
  startedAt: string;
}

async function checkActiveWorkflowRun(): Promise<ActiveWorkflowRunInfo | null> {
  try {
    const resp = await fetch(GITHUB_WORKFLOW_RUNS_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
    if (!resp.ok) {
      return null;
    }
    const data: unknown = await resp.json();
    if (!isPlainObject(data) || !Array.isArray(data.workflow_runs)) {
      return null;
    }
    for (let i = 0; i < data.workflow_runs.length; i++) {
      const run = data.workflow_runs[i];
      if (!isPlainObject(run)) continue;
      const status = typeof run.status === 'string' ? run.status : '';
      const event = typeof run.event === 'string' ? run.event : '';
      if (
        (status === 'in_progress' || status === 'queued') &&
        (event === 'schedule' || event === 'workflow_dispatch')
      ) {
        return {
          hasActiveScanRun: true,
          runId: String(run.id ?? ''),
          event,
          startedAt:
            typeof run.run_started_at === 'string'
              ? run.run_started_at
              : typeof run.created_at === 'string'
                ? run.created_at
                : new Date().toISOString(),
        };
      }
    }
    return {
      hasActiveScanRun: false,
      runId: '',
      event: '',
      startedAt: '',
    };
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

export async function fetchLiveScanStatus(): Promise<ScanStatusPayload | null> {
  const customUrl = getCustomOverrideUrl();
  if (customUrl) {
    const resp = await fetch(customUrl, { cache: 'no-store' });
    if (!resp.ok) return null;
    return parseScanStatusPayload(await resp.json());
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

  // 2) Respaldo mediante raw.githubusercontent.com si se agotó cuota o falló git/ref
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
  if (!payload) {
    try {
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
      };
      if (etagCache.etag) {
        headers['If-None-Match'] = etagCache.etag;
      }
      const resp = await fetch(GITHUB_CONTENTS_STATUS_URL, {
        headers,
        cache: 'no-store',
      });

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
          etagCache.payload = parsed;
          payload = parsed;
        }
      } else {
        payload = etagCache.payload;
      }
    } catch {
      payload = etagCache.payload;
    }
  }

  const now = Date.now();
  const canCheckActions =
    now - etagCache.lastActionsCheckMs >= ACTIONS_CHECK_COOLDOWN_MS;

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
  // un escaneo diario o forzado en los primeros segundos antes del primer push a `scan-status`.
  if (canCheckActions) {
    etagCache.lastActionsCheckMs = now;
    const runCheck = await checkActiveWorkflowRun();
    if (
      runCheck &&
      runCheck.hasActiveScanRun &&
      runCheck.runId &&
      (!payload || payload.scanId !== runCheck.runId)
    ) {
      return {
        schemaVersion: 2,
        state: 'running',
        scanId: runCheck.runId,
        trigger: runCheck.event || 'workflow_dispatch',
        recordNovedades: runCheck.event === 'schedule',
        part: '1/2',
        phase: 'censo',
        startedAt: runCheck.startedAt,
        updatedAt: new Date(now).toISOString(),
        censusBoxesVisited: 0,
        estimatedCensusBoxes: 239,
        discoveredAntennas: 0,
        scannedAntennas: 0,
        totalAntennas: payload?.totalAntennas || 62230,
        percent: 0,
      };
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
  });

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
      const s = query.state.data?.state;
      if (s === 'running' || s === 'handoff') {
        return etagCache.rateLimitRemaining <= 20
          ? CONSERVATIVE_ACTIVE_POLL_INTERVAL_MS
          : ACTIVE_POLL_INTERVAL_MS;
      }
      return IDLE_POLL_INTERVAL_MS;
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
        void queryClient.invalidateQueries({ queryKey: ['antenas-dataset'] });
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
}

export function useScanProgress(
  fallbackTotalAntennas = 62230,
): UseScanProgressResult {
  const query = useSharedScanStatusQuery();
  const status = query.data ?? null;
  const isActive =
    status?.state === 'running' || status?.state === 'handoff';

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
    };
  }, [status, tickState, fallbackTotalAntennas, query.isLoading]);
}
