import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Compass,
  Layers,
  Loader2,
  LocateFixed,
  Radio,
  RotateCcw,
  Ruler,
  Trash2,
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
import type { MeasurePoint, RadarPoint } from '../../types/map';
import {
  SPAIN_REGION_PRESETS,
  bearingToCardinal,
  calculateBearingDeg,
  formatDistance,
  haversineDistanceKm,
} from '../../utils/geo';

const RADAR_RADIUS_OPTIONS_KM = [1, 2, 5, 10] as const;
const EMPTY_MEASURE_POINTS: MeasurePoint[] = [];

export interface MapOverlaysProps {
  antenas: AntennaRecord[];
  selectedAntenna: AntennaRecord | null;
  styleId: OpenFreeMapStyleOption['id'];
  onStyleChange: (styleId: OpenFreeMapStyleOption['id']) => void;
  radarPoint?: RadarPoint | null;
  onRadarPointChange?: (point: RadarPoint | null) => void;
  radarModeActive?: boolean;
  onToggleRadarMode?: () => void;
  measurePoints?: MeasurePoint[];
  onMeasurePointsChange?: (points: MeasurePoint[]) => void;
  measureModeActive?: boolean;
  onToggleMeasureMode?: () => void;
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
  measurePoints = EMPTY_MEASURE_POINTS,
  onMeasurePointsChange,
  measureModeActive,
  onToggleMeasureMode,
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

  const toggleMeasureAction = onToggleMeasureMode ?? onToggleRadarMode;
  const isMeasureActive = measureModeActive ?? radarModeActive;

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

  const measureMetrics = useMemo(() => {
    if (measurePoints.length < 2) {
      return null;
    }
    const [pA, pB] = measurePoints;
    const distanceKm = haversineDistanceKm(pA.lat, pA.lon, pB.lat, pB.lon);
    const distanceMeters = distanceKm * 1000;
    const bearingDeg = calculateBearingDeg(pA.lat, pA.lon, pB.lat, pB.lon);

    let primaryLabel: string;
    let secondaryLabel: string | null = null;

    if (distanceMeters < 100) {
      primaryLabel = `${distanceMeters.toLocaleString('es-ES', {
        minimumFractionDigits: distanceMeters < 10 ? 2 : 1,
        maximumFractionDigits: distanceMeters < 10 ? 2 : 1,
      })} m`;
    } else if (distanceKm < 1) {
      primaryLabel = `${Math.round(distanceMeters).toLocaleString('es-ES')} m`;
      secondaryLabel = `${distanceKm.toLocaleString('es-ES', {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3,
      })} km`;
    } else {
      primaryLabel = formatDistance(distanceKm);
      secondaryLabel = `${Math.round(distanceMeters).toLocaleString('es-ES')} m`;
    }

    return {
      primaryLabel,
      secondaryLabel,
      bearingDeg,
      cardinal: bearingToCardinal(bearingDeg),
    };
  }, [measurePoints]);

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
            <span
              className="map-region-bar-label"
              title="Saltos rápidos por región"
            >
              <Compass size={13} aria-hidden="true" />
              <span className="map-region-bar-label-text">Regiones</span>
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

            {toggleMeasureAction && (
              <button
                id="map-toggle-radar-btn"
                type="button"
                className={`map-tool-btn${isMeasureActive ? ' is-active' : ''}`}
                onClick={toggleMeasureAction}
                aria-pressed={isMeasureActive}
                title="Medir distancia seleccionando 2 puntos en el mapa (Punto A y Punto B)"
              >
                <Ruler size={15} aria-hidden="true" />
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

        {/* Tarjeta flotante de medición de distancia entre 2 puntos (Punto A y Punto B) */}
        {(isMeasureActive || measurePoints.length > 0) && (
          <div
            className="map-measure-banner"
            role="status"
            aria-live="polite"
          >
            {measurePoints.length === 0 && (
              <div className="map-measure-row">
                <span className="map-measure-pulse" aria-hidden="true" />
                <span className="map-measure-step-text">
                  <strong>Selecciona el Punto A en el mapa</strong> · Haz clic
                  sobre cualquier ubicación o antena
                </span>
                {toggleMeasureAction && (
                  <button
                    id="map-cancel-measure-btn"
                    type="button"
                    className="map-radar-close-btn"
                    onClick={toggleMeasureAction}
                  >
                    <X size={12} aria-hidden="true" />
                    Cancelar
                  </button>
                )}
              </div>
            )}

            {measurePoints.length === 1 && (
              <div className="map-measure-row">
                <span className="map-measure-pin-badge">A</span>
                <span className="map-measure-step-text">
                  <strong>Punto A fijado</strong> · Selecciona el Punto B en el
                  mapa
                </span>
                <span className="map-measure-coord-chip">
                  {measurePoints[0].label
                    ? `${measurePoints[0].label} (${measurePoints[0].lat.toFixed(5)}, ${measurePoints[0].lon.toFixed(5)})`
                    : `${measurePoints[0].lat.toFixed(5)}, ${measurePoints[0].lon.toFixed(5)}`}
                </span>
                {onMeasurePointsChange && (
                  <button
                    id="map-clear-measure-a-btn"
                    type="button"
                    className="map-radar-close-btn"
                    onClick={() => onMeasurePointsChange([])}
                    title="Borrar Punto A"
                  >
                    <Trash2 size={12} aria-hidden="true" />
                    Borrar
                  </button>
                )}
                <button
                  id="map-close-measure-1-btn"
                  type="button"
                  className="map-radar-close-btn"
                  onClick={() => {
                    onMeasurePointsChange?.([]);
                    if (isMeasureActive) {
                      toggleMeasureAction?.();
                    }
                  }}
                >
                  <X size={12} aria-hidden="true" />
                  Cerrar
                </button>
              </div>
            )}

            {measurePoints.length >= 2 && measureMetrics && (
              <div className="map-measure-result">
                <div className="map-measure-row">
                  <span className="map-measure-label-tag">
                    <Ruler size={13} aria-hidden="true" />
                    Distancia A → B
                  </span>
                  <span className="map-measure-distance-main">
                    {measureMetrics.primaryLabel}
                  </span>
                  {measureMetrics.secondaryLabel && (
                    <span className="map-measure-distance-sub">
                      ({measureMetrics.secondaryLabel})
                    </span>
                  )}
                  <span
                    className="map-measure-bearing-pill"
                    title="Acimut geodésico desde Punto A hacia Punto B"
                  >
                    Rumbo {Math.round(measureMetrics.bearingDeg)}° ·{' '}
                    {measureMetrics.cardinal}
                  </span>

                  <div className="map-measure-actions">
                    <button
                      id="map-new-measure-btn"
                      type="button"
                      className="map-measure-action-btn"
                      onClick={() => {
                        onMeasurePointsChange?.([]);
                        if (!isMeasureActive) {
                          toggleMeasureAction?.();
                        }
                      }}
                      title="Borrar puntos actuales y seleccionar nuevos Punto A y Punto B"
                    >
                      <RotateCcw size={12} aria-hidden="true" />
                      Nueva medición
                    </button>
                    <button
                      id="map-close-measure-btn"
                      type="button"
                      className="map-radar-close-btn"
                      onClick={() => {
                        onMeasurePointsChange?.([]);
                        if (isMeasureActive) {
                          toggleMeasureAction?.();
                        }
                      }}
                      title="Cerrar herramienta de medición"
                    >
                      <X size={12} aria-hidden="true" />
                      Cerrar
                    </button>
                  </div>
                </div>

                <div className="map-measure-endpoints">
                  <span className="map-measure-endpoint-item">
                    <span className="map-measure-pin-badge is-sm">A</span>
                    <span className="map-measure-coord-mono">
                      {measurePoints[0].label
                        ? `${measurePoints[0].label} (${measurePoints[0].lat.toFixed(5)}, ${measurePoints[0].lon.toFixed(5)})`
                        : `${measurePoints[0].lat.toFixed(5)}, ${measurePoints[0].lon.toFixed(5)}`}
                    </span>
                  </span>
                  <span className="map-measure-arrow" aria-hidden="true">
                    →
                  </span>
                  <span className="map-measure-endpoint-item">
                    <span className="map-measure-pin-badge is-sm">B</span>
                    <span className="map-measure-coord-mono">
                      {measurePoints[1].label
                        ? `${measurePoints[1].label} (${measurePoints[1].lat.toFixed(5)}, ${measurePoints[1].lon.toFixed(5)})`
                        : `${measurePoints[1].lat.toFixed(5)}, ${measurePoints[1].lon.toFixed(5)}`}
                    </span>
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Banner indicador del punto de cobertura GPS / Radar RF activo */}
        {(radarPoint ||
          (radarModeActive && onToggleMeasureMode !== undefined)) && (
          <div className="map-radar-banner" role="status" aria-live="polite">
            <span className="map-radar-pulse" aria-hidden="true" />
            <span className="map-radar-banner-text">
              {radarModeActive && !radarPoint
                ? 'Modo radar activo · Haz clic en el mapa para fijar el centro de cobertura'
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

            {radarModeActive &&
              onToggleMeasureMode !== undefined &&
              onToggleRadarMode && (
                <button
                  id="map-exit-radar-mode-btn"
                  type="button"
                  className="map-radar-close-btn"
                  onClick={onToggleRadarMode}
                  title="Desactivar modo radar en mapa"
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

            <div
              className="map-legend-multi-note"
              title="Las estaciones de distintos operadores situadas a menos de 5 metros se agrupan en un único marcador multicolor con los colores de cada operador integrado"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                className="map-legend-multi-icon"
                aria-hidden="true"
              >
                <path
                  d="M12 12 L12 2 A10 10 0 0 1 22 12 Z"
                  fill={OPERATOR_META.movistar.color}
                />
                <path
                  d="M12 12 L22 12 A10 10 0 0 1 12 22 Z"
                  fill={OPERATOR_META.orange.color}
                />
                <path
                  d="M12 12 L12 22 A10 10 0 0 1 2 12 Z"
                  fill={OPERATOR_META.vodafone.color}
                />
                <path
                  d="M12 12 L2 12 A10 10 0 0 1 12 2 Z"
                  fill={OPERATOR_META.masmovil.color}
                />
                <line
                  x1="12"
                  y1="2"
                  x2="12"
                  y2="22"
                  stroke="#FFFFFF"
                  strokeWidth="1.6"
                />
                <line
                  x1="2"
                  y1="12"
                  x2="22"
                  y2="12"
                  stroke="#FFFFFF"
                  strokeWidth="1.6"
                />
                <circle cx="12" cy="12" r="2.2" fill="#FFFFFF" />
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                  fill="none"
                  stroke="#FFFFFF"
                  strokeWidth="2"
                />
              </svg>
              <span>Icono multicolor: operadores a &lt; 5 m</span>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
