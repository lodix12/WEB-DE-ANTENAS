import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Layers,
  Loader2,
  LocateFixed,
  Lock,
  LockOpen,
  Radio,
  Ruler,
} from 'lucide-react';
import {
  OPENFREEMAP_STYLES,
  type OpenFreeMapStyleOption,
} from '../../types/antena';
import type { MeasurePoint } from '../../types/map';

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
  onFlyToRegion,
}: MapOverlaysProps) {
  const [styleMenuOpen, setStyleMenuOpen] = useState(false);
  const [isLocating, setIsLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  const stylePopoverRef = useRef<HTMLDivElement | null>(null);

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

  return (
    <div className="map-overlay-top-stack">
      <div className="map-top-row">
        {/* Herramientas cartográficas: Ubicación GPS, Medición 2 puntos, Bandas en mapa y Estilo OpenFreeMap + Bloqueo 3D */}
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
                  ? 'Limpiar medición activa y desactivar regla (Esc)'
                  : 'Medir distancia seleccionando 2 puntos en el mapa (Punto A y Punto B)'
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
                  ? 'Ocultar las etiquetas de bandas de frecuencia en el mapa'
                  : 'Mostrar directamente las bandas de frecuencia que emite cada antena sin hacer clic'
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
              className={`map-tool-btn${styleMenuOpen ? ' is-active' : ''}`}
              onClick={() => setStyleMenuOpen((prev) => !prev)}
              aria-haspopup="dialog"
              aria-expanded={styleMenuOpen}
              title="Cambiar estilo cartográfico y opciones de vista del mapa"
            >
              <Layers size={15} aria-hidden="true" />
              <span className="map-tool-btn-label">{currentStyle.label}</span>
              <ChevronDown size={13} aria-hidden="true" />
            </button>

            {styleMenuOpen && (
              <div
                className="map-style-popover"
                role="dialog"
                aria-label="Opciones de cartografía y vista del mapa"
              >
                <div className="map-style-popover-header">
                  Cartografía OpenFreeMap
                </div>

                <div
                  className="map-style-options-list"
                  role="listbox"
                  aria-label="Estilos de mapa OpenFreeMap"
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

                {onToggleShowBandsOnMap && (
                  <>
                    <div
                      className="map-style-popover-divider"
                      role="separator"
                    />
                    <button
                      id="map-show-bands-option"
                      type="button"
                      role="switch"
                      aria-checked={showBandsOnMap}
                      className={`map-lock-3d-option${showBandsOnMap ? ' is-locked' : ''}`}
                      onClick={() => onToggleShowBandsOnMap()}
                    >
                      <span className="map-lock-3d-icon" aria-hidden="true">
                        <Radio size={14} strokeWidth={2.2} />
                      </span>
                      <span className="map-style-option-body">
                        <span className="map-style-option-title">
                          Mostrar bandas en antenas
                        </span>
                        <span className="map-style-option-desc">
                          Ver frecuencias emitidas sin hacer clic
                        </span>
                      </span>
                      <span
                        className={`map-lock-3d-switch${showBandsOnMap ? ' is-on' : ''}`}
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
