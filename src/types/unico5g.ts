export type UnicoOperatorKey = 'movistar' | 'orange' | 'vodafone' | 'avatel';

export type UnicoFase = 1 | 2;

export type UnicoFaseFilter = 'all' | '1' | '2';

export type UnicoColorMode = 'operator' | 'fase';

export type UnicoTableSortField = 'territorio' | 'mun' | 'prov' | 'ccaa' | 'fase' | 'op';

export interface UnicoOperatorMeta {
  key: UnicoOperatorKey;
  name: string;
  shortName: string;
  color: string;
  softBg: string;
  borderTint: string;
  description: string;
}

/**
 * Orden fijo programático (no competitivo / sin rankings) de adjudicatarios UNICO 5G.
 */
export const UNICO_OPERATOR_ORDER: readonly UnicoOperatorKey[] = [
  'movistar',
  'orange',
  'vodafone',
  'avatel',
] as const;

export const UNICO_OPERATOR_META: Record<UnicoOperatorKey, UnicoOperatorMeta> = {
  movistar: {
    key: 'movistar',
    name: 'Movistar (Telefónica)',
    shortName: 'Movistar',
    color: '#0066CC',
    softBg: 'rgba(0, 102, 204, 0.12)',
    borderTint: 'rgba(0, 102, 204, 0.32)',
    description: 'Telefónica Móviles España, S.A.',
  },
  orange: {
    key: 'orange',
    name: 'Orange',
    shortName: 'Orange',
    color: '#EA580C',
    softBg: 'rgba(234, 88, 12, 0.12)',
    borderTint: 'rgba(234, 88, 12, 0.34)',
    description:
      'Agrupa Orange Espagne S.A. y UTE Orange Espagne y Orange Comunicaciones Fijas',
  },
  vodafone: {
    key: 'vodafone',
    name: 'Vodafone España',
    shortName: 'Vodafone',
    color: '#DC2626',
    softBg: 'rgba(220, 38, 38, 0.12)',
    borderTint: 'rgba(220, 38, 38, 0.32)',
    description: 'Vodafone España, S.A.',
  },
  avatel: {
    key: 'avatel',
    name: 'Avatel Telecom',
    shortName: 'Avatel',
    color: '#0D9488',
    softBg: 'rgba(13, 148, 136, 0.12)',
    borderTint: 'rgba(13, 148, 136, 0.32)',
    description: 'Avatel Telecom, S.A.',
  },
};

export const UNICO_FASE_META: Record<
  UnicoFase,
  {
    fase: UnicoFase;
    label: string;
    shortLabel: string;
    convocatoria: string;
    color: string;
    softBg: string;
  }
> = {
  1: {
    fase: 1,
    label: 'Fase 1 · Convocatoria 2023',
    shortLabel: 'Fase 1',
    convocatoria: '2023',
    color: '#0284C7',
    softBg: 'rgba(2, 132, 199, 0.12)',
  },
  2: {
    fase: 2,
    label: 'Fase 2 · Convocatoria 2024',
    shortLabel: 'Fase 2',
    convocatoria: '2024',
    color: '#D97706',
    softBg: 'rgba(217, 119, 6, 0.14)',
  },
};

/**
 * Registro limpio de antena subvencionada UNICO 5G Redes Activas.
 * Excluye expresamente código de emplazamiento e ID de propietario.
 */
export interface UnicoAntennaRecord {
  /** Clave interna secuencial de fila (ej. "u5g-1"), nunca un código de emplazamiento */
  id: string;
  /** Fase del programa UNICO 5G Redes Activas (1 = 2023, 2 = 2024) */
  fase: UnicoFase;
  /** Operador normalizado (todos los proyectos con Orange agrupados en 'orange') */
  op: UnicoOperatorKey;
  /** Razón social o UTE adjudicataria original del proyecto */
  empresa: string;
  /** Comunidad Autónoma oficial canónica */
  ccaa: string;
  /** Provincia oficial canónica en mayúsculas */
  prov: string;
  /** Municipio oficial INE */
  mun: string;
  /** Latitud WGS84 en grados decimales */
  lat: number;
  /** Longitud WGS84 en grados decimales */
  lon: number;
}

export interface UnicoEntityBreakdown {
  empresa: string;
  total: number;
  fase1: number;
  fase2: number;
  proyectosFase2?: number;
}

export interface UnicoOperatorDatasetSummary {
  key: UnicoOperatorKey;
  label: string;
  total: number;
  fase1: number;
  fase2: number;
  proyectosFase2: number;
  entities: UnicoEntityBreakdown[];
}

export interface UnicoDataset {
  schemaVersion: number;
  program: string;
  updatedAt: string;
  total: number;
  fase1Total: number;
  fase2Total: number;
  fase2ProjectsTotal: number;
  operators: Record<UnicoOperatorKey, UnicoOperatorDatasetSummary>;
  antenas: UnicoAntennaRecord[];
}

export interface UnicoBounds {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface UnicoOperatorStat {
  key: UnicoOperatorKey;
  meta: UnicoOperatorMeta;
  total: number;
  pctOfSelection: number;
  pctOfDataset: number;
  fase1: number;
  fase2: number;
  pctFase1WithinOp: number;
  pctFase2WithinOp: number;
  proyectosFase2: number;
  entities: UnicoEntityBreakdown[];
}

export interface UnicoProvinceStat {
  prov: string;
  ccaa: string;
  total: number;
  pctOfSelection: number;
  pctOfDataset: number;
  fase1: number;
  fase2: number;
  municipiosCount: number;
  byOperator: Record<UnicoOperatorKey, number>;
  bounds: UnicoBounds;
}

export interface UnicoComunidadStat {
  ccaa: string;
  total: number;
  pctOfSelection: number;
  pctOfDataset: number;
  fase1: number;
  fase2: number;
  municipiosCount: number;
  provincesCount: number;
  byOperator: Record<UnicoOperatorKey, number>;
  provinces: UnicoProvinceStat[];
  bounds: UnicoBounds;
}

export interface UnicoRouteSearch {
  fase?: UnicoFaseFilter;
  op?: string;
  ccaa?: string;
  prov?: string;
  mun?: string;
  q?: string;
  colorMode?: UnicoColorMode;
  page?: number;
  pageSize?: number;
}

export interface UnicoFilterState {
  fase: UnicoFaseFilter;
  operators: UnicoOperatorKey[];
  ccaa: string;
  prov: string;
  mun: string;
  query: string;
}
