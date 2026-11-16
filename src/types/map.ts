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
  /** Puntos seleccionados (0, 1 o 2) para medir distancia entre 2 puntos en el mapa */
  measurePoints?: MeasurePoint[];
  /** Actualizar o limpiar los puntos de medición (Punto A y Punto B) */
  onMeasurePointsChange?: (points: MeasurePoint[]) => void;
  /** Si está activo el modo "Medir en mapa" (seleccionar 2 puntos) */
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
}
