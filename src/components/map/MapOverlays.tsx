import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  Check,
  Group,
  Layers,
  Loader2,
  LocateFixed,
  Lock,
  LockOpen,
  Radio,
  RadioTower,
  Ruler,
  Ungroup,
} from 'lucide-react';
import {
  OPENFREEMAP_STYLES,
  type OpenFreeMapStyleOption,
} from '../../types/antena';
import {
  CLUSTERING_LEVEL_OPTIONS,
  DEFAULT_CLUSTERING_LEVEL,
  getClusteringLevelConfig,
  type ClusteringLevel,
  type MeasurePoint,
} from '../../types/map';

const EMPTY_MEASURE_POINTS: MeasurePoint[] = [];

export interface MapOverlaysProps {
  styleId: OpenFreeMapStyleOption['id'];
  onStyleChange: (styleId: OpenFreeMapStyleOption['id']) => void;
  radarModeActive?: boolean;
  onToggleRadarMode?: () => void;
  measurePoints?: MeasurePoint[];
  onMeasurePointsChange?: (points: MeasurePoint[]) => void;
  measureModeActive?: boolean;
  onToggleMeasureMode?: () => void;
  lock3dPitch?: boolean;
  onToggleLock3dPitch?: () => void;
  showBandsOnMap?: boolean;
  onToggleShowBandsOnMap?: () => void;
  clusteringLevel?: ClusteringLevel;
  onClusteringLevelChange?: (level: ClusteringLevel) => void;
  highlightUnicoDeclared?: boolean;
  onToggleHighlightUnicoDeclared?: () => void;
  onFlyToRegion: (
    lon: number,
    lat: number,
    zoom: number,
    presetId?: string,
  ) => void;
}

export function MapOverlays({
  styleId,
  onStyleChange,
  radarModeActive = false,
  onToggleRadarMode,
  measurePoints = EMPTY_MEASURE_POINTS,
  onMeasurePointsChange,
  measureModeActive,
  onToggleMeasureMode,
  lock3dPitch = true,
  onToggleLock3dPitch,
  showBandsOnMap = false,
  onToggleShowBandsOnMap,
  clusteringLevel = DEFAULT_CLUSTERING_LEVEL,
  onClusteringLevelChange,
  highlightUnicoDeclared = true,
  onToggleHighlightUnicoDeclared,
  onFlyToRegion,
}: MapOverlaysProps) {
  const [styleMenuOpen, setStyleMenuOpen] = useState(false);
  const [isLocating, setIsLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  const stylePopoverRef = useRef<HTMLDivElement | null>(null);
  const clusteringBtnRefs = useRef<
    Partial<Record<ClusteringLevel, HTMLButtonElement | null>>
  >({});

  const toggleMeasureAction = onToggleMeasureMode ?? onToggleRadarMode;
  const isMeasureActive = measureModeActive ?? radarModeActive;
  const hasActiveMeasurement =
    Boolean(isMeasureActive) || measurePoints.length > 0;

  const currentStyle = useMemo(
    () =>
      OPENFREEMAP_STYLES.find((option) => option.id === styleId) ??
      OPENFREEMAP_STYLES[0],
    [styleId],
  );

  const currentClusteringOption = useMemo(
    () => getClusteringLevelConfig(clusteringLevel),
    [clusteringLevel],
  );

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

  const handleMeasureButtonClick = () => {
    if (hasActiveMeasurement) {
      onMeasurePointsChange?.([]);
      if (isMeasureActive) {
        toggleMeasureAction?.();
      }
    } else {
      toggleMeasureAction?.();
    }
  };

  const handleClusteringKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % CLUSTERING_LEVEL_OPTIONS.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex =
        (currentIndex - 1 + CLUSTERING_LEVEL_OPTIONS.length) %
        CLUSTERING_LEVEL_OPTIONS.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = CLUSTERING_LEVEL_OPTIONS.length - 1;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      const nextOption = CLUSTERING_LEVEL_OPTIONS[nextIndex];
      onClusteringLevelChange?.(nextOption.id);
      clusteringBtnRefs.current[nextOption.id]?.focus();
    }
  };

  return (
    <div className="map-overlay-top-stack">
      <div className="map-top-row">
        {/* Herramientas cartográficas inferiores derechas: Ubicación GPS, Medición hasta 10 puntos, Bandas en mapa y Estilo OpenFreeMap + Bloqueo 3D */}
        <div className="map-tools-cluster">
          <button
            id="map-locate-gps-btn"
            type="button"
            className="map-tool-btn"
            onClick={handleGeolocate}
            disabled={isLocating}
            title="Centrar mapa en mi ubicación GPS actual"
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
              className={`map-tool-btn${hasActiveMeasurement ? ' is-active' : ''}`}
              onClick={handleMeasureButtonClick}
              aria-pressed={hasActiveMeasurement}
              title={
                hasActiveMeasurement
                  ? 'Desactivar medición y borrar puntos (Esc)'
                  : 'Medir distancia seleccionando hasta 10 puntos en el mapa'
              }
            >
              <Ruler size={15} aria-hidden="true" />
              <span className="map-tool-btn-label">Medir en mapa</span>
            </button>
          )}

          {onToggleShowBandsOnMap && (
            <button
              id="map-toggle-bands-btn"
              type="button"
              className={`map-tool-btn${showBandsOnMap ? ' is-active' : ''}`}
              onClick={() => onToggleShowBandsOnMap()}
              aria-pressed={showBandsOnMap}
              title={
                showBandsOnMap
                  ? 'Ocultar las tarjetas de códigos de banda en el mapa'
                  : 'Mostrar directamente los códigos de banda que emite cada antena sin hacer clic'
              }
            >
              <Radio size={15} aria-hidden="true" />
              <span className="map-tool-btn-label">Mostrar bandas</span>
            </button>
          )}

          <div className="map-style-switcher-wrap" ref={stylePopoverRef}>
            <button
              id="map-style-switcher-btn"
              type="button"
              className={`map-tool-btn map-style-switcher-btn${styleMenuOpen ? ' is-active' : ''}`}
              onClick={() => setStyleMenuOpen((prev) => !prev)}
              aria-haspopup="dialog"
              aria-expanded={styleMenuOpen}
              title="Cambiar estilo cartográfico y opciones de vista del mapa"
            >
              <Layers size={15} aria-hidden="true" />
              <span className="map-tool-btn-label">{currentStyle.label}</span>
            </button>

            {styleMenuOpen && (
              <div
                className="map-style-popover"
                role="dialog"
                aria-label="Opciones de cartografía y vista del mapa"
              >
                <div className="map-style-popover-header">
                  Capas cartográficas
                </div>

                <div
                  className="map-style-options-list"
                  role="listbox"
                  aria-label="Capas cartográficas del mapa"
                >
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
                        title={option.label}
                        onClick={() => {
                          onStyleChange(option.id);
                          setStyleMenuOpen(false);
                        }}
                      >
                        <span
                          className="map-style-swatch"
                          data-style={option.id}
                          aria-hidden="true"
                        >
                          {selected && (
                            <Check
                              size={12}
                              strokeWidth={3}
                              className="map-style-check"
                              aria-hidden="true"
                            />
                          )}
                        </span>
                        <span className="map-style-option-title">
                          {option.label}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div
                  className="map-style-popover-divider"
                  role="separator"
                />
                <div
                  id="map-clustering-level-control"
                  className="map-clustering-control"
                  data-clustering-level={currentClusteringOption.id}
                >
                  <div className="map-clustering-header">
                    <span
                      className="map-lock-3d-icon map-clustering-icon"
                      aria-hidden="true"
                    >
                      {currentClusteringOption.id === 'none' ? (
                        <Ungroup size={15} aria-hidden="true" />
                      ) : (
                        <Group size={15} aria-hidden="true" />
                      )}
                    </span>
                    <span className="map-style-option-body">
                      <span className="map-style-option-title map-style-option-name">
                        Nivel de clustering
                      </span>
                      <span
                        id="map-clustering-level-desc"
                        className="map-style-option-desc"
                      >
                        {currentClusteringOption.description}
                      </span>
                    </span>
                  </div>

                  <div
                    className="map-clustering-segmented"
                    role="radiogroup"
                    aria-label="Nivel de clustering"
                    aria-describedby="map-clustering-level-desc"
                  >
                    {CLUSTERING_LEVEL_OPTIONS.map((option, index) => {
                      const selected = option.id === currentClusteringOption.id;
                      return (
                        <button
                          key={option.id}
                          ref={(node) => {
                            clusteringBtnRefs.current[option.id] = node;
                          }}
                          id={`map-clustering-level-${option.id}`}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          tabIndex={selected ? 0 : -1}
                          className={`map-clustering-segment${selected ? ' is-selected' : ''}`}
                          title={option.description}
                          onClick={() => onClusteringLevelChange?.(option.id)}
                          onKeyDown={(event) =>
                            handleClusteringKeyDown(event, index)
                          }
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {onToggleHighlightUnicoDeclared && (
                  <>
                    <div
                      className="map-style-popover-divider"
                      role="separator"
                    />
                    <button
                      id="map-highlight-unico-option"
                      type="button"
                      role="switch"
                      aria-checked={highlightUnicoDeclared}
                      className={`map-lock-3d-option${highlightUnicoDeclared ? ' is-unico-active' : ''}`}
                      onClick={() => onToggleHighlightUnicoDeclared()}
                    >
                      <span className="map-lock-3d-icon" aria-hidden="true">
                        <RadioTower size={15} aria-hidden="true" />
                      </span>
                      <span className="map-style-option-body">
                        <span className="map-style-option-title map-style-option-name">
                          Resaltar declaradas UNICO 5G
                        </span>
                        <span className="map-style-option-desc">
                          Destacar con aro verde las antenas declaradas en UNICO
                        </span>
                      </span>
                      <span
                        className={`map-lock-3d-switch map-switch-pill${highlightUnicoDeclared ? ' is-on is-unico-on' : ''}`}
                        aria-hidden="true"
                      >
                        <span className="map-lock-3d-switch-thumb" />
                      </span>
                    </button>
                  </>
                )}

                {onToggleLock3dPitch && (
                  <>
                    <div
                      className="map-style-popover-divider"
                      role="separator"
                    />
                    <button
                      id="map-lock-3d-option"
                      type="button"
                      role="switch"
                      aria-checked={lock3dPitch}
                      className={`map-lock-3d-option${lock3dPitch ? ' is-locked' : ''}`}
                      onClick={() => onToggleLock3dPitch()}
                    >
                      <span className="map-lock-3d-icon" aria-hidden="true">
                        {lock3dPitch ? (
                          <Lock size={14} strokeWidth={2.2} />
                        ) : (
                          <LockOpen size={14} strokeWidth={2.2} />
                        )}
                      </span>
                      <span className="map-style-option-body">
                        <span className="map-style-option-title">
                          Bloquear vista 3D / vertical
                        </span>
                        <span className="map-style-option-desc">
                          Mantener plano cenital 2D (0°)
                        </span>
                      </span>
                      <span
                        className={`map-lock-3d-switch${lock3dPitch ? ' is-on' : ''}`}
                        aria-hidden="true"
                      >
                        <span className="map-lock-3d-switch-thumb" />
                      </span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {geoError && (
        <div className="map-geo-alert" role="alert">
          <span>{geoError}</span>
        </div>
      )}
    </div>
  );
}
