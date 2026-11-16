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
import type { FlyToTarget, MeasurePoint, RadarPoint } from '../types/map';
import {
  getComunidadAutonomaByProvince,
  matchesAntennaBandsFilter,
} from './useAntenasData';
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
  const [selectedComunidad, setSelectedComunidadState] = useState('');
  const [selectedProvince, setSelectedProvinceState] = useState('');
  const [selectedBands, setSelectedBands] = useState<string[]>([]);
  const [exclusiveBands, setExclusiveBands] = useState<boolean>(false);
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

  const [measurePoints, setMeasurePoints] = useState<MeasurePoint[]>([]);
  const [measureModeActive, setMeasureModeActive] = useState<boolean>(false);
  const [showBandsOnMap, setShowBandsOnMap] = useState<boolean>(false);

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

  const setSelectedComunidad = useCallback((ccaa: string) => {
    setSelectedComunidadState(ccaa);
    if (!ccaa) {
      setSelectedProvinceState('');
      return;
    }
    setSelectedProvinceState((prevProv) =>
      prevProv && getComunidadAutonomaByProvince(prevProv) !== ccaa
        ? ''
        : prevProv,
    );
  }, []);

  const setSelectedProvince = useCallback((prov: string) => {
    setSelectedProvinceState(prov);
    if (prov) {
      const provCcaa = getComunidadAutonomaByProvince(prov);
      setSelectedComunidadState((prevCcaa) =>
        prevCcaa && prevCcaa !== provCcaa ? provCcaa : prevCcaa,
      );
    }
  }, []);

  const toggleBand = useCallback((band: string) => {
    const trimmed = band.trim();
    if (!trimmed) return;
    setSelectedBands((prev) =>
      prev.includes(trimmed)
        ? prev.filter((b) => b !== trimmed)
        : [...prev, trimmed],
    );
  }, []);

  const clearBands = useCallback(() => {
    setSelectedBands([]);
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
    setSelectedComunidadState('');
    setSelectedProvinceState('');
    setSelectedBands([]);
    setExclusiveBands(false);
    setActiveOperators([...OPERATOR_ORDER]);
  }, []);

  const hasActiveFilters =
    searchQuery.trim().length > 0 ||
    selectedComunidad !== '' ||
    selectedProvince !== '' ||
    selectedBands.length > 0 ||
    exclusiveBands ||
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
    setRadarModeActive((prev) => {
      const next = !prev;
      if (next) setMeasureModeActive(false);
      return next;
    });
  }, []);

  const toggleMeasureMode = useCallback(() => {
    setMeasureModeActive((prev) => {
      const next = !prev;
      if (next) {
        setRadarModeActive(false);
        setMeasurePoints((pts) => (pts.length >= 2 ? [] : pts));
      } else {
        setMeasurePoints([]);
      }
      return next;
    });
  }, []);

  const clearMeasurement = useCallback(() => {
    setMeasurePoints([]);
    setMeasureModeActive(false);
  }, []);

  const toggleShowBandsOnMap = useCallback(() => {
    setShowBandsOnMap((prev) => !prev);
  }, []);

  const jumpToCoordinates = useCallback(
    (lat: number, lon: number, _label?: string) => {
      setRadarModeActive(false);
      setGpsError(null);
      triggerFlyTo(lat, lon, 15);
    },
    [triggerFlyTo],
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
          if (flyOnSuccess) {
            triggerFlyTo(latitude, longitude, 14.2);
          }
        },
        (err) => {
          setGpsLoading(false);
          if (err.code === err.PERMISSION_DENIED) {
            setGpsError(
              'Permiso de ubicación denegado. Puedes escribir coordenadas en el buscador superior.',
            );
          } else {
            setGpsError(
              'No se pudo obtener la señal GPS. Prueba a introducir coordenadas en el buscador.',
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
    [triggerFlyTo],
  );

  const focusAntennaOnMap = useCallback(
    (ant: AntennaRecord) => {
      setActiveOperators((prev) =>
        prev.includes(ant.op) ? prev : [...prev, ant.op],
      );
      setSelectedComunidadState((prev) =>
        prev && getComunidadAutonomaByProvince(ant.prov) !== prev ? '' : prev,
      );
      setSelectedProvinceState((prev) =>
        prev && ant.prov !== prev ? '' : prev,
      );
      if (
        selectedBands.length > 0 &&
        !matchesAntennaBandsFilter(ant.bandas, selectedBands, exclusiveBands)
      ) {
        setSelectedBands([]);
        setExclusiveBands(false);
      }
      setSelectedAntenna(ant);
      triggerFlyTo(ant.lat, ant.lon, 16);
    },
    [exclusiveBands, selectedBands, triggerFlyTo],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      theme,
      toggleTheme,
      styleId,
      setStyleId,
      searchQuery,
      setSearchQuery,
      selectedComunidad,
      setSelectedComunidad,
      selectedProvince,
      setSelectedProvince,
      selectedBands,
      toggleBand,
      clearBands,
      exclusiveBands,
      setExclusiveBands,
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
      measurePoints,
      setMeasurePoints,
      clearMeasurement,
      measureModeActive,
      setMeasureModeActive,
      toggleMeasureMode,
      showBandsOnMap,
      setShowBandsOnMap,
      toggleShowBandsOnMap,
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
      selectedComunidad,
      setSelectedComunidad,
      selectedProvince,
      setSelectedProvince,
      selectedBands,
      toggleBand,
      clearBands,
      exclusiveBands,
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
      measurePoints,
      clearMeasurement,
      measureModeActive,
      toggleMeasureMode,
      showBandsOnMap,
      setShowBandsOnMap,
      toggleShowBandsOnMap,
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
