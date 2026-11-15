import { useMemo } from 'react';
import { Compass, Navigation, Ruler, X } from 'lucide-react';
import {
  OPERATOR_META,
  type AntennaRecord,
} from '../../types/antena';
import type { MeasurePoint, RadarPoint } from '../../types/map';
import {
  bearingToCardinal,
  calculateBearingDeg,
  findNearestAntennas,
  formatDistance,
  haversineDistanceKm,
} from '../../utils/geo';

const RADIUS_OPTIONS_KM = [0.5, 1, 2, 5, 10] as const;

export interface NearestAntennasCardProps {
  antenas: AntennaRecord[];
  selectedAntenna: AntennaRecord | null;
  onSelectAntenna: (ant: AntennaRecord) => void;
  onFlyToAntenna: (ant: AntennaRecord) => void;
  radarPoint: RadarPoint | null;
  onClearRadar: () => void;
  radarRadiusKm: number;
  onRadiusChange: (radiusKm: number) => void;
  measurePoints: MeasurePoint[];
  onClearMeasurement: () => void;
  onResetMeasurePoints: () => void;
  measureModeActive: boolean;
  onToggleMeasureMode: () => void;
  gpsLoading: boolean;
  gpsError: string | null;
  onRequestGps: () => void;
}

export function NearestAntennasCard({
  antenas,
  selectedAntenna,
  onSelectAntenna,
  onFlyToAntenna,
  radarPoint,
  onClearRadar,
  radarRadiusKm,
  onRadiusChange,
  measurePoints,
  onClearMeasurement,
  onResetMeasurePoints,
  measureModeActive,
  onToggleMeasureMode,
  gpsLoading,
  gpsError,
  onRequestGps,
}: NearestAntennasCardProps) {
  const activeRadius = radarPoint?.radiusKm ?? radarRadiusKm;

  const nearestList = useMemo(() => {
    if (!radarPoint) return [];
    return findNearestAntennas(
      antenas,
      radarPoint.lat,
      radarPoint.lon,
      12,
      activeRadius,
    );
  }, [antenas, radarPoint, activeRadius]);

  const measurementSummary = useMemo(() => {
    if (measurePoints.length < 2) return null;
    const [ptA, ptB] = measurePoints;
    const distKm = haversineDistanceKm(ptA.lat, ptA.lon, ptB.lat, ptB.lon);
    const distMeters = Math.round(distKm * 1000);
    const bearingDeg = calculateBearingDeg(ptA.lat, ptA.lon, ptB.lat, ptB.lon);
    return {
      ptA,
      ptB,
      distKm,
      distMeters,
      formatted: formatDistance(distKm),
      bearingDeg: Math.round(bearingDeg),
      cardinal: bearingToCardinal(bearingDeg),
    };
  }, [measurePoints]);

  return (
    <div className="radar-box">
      <div className="field-label">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Compass size={13} aria-hidden="true" />
          Medición y Radar 4G/5G
        </span>
        {(radarPoint || measurePoints.length > 0) && (
          <button
            type="button"
            className="text-link-btn"
            onClick={() => {
              if (measurePoints.length > 0) onClearMeasurement();
              if (radarPoint) onClearRadar();
            }}
            id="radar-clear-btn"
          >
            Limpiar
          </button>
        )}
      </div>

      <div className="radar-actions-row">
        <button
          type="button"
          id="radar-gps-btn"
          className="btn btn-secondary btn-sm"
          onClick={onRequestGps}
          disabled={gpsLoading}
        >
          <Navigation size={13} aria-hidden="true" />
          <span>{gpsLoading ? 'Localizando…' : 'Usar mi GPS'}</span>
        </button>

        <button
          type="button"
          id="radar-map-pick-btn"
          className={`btn btn-sm ${
            measureModeActive ? 'btn-active' : 'btn-secondary'
          }`}
          onClick={onToggleMeasureMode}
        >
          <Ruler size={13} aria-hidden="true" />
          <span>
            {measureModeActive
              ? measurePoints.length === 1
                ? 'Marca Punto B…'
                : 'Marca Punto A…'
              : 'Medir en mapa'}
          </span>
        </button>
      </div>

      {(measureModeActive || measurePoints.length > 0) && (
        <div
          className="radar-hint-banner"
          role="status"
          style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
        >
          {measurementSummary ? (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                  Distancia A → B:
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    color: 'var(--accent-primary)',
                  }}
                >
                  {measurementSummary.formatted}
                </span>
              </div>
              <div
                className="mono"
                style={{ fontSize: 11, color: 'var(--text-secondary)' }}
              >
                {measurementSummary.distMeters.toLocaleString('es-ES')} m · Rumbo{' '}
                {measurementSummary.bearingDeg}° {measurementSummary.cardinal}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                <button
                  type="button"
                  className="btn btn-subtle btn-sm"
                  onClick={onResetMeasurePoints}
                  style={{ flex: 1 }}
                >
                  Nueva medición
                </button>
                <button
                  type="button"
                  className="btn btn-subtle btn-sm"
                  onClick={onClearMeasurement}
                >
                  Cerrar
                </button>
              </div>
            </>
          ) : measurePoints.length === 1 ? (
            <span>
              <strong>Punto A fijado</strong> (
              <span className="mono">
                {measurePoints[0].lat.toFixed(5)},{' '}
                {measurePoints[0].lon.toFixed(5)}
              </span>
              ). Haz clic en el segundo punto del mapa para calcular la distancia.
            </span>
          ) : (
            <span>
              Selecciona <strong>2 puntos en el mapa</strong> (Punto A y Punto B)
              para calcular la distancia exacta entre ambos.
            </span>
          )}
        </div>
      )}

      <div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            marginBottom: 5,
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>Radio de búsqueda GPS</span>
          <span className="mono">
            {activeRadius < 1
              ? `${activeRadius * 1000} m`
              : `${activeRadius} km`}
          </span>
        </div>
        <div className="radius-selector" role="group" aria-label="Radio de búsqueda">
          {RADIUS_OPTIONS_KM.map((km) => {
            const label = km < 1 ? `${km * 1000} m` : `${km} km`;
            return (
              <button
                key={km}
                type="button"
                className={`radius-pill ${
                  activeRadius === km ? 'is-selected' : ''
                }`}
                onClick={() => onRadiusChange(km)}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {gpsError && (
        <div className="radar-error-msg" role="alert">
          {gpsError}
        </div>
      )}

      {radarPoint ? (
        <>
          <div className="radar-active-readout">
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 600,
                  fontSize: 11.5,
                  color: 'var(--text-secondary)',
                }}
              >
                {radarPoint.label ?? 'Punto de referencia activo'}
              </div>
              <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                {radarPoint.lat.toFixed(5)}, {radarPoint.lon.toFixed(5)}
              </div>
            </div>
            <button
              type="button"
              className="search-clear-btn"
              style={{ position: 'static' }}
              onClick={onClearRadar}
              aria-label="Borrar punto de radar"
              title="Borrar punto de radar"
            >
              <X size={14} />
            </button>
          </div>

          {nearestList.length === 0 ? (
            <div
              style={{
                padding: '12px 10px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-subtle)',
                fontSize: 12,
                color: 'var(--text-muted)',
                textAlign: 'center',
              }}
            >
              No hay estaciones visibles en un radio de{' '}
              <strong className="mono">{activeRadius} km</strong>. Amplía el
              radio o activa más operadores.
            </div>
          ) : (
            <div className="nearest-list" role="list">
              {nearestList.map((item) => {
                const meta = OPERATOR_META[item.op];
                const isSelected = selectedAntenna?.id === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="listitem"
                    className={`nearest-item ${isSelected ? 'is-selected' : ''}`}
                    onClick={() => {
                      onSelectAntenna(item);
                      onFlyToAntenna(item);
                    }}
                  >
                    <div className="nearest-item-main">
                      <div className="nearest-item-top">
                        <span
                          className="operator-dot"
                          style={{ backgroundColor: meta.color }}
                          aria-hidden="true"
                        />
                        <span>{meta.shortName}</span>
                        <span
                          className="mono"
                          style={{
                            fontSize: 11,
                            fontWeight: 500,
                            color: 'var(--text-muted)',
                          }}
                        >
                          #{item.gid}
                        </span>
                      </div>
                      <div className="nearest-item-addr">
                        {item.dir ? `${item.dir} · ${item.mun}` : item.mun}
                      </div>
                    </div>

                    <div className="nearest-item-rf">
                      <span className="nearest-dist">
                        {formatDistance(item.distanceKm)}
                      </span>
                      <span
                        className="nearest-bearing"
                        title={`Orientar antena hacia ${item.cardinal}`}
                      >
                        <svg
                          width="11"
                          height="11"
                          viewBox="0 0 16 16"
                          fill="none"
                          style={{
                            transform: `rotate(${Math.round(item.bearingDeg)}deg)`,
                            flexShrink: 0,
                          }}
                          aria-hidden="true"
                        >
                          <path
                            d="M8 2L12.5 13L8 10.4L3.5 13L8 2Z"
                            fill="currentColor"
                          />
                        </svg>
                        <span>{item.cardinal.replace(/[()]/g, '')}</span>
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>
          Calcula las estaciones más próximas y el rumbo de brújula exacto
          (acimut) para orientar routers y antenas exteriores 4G/5G rurales.
        </p>
      )}
    </div>
  );
}
