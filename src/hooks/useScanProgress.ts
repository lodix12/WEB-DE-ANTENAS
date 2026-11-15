import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ScanLifecycleState,
  ScanPhase,
  ScanStatusPayload,
} from '../types/antena';

const GITHUB_CONTENTS_STATUS_URL =
  'https://api.github.com/repos/lodix12/WEB-DE-ANTENAS/contents/scan-status.json?ref=scan-status';

const GITHUB_RAW_STATUS_URL =
  'https://raw.githubusercontent.com/lodix12/WEB-DE-ANTENAS/scan-status/scan-status.json';

const GITHUB_WORKFLOW_RUNS_URL =
  'https://api.github.com/repos/lodix12/WEB-DE-ANTENAS/actions/workflows/update-and-deploy.yml/runs?per_page=4';

/** Intervalo de sondeo compatible con la cuota pública de GitHub API (<= 55 req/h + ETag 304) */
const POLL_INTERVAL_MS = 65_000;

/** Si un estado "running"/"handoff" supera 6 minutos sin latido, verificar si el job sigue vivo */
const STALE_HEARTBEAT_MS = 6 * 60 * 1000;

/** Evitar consultar /actions/runs más de una vez cada 2 minutos */
const ACTIONS_CHECK_COOLDOWN_MS = 120_000;

const VALID_STATES = new Set<string>([
  'running',
  'handoff',
  'completed',
  'stopped',
  'idle',
]);

const VALID_PHASES = new Set<string>(['censo', 'frecuencias']);

const PERCENT_FORMATTER_ES = new Intl.NumberFormat('es-ES', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

interface EtagCache {
  etag: string | null;
  payload: ScanStatusPayload | null;
  lastActionsCheckMs: number;
}

const etagCache: EtagCache = {
  etag: null,
  payload: null,
  lastActionsCheckMs: 0,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * respetando la cadencia real del escáner (`>= 1.0 s` por petición HTTP).
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
  // Acotar la extrapolación local a 55 s hasta recibir el siguiente latido real
  const boundedElapsedSec =
    status.state === 'running' ? Math.min(55, rawElapsedSec) : 0;

  if (status.phase === 'censo') {
    const estBoxes = Math.max(239, status.estimatedCensusBoxes);
    const liveBoxes = Math.min(
      estBoxes,
      status.censusBoxesVisited + Math.floor(boundedElapsedSec * 0.85),
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

  // Fase de frecuencias: ~0.90 antenas/s conservadoras (el crawler real avanza >= 1.0 - 1.15/s)
  const extraAntennas = Math.floor(boundedElapsedSec * 0.9);
  const maxAllowed = Math.max(status.scannedAntennas, totalAntennas - 1);
  const liveScanned = Math.min(
    maxAllowed,
    status.scannedAntennas + extraAntennas,
  );
  const rawPct = totalAntennas > 0 ? (liveScanned / totalAntennas) * 100 : 0;
  const minFloor =
    status.part === '' || status.part === '1/4'
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

async function fetchRawBranchFallback(): Promise<ScanStatusPayload | null> {
  const bucket = Math.floor(Date.now() / 45_000);
  const resp = await fetch(`${GITHUB_RAW_STATUS_URL}?t=${bucket}`, {
    cache: 'no-store',
  });
  if (!resp.ok) {
    return null;
  }
  const json: unknown = await resp.json();
  return parseScanStatusPayload(json);
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

export async function fetchLiveScanStatus(): Promise<ScanStatusPayload | null> {
  const customUrl = getCustomOverrideUrl();
  if (customUrl) {
    const resp = await fetch(customUrl, { cache: 'no-store' });
    if (!resp.ok) return null;
    return parseScanStatusPayload(await resp.json());
  }

  let payload: ScanStatusPayload | null = null;

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
    } else if (resp.status === 403 || resp.status === 429) {
      payload = await fetchRawBranchFallback();
    }
  } catch {
    try {
      payload = await fetchRawBranchFallback();
    } catch {
      payload = etagCache.payload;
    }
  }

  const now = Date.now();
  const canCheckActions =
    now - etagCache.lastActionsCheckMs >= ACTIONS_CHECK_COOLDOWN_MS;

  // 1) Si el documento indica "running"/"handoff" pero el latido lleva > 6 min congelado,
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

  // 2) Si el estado aparece inactivo/completado, verificar de forma ligera si acaba de arrancar
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
        schemaVersion: 1,
        state: 'running',
        scanId: runCheck.runId,
        trigger: runCheck.event || 'workflow_dispatch',
        recordNovedades: runCheck.event === 'schedule',
        part: '1/4',
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

export interface UseScanProgressResult extends InterpolatedScanMetrics {
  status: ScanStatusPayload | null;
  isLoadingInitial: boolean;
  formattedPercent: string;
}

export function useScanProgress(
  fallbackTotalAntennas = 62230,
): UseScanProgressResult {
  const queryClient = useQueryClient();
  const query = useQuery<ScanStatusPayload | null>({
    queryKey: ['scan-status'],
    queryFn: fetchLiveScanStatus,
    staleTime: 15_000,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 1,
  });

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

  const prevActiveScanIdRef = useRef<string | null>(null);

  // Cuando un escaneo en curso pasa a "completed", refrescar automáticamente novedades y censo
  useEffect(() => {
    if (isActive && status?.scanId) {
      prevActiveScanIdRef.current = status.scanId;
    } else if (
      status?.state === 'completed' &&
      prevActiveScanIdRef.current &&
      prevActiveScanIdRef.current === status.scanId
    ) {
      prevActiveScanIdRef.current = null;
      void queryClient.invalidateQueries({ queryKey: ['novedades-dataset'] });
      void queryClient.invalidateQueries({ queryKey: ['antenas-dataset'] });
    }
  }, [isActive, status?.scanId, status?.state, queryClient]);

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
