import type {
  AntennaRecord,
  OpenFreeMapStyleOption,
  OperatorKey,
} from './antena';
import type {
  UnicoAntennaRecord,
  UnicoDeclaredRealAntennaMatch,
} from './unico5g';

export interface FlyToTarget {
  lat: number;
  lon: number;
  zoom?: number;
  token: number | string;
}

export interface RadarPoint {
  lat: number;
  lon: number;
  label?: string;
  radiusKm?: number;
}

export const MAX_MEASURE_POINTS = 10;

export type ClusteringLevel = 'none' | 'normal' | 'high' | 'max';

export interface ClusteringLevelOption {
  id: ClusteringLevel;
  label: string;
  description: string;
  cluster: boolean;
  clusterMaxZoom: number;
  clusterRadius: number;
}

export const DEFAULT_CLUSTERING_LEVEL: ClusteringLevel = 'max';

export const CLUSTERING_LEVEL_OPTIONS: readonly ClusteringLevelOption[] = [
  {
    id: 'none',
    label: 'Ninguno',
    description: 'Mostrar antenas sin agrupar al alejar',
    cluster: false,
    clusterMaxZoom: 12,
    clusterRadius: 46,
  },
  {
    id: 'normal',
    label: 'Normal',
    description: 'Agrupación estándar al alejar el mapa',
    cluster: true,
    clusterMaxZoom: 12,
    clusterRadius: 46,
  },
  {
    id: 'high',
    label: 'Alto',
    description: 'Agrupación algo mayor al alejar el mapa',
    cluster: true,
    clusterMaxZoom: 13,
    clusterRadius: 68,
  },
  {
    id: 'max',
    label: 'Máximo',
    description: 'Agrupación máxima al alejar el mapa',
    cluster: true,
    clusterMaxZoom: 14,
    clusterRadius: 100,
  },
];

export function getClusteringLevelConfig(
  level: ClusteringLevel,
): ClusteringLevelOption {
  return (
    CLUSTERING_LEVEL_OPTIONS.find((option) => option.id === level) ??
    CLUSTERING_LEVEL_OPTIONS.find(
      (option) => option.id === DEFAULT_CLUSTERING_LEVEL,
    ) ??
    CLUSTERING_LEVEL_OPTIONS[CLUSTERING_LEVEL_OPTIONS.length - 1]
  );
}

export interface MeasurePoint {
  lat: number;
  lon: number;
  label?: string;
}

export interface NearestAntennaResult extends AntennaRecord {
  distanceKm: number;
  bearingDeg: number;
  cardinal: string;
}

export interface AntenasMapProps {
  /** Lista filtrada de antenas a renderizar en MapLibre */
  antenas: AntennaRecord[];
  /** Antena actualmente seleccionada para panel de detalle y resaltado */
  selectedAntenna: AntennaRecord | null;
  /** Callback al hacer clic en una antena o limpiar selección */
  onSelectAntenna: (antenna: AntennaRecord | null) => void;
  /** Estilo de OpenFreeMap activo */
  styleId: OpenFreeMapStyleOption['id'];
  /** Cambiar el estilo de OpenFreeMap */
  onStyleChange: (styleId: OpenFreeMapStyleOption['id']) => void;
  /** Coordenadas a las que desplazar la cámara cuando cambia `token` */
  flyToTarget?: FlyToTarget | null;
  /** Ubicación GPS o punto de radar de cercanía */
  radarPoint?: RadarPoint | null;
  /** Actualizar o borrar el punto de radar en el mapa */
  onRadarPointChange?: (point: RadarPoint | null) => void;
  /** Si está activo el modo de radar por clic (legado/opcional) */
  radarModeActive?: boolean;
  /** Activar/desactivar modo radar */
  onToggleRadarMode?: () => void;
  /** Puntos seleccionados (0..10 puntos, hasta `MAX_MEASURE_POINTS`) para medir distancia en el mapa */
  measurePoints?: MeasurePoint[];
  /** Actualizar o limpiar los puntos de medición (`0..10` puntos) */
  onMeasurePointsChange?: (points: MeasurePoint[]) => void;
  /** Si está activo el modo "Medir en mapa" (seleccionar `0..10` puntos) */
  measureModeActive?: boolean;
  /** Activar/desactivar el modo "Medir en mapa" */
  onToggleMeasureMode?: () => void;
  /** Operadores actualmente visibles */
  activeOperators: OperatorKey[];
  /** Alternar visibilidad de un operador desde la leyenda */
  onToggleOperator?: (op: OperatorKey) => void;
  /** Si el movimiento 3D / inclinación vertical del mapa está bloqueado (por defecto true al cargar) */
  lock3dPitch?: boolean;
  /** Alternar bloqueo de movimiento 3D / inclinación vertical del mapa */
  onToggleLock3dPitch?: () => void;
  /** Si está activa la visualización directa de bandas de frecuencia bajo cada antena en el mapa */
  showBandsOnMap?: boolean;
  /** Alternar la visualización directa de bandas de frecuencia en el mapa */
  onToggleShowBandsOnMap?: () => void;
  /** Nivel de agrupación en clústeres al alejar el mapa ('none' | 'normal' | 'high' | 'max', por defecto 'max') */
  clusteringLevel?: ClusteringLevel;
  /** Cambiar el nivel de agrupación en clústeres del mapa */
  onClusteringLevelChange?: (level: ClusteringLevel) => void;
  /** Mapa O(1) de antenas reales seleccionadas como declaración del programa UNICO 5G */
  unicoDeclaredById?: ReadonlyMap<string, UnicoDeclaredRealAntennaMatch>;
  /** Si el resaltado visual en mapa de antenas seleccionadas como declaración UNICO 5G está activo (por defecto true) */
  highlightUnicoDeclared?: boolean;
  /** Alternar el resaltado visual en mapa de antenas seleccionadas como declaración UNICO 5G */
  onToggleHighlightUnicoDeclared?: () => void;
  /** Catálogo completo de coordenadas oficiales exactas de los proyectos UNICO 5G (9.291 ubicaciones) */
  unicoProjects?: readonly UnicoAntennaRecord[];
  /** Máscaras de bits 5G alineadas con `unicoProjects` para mostrar estado declarado/pendiente */
  unicoDeclaredMasks?: Uint16Array | null;
  /** Si está activa la capa de puntos con las coordenadas oficiales exactas de los proyectos UNICO 5G (por defecto false) */
  showUnicoProjects?: boolean;
  /** Alternar la visibilidad de los puntos de coordenadas oficiales exactas de los proyectos UNICO 5G */
  onToggleShowUnicoProjects?: () => void;
  /** Enfocar y abrir ficha de una antena real emparejada desde una coordenada UNICO 5G (incluso si está filtrada o a <= 1 km) */
  onFocusUnicoMatchedAntenna?: (antennaId: string) => void;
}
