import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  OPENFREEMAP_STYLES,
  OPERATOR_ORDER,
  type AntennaRecord,
  type OpenFreeMapStyleOption,
  type OperatorKey,
} from '../types/antena';
import type { FlyToTarget, RadarPoint } from '../types/map';
import {
  WorkspaceContext,
  type ThemeMode,
  type WorkspaceContextValue,
} from './useWorkspace';

const THEME_STORAGE_KEY = 'radiomapa-theme';
const MAP_STYLE_STORAGE_KEY = 'radiomapa-map-style';

function getInitialTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'dark';
  const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function getInitialStyleId(theme: ThemeMode): OpenFreeMapStyleOption['id'] {
  if (typeof window !== 'undefined') {
    const saved = window.localStorage.getItem(MAP_STYLE_STORAGE_KEY);
    if (saved && OPENFREEMAP_STYLES.some((s) => s.id === saved)) {
      return saved as OpenFreeMapStyleOption['id'];
    }
  }
  return theme === 'dark' ? 'dark' : 'liberty';
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [styleId, setStyleIdState] = useState<OpenFreeMapStyleOption['id']>(() =>
    getInitialStyleId(getInitialTheme()),
  );
  const [userPickedCustomStyle, setUserPickedCustomStyle] = useState<boolean>(
    () =>
      typeof window !== 'undefined' &&
      Boolean(window.localStorage.getItem(MAP_STYLE_STORAGE_KEY)),
  );

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedProvince, setSelectedProvinceState] = useState('');
  const [selectedMunicipality, setSelectedMunicipality] = useState('');
  const [activeOperators, setActiveOperators] = useState<OperatorKey[]>(() => [
    ...OPERATOR_ORDER,
  ]);

  const [selectedAntenna, setSelectedAntenna] = useState<AntennaRecord | null>(
    null,
  );
  const [flyToTarget, setFlyToTarget] = useState<FlyToTarget | null>(null);
  const [radarRadiusKm, setRadarRadiusKmState] = useState<number>(2);
  const [radarPoint, setRadarPointState] = useState<RadarPoint | null>(null);
  const [radarModeActive, setRadarModeActive] = useState<boolean>(false);

  const [gpsLoading, setGpsLoading] = useState<boolean>(false);
  const [gpsError, setGpsError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute(
        'content',
        theme === 'dark' ? '#0b1120' : '#ffffff',
      );
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: ThemeMode = prev === 'dark' ? 'light' : 'dark';
      if (!userPickedCustomStyle) {
        setStyleIdState(next === 'dark' ? 'dark' : 'liberty');
      } else {
        setStyleIdState((currStyle) => {
          if (next === 'dark' && currStyle === 'liberty') return 'dark';
          if (next === 'light' && currStyle === 'dark') return 'liberty';
          return currStyle;
        });
      }
      return next;
    });
  }, [userPickedCustomStyle]);

  const setStyleId = useCallback((id: OpenFreeMapStyleOption['id']) => {
    setStyleIdState(id);
    setUserPickedCustomStyle(true);
    window.localStorage.setItem(MAP_STYLE_STORAGE_KEY, id);
  }, []);

  const setSelectedProvince = useCallback((prov: string) => {
    setSelectedProvinceState(prov);
    setSelectedMunicipality('');
  }, []);

  const toggleOperator = useCallback((op: OperatorKey) => {
    setActiveOperators((prev) =>
      prev.includes(op) ? prev.filter((item) => item !== op) : [...prev, op],
    );
  }, []);

  const selectAllOperators = useCallback(() => {
    setActiveOperators([...OPERATOR_ORDER]);
  }, []);

  const clearAllOperators = useCallback(() => {
    setActiveOperators([]);
  }, []);

  const resetAllFilters = useCallback(() => {
    setSearchQuery('');
    setSelectedProvinceState('');
    setSelectedMunicipality('');
    setActiveOperators([...OPERATOR_ORDER]);
  }, []);

  const hasActiveFilters =
    searchQuery.trim().length > 0 ||
    selectedProvince !== '' ||
    selectedMunicipality !== '' ||
    activeOperators.length !== OPERATOR_ORDER.length;

  const triggerFlyTo = useCallback((lat: number, lon: number, zoom = 14) => {
    setFlyToTarget({
      lat,
      lon,
      zoom,
      token: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    });
  }, []);

  const setRadarPoint = useCallback(
    (point: RadarPoint | null) => {
      setGpsError(null);
      if (!point) {
        setRadarPointState(null);
        return;
      }
      setRadarPointState({
        ...point,
        radiusKm: point.radiusKm ?? radarRadiusKm,
      });
    },
    [radarRadiusKm],
  );

  const setRadarRadiusKm = useCallback((nextRadius: number) => {
    setRadarRadiusKmState(nextRadius);
    setRadarPointState((prev) =>
      prev ? { ...prev, radiusKm: nextRadius } : null,
    );
  }, []);

  const toggleRadarMode = useCallback(() => {
    setRadarModeActive((prev) => !prev);
  }, []);

  const jumpToCoordinates = useCallback(
    (lat: number, lon: number, label = 'Coordenadas introducidas') => {
      setRadarModeActive(false);
      setGpsError(null);
      setRadarPointState({
        lat,
        lon,
        label,
        radiusKm: radarRadiusKm,
      });
      triggerFlyTo(lat, lon, 14.5);
    },
    [radarRadiusKm, triggerFlyTo],
  );

  const requestGpsLocation = useCallback(
    (flyOnSuccess = true) => {
      if (typeof navigator === 'undefined' || !navigator.geolocation) {
        setGpsError('Tu navegador no soporta geolocalización GPS.');
        return;
      }
      setGpsLoading(true);
      setGpsError(null);
      setRadarModeActive(false);

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setGpsLoading(false);
          const { latitude, longitude } = pos.coords;
          setRadarPointState({
            lat: latitude,
            lon: longitude,
            label: 'Mi ubicación GPS',
            radiusKm: radarRadiusKm,
          });
          if (flyOnSuccess) {
            triggerFlyTo(latitude, longitude, 14.2);
          }
        },
        (err) => {
          setGpsLoading(false);
          if (err.code === err.PERMISSION_DENIED) {
            setGpsError(
              'Permiso de ubicación denegado. Puedes hacer clic en "Medir en mapa" o escribir coordenadas.',
            );
          } else {
            setGpsError(
              'No se pudo obtener la señal GPS. Prueba a seleccionar un punto directamente en el mapa.',
            );
          }
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 60000,
        },
      );
    },
    [radarRadiusKm, triggerFlyTo],
  );

  const focusAntennaOnMap = useCallback(
    (ant: AntennaRecord) => {
      setActiveOperators((prev) =>
        prev.includes(ant.op) ? prev : [...prev, ant.op],
      );
      setSelectedAntenna(ant);
      triggerFlyTo(ant.lat, ant.lon, 16);
    },
    [triggerFlyTo],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      theme,
      toggleTheme,
      styleId,
      setStyleId,
      searchQuery,
      setSearchQuery,
      selectedProvince,
      setSelectedProvince,
      selectedMunicipality,
      setSelectedMunicipality,
      activeOperators,
      toggleOperator,
      selectAllOperators,
      clearAllOperators,
      resetAllFilters,
      hasActiveFilters,
      selectedAntenna,
      setSelectedAntenna,
      flyToTarget,
      triggerFlyTo,
      radarPoint,
      setRadarPoint,
      radarRadiusKm,
      setRadarRadiusKm,
      radarModeActive,
      setRadarModeActive,
      toggleRadarMode,
      gpsLoading,
      gpsError,
      requestGpsLocation,
      focusAntennaOnMap,
      jumpToCoordinates,
    }),
    [
      theme,
      toggleTheme,
      styleId,
      setStyleId,
      searchQuery,
      selectedProvince,
      setSelectedProvince,
      selectedMunicipality,
      activeOperators,
      toggleOperator,
      selectAllOperators,
      clearAllOperators,
      resetAllFilters,
      hasActiveFilters,
      selectedAntenna,
      flyToTarget,
      triggerFlyTo,
      radarPoint,
      setRadarPoint,
      radarRadiusKm,
      setRadarRadiusKm,
      radarModeActive,
      toggleRadarMode,
      gpsLoading,
      gpsError,
      requestGpsLocation,
      focusAntennaOnMap,
      jumpToCoordinates,
    ],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}
