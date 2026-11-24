export type UnicoOperatorKey = 'movistar' | 'orange' | 'vodafone';

export type UnicoFase = 1 | 2;

export type UnicoFaseFilter = 'all' | '1' | '2';

export type UnicoTerritoryTab = 'provincia' | 'comunidad';

export type UnicoDeclaredBandFilter = 'all' | 'N78' | 'N28' | 'N28+';

export interface UnicoOperatorMeta {
  key: UnicoOperatorKey;
  name: string;
  color: string;
}

/**
 * Orden fijo de operadoras UNICO 5G (sin rankings competitivos).
 * Todas las antenas de Orange, UTE Orange y Avatel se agrupan en "Orange".
 */
export const UNICO_OPERATOR_ORDER: readonly UnicoOperatorKey[] = [
  'movistar',
  'orange',
  'vodafone',
] as const;

export const UNICO_OPERATOR_META: Record<UnicoOperatorKey, UnicoOperatorMeta> = {
  movistar: {
    key: 'movistar',
    name: 'Telefonica',
    color: '#3B82F6',
  },
  orange: {
    key: 'orange',
    name: 'Orange',
    color: '#F97316',
  },
  vodafone: {
    key: 'vodafone',
    name: 'Vodafone',
    color: '#EF4444',
  },
};

export const UNICO_DECLARED_BAND_TABS: ReadonlyArray<{
  id: UnicoDeclaredBandFilter;
  label: string;
}> = [
  { id: 'all', label: 'Todo' },
  { id: 'N78', label: 'N78' },
  { id: 'N28', label: 'N28' },
  { id: 'N28+', label: 'N28+' },
] as const;

export interface UnicoAntennaRecord {
  id: string;
  fase: UnicoFase;
  op: UnicoOperatorKey;
  empresa: string;
  ccaa: string;
  prov: string;
  mun: string;
  lat: number;
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

export interface UnicoDeclaredOperatorSummary {
  total: number;
  declared: number;
  N78: number;
  N28: number;
  'N28+': number;
}

export interface UnicoDeclaredSummary {
  total: number;
  declared: number;
  byBand: {
    all: number;
    N78: number;
    N28: number;
    'N28+': number;
  };
  byOperator: Record<UnicoOperatorKey, UnicoDeclaredOperatorSummary>;
}

export interface UnicoDataset {
  schemaVersion: number;
  program: string;
  updatedAt: string;
  declaredUpdatedAt?: string;
  total: number;
  fase1Total: number;
  fase2Total: number;
  fase2ProjectsTotal: number;
  operators: Record<UnicoOperatorKey, UnicoOperatorDatasetSummary>;
  antenas: UnicoAntennaRecord[];
  declaredMasks?: number[];
  declaredSummary?: UnicoDeclaredSummary;
}

export interface UnicoOperatorCountStat {
  key: UnicoOperatorKey;
  meta: UnicoOperatorMeta;
  total: number;
  pctOfTotal: number;
  declared: number;
  pctDeclared: number;
}

export interface UnicoSimpleSummary {
  totalAntennas: number;
  totalDeclared: number;
  pctDeclaredGlobal: number;
  byOperator: UnicoOperatorCountStat[];
}

export interface UnicoRouteSearch {
  tab?: UnicoTerritoryTab;
  fase?: UnicoFaseFilter;
  band?: UnicoDeclaredBandFilter;
  provs?: string;
  ccaas?: string;
}
