export type OperatorKey =
  | 'movistar'
  | 'vodafone'
  | 'orange'
  | 'masmovil'
  | 'digi'
  | 'otros';

export interface ConcesionBanda {
  /** Código/Referencia oficial de la concesión en MINETUR (ej. "M M -2205199") */
  ref: string;
  /** Rango exacto declarado en MINETUR sin abreviación (ej. "3460.00 - 3600.00") */
  freq: string;
}

export interface AntennaRecord {
  /** Identificador único oficial, ej. "TELEFONICA MOVILES ESPAÑA, S.A.U. - 3600449" */
  id: string;
  /** Gis_ID oficial numérico/alfanumérico, ej. "3600449" */
  gid: string;
  /** Clave normalizada del operador */
  op: OperatorKey;
  /** Razón social original en Infoantenas (MINETUR) */
  opRaw: string;
  /** Latitud WGS84 en grados decimales */
  lat: number;
  /** Longitud WGS84 en grados decimales */
  lon: number;
  /** Dirección postal (calle, polígono, parcela, número) */
  dir: string;
  /** Municipio oficial extraído */
  mun: string;
  /** Provincia oficial normalizada */
  prov: string;
  /** Gis_IDs originales fusionados cuando se agrupan declaraciones duplicadas (< 35 m en Vodafone) */
  mergedGids?: string[];
  /** Bandas comerciales activas en MHz extraídas de detalleEstacion.do (ej. ["700 MHz", "800 MHz", "1800 MHz", "3500 MHz"]) */
  bandas?: string[];
  /** Rangos exactos de frecuencias asignadas en MHz en detalleEstacion.do (ej. ["935.10 - 949.90", "3460.00 - 3600.00"]) */
  frecuencias?: string[];
  /** Concesiones individuales (Referencia + Frecuencia exacta) en detalleEstacion.do */
  concesiones?: ConcesionBanda[];
  /** Marca temporal ISO 8601 UTC del último escaneo de bandas de esta estación */
  bandsScannedAt?: string;
}

export interface OperatorSummary {
  key: OperatorKey;
  name: string;
  count: number;
  legalEntities: string[];
}

export interface ProvinceSummary {
  provincia: string;
  count: number;
  byOperator: Partial<Record<OperatorKey, number>>;
}

export interface CrawlStats {
  requestsCount: number;
  durationSeconds: number;
  gridBoxesVisited: number;
  subdividedBoxes: number;
  zoomParam: number;
  delaySeconds: number;
  isPartialSeed?: boolean;
  /** Declaraciones duplicadas de Vodafone (< 35 m) fusionadas en una única antena */
  vodafoneFusedDuplicates?: number;
  /** Número de antenas del JSON que ya disponen de sus bandas/frecuencias extraídas */
  bandsPopulatedCount?: number;
  /** Peticiones a detalleEstacion.do realizadas en la última sincronización de bandas */
  bandRequestsCount?: number;
}

export interface AntenasDataset {
  /** Marca temporal ISO 8601 UTC de generación del JSON */
  updatedAt: string;
  /** URL base oficial de Infoantenas */
  sourceUrl: string;
  /** Número total de estaciones únicas registradas */
  total: number;
  /** Métricas de la recolección iterativa por coordenadas */
  crawlStats: CrawlStats;
  /** Resumen agregado por operador */
  operators: Record<OperatorKey, OperatorSummary>;
  /** Resumen agregado por provincia ordenado por número de antenas */
  provinces: ProvinceSummary[];
  /** Listado completo sin duplicados de antenas móviles de España */
  antenas: AntennaRecord[];
}

export type NovedadTipo = 'antena' | 'frecuencia';

export interface NovedadRecord {
  /** Identificador único determinista de la novedad */
  id: string;
  /** Tipo de novedad: antena nueva o frecuencia nueva */
  tipo: NovedadTipo;
  /** Clave normalizada del operador asociado */
  op: OperatorKey;
  /** Razón social original declarada en MINETUR */
  opRaw: string;
  /** Código asociado a la antena (Gis_ID, ej. "2800006"), enlazado al mapa */
  codigo: string;
  /** Identificador completo de la antena en antenas.json para enfoque exacto en el mapa */
  antennaId: string;
  /** Código oficial asociado a la frecuencia/banda nueva (Referencia MINETUR, ej. "M M -2205199"), o "" si es antena nueva */
  codigoBanda: string;
  /** Frecuencia exacta declarada en la página del ministerio con rango completo sin abreviación (ej. "3460.00 - 3600.00 MHz"), o "" si es antena nueva */
  frecuencia: string;
  /** Ciudad / municipio de la antena o frecuencia nueva */
  ubicacion: string;
  /** Provincia normalizada */
  prov?: string;
  /** Marca temporal ISO 8601 UTC exacta del escaneo */
  scannedAt: string;
  /** Fecha formateada en Dia/Mes/Año y hora exacta (Europe/Madrid): "DD/MM/YYYY HH:MM:SS" */
  fecha: string;
}

export interface NovedadesDataset {
  /** Marca temporal ISO 8601 UTC de generación del archivo de novedades */
  updatedAt: string;
  /** Identificador del lote/ejecución de escaneo */
  scanId: string;
  /** Marca temporal ISO 8601 UTC del escaneo anterior frente al que se ha comparado */
  previousScanAt: string | null;
  /** Si el escaneo fue forzado como línea base sin contabilizar novedades */
  isBaselineScan?: boolean;
  /** Total de filas de novedades */
  total: number;
  /** Total de antenas nuevas respecto al escaneo anterior */
  antenasNuevas: number;
  /** Total de frecuencias nuevas respecto al escaneo anterior */
  frecuenciasNuevas: number;
  /** Listado de antenas y frecuencias nuevas respecto al escaneo anterior */
  novedades: NovedadRecord[];
}

export type ScanLifecycleState =
  | 'running'
  | 'handoff'
  | 'completed'
  | 'stopped'
  | 'idle';

export type ScanPhase = 'censo' | 'frecuencias';

export interface ScanStatusPayload {
  /** Versión del esquema de telemetría en vivo */
  schemaVersion: number;
  /** Estado actual del proceso de escaneo */
  state: ScanLifecycleState;
  /** Identificador de ejecución de GitHub Actions (run_id) */
  scanId: string;
  /** Origen del disparo: 'schedule' (diario 18:00) o 'workflow_dispatch' (forzado manual) */
  trigger: string;
  /** Si el escaneo registra novedades (false en escaneos forzados de línea base) */
  recordNovedades: boolean;
  /** Tramo secuencial en ejecución (ej. "1/4", "2/4", "3/4", "4/4") */
  part: string;
  /** Fase activa: barrido inicial del censo o enriquecimiento de bandas/frecuencias */
  phase: ScanPhase;
  /** Marca temporal ISO 8601 UTC de inicio del ciclo de escaneo */
  startedAt: string;
  /** Marca temporal ISO 8601 UTC del último latido publicado */
  updatedAt: string;
  /** Cuadrículas GeoJSON visitadas durante la fase de censo */
  censusBoxesVisited: number;
  /** Estimación total de cuadrículas GeoJSON en el barrido nacional */
  estimatedCensusBoxes: number;
  /** Antenas descubiertas durante la fase de censo */
  discoveredAntennas: number;
  /** Número de antenas escaneadas en el ciclo actual */
  scannedAntennas: number;
  /** Número total de antenas objetivo en el censo nacional */
  totalAntennas: number;
  /** Porcentaje global de avance (0.00 - 100.00) */
  percent: number;
  /** Secuencia monotónica de publicación de deltas en vivo */
  deltaSeq?: number;
  /** Número de bloques inmutables sellados en scan-status (live-chunk-0..N-1.json) */
  chunkCount?: number;
  /** Total acumulado de antenas nuevas emitidas en el flujo en vivo */
  liveNewAntennasCount?: number;
  /** Total acumulado de estaciones enriquecidas con bandas en el flujo en vivo */
  liveUpdatedAntennasCount?: number;
  /** Total acumulado de filas de novedades emitidas en el flujo en vivo */
  liveNovedadesCount?: number;
  /** Cadencia real medida de peticiones HTTP por segundo en el escáner */
  requestsPerSecond?: number;
  /** Marca temporal ISO 8601 UTC del dataset estático generado al completar el escaneo */
  completedDatasetUpdatedAt?: string;
}

export interface LiveBandPatch {
  id: string;
  gid: string;
  mergedGids?: string[];
  bandas: string[];
  frecuencias: string[];
  concesiones: ConcesionBanda[];
  bandsScannedAt: string;
}

export interface LiveScanDeltaChunk {
  schemaVersion: number;
  scanId: string;
  seq: number;
  chunkIndex: number;
  isTail: boolean;
  updatedAt: string;
  recordNovedades: boolean;
  previousScanAt: string | null;
  replacesNewAntennas?: boolean;
  newAntennas: AntennaRecord[];
  bandPatches: LiveBandPatch[];
  novedades: NovedadRecord[];
}

export interface OperatorMeta {
  key: OperatorKey;
  name: string;
  shortName: string;
  color: string;
  softBg: string;
  description: string;
}

export const OPERATOR_ORDER: OperatorKey[] = [
  'movistar',
  'orange',
  'vodafone',
  'masmovil',
  'digi',
  'otros',
];

export const OPERATOR_META: Record<OperatorKey, OperatorMeta> = {
  movistar: {
    key: 'movistar',
    name: 'Movistar (Telefónica)',
    shortName: 'Movistar',
    color: '#0066CC',
    softBg: 'rgba(0, 102, 204, 0.12)',
    description: 'Telefónica Móviles España, S.A.U.',
  },
  orange: {
    key: 'orange',
    name: 'Orange (MasOrange)',
    shortName: 'Orange',
    color: '#EA580C',
    softBg: 'rgba(234, 88, 12, 0.12)',
    description: 'Orange Espagne, S.A.U.',
  },
  vodafone: {
    key: 'vodafone',
    name: 'Vodafone España',
    shortName: 'Vodafone',
    color: '#DC2626',
    softBg: 'rgba(220, 38, 38, 0.12)',
    description: 'Vodafone España, S.A.U.',
  },
  masmovil: {
    key: 'masmovil',
    name: 'Yoigo / Grupo MásMóvil',
    shortName: 'Yoigo / MásMóvil',
    color: '#0D9488',
    softBg: 'rgba(13, 148, 136, 0.12)',
    description: 'Xfera Móviles, S.A.U.',
  },
  digi: {
    key: 'digi',
    name: 'DIGI Spain',
    shortName: 'DIGI',
    color: '#7C3AED',
    softBg: 'rgba(124, 58, 237, 0.14)',
    description: 'DS Mobile Networks, S.L.',
  },
  otros: {
    key: 'otros',
    name: 'Otros Operadores',
    shortName: 'Otros',
    color: '#64748B',
    softBg: 'rgba(100, 116, 139, 0.14)',
    description: 'Operadores regionales e infraestructuras especiales',
  },
};

export interface OpenFreeMapStyleOption {
  id: 'positron' | 'liberty' | 'bright' | 'dark' | 'fiord';
  label: string;
  description: string;
  url: string;
  isDark: boolean;
}

export const OPENFREEMAP_STYLES: OpenFreeMapStyleOption[] = [
  {
    id: 'liberty',
    label: 'Liberty',
    description: 'Cartografía detallada con relieve urbano y vías',
    url: 'https://tiles.openfreemap.org/styles/liberty',
    isDark: false,
  },
  {
    id: 'positron',
    label: 'Positron',
    description: 'Mapa base limpio de alto contraste para análisis RF',
    url: 'https://tiles.openfreemap.org/styles/positron',
    isDark: false,
  },
  {
    id: 'bright',
    label: 'Bright',
    description: 'Estilo clásico OpenStreetMap nítido',
    url: 'https://tiles.openfreemap.org/styles/bright',
    isDark: false,
  },
  {
    id: 'dark',
    label: 'Dark Matter',
    description: 'Modo nocturno técnico para densidad de red',
    url: 'https://tiles.openfreemap.org/styles/dark',
    isDark: true,
  },
  {
    id: 'fiord',
    label: 'Fiord',
    description: 'Cartografía azul profundo de baja fatiga visual',
    url: 'https://tiles.openfreemap.org/styles/fiord',
    isDark: true,
  },
];

export function getDetalleEstacionUrl(
  antena: Pick<AntennaRecord, 'gid'>,
): string {
  const base = 'https://geoportal.minetur.gob.es/VCTEL/detalleEstacion.do';
  const params = new URLSearchParams({
    emplazamiento: antena.gid,
  });
  return `${base}?${params.toString()}`;
}

export function getFullAddress(
  antena: Pick<AntennaRecord, 'dir' | 'mun' | 'prov'>,
): string {
  const parts = [antena.dir, [antena.mun, antena.prov].filter(Boolean).join(', ')].filter(Boolean);
  return parts.join(' · ');
}
