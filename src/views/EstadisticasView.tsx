import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ExternalLink, MapPin, Search, X } from 'lucide-react';
import { useAntenasData } from '../hooks/useAntenasData';
import { useWorkspace } from '../hooks/useWorkspace';
import {
  OPERATOR_META,
  OPERATOR_ORDER,
  type OperatorKey,
} from '../types/antena';
import {
  formatDateTimeEs,
  formatRelativeDateEs,
  normalizeSearchText,
} from '../utils/export';

type ProvinceSortMode = 'count' | 'alpha';

function formatPercent(part: number, total: number): string {
  if (total <= 0) return '0,0 %';
  return `${((part / total) * 100).toLocaleString('es-ES', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} %`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins} min ${secs} s`;
}

export function EstadisticasView() {
  const navigate = useNavigate();
  const { derived, isLoading, isError, error } = useAntenasData();
  const {
    setSelectedProvince,
    selectAllOperators,
    toggleOperator,
    activeOperators,
    triggerFlyTo,
  } = useWorkspace();

  const [provQuery, setProvQuery] = useState('');
  const [provSort, setProvSort] = useState<ProvinceSortMode>('count');

  useEffect(() => {
    document.title =
      'Estadísticas del Despliegue Móvil en España · RadioMapa España';
  }, []);

  const operatorRows = useMemo(() => {
    if (!derived) return [];
    const { dataset, operatorCounts } = derived;

    // Respaldo de razones sociales extraídas si no vinieran en el resumen
    const fallbackEntities = new Map<OperatorKey, Set<string>>();
    for (const op of OPERATOR_ORDER) {
      fallbackEntities.set(op, new Set<string>());
    }
    for (let i = 0; i < dataset.antenas.length; i++) {
      const a = dataset.antenas[i];
      if (a.opRaw) {
        fallbackEntities.get(a.op)?.add(a.opRaw);
      }
    }

    return OPERATOR_ORDER.map((opKey) => {
      const summary = dataset.operators?.[opKey];
      const count = operatorCounts[opKey] ?? summary?.count ?? 0;
      const legalEntities =
        summary?.legalEntities && summary.legalEntities.length > 0
          ? summary.legalEntities
          : Array.from(fallbackEntities.get(opKey) ?? []).sort((a, b) =>
              a.localeCompare(b, 'es'),
            );

      return {
        key: opKey,
        meta: OPERATOR_META[opKey],
        count,
        legalEntities,
      };
    }).sort((a, b) => b.count - a.count);
  }, [derived]);

  const filteredProvinces = useMemo(() => {
    if (!derived) return [];
    const norm = normalizeSearchText(provQuery);
    const source =
      provSort === 'alpha' ? derived.provincesByAlpha : derived.provincesByCount;

    if (!norm) return source;
    return source.filter((p) =>
      normalizeSearchText(p.provincia).includes(norm),
    );
  }, [derived, provQuery, provSort]);

  function handleInspectProvinceOnMap(provincia: string) {
    selectAllOperators();
    setSelectedProvince(provincia);
    const centroid = derived?.provinceCentroids.get(provincia);
    if (centroid) {
      triggerFlyTo(centroid.lat, centroid.lon, 8.3);
    }
    void navigate({ to: '/', search: {} });
  }

  function handleFilterSingleOperatorOnMap(targetOp: OperatorKey) {
    // Dejar activo únicamente el operador elegido
    for (const op of OPERATOR_ORDER) {
      const currentlyOn = activeOperators.includes(op);
      if (op === targetOp && !currentlyOn) toggleOperator(op);
      if (op !== targetOp && currentlyOn) toggleOperator(op);
    }
    void navigate({ to: '/', search: {} });
  }

  if (isLoading && !derived) {
    return (
      <main className="page-container">
        <div className="state-center-box">
          <div className="spinner-ring" aria-hidden="true" />
          <p>Calculando indicadores territoriales y cuotas de red…</p>
        </div>
      </main>
    );
  }

  if (isError || !derived) {
    return (
      <main className="page-container">
        <div className="state-center-box">
          <p style={{ color: 'var(--status-danger)', fontWeight: 600 }}>
            {error instanceof Error
              ? error.message
              : 'No se pudieron cargar las estadísticas.'}
          </p>
        </div>
      </main>
    );
  }

  const { dataset, totalUniqueMunicipalities } = derived;
  const maxOperatorCount = operatorRows[0]?.count || 1;
  const { crawlStats } = dataset;

  return (
    <main className="page-container">
      <header className="page-hero">
        <span className="page-eyebrow">Radiografía de Infraestructura RF</span>
        <h1 className="page-h1">
          Estadísticas de Despliegue Móvil en España
        </h1>
        <p className="page-lead">
          Análisis cuantitativo de estaciones base activas por grupo operador,
          entidad concesionaria y distribución territorial en las 50 provincias y
          2 ciudades autónomas según el Registro Oficial de Infoantenas.
        </p>
      </header>

      {/* Franja superior de métricas clave */}
      <section className="metrics-strip" aria-label="Indicadores generales">
        <div className="metric-cell">
          <span className="metric-label">Total Estaciones en España</span>
          <span className="metric-value">
            {dataset.total.toLocaleString('es-ES')}
          </span>
          <span className="metric-sub">
            Emplazamientos únicos deduplicados
          </span>
        </div>

        <div className="metric-cell">
          <span className="metric-label">Provincias y Ciudades Autónomas</span>
          <span className="metric-value">
            {derived.provincesByCount.length.toLocaleString('es-ES')}
          </span>
          <span className="metric-sub">
            Península, Baleares, Canarias, Ceuta y Melilla
          </span>
        </div>

        <div className="metric-cell">
          <span className="metric-label">Municipios con Cobertura</span>
          <span className="metric-value">
            {totalUniqueMunicipalities.toLocaleString('es-ES')}
          </span>
          <span className="metric-sub">
            Términos municipales con estaciones registradas
          </span>
        </div>

        <div className="metric-cell">
          <span className="metric-label">Última Sincronización</span>
          <span
            className="metric-value"
            style={{ fontSize: 'clamp(16px, 1.6vw, 20px)', paddingTop: 4 }}
          >
            {formatDateTimeEs(dataset.updatedAt)}
          </span>
          <span className="metric-sub">
            Actualizado {formatRelativeDateEs(dataset.updatedAt)} · Ciclo 24 h
          </span>
        </div>
      </section>

      {crawlStats?.isPartialSeed && (
        <div className="callout-note" role="note">
          <strong>Nota sobre conjunto de datos inicial:</strong> Este entorno
          contiene una muestra semilla representativa para desarrollo rápido. En
          producción, el flujo diario de GitHub Actions ejecuta el barrido
          completo sobre todo el territorio nacional.
        </div>
      )}

      {/* Distribución por Operador y Razones Sociales */}
      <section className="section-block" aria-labelledby="stats-operators-h2">
        <div className="section-block-header">
          <div>
            <h2 id="stats-operators-h2" className="section-h2">
              Distribución Nacional por Operador y Razón Social
            </h2>
            <p className="section-desc">
              Volumen de estaciones base, cuota sobre el parque nacional y
              sociedades concesionarias agrupadas del registro MINETUR.
            </p>
          </div>
        </div>

        <div className="section-block-body">
          <div className="operator-bars-list">
            {operatorRows.map((row) => {
              const barWidthPct =
                maxOperatorCount > 0
                  ? Math.max((row.count / maxOperatorCount) * 100, row.count > 0 ? 1.2 : 0)
                  : 0;

              return (
                <div key={row.key} className="operator-bar-row">
                  <div className="operator-bar-meta">
                    <div className="operator-bar-title">
                      <span
                        className="operator-dot"
                        style={{
                          backgroundColor: row.meta.color,
                          width: 11,
                          height: 11,
                        }}
                        aria-hidden="true"
                      />
                      <span>{row.meta.name}</span>
                      <button
                        type="button"
                        className="text-link-btn"
                        onClick={() => handleFilterSingleOperatorOnMap(row.key)}
                        title={`Ver únicamente estaciones de ${row.meta.shortName} en el mapa`}
                      >
                        Ver en mapa →
                      </button>
                    </div>

                    <div className="operator-bar-numbers">
                      <span
                        style={{
                          fontSize: 15,
                          fontWeight: 700,
                          color: 'var(--text-primary)',
                        }}
                      >
                        {row.count.toLocaleString('es-ES')}
                      </span>
                      <span
                        style={{
                          fontSize: 12.5,
                          color: 'var(--text-muted)',
                          minWidth: 56,
                          textAlign: 'right',
                        }}
                      >
                        {formatPercent(row.count, dataset.total)}
                      </span>
                    </div>
                  </div>

                  <div className="operator-bar-track" aria-hidden="true">
                    <div
                      className="operator-bar-fill"
                      style={{
                        width: `${barWidthPct}%`,
                        backgroundColor: row.meta.color,
                      }}
                    />
                  </div>

                  {row.legalEntities.length > 0 && (
                    <div className="legal-entities-row">
                      {row.legalEntities.map((entity) => (
                        <span key={entity} className="legal-entity-tag">
                          {entity}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Despliegue por Provincia con Barra Multi-Operador Apilada */}
      <section className="section-block" aria-labelledby="stats-provinces-h2">
        <div className="section-block-header">
          <div>
            <h2 id="stats-provinces-h2" className="section-h2">
              Despliegue Territorial por Provincia
            </h2>
            <p className="section-desc">
              Comparativa provincial con cuota apilada por operador y detección
              de red con mayor presencia local.
            </p>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <div className="search-input-wrap" style={{ width: 220 }}>
              <span className="search-input-icon" aria-hidden="true">
                <Search size={14} />
              </span>
              <input
                id="stats-province-search"
                type="search"
                className="search-input"
                value={provQuery}
                onChange={(e) => setProvQuery(e.target.value)}
                placeholder="Buscar provincia…"
              />
              {provQuery && (
                <button
                  type="button"
                  className="search-clear-btn"
                  onClick={() => setProvQuery('')}
                  aria-label="Limpiar filtro provincial"
                >
                  <X size={13} />
                </button>
              )}
            </div>

            <select
              id="stats-province-sort"
              aria-label="Ordenar provincias"
              className="select-control"
              style={{ width: 190 }}
              value={provSort}
              onChange={(e) => setProvSort(e.target.value as ProvinceSortMode)}
            >
              <option value="count">Ordenar: Mayor número</option>
              <option value="alpha">Ordenar: Alfabético (A–Z)</option>
            </select>
          </div>
        </div>

        <div
          style={{
            padding: '10px 20px',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'var(--bg-surface-subtle)',
          }}
        >
          <div className="legend-inline">
            {OPERATOR_ORDER.map((opKey) => (
              <span key={opKey} className="legend-inline-item">
                <span
                  className="operator-dot"
                  style={{ backgroundColor: OPERATOR_META[opKey].color }}
                  aria-hidden="true"
                />
                <span>{OPERATOR_META[opKey].shortName}</span>
              </span>
            ))}
          </div>
        </div>

        <div className="province-table-wrap">
          <table className="clean-table">
            <thead>
              <tr>
                <th style={{ width: 52 }}>#</th>
                <th>Provincia</th>
                <th style={{ textAlign: 'right' }}>Estaciones</th>
                <th style={{ textAlign: 'right' }}>% Nacional</th>
                <th>Operador Líder</th>
                <th style={{ minWidth: 240 }}>Reparto por Operador</th>
                <th style={{ width: 110 }} />
              </tr>
            </thead>
            <tbody>
              {filteredProvinces.map((prov, index) => {
                // Determinar el operador con mayor presencia en la provincia
                let leadOp: OperatorKey = 'movistar';
                let leadCount = -1;
                for (const opKey of OPERATOR_ORDER) {
                  const c = prov.byOperator[opKey] ?? 0;
                  if (c > leadCount) {
                    leadCount = c;
                    leadOp = opKey;
                  }
                }
                const leadMeta = OPERATOR_META[leadOp];

                return (
                  <tr key={prov.provincia}>
                    <td className="mono" style={{ color: 'var(--text-muted)' }}>
                      {index + 1}
                    </td>
                    <td style={{ fontWeight: 700 }}>{prov.provincia}</td>
                    <td
                      className="mono"
                      style={{ textAlign: 'right', fontWeight: 700 }}
                    >
                      {prov.count.toLocaleString('es-ES')}
                    </td>
                    <td
                      className="mono"
                      style={{ textAlign: 'right', color: 'var(--text-muted)' }}
                    >
                      {formatPercent(prov.count, dataset.total)}
                    </td>
                    <td>
                      {leadCount > 0 && (
                        <span
                          className="operator-badge"
                          style={{
                            backgroundColor: leadMeta.softBg,
                            color: leadMeta.color,
                          }}
                        >
                          <span
                            className="operator-dot"
                            style={{ backgroundColor: leadMeta.color }}
                            aria-hidden="true"
                          />
                          {leadMeta.shortName} ·{' '}
                          <span className="mono">
                            {formatPercent(leadCount, prov.count)}
                          </span>
                        </span>
                      )}
                    </td>
                    <td>
                      <div className="stacked-bar">
                        {OPERATOR_ORDER.map((opKey) => {
                          const c = prov.byOperator[opKey] ?? 0;
                          if (c <= 0 || prov.count <= 0) return null;
                          const pct = (c / prov.count) * 100;
                          const meta = OPERATOR_META[opKey];
                          return (
                            <div
                              key={opKey}
                              className="stacked-bar-seg"
                              style={{
                                width: `${pct}%`,
                                backgroundColor: meta.color,
                              }}
                              title={`${meta.shortName}: ${c.toLocaleString('es-ES')} estaciones (${formatPercent(c, prov.count)})`}
                            />
                          );
                        })}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        className="btn btn-subtle btn-sm"
                        onClick={() => handleInspectProvinceOnMap(prov.provincia)}
                      >
                        <MapPin size={12} aria-hidden="true" />
                        <span>Mapa</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Estado Técnico del Pipeline de Datos */}
      <section className="section-block" aria-labelledby="stats-pipeline-h2">
        <div className="section-block-header">
          <div>
            <h2 id="stats-pipeline-h2" className="section-h2">
              Estado del Pipeline de Sincronización Geográfica
            </h2>
            <p className="section-desc">
              Métricas operativas de la última ejecución del recolector espacial
              contra el Geoportal de Infoantenas.
            </p>
          </div>
          <a
            href={dataset.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary btn-sm"
          >
            <span>Portal Oficial MINETUR</span>
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        </div>

        <div className="metrics-strip" style={{ border: 'none', borderRadius: 0 }}>
          <div className="metric-cell">
            <span className="metric-label">Peticiones HTTP Realizadas</span>
            <span className="metric-value" style={{ fontSize: 22 }}>
              {crawlStats.requestsCount.toLocaleString('es-ES')}
            </span>
            <span className="metric-sub">
              Consultas GeoJSON por caja delimitadora (bbox)
            </span>
          </div>

          <div className="metric-cell">
            <span className="metric-label">Celdas Geográficas Visitadas</span>
            <span className="metric-value" style={{ fontSize: 22 }}>
              {crawlStats.gridBoxesVisited.toLocaleString('es-ES')}
            </span>
            <span className="metric-sub">
              <span className="mono">
                {crawlStats.subdividedBoxes.toLocaleString('es-ES')}
              </span>{' '}
              subdivisiones adaptativas en zonas densas
            </span>
          </div>

          <div className="metric-cell">
            <span className="metric-label">Duración del Barrido</span>
            <span className="metric-value" style={{ fontSize: 22 }}>
              {formatDuration(crawlStats.durationSeconds)}
            </span>
            <span className="metric-sub">
              Nivel de zoom paramétrico{' '}
              <span className="mono">z={crawlStats.zoomParam}</span>
            </span>
          </div>

          <div className="metric-cell">
            <span className="metric-label">Intervalo de Cortesía</span>
            <span className="metric-value" style={{ fontSize: 22 }}>
              {crawlStats.delaySeconds.toLocaleString('es-ES', {
                minimumFractionDigits: 1,
              })}{' '}
              s
            </span>
            <span className="metric-sub">
              Pausa mínima garantizada entre peticiones
            </span>
          </div>
        </div>
      </section>
    </main>
  );
}
