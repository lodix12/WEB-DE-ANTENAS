import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Compass,
  Crosshair,
  Layers,
  Loader2,
  LocateFixed,
  Radio,
  X,
} from 'lucide-react';
import {
  OPENFREEMAP_STYLES,
  OPERATOR_META,
  OPERATOR_ORDER,
  type AntennaRecord,
  type OpenFreeMapStyleOption,
  type OperatorKey,
} from '../../types/antena';
import type { RadarPoint } from '../../types/map';
import {
  SPAIN_REGION_PRESETS,
  bearingToCardinal,
  calculateBearingDeg,
  formatDistance,
  haversineDistanceKm,
} from '../../utils/geo';

const RADAR_RADIUS_OPTIONS_KM = [1, 2, 5, 10] as const;

export interface MapOverlaysProps {
  antenas: AntennaRecord[];
  selectedAntenna: AntennaRecord | null;
  styleId: OpenFreeMapStyleOption['id'];
  onStyleChange: (styleId: OpenFreeMapStyleOption['id']) => void;
  radarPoint?: RadarPoint | null;
  onRadarPointChange?: (point: RadarPoint | null) => void;
  radarModeActive?: boolean;
  onToggleRadarMode?: () => void;
  activeOperators: OperatorKey[];
  onToggleOperator?: (op: OperatorKey) => void;
  activeRegionId: string | null;
  onFlyToRegion: (
    lon: number,
    lat: number,
    zoom: number,
    presetId?: string,
  ) => void;
}

export function MapOverlays({
  antenas,
  selectedAntenna,
  styleId,
  onStyleChange,
  radarPoint,
  onRadarPointChange,
  radarModeActive = false,
  onToggleRadarMode,
  activeOperators,
  onToggleOperator,
  activeRegionId,
  onFlyToRegion,
}: MapOverlaysProps) {
  const [styleMenuOpen, setStyleMenuOpen] = useState(false);
  const [legendCollapsed, setLegendCollapsed] = useState(false);
  const [isLocating, setIsLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  const stylePopoverRef = useRef<HTMLDivElement | null>(null);

  const currentStyle = useMemo(
    () =>
      OPENFREEMAP_STYLES.find((option) => option.id === styleId) ??
      OPENFREEMAP_STYLES[0],
    [styleId],
  );

  const operatorCounts = useMemo(() => {
    const counts: Record<OperatorKey, number> = {
      movistar: 0,
      orange: 0,
      vodafone: 0,
      masmovil: 0,
      digi: 0,
      otros: 0,
    };
    for (let i = 0; i < antenas.length; i++) {
      const op = antenas[i].op;
      counts[op] = (counts[op] ?? 0) + 1;
    }
    return counts;
  }, [antenas]);

  const activeOperatorSet = useMemo(
    () => new Set<OperatorKey>(activeOperators),
    [activeOperators],
  );

  const losMetrics = useMemo(() => {
    if (!radarPoint || !selectedAntenna) {
      return null;
    }
    const distanceKm = haversineDistanceKm(
      radarPoint.lat,
      radarPoint.lon,
      selectedAntenna.lat,
      selectedAntenna.lon,
    );
    const bearingDeg = calculateBearingDeg(
      radarPoint.lat,
      radarPoint.lon,
      selectedAntenna.lat,
      selectedAntenna.lon,
    );
    return {
      distanceFormatted: formatDistance(distanceKm),
      cardinal: bearingToCardinal(bearingDeg),
    };
  }, [radarPoint, selectedAntenna]);

  useEffect(() => {
    if (!styleMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (
        stylePopoverRef.current &&
        event.target instanceof Node &&
        !stylePopoverRef.current.contains(event.target)
      ) {
        setStyleMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setStyleMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [styleMenuOpen]);

  useEffect(() => {
    if (!geoError) {
      return;
    }
    const timer = window.setTimeout(() => setGeoError(null), 5000);
    return () => window.clearTimeout(timer);
  }, [geoError]);

  const handleGeolocate = () => {
    if (!('geolocation' in navigator)) {
      setGeoError('Tu navegador no soporta geolocalización GPS.');
      return;
    }

    setGeoError(null);
    setIsLocating(true);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setIsLocating(false);
        const lat = Number(position.coords.latitude.toFixed(6));
        const lon = Number(position.coords.longitude.toFixed(6));
        onRadarPointChange?.({
          lat,
          lon,
          radiusKm: radarPoint?.radiusKm ?? 2,
          label: 'Mi ubicación GPS',
        });
        onFlyToRegion(lon, lat, 14.5);
      },
      (error) => {
        setIsLocating(false);
        if (error.code === error.PERMISSION_DENIED) {
          setGeoError('Permiso de ubicación denegado en el navegador.');
        } else {
          setGeoError('No fue posible obtener la ubicación actual.');
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000,
      },
    );
  };

  const activeRadiusKm = radarPoint?.radiusKm ?? 2;

  return (
    <>
      <div className="map-overlay-top-stack">
        <div className="map-top-row">
          {/* Acceso rápido a territorios peninsulares, insulares y capitales */}
          <nav
            className="map-region-bar"
            aria-label="Saltos rápidos por región de España"
          >
            <span className="map-region-bar-label">
              <Compass size={13} aria-hidden="true" />
              Regiones
            </span>
            {SPAIN_REGION_PRESETS.map((preset) => {
              const isCurrent = activeRegionId === preset.id;
              return (
                <button
                  key={preset.id}
                  id={`map-region-${preset.id}`}
                  type="button"
                  className={`map-region-btn${isCurrent ? ' is-active' : ''}`}
                  onClick={() =>
                    onFlyToRegion(preset.lon, preset.lat, preset.zoom, preset.id)
                  }
                  title={`Centrar mapa en ${preset.label}`}
                >
                  {preset.label}
                </button>
              );
            })}
          </nav>

          {/* Herramientas cartográficas: Ubicación GPS, Medición RF y Estilo OpenFreeMap */}
          <div className="map-tools-cluster">
            <button
              id="map-locate-gps-btn"
              type="button"
              className="map-tool-btn"
              onClick={handleGeolocate}
              disabled={isLocating}
              title="Centrar en mi ubicación GPS actual y analizar cobertura cercana"
            >
              {isLocating ? (
                <Loader2 size={15} className="map-spin" aria-hidden="true" />
              ) : (
                <LocateFixed size={15} aria-hidden="true" />
              )}
              <span className="map-tool-btn-label">Mi ubicación</span>
            </button>

            {onToggleRadarMode && (
              <button
                id="map-toggle-radar-btn"
                type="button"
                className={`map-tool-btn${radarModeActive ? ' is-active' : ''}`}
                onClick={onToggleRadarMode}
                aria-pressed={radarModeActive}
                title="Activar medición haciendo clic en cualquier punto del mapa"
              >
                <Crosshair size={15} aria-hidden="true" />
                <span className="map-tool-btn-label">Medir en mapa</span>
              </button>
            )}

            <div className="map-style-switcher-wrap" ref={stylePopoverRef}>
              <button
                id="map-style-switcher-btn"
                type="button"
                className={`map-tool-btn${styleMenuOpen ? ' is-active' : ''}`}
                onClick={() => setStyleMenuOpen((prev) => !prev)}
                aria-haspopup="listbox"
                aria-expanded={styleMenuOpen}
                title="Cambiar estilo cartográfico de OpenFreeMap"
              >
                <Layers size={15} aria-hidden="true" />
                <span className="map-tool-btn-label">{currentStyle.label}</span>
                <ChevronDown size={13} aria-hidden="true" />
              </button>

              {styleMenuOpen && (
                <div
                  className="map-style-popover"
                  role="listbox"
                  aria-label="Estilos de mapa OpenFreeMap"
                >
                  <div className="map-style-popover-header">
                    Cartografía OpenFreeMap
                  </div>
                  {OPENFREEMAP_STYLES.map((option) => {
                    const selected = option.id === styleId;
                    return (
                      <button
                        key={option.id}
                        id={`map-style-option-${option.id}`}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`map-style-option${selected ? ' is-selected' : ''}`}
                        onClick={() => {
                          onStyleChange(option.id);
                          setStyleMenuOpen(false);
                        }}
                      >
                        <span
                          className="map-style-swatch"
                          data-style={option.id}
                          aria-hidden="true"
                        />
                        <span className="map-style-option-body">
                          <span className="map-style-option-title">
                            {option.label}
                          </span>
                          <span className="map-style-option-desc">
                            {option.description}
                          </span>
                        </span>
                        {selected && (
                          <Check
                            size={15}
                            className="map-style-check"
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Banner indicador del modo medición RF o punto de cobertura activo */}
        {(radarModeActive || radarPoint) && (
          <div className="map-radar-banner" role="status" aria-live="polite">
            <span className="map-radar-pulse" aria-hidden="true" />
            <span className="map-radar-banner-text">
              {radarModeActive && !radarPoint
                ? 'Modo medición activo · Haz clic en cualquier punto del mapa para fijar el radar de cobertura'
                : radarModeActive
                  ? `${radarPoint?.label ?? 'Punto activo'} · Haz clic en el mapa para reubicar o en una antena para trazar enlace`
                  : `${radarPoint?.label ?? 'Radar de cobertura'} (${radarPoint?.lat.toFixed(4)}, ${radarPoint?.lon.toFixed(4)})`}
            </span>

            {losMetrics && (
              <span
                className="map-radar-telemetry"
                title="Distancia y acimut hacia la estación seleccionada"
              >
                Enlace: {losMetrics.distanceFormatted} · {losMetrics.cardinal}
              </span>
            )}

            {radarPoint && onRadarPointChange && (
              <div
                className="map-radar-radii"
                role="group"
                aria-label="Radio de cobertura del radar"
              >
                {RADAR_RADIUS_OPTIONS_KM.map((km) => (
                  <button
                    key={km}
                    type="button"
                    className={`map-radius-chip${activeRadiusKm === km ? ' is-active' : ''}`}
                    onClick={() =>
                      onRadarPointChange({
                        ...radarPoint,
                        radiusKm: km,
                      })
                    }
                  >
                    {km} km
                  </button>
                ))}
              </div>
            )}

            {radarPoint && onRadarPointChange && (
              <button
                id="map-clear-radar-point-btn"
                type="button"
                className="map-radar-close-btn"
                onClick={() => onRadarPointChange(null)}
                title="Borrar punto de análisis del mapa"
              >
                <X size={12} aria-hidden="true" />
                Borrar pin
              </button>
            )}

            {radarModeActive && onToggleRadarMode && (
              <button
                id="map-exit-radar-mode-btn"
                type="button"
                className="map-radar-close-btn"
                onClick={onToggleRadarMode}
                title="Desactivar modo medición en mapa"
              >
                <X size={12} aria-hidden="true" />
                Salir
              </button>
            )}
          </div>
        )}

        {geoError && (
          <div className="map-geo-alert" role="alert">
            <span>{geoError}</span>
          </div>
        )}
      </div>

      {/* Leyenda inferior izquierda compacta y colapsable por operador */}
      <aside
        className={`map-legend-card${legendCollapsed ? ' is-collapsed' : ''}`}
        aria-label="Leyenda de operadores móviles"
      >
        <button
          id="map-legend-toggle-btn"
          type="button"
          className="map-legend-header"
          onClick={() => setLegendCollapsed((prev) => !prev)}
          aria-expanded={!legendCollapsed}
        >
          <span className="map-legend-header-main">
            <span className="map-legend-title-row">
              <Radio size={13} aria-hidden="true" />
              Operadores
            </span>
            <span className="map-legend-subtitle">
              {antenas.length.toLocaleString('es-ES')} estaciones en vista
            </span>
          </span>
          {legendCollapsed ? (
            <ChevronUp
              size={15}
              className="map-legend-chevron"
              aria-hidden="true"
            />
          ) : (
            <ChevronDown
              size={15}
              className="map-legend-chevron"
              aria-hidden="true"
            />
          )}
        </button>

        {!legendCollapsed && (
          <div className="map-legend-list">
            {OPERATOR_ORDER.map((op) => {
              const meta = OPERATOR_META[op];
              const isActive = activeOperatorSet.has(op);
              const count = operatorCounts[op] ?? 0;

              return (
                <button
                  key={op}
                  id={`map-legend-op-${op}`}
                  type="button"
                  className={`map-legend-item${isActive ? '' : ' is-inactive'}`}
                  onClick={() => onToggleOperator?.(op)}
                  disabled={!onToggleOperator}
                  aria-pressed={isActive}
                  title={
                    onToggleOperator
                      ? `${isActive ? 'Ocultar' : 'Mostrar'} ${meta.name}`
                      : meta.name
                  }
                >
                  <span className="map-legend-item-left">
                    <span
                      className="map-legend-dot"
                      style={{ backgroundColor: meta.color }}
                      aria-hidden="true"
                    />
                    <span className="map-legend-name">{meta.shortName}</span>
                  </span>
                  <span className="map-legend-count">
                    {isActive ? count.toLocaleString('es-ES') : 'Oculto'}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </aside>
    </>
  );
}
