import { useMemo, useState } from 'react';
import {
  Check,
  Compass,
  Copy,
  Crosshair,
  ExternalLink,
  Layers,
  X,
} from 'lucide-react';
import {
  getDetalleEstacionUrl,
  OPERATOR_META,
  type AntennaRecord,
} from '../../types/antena';
import type { RadarPoint } from '../../types/map';
import {
  bearingToCardinal,
  calculateBearingDeg,
  findNearestAntennas,
  formatDistance,
  groupColocatedAntennasForMap,
  haversineDistanceKm,
} from '../../utils/geo';

export interface StationDetailDrawerProps {
  antenna: AntennaRecord | null;
  allAntenas: AntennaRecord[];
  radarPoint: RadarPoint | null;
  onClose: () => void;
  onSelectAntenna: (ant: AntennaRecord) => void;
  onSetRadarAtStation: (ant: AntennaRecord) => void;
}

export function StationDetailDrawer({
  antenna,
  allAntenas,
  radarPoint,
  onClose,
  onSelectAntenna,
  onSetRadarAtStation,
}: StationDetailDrawerProps) {
  const [copiedCoords, setCopiedCoords] = useState(false);

  const integratedSite = useMemo(() => {
    if (!antenna || allAntenas.length === 0) return null;
    const nearby = findNearestAntennas(
      allAntenas,
      antenna.lat,
      antenna.lon,
      40,
      0.05,
    );
    const candidates: AntennaRecord[] = nearby.some(
      (item) => item.id === antenna.id,
    )
      ? nearby
      : [antenna, ...nearby];
    const sites = groupColocatedAntennasForMap(candidates, 5);
    return (
      sites.find(
        (site) =>
          site.isMultiOperator &&
          (site.memberIds.includes(antenna.id) ||
            site.members.some((member) => member.id === antenna.id)),
      ) ?? null
    );
  }, [antenna, allAntenas]);

  const colocatedStations = useMemo(() => {
    if (!antenna || allAntenas.length === 0) return [];
    // Buscar otras estaciones a menos de 100 metros (0.1 km)
    const nearby = findNearestAntennas(
      allAntenas,
      antenna.lat,
      antenna.lon,
      25,
      0.1,
    );
    return nearby.filter((item) => item.id !== antenna.id);
  }, [antenna, allAntenas]);

  const radarVector = useMemo(() => {
    if (!antenna || !radarPoint) return null;
    const distanceKm = haversineDistanceKm(
      radarPoint.lat,
      radarPoint.lon,
      antenna.lat,
      antenna.lon,
    );
    const bearingDeg = calculateBearingDeg(
      radarPoint.lat,
      radarPoint.lon,
      antenna.lat,
      antenna.lon,
    );
    return {
      distanceKm,
      bearingDeg,
      cardinal: bearingToCardinal(bearingDeg),
    };
  }, [antenna, radarPoint]);

  if (!antenna) return null;

  const meta = OPERATOR_META[antenna.op];
  const coordsText = `${antenna.lat.toFixed(6)}, ${antenna.lon.toFixed(6)}`;
  const mineturUrl = getDetalleEstacionUrl(antenna);
  const osmUrl = `https://www.openstreetmap.org/?mlat=${antenna.lat}&mlon=${antenna.lon}#map=18/${antenna.lat}/${antenna.lon}`;
  const streetViewUrl = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${antenna.lat},${antenna.lon}`;

  async function handleCopyCoords() {
    try {
      await navigator.clipboard.writeText(coordsText);
      setCopiedCoords(true);
      window.setTimeout(() => setCopiedCoords(false), 2000);
    } catch {
      // Ignorar si el portapapeles está restringido
    }
  }

  return (
    <aside
      className="station-drawer"
      aria-label={`Detalle de estación ${antenna.gid}`}
    >
      <div className="drawer-header">
        <div className="drawer-title-group">
          <div>
            <span
              className="operator-badge"
              style={{
                backgroundColor: meta.softBg,
                color: meta.color,
                border: `1px solid ${meta.color}33`,
              }}
            >
              <span
                className="operator-dot"
                style={{ backgroundColor: meta.color }}
                aria-hidden="true"
              />
              {meta.name}
            </span>
          </div>
          <h2 className="drawer-station-title">
            Estación <span className="mono">#{antenna.gid}</span>
          </h2>
          <p className="drawer-legal-name">{antenna.opRaw}</p>
        </div>

        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          id="drawer-close-btn"
          aria-label="Cerrar ficha de estación"
          style={{ padding: '0 8px' }}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="drawer-body">
        {/* Operadores integrados en el mismo icono multicolor (< 5 m) */}
        {integratedSite && (
          <section
            className="integrated-operators-card"
            aria-label="Operadores integrados en este icono (< 5 m)"
          >
            <div className="integrated-operators-head">
              <span className="integrated-operators-title">
                <Layers size={13} aria-hidden="true" />
                <span>Operadores integrados en este icono (&lt; 5 m)</span>
              </span>
              <span className="colocation-count-pill">
                {integratedSite.operators.length} oper.
              </span>
            </div>
            <p className="integrated-operators-sub">
              Selecciona cada operador integrado para consultar su{' '}
              <span className="mono">Gis_ID</span> y abrir su ficha oficial
              MINETUR:
            </p>
            <div
              className="integrated-op-tabs"
              role="tablist"
              aria-label="Seleccionar operador integrado en este emplazamiento"
            >
              {integratedSite.members.map((member) => {
                const mMeta = OPERATOR_META[member.op];
                const isSelectedMember = member.id === antenna.id;
                return (
                  <button
                    key={member.id}
                    type="button"
                    role="tab"
                    aria-selected={isSelectedMember}
                    className={`integrated-op-chip${isSelectedMember ? ' is-active' : ''}`}
                    style={
                      isSelectedMember
                        ? {
                            borderColor: mMeta.color,
                            backgroundColor: mMeta.softBg,
                          }
                        : undefined
                    }
                    onClick={() => onSelectAntenna(member)}
                  >
                    <span
                      className="operator-dot"
                      style={{ backgroundColor: mMeta.color }}
                      aria-hidden="true"
                    />
                    <span>{mMeta.shortName}</span>
                    <span className="integrated-op-gid mono">
                      #{member.gid}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* Vector desde Radar Point (si está activo) */}
        {radarVector && (
          <div className="rf-vector-strip">
            <div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  color: 'var(--accent-primary)',
                }}
              >
                Vector desde tu punto de medición
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  marginTop: 2,
                }}
              >
                Apunta la antena exterior rumbo{' '}
                <strong className="mono">{radarVector.cardinal}</strong>
              </div>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div
                className="mono"
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: 'var(--text-primary)',
                }}
              >
                {formatDistance(radarVector.distanceKm)}
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 11.5,
                  color: 'var(--accent-primary)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <Compass size={12} aria-hidden="true" />
                {Math.round(radarVector.bearingDeg)}°
              </div>
            </div>
          </div>
        )}

        {/* Metadatos Oficiales */}
        <div className="detail-kv-list">
          <div className="detail-kv-row">
            <span className="detail-kv-label">Dirección del Emplazamiento</span>
            <span className="detail-kv-value">
              {antenna.dir || 'Dirección sin especificar en registro'}
            </span>
          </div>

          <div className="detail-kv-row">
            <span className="detail-kv-label">Municipio y Provincia</span>
            <span className="detail-kv-value">
              {antenna.mun}
              {antenna.prov ? ` · ${antenna.prov}` : ''}
            </span>
          </div>

          <div className="detail-kv-row">
            <span className="detail-kv-label">
              Identificador Oficial (Gis_ID / Expediente)
            </span>
            <span className="detail-kv-value mono" style={{ fontSize: 12 }}>
              {antenna.gid} — {antenna.id}
            </span>
          </div>

          {antenna.mergedGids && antenna.mergedGids.length > 1 && (
            <div className="detail-kv-row">
              <span className="detail-kv-label">
                Declaraciones Fusionadas (&lt; 10 m · {antenna.mergedGids.length}{' '}
                expedientes)
              </span>
              <div className="merged-gids-wrap">
                {antenna.mergedGids.map((gid) => (
                  <span key={gid} className="merged-gid-chip mono">
                    #{gid}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="detail-kv-row">
            <span className="detail-kv-label">Coordenadas Exactas (WGS84)</span>
            <div className="coord-box">
              <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>
                {coordsText}
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  id="copy-coords-btn"
                  className="btn btn-subtle btn-sm"
                  onClick={handleCopyCoords}
                >
                  {copiedCoords ? (
                    <>
                      <Check size={12} aria-hidden="true" />
                      <span>¡Copiado!</span>
                    </>
                  ) : (
                    <>
                      <Copy size={12} aria-hidden="true" />
                      <span>Copiar</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  id="set-radar-station-btn"
                  className="btn btn-subtle btn-sm"
                  onClick={() => onSetRadarAtStation(antenna)}
                  title="Centrar el radar de cercanía en este emplazamiento"
                >
                  <Crosshair size={12} aria-hidden="true" />
                  <span>Radar</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Co-emplazamiento (< 100 m) */}
        <section className="colocation-section">
          <div className="colocation-header">
            <span className="colocation-title">
              Co-emplazamiento (&lt; 100 m)
            </span>
            <span className="colocation-count-pill">
              {colocatedStations.length === 0
                ? 'Emplazamiento único'
                : `${colocatedStations.length} compartidas`}
            </span>
          </div>

          {colocatedStations.length === 0 ? (
            <p
              style={{
                fontSize: 12,
                color: 'var(--text-muted)',
                padding: '10px 12px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              No figuran estaciones de otros operadores registradas a menos de
              100 metros de este mástil o azotea.
            </p>
          ) : (
            <div className="nearest-list" role="list">
              {colocatedStations.map((other) => {
                const otherMeta = OPERATOR_META[other.op];
                const meters = Math.round(other.distanceKm * 1000);
                return (
                  <button
                    key={other.id}
                    type="button"
                    role="listitem"
                    className="nearest-item"
                    onClick={() => onSelectAntenna(other)}
                  >
                    <div className="nearest-item-main">
                      <div className="nearest-item-top">
                        <span
                          className="operator-dot"
                          style={{ backgroundColor: otherMeta.color }}
                          aria-hidden="true"
                        />
                        <span>{otherMeta.shortName}</span>
                        <span
                          className="mono"
                          style={{
                            fontSize: 11,
                            fontWeight: 500,
                            color: 'var(--text-muted)',
                          }}
                        >
                          #{other.gid}
                        </span>
                      </div>
                      <div className="nearest-item-addr">{other.opRaw}</div>
                    </div>

                    <div className="nearest-item-rf">
                      <span className="nearest-dist">
                        {meters <= 4 ? 'Misma torre' : `${meters} m`}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* CTA Oficial MINETUR + Enlaces cartográficos externos */}
        <div className="drawer-cta-stack">
          <a
            href={mineturUrl}
            target="_blank"
            rel="noopener noreferrer"
            id="minetur-official-cta"
            className="btn btn-primary minetur-cta-btn"
          >
            <span>
              Consultar niveles de exposición y bandas (MHz) en MINETUR
            </span>
            <ExternalLink size={15} style={{ flexShrink: 0 }} aria-hidden="true" />
          </a>
          <p style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.4 }}>
            Abre la ficha oficial del Ministerio para la Transformación Digital
            con las bandas activas (700–3500 MHz) y mediciones certificadas en
            µW/cm².
          </p>

          <div className="external-map-links">
            <a
              href={streetViewUrl}
              target="_blank"
              rel="noopener noreferrer"
              id="drawer-streetview-link"
              className="btn btn-secondary btn-sm"
            >
              <span>Street View</span>
              <ExternalLink size={12} aria-hidden="true" />
            </a>
            <a
              href={osmUrl}
              target="_blank"
              rel="noopener noreferrer"
              id="drawer-osm-link"
              className="btn btn-secondary btn-sm"
            >
              <span>OpenStreetMap</span>
              <ExternalLink size={12} aria-hidden="true" />
            </a>
          </div>
        </div>
      </div>
    </aside>
  );
}
