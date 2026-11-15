import { createContext, useContext } from 'react';
import type {
  AntennaRecord,
  OpenFreeMapStyleOption,
  OperatorKey,
} from '../types/antena';
import type { FlyToTarget, RadarPoint } from '../types/map';

export type ThemeMode = 'light' | 'dark';

export interface WorkspaceContextValue {
  theme: ThemeMode;
  toggleTheme: () => void;
  styleId: OpenFreeMapStyleOption['id'];
  setStyleId: (id: OpenFreeMapStyleOption['id']) => void;

  /* Filtros compartidos */
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  selectedProvince: string;
  setSelectedProvince: (prov: string) => void;
  selectedMunicipality: string;
  setSelectedMunicipality: (mun: string) => void;
  activeOperators: OperatorKey[];
  toggleOperator: (op: OperatorKey) => void;
  selectAllOperators: () => void;
  clearAllOperators: () => void;
  resetAllFilters: () => void;
  hasActiveFilters: boolean;

  /* Selección, Cámara y Radar */
  selectedAntenna: AntennaRecord | null;
  setSelectedAntenna: (ant: AntennaRecord | null) => void;
  flyToTarget: FlyToTarget | null;
  triggerFlyTo: (lat: number, lon: number, zoom?: number) => void;
  radarPoint: RadarPoint | null;
  setRadarPoint: (point: RadarPoint | null) => void;
  radarRadiusKm: number;
  setRadarRadiusKm: (radiusKm: number) => void;
  radarModeActive: boolean;
  setRadarModeActive: (active: boolean) => void;
  toggleRadarMode: () => void;

  /* Geolocalización GPS */
  gpsLoading: boolean;
  gpsError: string | null;
  requestGpsLocation: (flyOnSuccess?: boolean) => void;

  /* Acciones cruzadas entre vistas */
  focusAntennaOnMap: (ant: AntennaRecord) => void;
  jumpToCoordinates: (lat: number, lon: number, label?: string) => void;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(
  null,
);

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error('useWorkspace debe utilizarse dentro de WorkspaceProvider');
  }
  return ctx;
}
