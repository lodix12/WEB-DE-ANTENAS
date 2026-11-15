import type {
  AntennaRecord,
  OpenFreeMapStyleOption,
  OperatorKey,
} from './antena';

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
  /** Ubicación del usuario o punto de análisis de cobertura */
  radarPoint?: RadarPoint | null;
  /** Actualizar o borrar el punto de análisis en el mapa */
  onRadarPointChange?: (point: RadarPoint | null) => void;
  /** Si está activo el modo de medición haciendo clic sobre el mapa */
  radarModeActive?: boolean;
  /** Activar/desactivar modo medición por clic */
  onToggleRadarMode?: () => void;
  /** Operadores actualmente visibles */
  activeOperators: OperatorKey[];
  /** Alternar visibilidad de un operador desde la leyenda */
  onToggleOperator?: (op: OperatorKey) => void;
}
