import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Clock,
  Radio,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import { useAntenasData } from '../hooks/useAntenasData';
import {
  STANDARD_NOVEDADES_BANDS,
  extractScanDayDmy,
  filterNovedades,
  formatScanDateTimeDmyHms,
  getOperatorRowBackground,
  useNovedadesData,
} from '../hooks/useNovedadesData';
import {
  OPERATOR_META,
  OPERATOR_ORDER,
  type NovedadTipo,
  type OperatorKey,
} from '../types/antena';

const INITIAL_VISIBLE_ROWS = 300;
const LOAD_MORE_STEP = 300;

export function NovedadesView() {
  const {
    data: dataset,
    isLoading,
    isError,
    error,
    refetch,
  } = useNovedadesData();
  const { derived } = useAntenasData();

  const [tipoFilter, setTipoFilter] = useState<'all' | NovedadTipo>('all');
  const [operatorFilter, setOperatorFilter] = useState<'all' | OperatorKey>(
    'all',
  );
  const [bandFilter, setBandFilter] = useState<string>('all');
  const [locationFilter, setLocationFilter] = useState<string>('all');
  const [dateFilter, setDateFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [pagination, setPagination] = useState<{ key: string; limit: number }>({
    key: '',
    limit: INITIAL_VISIBLE_ROWS,
  });

  useEffect(() => {
    document.title =
      'Novedades · Censo de Antenas y Frecuencias Móviles en España';
  }, []);

  const filterKey = `${tipoFilter}|${operatorFilter}|${bandFilter}|${locationFilter}|${dateFilter}|${searchQuery}`;
  const effectiveLimit =
    pagination.key === filterKey ? pagination.limit : INITIAL_VISIBLE_ROWS;

  const summaryCounts = useMemo(() => {
    const byOp: Record<OperatorKey, number> = {
      movistar: 0,
      orange: 0,
      vodafone: 0,
      masmovil: 0,
      digi: 0,
      otros: 0,
    };
    if (!dataset) {
      return { all: 0, antena: 0, frecuencia: 0, byOp };
    }
    let antena = 0;
    let frecuencia = 0;
    for (let i = 0; i < dataset.novedades.length; i++) {
      const item = dataset.novedades[i];
      if (item.tipo === 'antena') {
        antena += 1;
      } else {
        frecuencia += 1;
      }
      if (item.op in byOp) {
        byOp[item.op] += 1;
      }
    }
    return {
      all: dataset.novedades.length,
      antena: dataset.antenasNuevas ?? antena,
      frecuencia: dataset.frecuenciasNuevas ?? frecuencia,
      byOp,
    };
  }, [dataset]);

  const availableLocations = useMemo(() => {
    const cities = new Set<string>();
    if (dataset) {
      for (let i = 0; i < dataset.novedades.length; i++) {
        const city = dataset.novedades[i].ubicacion?.trim();
        if (city) cities.add(city);
      }
    }
    if (cities.size > 0) {
      return Array.from(cities).sort((a, b) => a.localeCompare(b, 'es'));
    }
    if (derived) {
      return derived.dataset.provinces
        .map((p) => p.provincia)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, 'es'));
    }
    return [];
  }, [dataset, derived]);

  const availableScanDates = useMemo(() => {
    const dates = new Set<string>();
    if (dataset) {
      for (let i = 0; i < dataset.novedades.length; i++) {
        const row = dataset.novedades[i];
        const day = extractScanDayDmy(row.scannedAt, row.fecha);
        if (day && day !== '—') {
          dates.add(day);
        }
      }
    }
    return Array.from(dates);
  }, [dataset]);

  const filteredRows = useMemo(() => {
    if (!dataset) return [];
    return filterNovedades({
      novedades: dataset.novedades,
      tipoFilter,
      operatorFilter,
      bandFilter,
      locationFilter,
      dateFilter,
      searchQuery,
    });
  }, [
    dataset,
    tipoFilter,
    operatorFilter,
    bandFilter,
    locationFilter,
    dateFilter,
    searchQuery,
  ]);

  const hasActiveFilters =
    tipoFilter !== 'all' ||
    operatorFilter !== 'all' ||
    bandFilter !== 'all' ||
    locationFilter !== 'all' ||
    dateFilter !== 'all' ||
    searchQuery.trim().length > 0;

  function handleResetFilters() {
    setTipoFilter('all');
    setOperatorFilter('all');
    setBandFilter('all');
    setLocationFilter('all');
    setDateFilter('all');
    setSearchQuery('');
    setPagination({ key: '', limit: INITIAL_VISIBLE_ROWS });
  }

  if (isLoading && !dataset) {
    return (
      <main className="page-container novedades-page">
        <div className="state-center-box">
          <div className="spinner-ring" aria-hidden="true" />
          <p style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
            Cargando registro de novedades de antenas y frecuencias…
          </p>
        </div>
      </main>
    );
  }

  if (isError || !dataset) {
    return (
      <main className="page-container novedades-page">
        <div className="state-center-box">
          <h1
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: 'var(--text-primary)',
            }}
          >
            Error al cargar las novedades del censo
          </h1>
          <p style={{ maxWidth: 460 }}>
            {error instanceof Error
              ? error.message
              : 'No se pudo descargar data/novedades.json.'}
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void refetch()}
          >
            <RefreshCw size={14} aria-hidden="true" />
            <span>Reintentar descarga</span>
          </button>
        </div>
      </main>
    );
  }

  const lastScanFormatted = formatScanDateTimeDmyHms(dataset.updatedAt);
  const previousScanFormatted = dataset.previousScanAt
    ? formatScanDateTimeDmyHms(dataset.previousScanAt)
    : null;
  const visibleRows =
    filteredRows.length > effectiveLimit
      ? filteredRows.slice(0, effectiveLimit)
      : filteredRows;
  const remainingRows = Math.max(0, filteredRows.length - visibleRows.length);
  const selectedOperatorMeta =
    operatorFilter !== 'all' ? OPERATOR_META[operatorFilter] : null;

  return (
    <main className="page-container novedades-page">
      <header className="page-hero">
        <span className="page-eyebrow">
          Monitorización Diaria del Espectro · 18:00 h
        </span>
        <h1 className="page-h1">Novedades de Antenas y Frecuencias</h1>
        <p className="page-lead">
          Cambios detectados respecto al escaneo diario anterior (programado
          todos los días a las 18:00 h).
        </p>
      </header>

      <section
        className="metrics-strip novedades-metrics-strip"
        aria-label="Resumen del último escaneo de novedades"
      >
        <div className="metric-cell">
          <span className="metric-label">Total novedades</span>
          <span className="metric-value">
            {dataset.total.toLocaleString('es-ES')}
          </span>
          <span className="metric-sub">
            {dataset.isBaselineScan
              ? 'Escaneo base de referencia (sin contabilizar)'
              : previousScanFormatted
                ? `Respecto a ${previousScanFormatted}`
                : 'Respecto al escaneo diario anterior'}
          </span>
        </div>

        <div className="metric-cell">
          <span className="metric-label">Antenas nuevas</span>
          <span className="metric-value">
            {dataset.antenasNuevas.toLocaleString('es-ES')}
          </span>
          <span className="metric-sub">
            Nuevos emplazamientos incorporados al censo
          </span>
        </div>

        <div className="metric-cell">
          <span className="metric-label">Frecuencias nuevas</span>
          <span className="metric-value">
            {dataset.frecuenciasNuevas.toLocaleString('es-ES')}
          </span>
          <span className="metric-sub">
            Nuevas concesiones de banda asignadas en MINETUR
          </span>
        </div>

        <div className="metric-cell">
          <span className="metric-label">Último escaneo</span>
          <span className="metric-value novedades-metric-datetime">
            {lastScanFormatted}
          </span>
          <span className="metric-sub">
            {dataset.isBaselineScan
              ? 'Línea base inicial · Próximo ciclo diario 18:00 h'
              : 'Día/Mes/Año y hora exacta (Europe/Madrid)'}
          </span>
        </div>
      </section>

      <section
        className="section-block novedades-table-section"
        aria-labelledby="novedades-section-h2"
      >
        <h2 id="novedades-section-h2" className="sr-only">
          Tabla de antenas y frecuencias nuevas respecto al escaneo anterior
        </h2>

        <div
          className="novedades-filters-panel"
          role="region"
          aria-label="Opciones de filtro de novedades"
        >
          <div className="novedades-filters-top-row">
            <div className="novedades-filters-heading">
              <SlidersHorizontal size={14} aria-hidden="true" />
              <span>Filtros</span>
            </div>

            <div
              className="novedades-type-pills"
              role="group"
              aria-label="Filtrar por tipo de novedad"
            >
              <button
                type="button"
                id="novedades-filter-all"
                className={`novedades-filter-pill${
                  tipoFilter === 'all' ? ' is-active' : ''
                }`}
                onClick={() => setTipoFilter('all')}
                aria-pressed={tipoFilter === 'all'}
              >
                <span>Todas</span>
                <span className="novedades-pill-count mono">
                  {summaryCounts.all.toLocaleString('es-ES')}
                </span>
              </button>

              <button
                type="button"
                id="novedades-filter-antenas"
                className={`novedades-filter-pill${
                  tipoFilter === 'antena' ? ' is-active' : ''
                }`}
                onClick={() => setTipoFilter('antena')}
                aria-pressed={tipoFilter === 'antena'}
              >
                <RadioTower size={13} aria-hidden="true" />
                <span>Antenas nuevas</span>
                <span className="novedades-pill-count mono">
                  {summaryCounts.antena.toLocaleString('es-ES')}
                </span>
              </button>

              <button
                type="button"
                id="novedades-filter-frecuencias"
                className={`novedades-filter-pill${
                  tipoFilter === 'frecuencia' ? ' is-active' : ''
                }`}
                onClick={() => setTipoFilter('frecuencia')}
                aria-pressed={tipoFilter === 'frecuencia'}
              >
                <Radio size={13} aria-hidden="true" />
                <span>Frecuencias nuevas</span>
                <span className="novedades-pill-count mono">
                  {summaryCounts.frecuencia.toLocaleString('es-ES')}
                </span>
              </button>
            </div>

            {hasActiveFilters && (
              <button
                type="button"
                id="novedades-reset-filters-btn"
                className="btn btn-subtle btn-sm novedades-reset-btn"
                onClick={handleResetFilters}
              >
                <RotateCcw size={12} aria-hidden="true" />
                <span>Limpiar filtros</span>
              </button>
            )}
          </div>

          <div
            className="novedades-operator-chips"
            role="group"
            aria-label="Filtro rápido por operadora"
          >
            <button
              type="button"
              id="novedades-op-chip-all"
              className={`novedades-op-chip${
                operatorFilter === 'all' ? ' is-active' : ''
              }`}
              onClick={() => setOperatorFilter('all')}
              aria-pressed={operatorFilter === 'all'}
            >
              <span>Todas las operadoras</span>
            </button>
            {OPERATOR_ORDER.map((opKey) => {
              const meta = OPERATOR_META[opKey];
              const isActive = operatorFilter === opKey;
              return (
                <button
                  key={opKey}
                  type="button"
                  id={`novedades-op-chip-${opKey}`}
                  className={`novedades-op-chip${isActive ? ' is-active' : ''}`}
                  style={
                    isActive
                      ? {
                          backgroundColor: getOperatorRowBackground(opKey, 0.22),
                          borderColor: meta.color,
                        }
                      : undefined
                  }
                  onClick={() =>
                    setOperatorFilter(isActive ? 'all' : opKey)
                  }
                  aria-pressed={isActive}
                >
                  <span
                    className="operator-dot"
                    style={{ backgroundColor: meta.color }}
                    aria-hidden="true"
                  />
                  <span>{meta.shortName}</span>
                  {summaryCounts.byOp[opKey] > 0 && (
                    <span className="novedades-pill-count mono">
                      {summaryCounts.byOp[opKey].toLocaleString('es-ES')}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="novedades-filters-grid">
            <div className="novedades-filter-field novedades-filter-field-search">
              <label
                htmlFor="novedades-search-input"
                className="novedades-filter-label"
              >
                Búsqueda libre
              </label>
              <div className="search-input-wrap">
                <span className="search-input-icon" aria-hidden="true">
                  <Search size={14} />
                </span>
                <input
                  id="novedades-search-input"
                  type="search"
                  className="search-input"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Código antena, código banda, MHz o ciudad…"
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="search-clear-btn"
                    onClick={() => setSearchQuery('')}
                    aria-label="Limpiar búsqueda de novedades"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            </div>

            <div className="novedades-filter-field">
              <label
                htmlFor="novedades-operator-filter"
                className="novedades-filter-label"
              >
                Operadora
              </label>
              <div className="novedades-op-select-wrap">
                {selectedOperatorMeta && (
                  <span
                    className="operator-dot novedades-op-select-dot"
                    style={{ backgroundColor: selectedOperatorMeta.color }}
                    aria-hidden="true"
                  />
                )}
                <select
                  id="novedades-operator-filter"
                  className={`select-control novedades-op-select${
                    selectedOperatorMeta ? ' has-dot' : ''
                  }`}
                  value={operatorFilter}
                  onChange={(e) =>
                    setOperatorFilter(e.target.value as 'all' | OperatorKey)
                  }
                >
                  <option value="all">Todas las operadoras</option>
                  {OPERATOR_ORDER.map((opKey) => (
                    <option key={opKey} value={opKey}>
                      {OPERATOR_META[opKey].name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="novedades-filter-field">
              <label
                htmlFor="novedades-band-filter"
                className="novedades-filter-label"
              >
                Banda / Frecuencia
              </label>
              <select
                id="novedades-band-filter"
                className="select-control"
                value={bandFilter}
                onChange={(e) => setBandFilter(e.target.value)}
              >
                <option value="all">Todas las bandas</option>
                {STANDARD_NOVEDADES_BANDS.map((band) => (
                  <option key={band} value={band}>
                    {band}
                  </option>
                ))}
              </select>
            </div>

            <div className="novedades-filter-field">
              <label
                htmlFor="novedades-location-filter"
                className="novedades-filter-label"
              >
                Ubicación
              </label>
              <select
                id="novedades-location-filter"
                className="select-control"
                value={locationFilter}
                onChange={(e) => setLocationFilter(e.target.value)}
              >
                <option value="all">Todas las ubicaciones</option>
                {availableLocations.map((loc) => (
                  <option key={loc} value={loc}>
                    {loc}
                  </option>
                ))}
              </select>
            </div>

            {availableScanDates.length > 0 && (
              <div className="novedades-filter-field">
                <label
                  htmlFor="novedades-date-filter"
                  className="novedades-filter-label"
                >
                  Fecha de escaneo
                </label>
                <select
                  id="novedades-date-filter"
                  className="select-control"
                  value={dateFilter}
                  onChange={(e) => setDateFilter(e.target.value)}
                >
                  <option value="all">Todas las fechas</option>
                  {availableScanDates.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>

        {hasActiveFilters && dataset.novedades.length > 0 && (
          <div className="novedades-results-status" aria-live="polite">
            Mostrando{' '}
            <strong className="mono">
              {filteredRows.length.toLocaleString('es-ES')}
            </strong>{' '}
            de{' '}
            <span className="mono">
              {dataset.novedades.length.toLocaleString('es-ES')}
            </span>{' '}
            novedades registradas
          </div>
        )}

        <div className="novedades-table-wrap">
          <table className="novedades-table" id="novedades-table">
            <thead>
              <tr>
                <th scope="col">Novedad</th>
                <th scope="col">Código</th>
                <th scope="col">Código Banda</th>
                <th scope="col">Frecuencia</th>
                <th scope="col">Ubicación</th>
                <th scope="col">Fecha</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.length > 0 ? (
                visibleRows.map((row) => {
                  const meta = OPERATOR_META[row.op];
                  const operatorDisplayName =
                    row.op === 'otros' && row.opRaw ? row.opRaw : meta.name;
                  const isFrecuencia = row.tipo === 'frecuencia';
                  const formattedFecha = formatScanDateTimeDmyHms(
                    row.scannedAt,
                    row.fecha,
                  );
                  const rowBgColor = getOperatorRowBackground(row.op, 0.5);

                  return (
                    <tr
                      key={row.id}
                      className="novedades-row"
                      data-operator={row.op}
                      style={{ backgroundColor: rowBgColor }}
                    >
                      <td>
                        <div className="novedades-cell-novedad">
                          <span
                            className={`novedades-badge ${
                              isFrecuencia ? 'is-frecuencia' : 'is-antena'
                            }`}
                          >
                            {isFrecuencia ? (
                              <Radio size={12} aria-hidden="true" />
                            ) : (
                              <RadioTower size={12} aria-hidden="true" />
                            )}
                            <span>
                              {isFrecuencia
                                ? 'Frecuencia nueva'
                                : 'Antena nueva'}
                            </span>
                          </span>

                          <span
                            className="novedades-operator-tag"
                            title={row.opRaw || meta.description}
                          >
                            <span
                              className="operator-dot novedades-row-op-dot"
                              style={{ backgroundColor: meta.color }}
                              aria-hidden="true"
                            />
                            <span className="novedades-operator-name">
                              {operatorDisplayName}
                            </span>
                          </span>
                        </div>
                      </td>

                      <td>
                        <Link
                          to="/"
                          search={{
                            gid: row.codigo,
                            id: row.antennaId || undefined,
                          }}
                          className="novedades-code-link mono"
                          title="Ver esta antena en el mapa interactivo"
                        >
                          {row.codigo}
                        </Link>
                      </td>

                      <td>
                        {isFrecuencia ? (
                          <span className="mono novedades-band-code">
                            {row.codigoBanda || 'Sin código'}
                          </span>
                        ) : (
                          <span
                            className="novedades-empty-cell"
                            aria-label="No aplica para antena nueva"
                          >
                            —
                          </span>
                        )}
                      </td>

                      <td>
                        {isFrecuencia ? (
                          <span className="mono novedades-freq-exact">
                            {row.frecuencia || '—'}
                          </span>
                        ) : (
                          <span
                            className="novedades-empty-cell"
                            aria-label="No aplica para antena nueva"
                          >
                            —
                          </span>
                        )}
                      </td>

                      <td>
                        <span
                          className="novedades-location-cell"
                          title={
                            row.prov && row.ubicacion
                              ? `${row.ubicacion} (${row.prov})`
                              : row.ubicacion || undefined
                          }
                        >
                          {row.ubicacion || '—'}
                        </span>
                      </td>

                      <td>
                        <span className="mono novedades-date-cell">
                          {formattedFecha}
                        </span>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="novedades-empty-state-cell">
                    {dataset.novedades.length === 0 ? (
                      <div className="novedades-empty-box">
                        <div
                          className="novedades-empty-icon"
                          aria-hidden="true"
                        >
                          {dataset.isBaselineScan ? (
                            <Clock size={20} />
                          ) : (
                            <Sparkles size={20} />
                          )}
                        </div>
                        <p className="novedades-empty-title">
                          {dataset.isBaselineScan
                            ? '0 novedades respecto al escaneo anterior (línea base activa)'
                            : '0 antenas o frecuencias nuevas respecto al escaneo anterior'}
                        </p>
                        <p className="novedades-empty-desc">
                          {dataset.isBaselineScan ? (
                            <>
                              El escaneo base actual (
                              <span className="mono">{lastScanFormatted}</span>)
                              sirve de referencia inicial y no contabiliza
                              novedades. Las nuevas antenas y concesiones de
                              frecuencia aparecerán en esta tabla tras el
                              próximo escaneo automático diario de las{' '}
                              <strong>18:00 h</strong>.
                            </>
                          ) : (
                            <>
                              No se han registrado altas de nuevas antenas ni
                              nuevas concesiones de frecuencia en el último
                              escaneo del{' '}
                              <span className="mono">{lastScanFormatted}</span>.
                              El próximo escaneo automático se ejecutará a las{' '}
                              <strong>18:00 h</strong>.
                            </>
                          )}
                        </p>
                      </div>
                    ) : (
                      <div className="novedades-empty-box">
                        <p className="novedades-empty-title">
                          Ninguna novedad coincide con los filtros aplicados
                        </p>
                        <p className="novedades-empty-desc">
                          Prueba con otro término de búsqueda, operadora, banda,
                          ubicación o tipo de novedad.
                        </p>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={handleResetFilters}
                        >
                          <RotateCcw size={13} aria-hidden="true" />
                          <span>Restablecer filtros</span>
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {remainingRows > 0 && (
          <div className="novedades-pagination-bar">
            <span className="novedades-pagination-info">
              Mostrando{' '}
              <strong className="mono">
                {visibleRows.length.toLocaleString('es-ES')}
              </strong>{' '}
              de{' '}
              <strong className="mono">
                {filteredRows.length.toLocaleString('es-ES')}
              </strong>{' '}
              filas
            </span>
            <div className="novedades-pagination-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() =>
                  setPagination({
                    key: filterKey,
                    limit: effectiveLimit + LOAD_MORE_STEP,
                  })
                }
              >
                Mostrar{' '}
                {Math.min(LOAD_MORE_STEP, remainingRows).toLocaleString(
                  'es-ES',
                )}{' '}
                más
              </button>
              {remainingRows > LOAD_MORE_STEP && (
                <button
                  type="button"
                  className="btn btn-subtle btn-sm"
                  onClick={() =>
                    setPagination({
                      key: filterKey,
                      limit: filteredRows.length,
                    })
                  }
                >
                  Mostrar todas ({filteredRows.length.toLocaleString('es-ES')})
                </button>
              )}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
