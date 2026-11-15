export type OperatorKey =
  | 'movistar'
  | 'vodafone'
  | 'orange'
  | 'masmovil'
  | 'digi'
  | 'otros';

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
  /** Gis_IDs originales fusionados cuando se agrupan declaraciones duplicadas (< 10 m en Vodafone) */
  mergedGids?: string[];
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
  /** Declaraciones duplicadas de Vodafone (< 10 m) fusionadas en una única antena */
  vodafoneFusedDuplicates?: number;
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
  antena: Pick<AntennaRecord, 'gid' | 'id'>,
): string {
  const base = 'https://geoportal.minetur.gob.es/VCTEL/detalleEstacion.do';
  const params = new URLSearchParams({
    emplazamiento: antena.gid,
    codEmplazamiento: antena.id,
  });
  return `${base}?${params.toString()}`;
}

export function getFullAddress(
  antena: Pick<AntennaRecord, 'dir' | 'mun' | 'prov'>,
): string {
  const parts = [antena.dir, [antena.mun, antena.prov].filter(Boolean).join(', ')].filter(Boolean);
  return parts.join(' · ');
}
