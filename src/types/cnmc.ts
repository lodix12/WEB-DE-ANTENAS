import { OPERATOR_META } from './antena';

export type CnmcMetricKey =
  | 'ingresos_por_operador'
  | 'ingresos'
  | 'inversiones_por_operador'
  | 'gastos_por_operador'
  | 'empleados_por_operador'
  | 'paquetes';

export type CnmcMarketFilter = 'all' | 'minorista' | 'mayorista';

export type CnmcChartMode = 'line' | 'area' | 'bar' | 'indexed';

export type CnmcDataSource = 'live' | 'cache' | 'fallback';

export const CNMC_NA_SERIES_KEY = 'N/A';
export const CNMC_NA_SERIES_LABEL = 'Sin desglose (N/A)';

export const CNMC_METRIC_ORDER: readonly CnmcMetricKey[] = [
  'ingresos_por_operador',
  'ingresos',
  'inversiones_por_operador',
  'gastos_por_operador',
  'empleados_por_operador',
  'paquetes',
] as const;

export interface CnmcMetricDefinition {
  key: CnmcMetricKey;
  label: string;
  shortLabel: string;
  description: string;
  unitLabel: string;
  unitShort: string;
  decimals: number;
  supportsMarket: boolean;
  dimensionLabel: string;
  dimensionField: 'operador' | 'tipoDeIngreso' | 'tipoDePaquete';
}

export const CNMC_METRIC_META: Record<CnmcMetricKey, CnmcMetricDefinition> = {
  ingresos_por_operador: {
    key: 'ingresos_por_operador',
    label: 'Ingresos por operador',
    shortLabel: 'Ingresos (op.)',
    description:
      'Ingresos anuales minoristas y mayoristas desglosados por operador (Millones €).',
    unitLabel: 'Millones €',
    unitShort: 'M€',
    decimals: 2,
    supportsMarket: true,
    dimensionLabel: 'Operador',
    dimensionField: 'operador',
  },
  ingresos: {
    key: 'ingresos',
    label: 'Ingresos por servicio',
    shortLabel: 'Ingresos (serv.)',
    description:
      'Ingresos anuales del sector por tipo de servicio minorista o mayorista (Millones €).',
    unitLabel: 'Millones €',
    unitShort: 'M€',
    decimals: 2,
    supportsMarket: true,
    dimensionLabel: 'Tipo de ingreso',
    dimensionField: 'tipoDeIngreso',
  },
  inversiones_por_operador: {
    key: 'inversiones_por_operador',
    label: 'Inversiones',
    shortLabel: 'Inversiones',
    description:
      'Inversiones anuales en infraestructuras de telecomunicaciones y servicios audiovisuales (Millones €).',
    unitLabel: 'Millones €',
    unitShort: 'M€',
    decimals: 2,
    supportsMarket: false,
    dimensionLabel: 'Operador',
    dimensionField: 'operador',
  },
  gastos_por_operador: {
    key: 'gastos_por_operador',
    label: 'Gastos de explotación',
    shortLabel: 'Gastos',
    description:
      'Gastos anuales de explotación declarados por operador (Millones €).',
    unitLabel: 'Millones €',
    unitShort: 'M€',
    decimals: 2,
    supportsMarket: false,
    dimensionLabel: 'Operador',
    dimensionField: 'operador',
  },
  empleados_por_operador: {
    key: 'empleados_por_operador',
    label: 'Empleados',
    shortLabel: 'Empleados',
    description:
      'Número anual de empleados por operador en telecomunicaciones y sector audiovisual.',
    unitLabel: 'Empleados',
    unitShort: 'emp.',
    decimals: 0,
    supportsMarket: false,
    dimensionLabel: 'Operador',
    dimensionField: 'operador',
  },
  paquetes: {
    key: 'paquetes',
    label: 'Paquetes contratados',
    shortLabel: 'Paquetes',
    description:
      'Número anual de empaquetamientos convergentes contratados en España por modalidad.',
    unitLabel: 'Paquetes',
    unitShort: 'paq.',
    decimals: 0,
    supportsMarket: false,
    dimensionLabel: 'Tipo de paquete',
    dimensionField: 'tipoDePaquete',
  },
};

export const CNMC_MARKET_OPTIONS: ReadonlyArray<{
  id: CnmcMarketFilter;
  label: string;
}> = [
  { id: 'all', label: 'Total (Minorista + Mayorista)' },
  { id: 'minorista', label: 'Servicio minorista' },
  { id: 'mayorista', label: 'Servicio mayorista' },
] as const;

export const CNMC_CHART_MODE_OPTIONS: ReadonlyArray<{
  id: CnmcChartMode;
  label: string;
}> = [
  { id: 'line', label: 'Líneas' },
  { id: 'area', label: 'Área apilada' },
  { id: 'bar', label: 'Barras' },
  { id: 'indexed', label: 'Base 100' },
] as const;

export interface CnmcRawRecord {
  _id?: number;
  anno?: string | number | null;
  pais?: string | null;
  tipo_de_mercado?: string | null;
  servicio?: string | null;
  concepto?: string | null;
  operador?: string | null;
  tipo_de_ingreso?: string | null;
  tipo_de_paquete?: string | null;
  unidades?: string | null;
  ingresos?: number | string | null;
  ingresos_por_operador?: number | string | null;
  empleados_por_operador?: number | string | null;
  paquetes?: number | string | null;
  inversiones_por_operador?: number | string | null;
  gastos_por_operador?: number | string | null;
}

export interface CnmcCompactRecord {
  a: number;
  m?: string;
  c?: string;
  o?: string;
  ti?: string;
  tp?: string;
  u?: string;
  ingresos?: number;
  ingresos_por_operador?: number;
  empleados_por_operador?: number;
  paquetes?: number;
  inversiones_por_operador?: number;
  gastos_por_operador?: number;
}

export interface CnmcNormalizedRecord {
  anno: number;
  tipoDeMercado: string;
  concepto: string;
  operador: string;
  tipoDeIngreso: string;
  tipoDePaquete: string;
  unidades: string;
  ingresos: number | null;
  ingresos_por_operador: number | null;
  empleados_por_operador: number | null;
  paquetes: number | null;
  inversiones_por_operador: number | null;
  gastos_por_operador: number | null;
}

export interface CnmcCatalogMetadata {
  datasetName: string;
  datasetTitle: string;
  version: string;
  resourceId: string;
  resourceUrl: string;
  periodo: string;
  modified: string;
  issued: string;
  metadataModified: string;
  novedad: string;
  frecuencia: string;
  licenseTitle: string;
  licenseUrl: string;
  portalUrl: string;
  step1Url: string;
  step2Url: string;
}

export interface CnmcFallbackFilePayload {
  schemaVersion: number;
  fetchedAt: string;
  metadata: CnmcCatalogMetadata;
  totalRecords: number;
  records: CnmcCompactRecord[];
}

export interface CnmcDatasetPayload {
  schemaVersion: number;
  fetchedAt: string;
  metadata: CnmcCatalogMetadata;
  totalRecords: number;
  records: CnmcNormalizedRecord[];
  source: CnmcDataSource;
  liveError?: string;
}

export interface CnmcRouteSearch {
  metric?: CnmcMetricKey;
  from?: number;
  to?: number;
  market?: CnmcMarketFilter;
  chart?: CnmcChartMode;
  series?: string;
  total?: '1' | '0';
}

export interface CnmcAnnualPoint {
  year: number;
  value: number | null;
  indexedValue: number | null;
  yoyPct: number | null;
  sharePct: number | null;
}

export interface CnmcChartSeries {
  key: string;
  label: string;
  color: string;
  isNaAggregate: boolean;
  points: CnmcAnnualPoint[];
  startValue: number | null;
  endValue: number | null;
  firstAvailableYear: number | null;
  firstAvailableValue: number | null;
  lastAvailableYear: number | null;
  lastAvailableValue: number | null;
  deltaAbs: number | null;
  deltaPct: number | null;
  endSharePct: number | null;
  maxValue: number;
}

export interface CnmcPeriodKpis {
  startYear: number;
  endYear: number;
  startTotal: number | null;
  endTotal: number | null;
  periodDeltaAbs: number | null;
  periodDeltaPct: number | null;
  cagrPct: number | null;
  prevYear: number | null;
  prevYearTotal: number | null;
  yoyDeltaAbs: number | null;
  yoyDeltaPct: number | null;
  leaderLabel: string | null;
  leaderColor: string | null;
  leaderValue: number | null;
  leaderSharePct: number | null;
}

export interface CnmcSeriesViewModel {
  metric: CnmcMetricDefinition;
  market: CnmcMarketFilter;
  availableYears: number[];
  years: number[];
  fromYear: number;
  toYear: number;
  allSeries: CnmcChartSeries[];
  visibleSeries: CnmcChartSeries[];
  totalPoints: CnmcAnnualPoint[];
  kpis: CnmcPeriodKpis;
}

const KNOWN_SERIES_COLORS: Readonly<Record<string, string>> = {
  Movistar: OPERATOR_META.movistar.color,
  Orange: OPERATOR_META.orange.color,
  MASORANGE: '#F97316',
  'Grupo MASMOVIL': '#D97706',
  Vodafone: OPERATOR_META.vodafone.color,
  DIGI: OPERATOR_META.digi.color,
  Resto: '#64748B',
  [CNMC_NA_SERIES_KEY]: '#475569',
  Adamo: '#0D9488',
  Avatel: '#0284C7',
  Onivia: '#0891B2',
  Euskaltel: '#EC4899',
  'Mediaset España': '#2563EB',
  RTVE: '#1D4ED8',
  'Televisió de Catalunya': '#0F766E',
  Jazztel: '#CA8A04',
  Ono: '#9333EA',
  Yoigo: '#DB2777',
  DTS: '#4F46E5',
};

const FALLBACK_SERIES_PALETTE: readonly string[] = [
  '#0284C7',
  '#0D9488',
  '#EA580C',
  '#DC2626',
  '#2563EB',
  '#D97706',
  '#059669',
  '#4F46E5',
  '#0891B2',
  '#E11D48',
  '#65A30D',
  '#9333EA',
  '#0369A1',
  '#B45309',
] as const;

export function resolveCnmcSeriesColor(
  seriesKey: string,
  fallbackIndex = 0,
): string {
  const known = KNOWN_SERIES_COLORS[seriesKey];
  if (known) return known;
  const idx = Math.abs(fallbackIndex) % FALLBACK_SERIES_PALETTE.length;
  return FALLBACK_SERIES_PALETTE[idx];
}

export function formatCnmcSeriesLabel(seriesKey: string): string {
  return seriesKey === CNMC_NA_SERIES_KEY ? CNMC_NA_SERIES_LABEL : seriesKey;
}
