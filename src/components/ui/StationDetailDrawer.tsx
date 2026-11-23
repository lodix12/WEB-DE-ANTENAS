import { useMemo, useState } from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  Layers,
  Radio,
  X,
} from 'lucide-react';
import {
  compareFrequencyRanges,
  normalizeAntennaBandsList,
} from '../../hooks/useAntenasData';
import {
  getDetalleEstacionUrl,
  OPERATOR_META,
  type AntennaRecord,
} from '../../types/antena';
import {
  MULTI_OPERATOR_SITE_MAX_DISTANCE_METERS,
  findNearestAntennas,
  groupColocatedAntennasForMap,
} from '../../utils/geo';

function formatFrequencyRangeEntry(raw: string): {
  rangeLabel: string;
  spanLabel: string | null;
} {
  const trimmed = raw.trim();
  const match =
    /^(\d+(?:[.,]\d+)?)\s*-\s*(\d+(?:[.,]\d+)?)(?:\s*[mg]hz)?$/i.exec(trimmed);
  if (!match) {
    if (/^2[67](?:[.,]\d+)?(?:\s*[mg]hz)?$/i.test(trimmed) || /ghz$/i.test(trimmed)) {
      const clean = trimmed.replace(/\s*[mg]hz$/i, '');
      return { rangeLabel: `${clean} GHz`, spanLabel: null };
    }
    const rangeLabel = /mhz$/i.test(trimmed) ? trimmed : `${trimmed} MHz`;
    return { rangeLabel, spanLabel: null };
  }

  const start = Number(match[1].replace(',', '.'));
  const end = Number(match[2].replace(',', '.'));
  const cleanRange = trimmed.replace(/\s*[mg]hz$/i, '');
  const isMmWaveOrGhz =
    (start >= 24 && end <= 29.5) || (/ghz/i.test(trimmed) && end < 100);
  const rangeLabel = isMmWaveOrGhz ? `${cleanRange} GHz` : `${cleanRange} MHz`;

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { rangeLabel, spanLabel: null };
  }

  const bwMhz = isMmWaveOrGhz
    ? Math.round((end - start) * 1000 * 100) / 100
    : Math.round((end - start) * 100) / 100;
  return {
    rangeLabel,
    spanLabel: `${bwMhz.toLocaleString('es-ES', {
      minimumFractionDigits: Number.isInteger(bwMhz) ? 0 : 1,
      maximumFractionDigits: 2,
    })} MHz`,
  };
}

export interface StationDetailDrawerProps {
  antenna: AntennaRecord | null;
  allAntenas: AntennaRecord[];
  onClose: () => void;
  onSelectAntenna: (ant: AntennaRecord) => void;
}

export function StationDetailDrawer({
  antenna,
  allAntenas,
  onClose,
  onSelectAntenna,
}: StationDetailDrawerProps) {
  const [copiedCoords, setCopiedCoords] = useState(false);

  const integratedSite = useMemo(() => {
    if (!antenna || allAntenas.length === 0) return null;
    const nearby = findNearestAntennas(
      allAntenas,
      antenna.lat,
      antenna.lon,
      200,
      0.15,
    );
    const candidates: AntennaRecord[] = nearby.some(
      (item) => item.id === antenna.id,
    )
      ? nearby
      : [antenna, ...nearby];
    const sites = groupColocatedAntennasForMap(
      candidates,
      MULTI_OPERATOR_SITE_MAX_DISTANCE_METERS,
    );
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

  const sortedBands = useMemo(() => {
    if (!antenna?.bandas) return null;
    return normalizeAntennaBandsList(antenna.bandas);
  }, [antenna]);

  const sortedFreqEntries = useMemo(() => {
    if (!antenna?.frecuencias || antenna.frecuencias.length === 0) return [];
    const seen = new Set<string>();
    const entries: Array<{ rangeLabel: string; spanLabel: string | null }> = [];
    const sorted = [...antenna.frecuencias].sort(compareFrequencyRanges);
    for (let i = 0; i < sorted.length; i++) {
      const formatted = formatFrequencyRangeEntry(sorted[i]);
      if (!seen.has(formatted.rangeLabel)) {
        seen.add(formatted.rangeLabel);
        entries.push(formatted);
      }
    }
    return entries;
  }, [antenna]);

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
        {/* Operadores integrados en el mismo icono multicolor (< 15 m) */}
        {integratedSite && (
          <section
            className="integrated-operators-card"
            aria-label={`Operadores integrados en este icono (< ${MULTI_OPERATOR_SITE_MAX_DISTANCE_METERS} m)`}
          >
            <div className="integrated-operators-head">
              <span className="integrated-operators-title">
                <Layers size={13} aria-hidden="true" />
                <span>Operadores integrados en este icono (&lt; {MULTI_OPERATOR_SITE_MAX_DISTANCE_METERS} m)</span>
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

        {/* Bandas y Frecuencias Asignadas */}
        <section
          className="station-bands-card"
          aria-label="Bandas y Frecuencias Asignadas"
        >
          <div className="station-bands-head">
            <span className="station-bands-title">
              <Radio size={13} aria-hidden="true" />
              <span>Bandas y Frecuencias Asignadas</span>
            </span>
            <span className="colocation-count-pill">
              {sortedBands && sortedBands.length > 0
                ? `${sortedBands.length} ${sortedBands.length === 1 ? 'banda' : 'bandas'}`
                : sortedBands !== null
                  ? 'Sin detalle'
                  : 'Sinc. incremental'}
            </span>
          </div>

          {sortedBands && sortedBands.length > 0 ? (
            <div className="station-bands-content">
              <div
                className="station-band-chips"
                aria-label="Bandas comerciales activas"
              >
                {sortedBands.map((band) => (
                  <span key={band} className="station-band-chip mono">
                    {band}
                  </span>
                ))}
              </div>

              {sortedFreqEntries.length > 0 && (
                <div
                  className="station-freq-table"
                  role="table"
                  aria-label="Rangos exactos de frecuencias asignadas"
                >
                  <div className="station-freq-thead" role="row">
                    <span role="columnheader">Rango Asignado</span>
                    <span role="columnheader">Bloque</span>
                  </div>
                  {sortedFreqEntries.map((entry) => (
                    <div
                      key={entry.rangeLabel}
                      className="station-freq-row"
                      role="row"
                    >
                      <span className="mono station-freq-range" role="cell">
                        {entry.rangeLabel}
                      </span>
                      <span className="mono station-freq-span" role="cell">
                        {entry.spanLabel ?? '—'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : sortedBands !== null ? (
            <div className="station-bands-content">
              <p className="station-bands-empty">
                Sin concesiones de banda detalladas en ficha oficial
              </p>
              {sortedFreqEntries.length > 0 && (
                <div
                  className="station-freq-table"
                  role="table"
                  aria-label="Rangos exactos de frecuencias asignadas"
                >
                  {sortedFreqEntries.map((entry) => (
                    <div
                      key={entry.rangeLabel}
                      className="station-freq-row"
                      role="row"
                    >
                      <span className="mono station-freq-range" role="cell">
                        {entry.rangeLabel}
                      </span>
                      <span className="mono station-freq-span" role="cell">
                        {entry.spanLabel ?? '—'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="station-bands-pending">
              <p>
                Frecuencias en cola de sincronización incremental desde MINETUR.
                Puedes consultarlas en tiempo real en la ficha oficial{' '}
                <a
                  href={mineturUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mono"
                >
                  detalleEstacion.do?emplazamiento={antenna.gid}
                </a>
                .
              </p>
            </div>
          )}
        </section>

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
                Declaraciones Fusionadas (&lt; 35 m) ·{' '}
                {antenna.mergedGids.length} expedientes
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
              Consultar niveles de exposición y bandas en MINETUR
            </span>
            <ExternalLink size={15} style={{ flexShrink: 0 }} aria-hidden="true" />
          </a>
          <p style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.4 }}>
            Abre la ficha oficial del Ministerio para la Transformación Digital
            con las bandas activas (700 MHz–26 GHz) y mediciones certificadas en
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
